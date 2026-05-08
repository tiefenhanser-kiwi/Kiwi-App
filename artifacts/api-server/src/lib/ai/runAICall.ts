// WS6 AI orchestrator — single entry point for every AI call.
// Per kiwi_ws6_plan.md §3 6a-1.

import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";

import { logger } from "../logger";
import {
  buildToolForSchema,
  defaultTextModeSuffix,
  extractPayload,
  forcedToolChoice,
  type AICallMode,
} from "./modes";
import { userFacingMessage, type AICallFailureReason } from "./errors";
import {
  estimateCostUsd,
  renderPromptBody,
  resolvePromptDescriptor,
} from "./promptRegistry";

export type { AICallMode } from "./modes";

export interface AICallOptions {
  // Override AIPrompt.defaultModel (post-6a-2: reads from DB).
  model?: string;
  // Override AIPrompt.defaultMode.
  mode?: AICallMode;
  // Default 4096; raise for high-schema tool_use flows.
  maxTokens?: number;
  // Default 0.7. Set to 0 for deterministic flows.
  temperature?: number;
  // Default true — single retry on validation failure with stricter prompt.
  retryOnValidationFailure?: boolean;
  // For LLMCallLog correlation post-6a-2.
  userId?: string;
  // Test seam — inject a custom client. Production callers omit.
  client?: Pick<Anthropic, "messages">;
}

export interface AICallMetadata {
  promptKey: string;
  // null until 6a-2 lands DB-backed prompts with versioning.
  promptVersion: number | null;
  model: string;
  mode: AICallMode;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costEstimateUsd: number;
  retryCount: number;
}

export interface AICallSuccess<T> {
  success: true;
  data: T;
  metadata: AICallMetadata;
}

export interface AICallFailure {
  success: false;
  reason: AICallFailureReason;
  userFacingMessage: string;
  internalError?: unknown;
  metadata: Partial<AICallMetadata>;
}

export type AICallResult<T> = AICallSuccess<T> | AICallFailure;

// Module-level singleton — built lazily so missing env doesn't blow up
// at import time. Tests bypass by passing opts.client.
let cachedClient: Anthropic | null = null;
function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

// Test-only — reset the cached client between tests. Not exported via
// schemas/index; importers reach in directly.
export function _resetClientCache(): void {
  cachedClient = null;
}

export async function runAICall<T extends z.ZodTypeAny>(
  promptKey: string,
  vars: Record<string, unknown>,
  schema: T,
  opts: AICallOptions = {},
): Promise<AICallResult<z.infer<T>>> {
  const start = Date.now();
  const descriptor = resolvePromptDescriptor(promptKey);
  const model = opts.model ?? descriptor.defaultModel;
  const mode: AICallMode = opts.mode ?? descriptor.defaultMode;
  const maxTokens = opts.maxTokens ?? 4096;
  const temperature = opts.temperature ?? 0.7;
  const retryOnValidationFailure = opts.retryOnValidationFailure ?? true;

  const client = opts.client ?? getClient();
  if (!client) {
    return failure({
      promptKey,
      model,
      mode,
      latencyMs: Date.now() - start,
      reason: "no_api_key",
    });
  }

  const baseBody = renderPromptBody(descriptor.body, vars);

  // Tool-use vs text dispatch. Both share the messages.create call; what
  // differs is whether we pass tools+tool_choice or a JSON-only suffix.
  let attempt = 0;
  let lastValidationError: unknown = null;
  let inputTokens = 0;
  let outputTokens = 0;

  while (attempt <= (retryOnValidationFailure ? 1 : 0)) {
    const userMessage = buildUserMessage({
      baseBody,
      mode,
      attempt,
      lastValidationError,
    });

    let message: Anthropic.Message;
    try {
      message = await client.messages.create({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [{ role: "user", content: userMessage }],
        ...(mode === "tool"
          ? {
              tools: buildToolForSchema(schema, descriptor.toolDescription),
              tool_choice: forcedToolChoice(),
            }
          : {}),
      });
    } catch (err) {
      const reason = inferSdkErrorReason(err);
      logger.error(
        { event: "ai_call", promptKey, model, mode, err },
        "AI SDK call failed",
      );
      return failure({
        promptKey,
        model,
        mode,
        latencyMs: Date.now() - start,
        inputTokens,
        outputTokens,
        retryCount: attempt,
        reason,
        internalError: err,
      });
    }

    inputTokens += message.usage.input_tokens;
    outputTokens += message.usage.output_tokens;

    const extracted = extractPayload(message, mode);
    if (!extracted.ok) {
      lastValidationError = `Could not extract payload from ${mode} response.`;
      attempt++;
      continue;
    }

    const parsed = schema.safeParse(extracted.value);
    if (parsed.success) {
      const metadata: AICallMetadata = {
        promptKey,
        promptVersion: null,
        model,
        mode,
        latencyMs: Date.now() - start,
        inputTokens,
        outputTokens,
        costEstimateUsd: estimateCostUsd(model, inputTokens, outputTokens),
        retryCount: attempt,
      };
      logger.info(
        { event: "ai_call", success: true, ...metadata },
        "AI call succeeded",
      );
      // TODO(6a-2): write metadata + truncated raw payload to LLMCallLog.
      // Schema lands in 6a-2; until then, log-only.
      return { success: true, data: parsed.data as z.infer<T>, metadata };
    }

    lastValidationError = parsed.error.flatten();
    attempt++;
  }

  // Exhausted retries.
  const latencyMs = Date.now() - start;
  logger.warn(
    {
      event: "ai_call",
      success: false,
      reason: "validation_failed",
      promptKey,
      model,
      mode,
      latencyMs,
      inputTokens,
      outputTokens,
      retryCount: attempt - 1,
      validationError: lastValidationError,
    },
    "AI call failed schema validation after retry",
  );
  return failure({
    promptKey,
    model,
    mode,
    latencyMs,
    inputTokens,
    outputTokens,
    retryCount: attempt - 1,
    reason: "validation_failed",
    internalError: lastValidationError,
  });
}

// ── helpers ──────────────────────────────────────────────────────────

function buildUserMessage(args: {
  baseBody: string;
  mode: AICallMode;
  attempt: number;
  lastValidationError: unknown;
}): string {
  const { baseBody, mode, attempt, lastValidationError } = args;
  const parts: string[] = [baseBody];
  if (mode === "text") parts.push(defaultTextModeSuffix());
  if (attempt > 0 && lastValidationError != null) {
    parts.push(
      "",
      "Your previous response failed validation:",
      typeof lastValidationError === "string"
        ? lastValidationError
        : JSON.stringify(lastValidationError),
      "Reply with ONLY a valid response matching the requested shape.",
    );
  }
  return parts.join("\n");
}

function inferSdkErrorReason(err: unknown): AICallFailureReason {
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status?: number }).status;
    if (status === 429) return "rate_limited";
    if (status === 401 || status === 403) return "no_api_key";
  }
  return "sdk_error";
}

function failure(args: {
  promptKey: string;
  model: string;
  mode: AICallMode;
  latencyMs: number;
  reason: AICallFailureReason;
  inputTokens?: number;
  outputTokens?: number;
  retryCount?: number;
  internalError?: unknown;
}): AICallFailure {
  return {
    success: false,
    reason: args.reason,
    userFacingMessage: userFacingMessage(args.reason),
    internalError: args.internalError,
    metadata: {
      promptKey: args.promptKey,
      promptVersion: null,
      model: args.model,
      mode: args.mode,
      latencyMs: args.latencyMs,
      inputTokens: args.inputTokens ?? 0,
      outputTokens: args.outputTokens ?? 0,
      retryCount: args.retryCount ?? 0,
    },
  };
}

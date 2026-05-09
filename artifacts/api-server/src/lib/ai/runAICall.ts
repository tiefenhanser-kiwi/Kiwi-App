// WS6 AI orchestrator — single entry point for every AI call.
// Per kiwi_ws6_plan.md §3 6a-1 (skeleton) + 6a-2 (DB-backed prompts +
// LLMCallLog write).
//
// Production caller pattern:
//   const result = await runAICall(promptKey, vars, schema, {
//     prisma,            // singleton from ../prisma; enables DB lookups + log writes
//     userId: req.userId,
//   });
//
// Test caller pattern (omit prisma → in-memory fallback, no log writes):
//   const result = await runAICall(promptKey, vars, schema, { client: stub });

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
  estimateCostUsdFromRate,
  getModelRate,
  renderPromptBody,
  resolvePromptDescriptorFromDb,
  type LLMCallLogCreateData,
  type PrismaLike,
} from "./promptRegistry";

export type { AICallMode } from "./modes";

export interface AICallOptions {
  // Override AIPrompt.defaultModel.
  model?: string;
  // Override AIPrompt.defaultMode.
  mode?: AICallMode;
  // Default 4096; raise for high-schema tool_use flows.
  maxTokens?: number;
  // Default 0.7. Set to 0 for deterministic flows.
  temperature?: number;
  // Default true — single retry on validation failure with stricter prompt.
  retryOnValidationFailure?: boolean;
  // For LLMCallLog correlation. Null = system-triggered (seeds, batch jobs).
  userId?: string;
  // Test seam — inject a custom Anthropic client. Production callers omit.
  client?: Pick<Anthropic, "messages">;
  // Production: pass the singleton from ../prisma to enable DB-backed prompt
  // resolution, model-rate lookup, and LLMCallLog writes.
  // Tests: omit (in-memory fallback, no log writes) or inject a stub.
  prisma?: PrismaLike;
}

export interface AICallMetadata {
  promptKey: string;
  // null when descriptor came from in-memory fallback (no DB row).
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

// Module-level Anthropic singleton — built lazily so missing env doesn't blow
// up at import time. Tests bypass by passing opts.client.
let cachedClient: Anthropic | null = null;
function getClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

// Test-only — reset the cached client between tests.
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
  const prismaClient = opts.prisma ?? null;
  const descriptor = await resolvePromptDescriptorFromDb(promptKey, prismaClient);
  const promptVersion = descriptor.version;
  const model = opts.model ?? descriptor.defaultModel;
  const mode: AICallMode = opts.mode ?? descriptor.defaultMode;
  const maxTokens = opts.maxTokens ?? 4096;
  const temperature = opts.temperature ?? 0.7;
  const retryOnValidationFailure = opts.retryOnValidationFailure ?? true;
  const userId = opts.userId ?? null;

  const client = opts.client ?? getClient();
  if (!client) {
    const failureResult = failure({
      promptKey,
      promptVersion,
      model,
      mode,
      latencyMs: Date.now() - start,
      reason: "no_api_key",
    });
    await writeLogSafely(prismaClient, {
      promptKey,
      promptVersion,
      model,
      mode,
      userId,
      latencyMs: failureResult.metadata.latencyMs ?? 0,
      inputTokens: 0,
      outputTokens: 0,
      costEstimateUsd: 0,
      retryCount: 0,
      success: false,
      failureReason: "no_api_key",
    });
    return failureResult;
  }

  // Fetch model rate once up-front so cost calc inside the success branch
  // stays synchronous and we don't re-query on every retry attempt.
  const rate = await getModelRate(model, prismaClient);

  const baseBody = renderPromptBody(descriptor.body, vars);

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
      const latencyMs = Date.now() - start;
      await writeLogSafely(prismaClient, {
        promptKey,
        promptVersion,
        model,
        mode,
        userId,
        latencyMs,
        inputTokens,
        outputTokens,
        costEstimateUsd: estimateCostUsdFromRate(rate, inputTokens, outputTokens),
        retryCount: attempt,
        success: false,
        failureReason: reason,
      });
      return failure({
        promptKey,
        promptVersion,
        model,
        mode,
        latencyMs,
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
      const latencyMs = Date.now() - start;
      const costEstimateUsd = estimateCostUsdFromRate(rate, inputTokens, outputTokens);
      const metadata: AICallMetadata = {
        promptKey,
        promptVersion,
        model,
        mode,
        latencyMs,
        inputTokens,
        outputTokens,
        costEstimateUsd,
        retryCount: attempt,
      };
      logger.info(
        { event: "ai_call", success: true, ...metadata },
        "AI call succeeded",
      );
      await writeLogSafely(prismaClient, {
        promptKey,
        promptVersion,
        model,
        mode,
        userId,
        latencyMs,
        inputTokens,
        outputTokens,
        costEstimateUsd,
        retryCount: attempt,
        success: true,
        failureReason: null,
      });
      return { success: true, data: parsed.data as z.infer<T>, metadata };
    }

    lastValidationError = parsed.error.flatten();
    attempt++;
  }

  // Exhausted retries.
  const latencyMs = Date.now() - start;
  const retryCount = attempt - 1;
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
      retryCount,
      validationError: lastValidationError,
    },
    "AI call failed schema validation after retry",
  );
  await writeLogSafely(prismaClient, {
    promptKey,
    promptVersion,
    model,
    mode,
    userId,
    latencyMs,
    inputTokens,
    outputTokens,
    costEstimateUsd: estimateCostUsdFromRate(rate, inputTokens, outputTokens),
    retryCount,
    success: false,
    failureReason: "validation_failed",
  });
  return failure({
    promptKey,
    promptVersion,
    model,
    mode,
    latencyMs,
    inputTokens,
    outputTokens,
    retryCount,
    reason: "validation_failed",
    internalError: lastValidationError,
  });
}

// ── helpers ──────────────────────────────────────────────────────────

// LLMCallLog write — non-fatal. A failed write must not propagate or change
// the AI call's result. If `prisma` is null (test or unconfigured caller),
// skip silently.
async function writeLogSafely(
  prisma: PrismaLike | null,
  data: LLMCallLogCreateData,
): Promise<void> {
  if (!prisma) return;
  try {
    await prisma.lLMCallLog.create({ data });
  } catch (err) {
    logger.error(
      { event: "llm_call_log_write", err, promptKey: data.promptKey },
      "LLMCallLog write failed — call result preserved",
    );
  }
}

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
  promptVersion: number | null;
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
      promptVersion: args.promptVersion,
      model: args.model,
      mode: args.mode,
      latencyMs: args.latencyMs,
      inputTokens: args.inputTokens ?? 0,
      outputTokens: args.outputTokens ?? 0,
      retryCount: args.retryCount ?? 0,
    },
  };
}

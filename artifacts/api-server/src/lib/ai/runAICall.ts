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

import Anthropic, { APIConnectionError } from "@anthropic-ai/sdk";
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
  // WS6 6c-2 — vision input. When present + non-empty, the user message
  // content swaps from string to [...attachments, { type: 'text', text }].
  // Image tokens are billed per-attempt; the retry path re-sends them.
  attachments?: Anthropic.ImageBlockParam[];
  // Plan-Gen Arc · Block 3 (R2) — optional cached stable system prefix. When
  // set, the string is emitted as its OWN system content block carrying
  // cache_control {type:"ephemeral"} (5-min TTL) so a byte-identical prefix
  // across calls hits the Anthropic prompt cache. The volatile per-call body
  // stays in the user message (stable-first, volatile-last — the prefix-match
  // caching contract). When ABSENT, the request is byte-identical to legacy
  // behavior: a single plain-string user message, no system block, no
  // cache_control. Existing callers pass nothing and are unchanged.
  cachedSystemPrefix?: string;
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
  // Plan-Gen Arc · Block 3 (R2) — prompt-cache usage. Production runAICall
  // ALWAYS populates these (0 when caching is inactive, which is every legacy
  // call). Typed OPTIONAL only so pre-existing test doubles that hand-build an
  // AICallMetadata literal keep compiling unchanged — consumers coalesce with
  // `?? 0`. `input_tokens` from the API is the UNCACHED remainder only; total
  // prompt size = inputTokens + cacheReadInputTokens + cacheCreationInputTokens.
  // Cost is still computed from input/output alone (see the cost call site) —
  // the harness reads these raw fields for its own cache-aware cost summary.
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
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
  const cachedSystemPrefix = opts.cachedSystemPrefix;

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
  // WS7-5b-server-fix2 — captured for the validation-failure-exhaustion WARN
  // below. Holds whatever the LAST failing safeParse received as input (raw
  // tool_use input or parsed JSON from text mode). When zod's flattened error
  // names a path but the cause is the SHAPE the model returned, this is the
  // diagnostic that explains "what did the model actually emit?". Truncated
  // at log time so a runaway payload can't blow up logs.
  let lastExtractedValue: unknown = null;
  let inputTokens = 0;
  let outputTokens = 0;
  // Plan-Gen Arc · Block 3 (R2) — accumulate cache usage across retry attempts.
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;

  const hasAttachments = (opts.attachments?.length ?? 0) > 0;

  while (attempt <= (retryOnValidationFailure ? 1 : 0)) {
    const userMessage = buildUserMessage({
      baseBody,
      mode,
      attempt,
      lastValidationError,
    });

    // 6c-2 — vision input: prepend image blocks to a text block. The string
    // fast-path stays the default to keep non-vision calls allocation-free.
    const messageContent: string | Array<Anthropic.ImageBlockParam | Anthropic.TextBlockParam> =
      hasAttachments
        ? [...(opts.attachments ?? []), { type: "text", text: userMessage }]
        : userMessage;

    let message: Anthropic.Message;
    try {
      message = await callMessagesCreateWithConnectionRetry(client, {
        model,
        max_tokens: maxTokens,
        temperature,
        // Plan-Gen Arc · Block 3 (R2) — cached stable prefix as its own system
        // block. Spread ONLY when set, so a legacy call (no cachedSystemPrefix)
        // emits no `system` key at all — byte-identical to before.
        ...(cachedSystemPrefix != null
          ? {
              system: [
                {
                  type: "text" as const,
                  text: cachedSystemPrefix,
                  cache_control: { type: "ephemeral" as const },
                },
              ],
            }
          : {}),
        messages: [{ role: "user", content: messageContent }],
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
        cacheReadInputTokens,
        cacheCreationInputTokens,
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
    // R2 — cache usage is nullable on the SDK type; coalesce to 0.
    cacheReadInputTokens += message.usage.cache_read_input_tokens ?? 0;
    cacheCreationInputTokens += message.usage.cache_creation_input_tokens ?? 0;

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
        cacheReadInputTokens,
        cacheCreationInputTokens,
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
        cacheReadInputTokens,
        cacheCreationInputTokens,
        costEstimateUsd,
        retryCount: attempt,
        success: true,
        failureReason: null,
      });
      return { success: true, data: parsed.data as z.infer<T>, metadata };
    }

    lastValidationError = parsed.error.flatten();
    lastExtractedValue = extracted.value;
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
      lastExtractedValue: truncateForLog(lastExtractedValue),
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
    cacheReadInputTokens,
    cacheCreationInputTokens,
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

// WS7-5b-server-fix2 — diagnostic-only. Renders the last failing-parse input
// as a string capped at ~2KB so the validation-failure-exhaustion WARN can
// include the raw payload without risking log blow-up on a runaway model
// response. JSON.stringify can throw on circular refs (none expected from
// tool_use input, but the SDK shape is not in our control) — fall back to
// String() so this helper never throws.
const LOG_VALUE_MAX_CHARS = 2048;
function truncateForLog(value: unknown): string {
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  if (serialized.length <= LOG_VALUE_MAX_CHARS) return serialized;
  return `${serialized.slice(0, LOG_VALUE_MAX_CHARS)}…[truncated ${serialized.length - LOG_VALUE_MAX_CHARS} chars]`;
}

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

// D-WS6-085 — APIConnectionError retry. Block 3 observed a 40% PASS rate on
// cold-start 6c-2 image imports: undici's keep-alive connection goes stale
// during the long 6c-1 idle, then 6c-2 reuses the dead conn and fails with
// `SocketError: other side closed`. The Anthropic SDK's built-in 2 retries
// all reuse the same pool slot within ~2s and exhaust together; a NEW SDK
// call (with fresh pool state) succeeds. So we retry at the userland level:
// each retry triggers a brand-new client.messages.create, which refreshes
// the connection pool. Non-connection errors are not retried.
//
// Backoff: 500/1000/2000ms linear. Block 3 evidence shows immediate retry
// usually works; longer backoffs are safety margin for server-side rollouts.

const CONNECTION_RETRY_BACKOFFS_MS = [500, 1000, 2000] as const;

async function callMessagesCreateWithConnectionRetry(
  client: Pick<Anthropic, "messages">,
  params: Anthropic.MessageCreateParams,
): Promise<Anthropic.Message> {
  const totalAttempts = CONNECTION_RETRY_BACKOFFS_MS.length + 1;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      return (await client.messages.create(params)) as Anthropic.Message;
    } catch (err) {
      lastErr = err;
      if (!(err instanceof APIConnectionError)) throw err;
      if (attempt === totalAttempts) break;
      const backoffMs = CONNECTION_RETRY_BACKOFFS_MS[attempt - 1];
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastErr;
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

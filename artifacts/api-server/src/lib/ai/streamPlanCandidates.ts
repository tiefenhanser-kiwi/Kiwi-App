// Latency Block (D-WS9-076) — streaming sibling of runAICall for plan-gen.
//
// ⚠️ TEXT MODE, deliberately. The diagnosis (see the STREAM FAILURE report)
// measured that tool_use buffers its input JSON to a terminal burst — first
// candidate landed 28ms–1.4s before the whole response, so progressive render
// is UNACHIEVABLE in tool mode. `text_delta` streams genuinely incrementally
// (measured: first candidate complete at ~5.7s of a ~13.6s generation), so this
// module runs TEXT mode: no tools, a JSON-only instruction injected at call
// time (NOT in the prompt body — no version bump), and text-extract + Zod for
// the final parse (runAICall's proven text pattern). The buffered fallback
// stays tool mode (known-good safety net).
//
// Why a sibling and not a runAICall option: runAICall is the single BUFFERED
// entry point for ~30 callers; its contract stays untouched. This module drives
// `messages.stream` for the ONE shape that benefits from progressive render —
// `{ candidates: [...] }` — emitting each candidate as it structurally
// completes (streamCandidateParser) and returning the same
// AICallResult<WizardPlanCandidatesResult> + metadata so the route logs +
// costs like the buffered path.
//
// Cache split: the stable instruction head (before `{{storeShortlist}}`) is
// passed as a cached `system` block (mode-agnostic — works in text mode too).
// byte-identity of head+tail vs. the buffered render is asserted in tests.
//
// Retry: none in-stream (a candidate already emitted can't be un-emitted). On
// final-validation failure or a mid-stream SDK error we return a failure; the
// route emits an `error` frame and the client falls back to the buffered
// endpoint (tool mode, which DOES retry). That keeps the retry safety net
// without double-emitting.

import type Anthropic from "@anthropic-ai/sdk";

import { logger } from "../logger";
import { extractPayload } from "./modes";
import { userFacingMessage } from "./errors";
import { getSharedAnthropicClient } from "./runAICall";
import type {
  AICallMetadata,
  AICallResult,
} from "./runAICall";
import {
  estimateCacheAwareCostUsdFromRate,
  getModelRate,
  resolvePromptDescriptorFromDb,
  splitRenderedPrompt,
  type LLMCallLogCreateData,
  type PrismaLike,
} from "./promptRegistry";
import { extractCompleteCandidates } from "./streamCandidateParser";
import {
  WizardPlanCandidateSchema,
  WizardPlanCandidatesResultSchema,
  type WizardPlanCandidate,
  type WizardPlanCandidatesResult,
} from "./schemas/wizard";

// Injected at call time (Ruling: code, not prompt body). Overrides the body's
// tool_use phrasing for text mode and pins the exact JSON shape so the model
// emits a directly-parseable object. The parser skips any leading fence, but we
// ask for none.
const TEXT_MODE_JSON_INSTRUCTION = [
  "",
  "OUTPUT FORMAT (OVERRIDE): There is NO tool available. Ignore any earlier",
  "instruction to make a tool_use call. Respond with ONLY a single raw JSON",
  "object — no prose, no markdown code fences, nothing before or after it —",
  "of exactly this shape:",
  '{"candidates":[{"id":string,"title":string,"tags":string[],',
  '"whyBullets":string[],"mealTitles":string[],',
  '"dailyMacros":{"calories":number,"proteinG":number,"carbsG":number,"fatG":number},',
  '"storeSlots":[{"slotIndex":number,"storeMealId":string}]}],',
  '"cannotGenerateMore":boolean,"reason":string}',
  'The "storeSlots", "cannotGenerateMore", and "reason" fields are optional;',
  "include storeSlots exactly as instructed above for any slot you fill from the",
  "shortlist. The JSON object is the entire response.",
].join("\n");

// Structural seam over `client.messages` — only the `stream` method is used.
// Production passes the real Anthropic messages resource; tests inject a fake.
export type StreamCapableMessages = Pick<Anthropic.Messages, "stream">;

export interface StreamPlanCandidatesOptions {
  prisma?: PrismaLike | null;
  userId?: string | null;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  // The {{var}} token that begins the volatile tail. When present and found in
  // the body, everything before it is sent as a cached system prefix.
  cacheSplitMarker?: string;
  // Test seam — inject a fake `messages` resource. Production omits (uses the
  // shared Anthropic singleton).
  client?: StreamCapableMessages;
  // Fired once per candidate the moment it structurally completes AND passes
  // WizardPlanCandidateSchema. `index` is its position in candidates[].
  onCandidate?: (index: number, candidate: WizardPlanCandidate) => void;
  // Fired on REAL text-delta activity (throttled to ~1/s), so the route can emit
  // a liveness `progress` frame during the pre-first-candidate window. Because
  // it's driven by genuine model output — not a timer — a true stall stops it
  // and the client watchdog fires correctly (no wedged-but-pinging masking).
  onProgress?: (info: { bytes: number }) => void;
}

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.7;
// Throttle progress signals so a fast delta stream doesn't flood frames.
const PROGRESS_THROTTLE_MS = 1000;

/**
 * Stream a plan-candidate generation call. Emits candidates progressively via
 * opts.onCandidate and resolves with the fully-validated result + metadata.
 *
 * Guarantees for the caller:
 *  - onCandidate fires strictly in index order, never for an index twice, and
 *    never for a candidate that fails WizardPlanCandidateSchema.
 *  - On success, result.data.candidates is the complete validated set. Some
 *    candidates may NOT have been emitted progressively (e.g. a transient
 *    per-candidate parse that only resolved at finalMessage); the caller must
 *    reconcile the final set against what it already sent (catch-up emit).
 */
export async function streamPlanCandidates(
  promptKey: string,
  vars: Record<string, unknown>,
  opts: StreamPlanCandidatesOptions = {},
): Promise<AICallResult<WizardPlanCandidatesResult>> {
  const start = Date.now();
  const prisma = opts.prisma ?? null;
  const userId = opts.userId ?? null;

  const descriptor = await resolvePromptDescriptorFromDb(promptKey, prisma);
  const promptVersion = descriptor.version;
  const model = opts.model ?? descriptor.defaultModel;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;

  const messages =
    opts.client ?? getSharedAnthropicClient()?.messages;
  if (!messages) {
    await writeStreamLog(prisma, {
      promptKey,
      promptVersion,
      model,
      mode: "text",
      userId,
      latencyMs: Date.now() - start,
      inputTokens: 0,
      outputTokens: 0,
      costEstimateUsd: 0,
      retryCount: 0,
      success: false,
      failureReason: "no_api_key",
    });
    return fail(promptKey, promptVersion, model, Date.now() - start, "no_api_key");
  }

  const rate = await getModelRate(model, prisma);

  // Cache split — head (stable, no vars) → cached system block; tail → user msg.
  const { prefix, body } = splitRenderedPrompt(
    descriptor.body,
    opts.cacheSplitMarker,
    vars,
  );
  // Text mode: the JSON-only instruction rides in the user message (after the
  // volatile tail), NOT in the prompt body and NOT in the cached prefix — so
  // the cached head stays byte-identical to the buffered render's head.
  const userContent = `${body}\n${TEXT_MODE_JSON_INSTRUCTION}`;

  // Progressive emit state. `emitted` is the count already handed to
  // onCandidate; extractCompleteCandidates is monotonic (a completed object
  // never un-completes), so we only ever advance.
  let emitted = 0;
  const tryEmit = (partialJson: string): void => {
    let complete: unknown[];
    try {
      complete = extractCompleteCandidates(partialJson);
    } catch {
      return; // never let a scan hiccup kill the live stream
    }
    for (let idx = emitted; idx < complete.length; idx++) {
      const parsed = WizardPlanCandidateSchema.safeParse(complete[idx]);
      // Hold (not skip) on a not-yet-valid candidate so emission stays strictly
      // in order — the final buffered validation is the backstop for it.
      if (!parsed.success) return;
      try {
        opts.onCandidate?.(idx, parsed.data);
      } catch (err) {
        logger.warn(
          { event: "stream_candidate_emit_threw", promptKey, idx, err },
          "onCandidate threw; continuing stream",
        );
      }
      emitted = idx + 1;
    }
  };

  // Accumulate text deltas ourselves. ⚠️ Bug-1 lesson: the SDK emits the
  // INCREMENTAL fragment as the delta arg (MessageStream.js), not the running
  // string — feeding the fragment to the scanner surfaces nothing. We keep the
  // rolling buffer and scan THAT. (Applies to `text` deltas exactly as it did
  // to the old `inputJson` deltas.)
  let acc = "";
  let lastProgressAt = 0;

  let finalMessage: Anthropic.Message;
  try {
    const stream = messages.stream({
      model,
      max_tokens: maxTokens,
      temperature,
      ...(prefix != null
        ? {
            system: [
              {
                type: "text" as const,
                text: prefix,
                cache_control: { type: "ephemeral" as const },
              },
            ],
          }
        : {}),
      messages: [{ role: "user", content: userContent }],
    });
    stream.on("text", (delta: string) => {
      acc += delta;
      tryEmit(acc);
      // Liveness signal on genuine data flow (throttled). Emitted even before
      // the first candidate completes, keeping the client watchdog alive across
      // the ~9s pre-first-card window without a timer.
      if (opts.onProgress) {
        const now = Date.now();
        if (now - lastProgressAt >= PROGRESS_THROTTLE_MS) {
          lastProgressAt = now;
          try {
            opts.onProgress({ bytes: acc.length });
          } catch (err) {
            logger.warn(
              { event: "stream_progress_emit_threw", promptKey, err },
              "onProgress threw; continuing stream",
            );
          }
        }
      }
    });
    finalMessage = await stream.finalMessage();
  } catch (err) {
    const latencyMs = Date.now() - start;
    logger.error(
      { event: "ai_call_stream", promptKey, model, err },
      "AI stream call failed",
    );
    await writeStreamLog(prisma, {
      promptKey,
      promptVersion,
      model,
      mode: "text",
      userId,
      latencyMs,
      inputTokens: 0,
      outputTokens: 0,
      costEstimateUsd: 0,
      retryCount: 0,
      success: false,
      failureReason: "sdk_error",
    });
    return fail(promptKey, promptVersion, model, latencyMs, "sdk_error");
  }

  const inputTokens = finalMessage.usage.input_tokens;
  const outputTokens = finalMessage.usage.output_tokens;
  const cacheReadInputTokens = finalMessage.usage.cache_read_input_tokens ?? 0;
  const cacheCreationInputTokens =
    finalMessage.usage.cache_creation_input_tokens ?? 0;
  const costEstimateUsd = estimateCacheAwareCostUsdFromRate(rate, {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
  });
  const latencyMs = Date.now() - start;

  const extracted = extractPayload(finalMessage, "text");
  const parsed = extracted.ok
    ? WizardPlanCandidatesResultSchema.safeParse(extracted.value)
    : null;

  if (!parsed || !parsed.success) {
    logger.warn(
      {
        event: "ai_call_stream",
        success: false,
        reason: "validation_failed",
        promptKey,
        model,
        latencyMs,
        inputTokens,
        outputTokens,
      },
      "AI stream call failed schema validation",
    );
    await writeStreamLog(prisma, {
      promptKey,
      promptVersion,
      model,
      mode: "text",
      userId,
      latencyMs,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      costEstimateUsd,
      retryCount: 0,
      success: false,
      failureReason: "validation_failed",
    });
    return fail(
      promptKey,
      promptVersion,
      model,
      latencyMs,
      "validation_failed",
      { inputTokens, outputTokens },
    );
  }

  const metadata: AICallMetadata = {
    promptKey,
    promptVersion,
    model,
    mode: "text",
    latencyMs,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    costEstimateUsd,
    retryCount: 0,
  };
  logger.info(
    { event: "ai_call_stream", success: true, ...metadata, emitted },
    "AI stream call succeeded",
  );
  await writeStreamLog(prisma, {
    promptKey,
    promptVersion,
    model,
    mode: "text",
    userId,
    latencyMs,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    costEstimateUsd,
    retryCount: 0,
    success: true,
    failureReason: null,
  });
  return { success: true, data: parsed.data, metadata };
}

// ── helpers ──────────────────────────────────────────────────────────────

function fail(
  promptKey: string,
  promptVersion: number | null,
  model: string,
  latencyMs: number,
  reason: "no_api_key" | "sdk_error" | "validation_failed",
  tokens?: { inputTokens: number; outputTokens: number },
): AICallResult<WizardPlanCandidatesResult> {
  return {
    success: false,
    reason,
    userFacingMessage: userFacingMessage(reason),
    metadata: {
      promptKey,
      promptVersion,
      model,
      mode: "text",
      latencyMs,
      inputTokens: tokens?.inputTokens ?? 0,
      outputTokens: tokens?.outputTokens ?? 0,
      retryCount: 0,
    },
  };
}

// Mirror of runAICall's writeLogSafely — a failed log write must never change
// the call's result. Kept local so runAICall.ts stays untouched.
async function writeStreamLog(
  prisma: PrismaLike | null,
  data: LLMCallLogCreateData,
): Promise<void> {
  if (!prisma) return;
  try {
    await prisma.lLMCallLog.create({ data });
  } catch (err) {
    logger.error(
      { event: "llm_call_log_write", err, promptKey: data.promptKey },
      "LLMCallLog write failed (stream) — call result preserved",
    );
  }
}

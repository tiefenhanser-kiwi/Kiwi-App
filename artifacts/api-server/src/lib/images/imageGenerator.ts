// Row 5 · Block 1 (D-WS9-246 step 3) — AI-created meal image, only when the
// judge accepted nothing. Vendor: OpenAI `gpt-image-1-mini` (⚠️ NOT
// `gpt-image-1`, which deprecates October 23, 2026). One fixed house prompt —
// a single plated dish, natural light, three-quarter angle, no text, no
// hands, no branding — receiving the meal title plus its dish list.
//
// Called over plain HTTPS (POST /v1/images/generations) through the injected
// fetch; no OpenAI SDK, so the network seam is the same one every other
// provider in this folder uses.
//
// 🔴 SPEND VISIBILITY. This is not an Anthropic call, so runAICall never sees
// it. It is wired into the same two mechanisms by hand:
//   1. checkSpendGuard() runs BEFORE the request with promptKey
//      `images.generate` — kill switch, global daily ceiling, per-user cap,
//      exactly as runAICall does. A refusal writes no row (same rule).
//   2. An LLMCallLog row is written AFTER the request with mode `image`
//      (the enum value the Block 1 migration adds), the model, the token
//      usage OpenAI reports, and costEstimateUsd from the model-rate table
//      (`ai.model_rate.gpt-image-1-mini.*`, seeded in systemSettings.ts).
//      The ceiling's SUM(costEstimateUsd) therefore includes generations.
// ⚠️ The ceiling counts `userId IS NOT NULL` rows only (BUG-262 — batch
// runs are outside it by ruling). A null-userId backfill is bounded by its
// OWN hard cap in the script, not by this guard. See the Block 1 report.

import { getModelRate, type PrismaLike } from "../ai/promptRegistry";
import { logger } from "../logger";
import { checkSpendGuard, type SpendGuardReason } from "../spendGuard";
import type { ImageFetch, MealImageSubject } from "./types";

export const IMAGES_GENERATE_KEY = "images.generate";
export const IMAGE_GEN_MODEL = "gpt-image-1-mini";
export const IMAGE_GEN_SIZE = "1024x1024";
export const IMAGE_GEN_QUALITY = "medium";
const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";
const GENERATE_TIMEOUT_MS = 90_000;

// The house prompt. Fixed wording; only the subject line varies.
export function buildHousePrompt(subject: MealImageSubject): string {
  const dishes = subject.dishTitles.filter(Boolean);
  const subjectLine =
    dishes.length > 0
      ? `${subject.title} — a plate of ${dishes.join(", ")}`
      : subject.title;
  return [
    `Professional food photograph of ${subjectLine}.`,
    "A single plated serving on a simple ceramic plate, on a neutral wooden or linen table.",
    "Natural daylight from a window, soft shadows, three-quarter angle from slightly above, shallow depth of field.",
    "Realistic, appetising, home-cooked. No text, no labels, no watermarks, no hands, no people, no logos, no branding, no packaging, no cutlery in motion.",
  ].join(" ");
}

export interface ImageGeneratorDeps {
  fetch: ImageFetch;
  apiKey: string;
  prisma?: PrismaLike;
  userId?: string;
  model?: string;
  timeoutMs?: number;
}

export interface ImageGenerationUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ImageGenerationResult =
  | {
      ok: true;
      bytes: Buffer;
      contentType: "image/jpeg";
      model: string;
      usage: ImageGenerationUsage;
      costEstimateUsd: number;
      latencyMs: number;
    }
  | {
      ok: false;
      reason: SpendGuardReason | "no_api_key" | "http_error" | "bad_response" | "network_error";
      detail?: string;
      costEstimateUsd: number;
      latencyMs: number;
    };

interface OpenAIImageResponse {
  data?: Array<{ b64_json?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  error?: { message?: string; type?: string };
}

export async function generateMealImage(
  subject: MealImageSubject,
  deps: ImageGeneratorDeps,
): Promise<ImageGenerationResult> {
  const start = Date.now();
  const model = deps.model ?? IMAGE_GEN_MODEL;
  const prisma = deps.prisma ?? null;
  const userId = deps.userId ?? null;

  if (!deps.apiKey) {
    return { ok: false, reason: "no_api_key", costEstimateUsd: 0, latencyMs: 0 };
  }

  // 1. Spend guard — same three checks, same order, same no-row-on-refusal
  //    rule as runAICall.
  const guard = await checkSpendGuard({ prisma, userId, promptKey: IMAGES_GENERATE_KEY });
  if (guard.refused) {
    return { ok: false, reason: guard.reason, costEstimateUsd: 0, latencyMs: Date.now() - start };
  }

  const rate = await getModelRate(model, prisma);
  const prompt = buildHousePrompt(subject);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? GENERATE_TIMEOUT_MS);
  let res;
  try {
    res = await deps.fetch(OPENAI_IMAGES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size: IMAGE_GEN_SIZE,
        quality: IMAGE_GEN_QUALITY,
        output_format: "jpeg",
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const latencyMs = Date.now() - start;
    const detail = err instanceof Error ? err.message : String(err);
    await writeImageLog(prisma, { model, userId, latencyMs, usage: { inputTokens: 0, outputTokens: 0 }, cost: 0, success: false, failureReason: "network_error" });
    return { ok: false, reason: "network_error", detail, costEstimateUsd: 0, latencyMs };
  }
  clearTimeout(timer);

  let body: OpenAIImageResponse;
  try {
    body = (await res.json()) as OpenAIImageResponse;
  } catch {
    body = {};
  }
  const usage: ImageGenerationUsage = {
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
  };
  const cost =
    (usage.inputTokens / 1_000_000) * rate.inputPerMtokUsd +
    (usage.outputTokens / 1_000_000) * rate.outputPerMtokUsd;
  const latencyMs = Date.now() - start;

  if (!res.ok) {
    const detail = body.error?.message ?? `HTTP ${res.status}`;
    await writeImageLog(prisma, { model, userId, latencyMs, usage, cost, success: false, failureReason: `http_${res.status}` });
    return { ok: false, reason: "http_error", detail, costEstimateUsd: cost, latencyMs };
  }
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) {
    await writeImageLog(prisma, { model, userId, latencyMs, usage, cost, success: false, failureReason: "bad_response" });
    return { ok: false, reason: "bad_response", detail: "no b64_json in response", costEstimateUsd: cost, latencyMs };
  }

  // 2. The ledger row the ceiling sums.
  await writeImageLog(prisma, { model, userId, latencyMs, usage, cost, success: true, failureReason: null });

  return {
    ok: true,
    bytes: Buffer.from(b64, "base64"),
    contentType: "image/jpeg",
    model,
    usage,
    costEstimateUsd: cost,
    latencyMs,
  };
}

// Mirrors runAICall's writeLogSafely: a failed write never changes the result.
async function writeImageLog(
  prisma: PrismaLike | null,
  row: {
    model: string;
    userId: string | null;
    latencyMs: number;
    usage: ImageGenerationUsage;
    cost: number;
    success: boolean;
    failureReason: string | null;
  },
): Promise<void> {
  if (!prisma) return;
  try {
    await prisma.lLMCallLog.create({
      data: {
        promptKey: IMAGES_GENERATE_KEY,
        promptVersion: null,
        model: row.model,
        mode: "image",
        userId: row.userId,
        latencyMs: row.latencyMs,
        inputTokens: row.usage.inputTokens,
        outputTokens: row.usage.outputTokens,
        costEstimateUsd: row.cost,
        retryCount: 0,
        success: row.success,
        failureReason: row.failureReason,
      },
    });
  } catch (err) {
    logger.error(
      { event: "llm_call_log_write", err, promptKey: IMAGES_GENERATE_KEY },
      "LLMCallLog write failed — image result preserved",
    );
  }
}

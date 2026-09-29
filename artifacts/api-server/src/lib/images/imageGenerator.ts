// Row 5 · Block 1 (D-WS9-246 step 3) — AI-created meal image, only when the
// judge accepted nothing. Vendor: OpenAI `gpt-image-1-mini`. One fixed house
// prompt — a single plated dish, natural light, three-quarter angle, no text,
// no hands, no branding — receiving the meal title plus its dish list.
//
// 🔴 MIGRATION OWED, BY DECEMBER 1, 2026 (BUG-332 Part A, verified against
// OpenAI's deprecations page on 2026-09-29). The comment that used to sit here
// said `gpt-image-1` deprecates October 23, 2026 and implied the mini was the
// safe choice. Both halves were wrong: OpenAI announced `gpt-image-1` AND
// `gpt-image-1-mini` on June 2, 2026 with a SHUTDOWN of December 1, 2026, and
// the named replacements are `gpt-image-2.5-sunburst` / `gpt-image-2.5-flare`.
// D-WS9-288 deliberately does NOT change the model here — a model swap re-opens
// the house prompt's calibration and the per-image cost, and is its own block.
// It is owed before December 1, 2026.
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

// BUG-332 / D-WS9-288 part 1 — the product-word clean-up.
//
// A product word says how a dish was BOUGHT, never how it is served. "Frozen
// Cheese Pizza" is a baked cheese pizza; "Near East Rice Pilaf Mix" is a rice
// pilaf. The old subject line handed the raw title to the model, so the
// packaging words won against the "no packaging" clause further down — the
// subject beat the constraint, which is why the fix is two halves and not one
// more "no".
//
// 🔴 DERIVED, NEVER STORED. This rewrites the SUBJECT LINE the model is shown
// and nothing else. `Meal.title` is the user's own text and stays exactly as
// typed everywhere — the card, the plan, the grocery list, the Cookbook. Same
// rule BUG-174/176 settled for units: derive, do not rewrite the stored value.
//
// Brand names are unbounded — there is no list of them — so they are NOT
// handled here. That is the prompt sentence's job, and it is the half that
// generalises.
//
// Placement: inside buildHousePrompt because that is the only place a subject
// line is composed, and both callers reach it — the drain (imageQueue.ts →
// imagePipeline.ts) and Block 1b's catalog script (scripts/ws9-row5/generate.ts).
const LEADING_PRODUCT_WORDS = [
  // Longest-first within a family: "store bought" must be tried before a bare
  // word could strand the second half.
  "store-bought",
  "store bought",
  "storebought",
  "pre-made",
  "premade",
  "pre made",
  "ready-made",
  "readymade",
  "ready made",
  "pre-packaged",
  "prepackaged",
  "packaged",
  "frozen",
  "boxed",
  "bagged",
  "canned",
  "tinned",
  "jarred",
  "instant",
];
// …except where the word IS the dish. A frozen yogurt is frozen on the plate.
const FROZEN_KEEP =
  /^(yogurt|yoghurt|custard|margarita|daiquiri|lemonade|smoothie|hot chocolate)\b/i;
// …and "Instant Pot" is an appliance, not a product state.
const INSTANT_KEEP = /^pot\b/i;
// Trailing product nouns: "Rice Pilaf Mix", "Taco Kit". One only.
const TRAILING_PRODUCT_WORDS = ["mix", "kit"];

/** One segment of a title — a single dish name. Exported for the tests. */
export function cleanSubjectText(raw: string): string {
  let s = raw.trim();
  // Repeat: "frozen boxed pizza" carries two.
  let changed = true;
  while (changed) {
    changed = false;
    for (const w of LEADING_PRODUCT_WORDS) {
      const m = new RegExp(`^${w}\\s+`, "i").exec(s);
      if (!m) continue;
      const rest = s.slice(m[0].length);
      if (w === "frozen" && FROZEN_KEEP.test(rest)) continue;
      if (w === "instant" && INSTANT_KEEP.test(rest)) continue;
      s = rest;
      changed = true;
      break;
    }
  }
  for (const w of TRAILING_PRODUCT_WORDS) {
    const re = new RegExp(`\\s+${w}$`, "i");
    if (re.test(s) && s.replace(re, "").trim().length > 0) {
      s = s.replace(re, "").trim();
      break;
    }
  }
  // A title that is nothing BUT a product word keeps its original text — an
  // empty subject line would be worse than a literal one.
  return s.length > 0 ? s : raw.trim();
}

/**
 * A meal title is a sentence of dish names joined by "with" / "and" / ",", so
 * the clean-up runs per segment ("Grilled Chicken with Frozen Fries" →
 * "Grilled Chicken with Fries"), not only on the head of the string.
 * Exported for the tests.
 */
export function cleanSubjectTitle(raw: string): string {
  return raw
    .split(/(\s+(?:with|and|,)\s+)/i)
    .map((part, i) => (i % 2 === 0 ? cleanSubjectText(part) : part))
    .join("");
}

// The house prompt. Fixed wording; only the subject line varies.
export function buildHousePrompt(subject: MealImageSubject): string {
  // BUG-332 / D-WS9-288 — the subject the MODEL sees, not the title the USER
  // sees. See cleanSubjectText above: derived here, never written back.
  const title = cleanSubjectTitle(subject.title);
  const dishes = subject.dishTitles.filter(Boolean).map(cleanSubjectTitle);
  const subjectLine =
    dishes.length > 0 ? `${title} — a plate of ${dishes.join(", ")}` : title;
  return [
    `Professional food photograph of ${subjectLine}.`,
    "A single plated serving on a simple ceramic plate, on a neutral wooden or linen table.",
    "Natural daylight from a window, soft shadows, three-quarter angle from slightly above, shallow depth of field.",
    // BUG-332 / D-WS9-288 part 2 — the rule, stated positively. The "no
    // packaging" clause below is a NEGATIVE constraint and the raw subject was
    // overriding it; this says what the picture IS, and says out loud what a
    // brand name in a title actually means.
    "Always the finished dish as a home cook would serve it at the table: cooked through, plated and ready to eat. A brand name or product word in the name says only WHAT KIND of dish this is, never how it is shown — show no packaging, box, bag, can, jar, wrapper or frozen or raw food, and do not copy any real brand's product; an ordinary home-cooked version of the dish is what is wanted.",
    // D-WS9-288 ruling 1b — portion and scale. Two live Cookbook pages showed
    // a whole roast chicken shrunk onto a dinner plate: "either a really big
    // side or a really small bird". The model will size a whole item to the
    // plate rather than carve it, so the carve has to be asked for.
    "The plate holds ONE person's serving at true, life-size scale beside its sides, so a whole bird, whole roast, whole fish, rack, ham, turkey or loaf is shown CARVED — a portion on the plate, such as a leg and thigh or a few slices — and never the whole item shrunk down to fit the plate.",
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

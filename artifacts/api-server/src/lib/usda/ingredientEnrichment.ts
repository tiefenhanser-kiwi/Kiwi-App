// WS7-8b USDA Block 1 — post-create ingredient nutrition enrichment.
//
// Locked design (Hans, July 5):
//   4. Post-create, FIRE-AND-FORGET. resolveIngredients stays untouched and
//      instant; this fills Ingredient.nutritionRefPerUnit async AFTER mint. A
//      USDA outage degrades to today's behavior and can NEVER block/slow a save.
//   3. Reactive with guardrails: search (Foundation/SR Legacy) → auto-accept
//      the best match ONLY when a conservative name-match passes; doubtful = miss.
//   5. On a definitive miss: write a miss-marker so the hot path doesn't
//      re-search. NO per-ingredient AI nutrition call, NO user-facing flag.
//      The quarterly-refresh script (Block 2) retries misses later.
//   2. Storage is per-100g, USDA-native, in the existing nutritionRefPerUnit
//      JSON column. No migration, no new columns.
//   6. USDA foodCategory is metadata only — stored in the JSON, NEVER used for
//      inferCategory or the category column.
//
// On transport/rate-limit failure we write NOTHING (row stays null → retried
// naturally on the next resolve).

import type { Prisma, PrismaClient } from "@prisma/client";

import { logger } from "../logger";
import {
  extractPer100gMacros,
  foodCategoryLabel,
  isUsdaEnabled,
  searchFoods,
  type FdcFood,
  type Per100gMacros,
} from "./fdcClient";

// ── persisted JSON shapes (written to Ingredient.nutritionRefPerUnit) ─────

export interface NutritionRefMatched {
  basis: "per100g";
  per100g: Per100gMacros;
  source: "usda";
  fdcId: number;
  dataType: string | null;
  foodCategory: string | null;
  fetchedAt: string; // ISO-8601
}

export interface NutritionRefMiss {
  source: "usda";
  matched: false;
  fetchedAt: string; // ISO-8601
}

export type NutritionRef = NutritionRefMatched | NutritionRefMiss;

/**
 * Build the matched per-100g record written to nutritionRefPerUnit. Single
 * source of truth for the shape — shared by reactive enrichment (enrichOne)
 * and the Block 2 backfill script so the two paths can never drift.
 */
export function buildMatchedRef(
  food: FdcFood,
  per100g: Per100gMacros,
  fetchedAt: string,
): NutritionRefMatched {
  return {
    basis: "per100g",
    per100g,
    source: "usda",
    fdcId: food.fdcId,
    dataType: food.dataType ?? null,
    foodCategory: foodCategoryLabel(food),
    fetchedAt,
  };
}

/**
 * Build the miss-marker written when a search returns but nothing passes the
 * guardrail. Shared shape (see buildMatchedRef).
 */
export function buildMissMarker(fetchedAt: string): NutritionRefMiss {
  return { source: "usda", matched: false, fetchedAt };
}

/**
 * True when the stored ref carries usable per-100g macro grounding. Miss
 * markers and nulls return false. Used by the estimator-grounding thread.
 */
export function isMatchedRef(value: unknown): value is NutritionRefMatched {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.source === "usda" &&
    v.matched !== false &&
    v.basis === "per100g" &&
    typeof v.per100g === "object" &&
    v.per100g !== null
  );
}

// ── name-match guardrail ──────────────────────────────────────────────────
// Conservative containment test: after normalizing both names to token sets,
// EVERY content token of the Kiwi ingredient must appear in the USDA
// description's token set. This rejects near-neighbors that share only a head
// noun — e.g. "chicken breast" must NOT accept "chicken bouillon cube"
// (the token "breast" is absent). When in doubt, MISS (correctness over
// coverage; the quarterly refresh revisits misses).
//
// This is a JUDGMENT CALL surfaced for Hans's review (Phase 3).

// Prep/marketing adjectives that carry no discriminating meaning for a
// generic USDA food and would otherwise force spurious misses. Deliberately
// SMALL — words that change the food identity (ground, smoked, roasted, …)
// are NOT stripped.
const FILLER_TOKENS = new Set([
  "fresh",
  "raw",
  "organic",
  "large",
  "small",
  "medium",
  "ripe",
  "whole",
]);

// Structural stopwords common in USDA descriptions ("Chicken, broilers or
// fryers, …"). Stripping these from BOTH sides keeps containment meaningful.
const STOPWORDS = new Set(["and", "or", "with", "in", "of", "the", "a", "for"]);

// Very small singularizer — enough for kitchen plurals (onions→onion,
// tomatoes→tomato, berries→berry). Mirrors the intent of the categorizer's
// consonant+y rule but only needs to canonicalize, not match.
function singularize(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (/(ses|xes|zes|ches|shes|oes)$/.test(token)) return token.slice(0, -2);
  if (token.endsWith("ss")) return token; // glass, watercress
  if (token.endsWith("s")) return token.slice(0, -1);
  return token;
}

// Lowercase, split on any non-letter, drop stopwords/fillers/short tokens,
// singularize. Returns a Set of content tokens.
export function tokenizeForMatch(name: string): Set<string> {
  const tokens = name
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 2)
    .filter((t) => !STOPWORDS.has(t) && !FILLER_TOKENS.has(t))
    .map(singularize)
    .filter((t) => t.length >= 2);
  return new Set(tokens);
}

/**
 * Conservative name-match: true when every content token of the Kiwi name is
 * present in the USDA description's token set (and the Kiwi name yielded at
 * least one content token). Auto-accept only on true.
 */
// ── CATALOG CONVENTION (Hans, ratified during BUG-096; D-WS9-178) ───────────
// MACROS DESCRIBE THE INGREDIENT AS PURCHASED.
//
// Quantities are as-purchased, and "cooked"/"baked"/"fried" is a PREPARATION
// NOTE on the step, never a different ingredient. So when two USDA records
// both plausibly describe a catalog row, the RAW / unprepared one wins:
//   russet potatoes -> 170027 "flesh and skin, RAW", not 170030 "... BAKED"
//   yellow potatoes -> 170026 "flesh and skin, raw", not 169764 "FRENCH FRIED"
//
// This is written down because BUG-032's wrong-food class came from a matcher
// INFERRING a convention instead of being handed one, and BUG-122 re-judges
// ~75-80 unaudited rows against exactly this question. The rule is not encoded
// in code below — it is a curation rule for whoever picks between candidates.
export function nameMatches(kiwiName: string, usdaDescription: string): boolean {
  const kiwiTokens = tokenizeForMatch(kiwiName);
  if (kiwiTokens.size === 0) return false;
  const usdaTokens = tokenizeForMatch(usdaDescription);
  for (const t of kiwiTokens) {
    if (!usdaTokens.has(t)) return false;
  }
  return true;
}

/**
 * Pick the best auto-acceptable match from a search result list. Iterates in
 * FDC rank order and returns the first food that (a) passes the name guardrail
 * and (b) yields a complete per-100g macro set. Returns null when nothing
 * qualifies (→ definitive miss).
 */
export function selectMatch(
  kiwiName: string,
  foods: FdcFood[],
): { food: FdcFood; per100g: Per100gMacros } | null {
  for (const food of foods) {
    if (!food.description || !nameMatches(kiwiName, food.description)) continue;
    const per100g = extractPer100gMacros(food);
    if (per100g) return { food, per100g };
  }
  return null;
}

// ── enrichment orchestration ──────────────────────────────────────────────

export interface EnrichIngredientTarget {
  id: string;
  canonicalName: string;
}

const DEFAULT_CONCURRENCY = 5;

/**
 * Enrich a batch of ingredient rows (each currently null nutritionRefPerUnit).
 * For each: search USDA, apply the guardrail, and write a matched record OR a
 * miss-marker — or, on transport failure, write nothing. Bounded concurrency.
 *
 * NEVER throws: a per-ingredient failure is logged and swallowed so a rejecting
 * enrichment can never surface into the fire-and-forget caller. Returns a small
 * summary for tests/telemetry.
 */
export async function enrichIngredients(
  prisma: Pick<PrismaClient, "ingredient">,
  targets: EnrichIngredientTarget[],
  opts: { concurrency?: number; now?: () => Date } = {},
): Promise<{ matched: number; missed: number; skipped: number; failed: number }> {
  const summary = { matched: 0, missed: 0, skipped: 0, failed: 0 };
  if (targets.length === 0) return summary;
  if (!isUsdaEnabled()) {
    // Disabled: no key. No-op silently (rows stay null, retried when a key
    // is configured). Counted as skipped for telemetry.
    summary.skipped = targets.length;
    return summary;
  }

  const nowFn = opts.now ?? (() => new Date());
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);

  // Simple worker-pool over the target list.
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const idx = cursor++;
      if (idx >= targets.length) return;
      const target = targets[idx];
      try {
        await enrichOne(prisma, target, nowFn, summary);
      } catch (err) {
        summary.failed++;
        logger.warn(
          { event: "usda_enrich_error", ingredientId: target.id, err },
          "USDA enrichment errored for ingredient",
        );
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, targets.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return summary;
}

async function enrichOne(
  prisma: Pick<PrismaClient, "ingredient">,
  target: EnrichIngredientTarget,
  nowFn: () => Date,
  summary: { matched: number; missed: number; skipped: number; failed: number },
): Promise<void> {
  const search = await searchFoods(target.canonicalName);
  if (!search.ok) {
    // Transport / rate-limit / disabled → write NOTHING; stays null for a
    // natural retry on the next resolve.
    summary.failed++;
    return;
  }

  const fetchedAt = nowFn().toISOString();
  const picked = selectMatch(target.canonicalName, search.data);

  if (!picked) {
    // Definitive miss: search returned but nothing passed the guardrail.
    const miss = buildMissMarker(fetchedAt);
    await prisma.ingredient.update({
      where: { id: target.id },
      data: { nutritionRefPerUnit: miss as unknown as Prisma.InputJsonValue },
    });
    summary.missed++;
    return;
  }

  const record = buildMatchedRef(picked.food, picked.per100g, fetchedAt);
  await prisma.ingredient.update({
    where: { id: target.id },
    data: { nutritionRefPerUnit: record as unknown as Prisma.InputJsonValue },
  });
  summary.matched++;
}

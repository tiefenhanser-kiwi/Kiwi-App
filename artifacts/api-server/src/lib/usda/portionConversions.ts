// WS7-8b Block B2 — derive unit-conversion factors from USDA FDC foodPortions.
//
// The nutrition arc (Block 1/2) stored per-100g macros + fdcId but NEVER the
// portion table. This module re-reads a full FDC food record's `foodPortions`
// and CONSERVATIVELY derives:
//   - gramsPerCup  — from a portion the text identifies as a "cup"
//   - gramsPerEach — from a portion the text identifies as ONE whole item
//     ("1 medium", "1 large", "1 fruit", "1 each")
//
// Conservative by design (correctness over coverage, mirroring the USDA
// name-match guardrail): when a portion's intent is ambiguous we skip it rather
// than fabricate a factor. A row that yields neither factor is a derive-MISS,
// left for hand-curation or the runtime AI-fallback. All output is stamped
// source:'usda_derived' by the caller.

import type { FdcFood, FdcFoodPortion } from "./fdcClient";
import { tokenizeForMatch } from "./ingredientEnrichment";

export interface DerivedConversion {
  gramsPerCup?: number;
  gramsPerEach?: number;
}

// Form keywords that CHANGE an ingredient's density/mass identity. A USDA
// description carrying one of these that the ingredient name does NOT is a
// different food for conversion purposes (avocado≠avocado OIL, carrot≠carrot
// DEHYDRATED, buttermilk≠buttermilk DRIED, black beans≠black bean SOUP). The
// nutrition arc's name-match guardrail is too permissive here (a single-token
// name like "avocado" is a subset of "oil, avocado"), so conversions apply a
// STRICTER gate before trusting a derived factor. Correctness over coverage —
// a rejected row falls through to hand-curation or the AI-fallback.
const FORM_DISQUALIFIERS = new Set<string>([
  "oil",
  "dried",
  "dehydrated",
  "powder",
  "powdered",
  "juice",
  "soup",
  "croissant",
  "chip",
  "chips",
  "flake",
  "flakes",
]);

/**
 * Gate a USDA food as a trustworthy conversion source for `canonicalName`:
 *   1. Head-noun match — a content token of the ingredient must appear in the
 *      USDA description's FIRST comma-segment (its main food). Rejects
 *      "avocado" → "Oil, avocado" (first segment "Oil") and "apples" →
 *      "Croissants, apple".
 *   2. No form disqualifier the ingredient lacks — rejects "carrot" →
 *      "Carrot, dehydrated" and "buttermilk" → "Milk, buttermilk, dried".
 * Pure; reuses the nutrition arc's tokenizer so tokenization can't drift.
 */
export function usdaConversionUsable(
  canonicalName: string,
  description: string | undefined | null,
): boolean {
  if (!description) return false;
  const firstSegment = description.split(",")[0] ?? "";
  const nameTokens = tokenizeForMatch(canonicalName);
  if (nameTokens.size === 0) return false;
  const segTokens = tokenizeForMatch(firstSegment);

  let headMatch = false;
  for (const t of nameTokens) {
    if (segTokens.has(t)) {
      headMatch = true;
      break;
    }
  }
  if (!headMatch) return false;

  const descTokens = tokenizeForMatch(description);
  for (const f of FORM_DISQUALIFIERS) {
    if (descTokens.has(f) && !nameTokens.has(f)) return false;
  }
  return true;
}

// Full descriptive text for a portion — SR Legacy uses modifier /
// portionDescription; Foundation may use measureUnit.name.
function portionText(p: FdcFoodPortion): string {
  return [p.modifier, p.portionDescription, p.measureUnit?.name]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ")
    .toLowerCase();
}

// A usable portion has a positive gramWeight and a positive amount to divide by
// (amount defaults to 1 when absent, matching FDC's common "1 cup" rows).
function gramsPerUnit(p: FdcFoodPortion): number | null {
  const g = p.gramWeight;
  if (typeof g !== "number" || !(g > 0)) return null;
  const amount = typeof p.amount === "number" && p.amount > 0 ? p.amount : 1;
  return g / amount;
}

// "cup" as a whole word, excluding compound cups (e.g. "cupcake"). We also
// reject fractional-cup rows we can't trust (the amount already normalizes, so
// "0.25 cup" → per-cup is fine; this just gates the word match).
function isCupPortion(text: string): boolean {
  return /\bcups?\b/.test(text);
}

// Whole-item descriptors, in preference order. "medium" is the canonical
// grocery default; large/small are second-best; the generic each/fruit/whole
// forms are the last resort. Ordered so a food with several count portions
// yields the most representative one.
const EACH_DESCRIPTORS = [
  "medium",
  "large",
  "small",
  "each",
  "fruit",
  "whole",
];

function eachRank(text: string): number {
  for (let i = 0; i < EACH_DESCRIPTORS.length; i++) {
    // Word-boundary match so "largely" / "smallish" don't false-positive.
    const re = new RegExp(`\\b${EACH_DESCRIPTORS[i]}\\b`);
    if (re.test(text)) return i;
  }
  return -1;
}

// WS7-8b B2 — per-ingredient derive denylist (Hans rulings A–D, July 11).
// The USDA guardrail catches FORM keywords, but some bad joins share every
// token with a DIFFERENT food (wrong organ / wrong state) and slip through:
//   • whole-row "miss"  → the derived food is a different food OR a state that
//     misrepresents the recipe's need (cooked grain ≈ water weight; a recipe's
//     "1 cup rice" means DRY, owned by curated). Drops all factors.
//   • { drop: [...] }   → the food is right but ONE derived factor is wrong
//     (pearl onion's gramsPerEach came from generic onions, ~2× high; its
//     gramsPerCup is fine).
// A code fix (unlike a CSV edit) survives every dry-run regeneration.
export type DeriveDenyRule = "miss" | { drop: Array<keyof DerivedConversion> };

export const DERIVE_DENYLIST: Record<string, DeriveDenyRule> = {
  // A — wrong food (token match, different food)
  "chicken broth": "miss", // [Chicken, canned, no broth] — canned chicken meat
  "lime zest": "miss", // [Limes, raw] — a whole lime; zest is ~2–4 g
  "sweet potato": "miss", // [Sweet potato leaves, raw] — wrong organ
  "frozen peas": "miss", // [Peas and carrots] — mixed vegetable
  // B — cooked grains (USDA cooked density = water weight; curated owns grains)
  "long grain white rice": "miss",
  "long-grain white rice": "miss",
  quinoa: "miss",
  "wild rice": "miss",
  // C — flaky sea salt (table-salt density overstates flakes; curated salt=273)
  "flaky sea salt": "miss",
  // D — pearl onion: keep cup, drop the ~2×-high each
  "pearl onion": { drop: ["gramsPerEach"] },
};

/** True when the canonical name is a WHOLE-ROW derive miss (for note-labeling). */
export function isDeriveDenied(canonicalName: string): boolean {
  return DERIVE_DENYLIST[canonicalName.toLowerCase().trim()] === "miss";
}

/**
 * Apply the derive denylist to a derived result. Whole-row "miss" → empty;
 * field-drop → strip the named factors; no rule → unchanged. Pure.
 */
export function applyDeriveDenylist(
  canonicalName: string,
  derived: DerivedConversion,
): DerivedConversion {
  const rule = DERIVE_DENYLIST[canonicalName.toLowerCase().trim()];
  if (!rule) return derived;
  if (rule === "miss") return {};
  const out = { ...derived };
  for (const f of rule.drop) delete out[f];
  return out;
}

/**
 * Derive gramsPerCup + gramsPerEach from an FDC food's foodPortions. Returns an
 * object with only the factors it could determine (possibly empty). Pure — no
 * network, no DB.
 */
export function deriveConversionFromPortions(food: FdcFood): DerivedConversion {
  const portions = food.foodPortions ?? [];
  const out: DerivedConversion = {};

  // gramsPerCup — first trustworthy cup portion wins.
  for (const p of portions) {
    const text = portionText(p);
    if (!isCupPortion(text)) continue;
    const gpu = gramsPerUnit(p);
    if (gpu !== null) {
      out.gramsPerCup = round2(gpu);
      break;
    }
  }

  // gramsPerEach — pick the highest-preference whole-item portion.
  let bestRank = Number.POSITIVE_INFINITY;
  let bestGrams: number | null = null;
  for (const p of portions) {
    const text = portionText(p);
    // A cup portion is not an "each"; skip so "1 cup" never becomes gramsPerEach.
    if (isCupPortion(text)) continue;
    const rank = eachRank(text);
    if (rank === -1) continue;
    const gpu = gramsPerUnit(p);
    if (gpu === null) continue;
    if (rank < bestRank) {
      bestRank = rank;
      bestGrams = gpu;
    }
  }
  if (bestGrams !== null) out.gramsPerEach = round2(bestGrams);

  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

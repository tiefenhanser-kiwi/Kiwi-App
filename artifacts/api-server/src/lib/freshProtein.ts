// ── D-WS9-292 — FRESH MEAT, POULTRY AND SEAFOOD ARE BOUGHT BY WEIGHT ────────
//
// Hans, September 30 2026, verbatim: "getting 4 lbs of boneless skinless
// chicken breasts when I only need 2.5 and 3 lbs thighs when I need 1.75 of
// that is wrong. And thighs are sold in packs smaller than 3lbs … for meat,
// order the quantity needed."
//
// THE RULE. A fresh meat / poultry / seafood row whose summed need resolves to
// a WEIGHT buys that weight, rounded UP to the next ¼ lb, and the line reads as
// a weight with no pack word:
//
//     4 lb pack boneless skinless chicken breasts (2½ pound)
//  →  2½ lb boneless skinless chicken breasts (2½ pound)
//
// ⚠️ ROUNDED UP, NEVER DOWN. R2 stands: a shopper who cannot cook is the worse
// failure, so the quarter-pound ladder only ever ceils. It is a ¼ lb and not an
// ⅛ because a counter scale and a pre-packed tray both work in quarters, and
// because the NEED parenthetical keeps the exact figure either way — this
// number answers "what do I ask for", not "how much does the recipe want".
//
// ⚠️ THE STORED CATALOG PACK IS NOT REWRITTEN. D-WS9-292 says the pack stops
// being USED for this class, not that it is wrong for every other purpose. No
// `Ingredient` row is written by this rule; `resolvePurchaseFields` simply
// stops consulting the pack for a row this module classifies `by_weight`.
//
// THREE EXCEPTIONS, each keeping today's behaviour exactly:
//
//   1. FIXED PACKAGE — meats sold only in a fixed package. You cannot ask a
//      counter for 0.4 lb of bacon. The list is the RULED list (go-ahead of
//      September 30), not the corpus: it carries every class Hans named whether
//      or not a row exists for it today, because the cost of a missing keyword
//      is a real defect and the cost of an unused one is nothing.
//   2. WHOLE ITEM — bought by the bird, not by the pound.
//   3. A COUNT NEED — see below; this one was AMENDED.
//
// ── 🔴 EXCEPTION 3 WAS AMENDED, AND THE AMENDMENT IS THE INTERESTING HALF ────
//
// The first draft read "a count need stays a count". Hans corrected it before
// the block ran: "a chicken breast is probably 1/2 lb on average, so 4 breasts
// = 2 lbs". So a COUNT need of a fresh cut CONVERTS: pieces × a typical piece
// weight, summed with any weight need for the same food, then ceiled to the ¼.
//
// ⚠️ A PIECE WEIGHT IS SOURCED OR IT DOES NOT EXIST. Every entry in
// PIECE_WEIGHT_LB below names where its number came from, and a cut with no
// defensible source STAYS A COUNT rather than taking a plausible-looking guess
// — an invented piece weight is an invented shopping list. Two sources were
// measured on 2026-09-30 and a third was measured and REFUSED:
//
//   ✓ the catalog's own pack displays, where one string states a weight AND a
//     piece count: "2 lb pack (4 chops)" is half a pound a chop, authored by
//     the catalog rather than inferred by this lane. Six Protein rows carry
//     that shape; they agree on pork chops across four of them.
//   ✓ INGREDIENT_CONVERSIONS' curated `salmon fillets` row, "1.5 lb (4
//     fillets)", which is the same shape in the code table.
//   ✗ AUTHORED RECIPE PROSE — measured across 1,780 ingredients, 43,841
//     dish-ingredient notes and 30,359 steps, and it yields nothing usable. The
//     extractor's hits are almost entirely a glyph split: "Cut 1½ pounds
//     chicken thighs" parses as a count of 1 and a weight of ½ lb, reporting a
//     half-pound "piece" that no author wrote. Exactly one genuine hit survives
//     in the whole catalog ("4 tilapia fillets (about 6 oz each)"), which is
//     not a corpus. The sweep is kept in scripts/grocery-f/piece-weights-text.ts
//     so nobody re-runs it hoping for a different answer.
//
// `conversionRef.gramsPerEach` is consulted FIRST by the classifier and is not
// duplicated here: zero Protein rows carry one today, but that is the field
// this table is standing in for, and a catalog that gains one should win.
//
// ── "SUMMED WITH ANY WEIGHT NEED FOR THE SAME FOOD" — ALREADY TRUE, MEASURED ─
//
// The ruling asks the converted weight to be summed with any weight need for
// the same food. Nothing here does that, because nothing here has to: this
// module runs on a row that consolidation has ALREADY summed. A count need and
// a weight need for one food are two buckets only until `mergeConvertibleGroups`
// folds them, and measured on the f0 corpus there are **0 same-canonical,
// different-unit groups inside `meat_seafood` across all 20 plans** — the case
// does not arise. If one ever does and no conversion relates the pair, it
// renders as two by-weight lines for one food, which over-buys and never
// under-buys (R2) and is the same answer the list gives today.
//
// ⚠️ THE TEMPTING FIX WAS REFUSED. Registering these piece weights as
// `gramsPerEach` on INGREDIENT_CONVERSIONS would make count↔weight relatable and
// let the EXISTING merge do the sum with no new code — genuinely the better
// shape. It is not done here because `gramsPerEach` is also the MACRO path's
// quantity→grams grounding (ingredientConversions.ts's second consumer), so
// four new entries would silently re-ground every count-unit nutrition estimate
// for those cuts. That is a nutrition change wearing a grocery change's
// clothes, it is invisible to the grocery census, and it belongs to whoever
// measures the macro path. The table stays local and grocery-only.

import { canonicalUnitToken } from "./ingredientConversions";

/** Pounds per gram — the one constant this module needs. */
const G_PER_LB = 453.59237;

/** The ladder D-WS9-292 rounds a buy weight up to. A quarter pound. */
export const BUY_WEIGHT_STEP_LB = 0.25;

const QTY_EPSILON = 1e-9;

/** Weight unit → pounds. Canonical tokens only; canonicalUnitToken runs first. */
const WEIGHT_TO_LB: Record<string, number> = {
  lb: 1,
  oz: 1 / 16,
  g: 1 / G_PER_LB,
  kg: 1000 / G_PER_LB,
};

/** The need unit as pounds-per-unit, or null when it is not a weight at all. */
export function weightUnitToLb(unit: string): number | null {
  return WEIGHT_TO_LB[canonicalUnitToken(unit)] ?? null;
}

/** Count-ish need units — the spellings COUNT_UNITS holds, which is not exported. */
const COUNTISH = new Set(["each", "whole", "", "piece", "pieces", "count", "ct"]);

function isCountNeed(unit: string): boolean {
  return COUNTISH.has(unit.trim().toLowerCase());
}

// ── exception 1 — the RULED fixed-package list ──────────────────────────────
//
// Ruled September 30: carry every class the ruling names whether or not the
// corpus has a row for it, and ADD smoked salmon / lox (sold only in small
// fixed packs, which is the ruling's own test). Ham steak, corned beef and crab
// cakes were named and REFUSED — the first two are buyable by weight at a
// counter and crab cakes are not a fresh cut. Meatballs and fish sticks are
// frozen-section items and are out of this section entirely.
//
// Matched as substrings of the canonical + display name, lower-cased. A
// substring rather than a word boundary because "thick-cut bacon", "turkey
// bacon" and "applewood smoked bacon" must all hit `bacon`.
export const FIXED_PACKAGE_MEATS: readonly string[] = [
  "bacon",
  "sausage",
  "hot dog",
  "hotdog",
  "frankfurter",
  "bratwurst",
  "chorizo",
  "kielbasa",
  "andouille",
  "deli",
  "lunch meat",
  "luncheon meat",
  "pepperoni",
  "salami",
  "prosciutto",
  "pancetta",
  "capicola",
  "mortadella",
  "guanciale",
  // canned fish. `anchovy` is KEPT on the ruling of September 30: today's only
  // row is anchovy paste, whose need is a teaspoon and which exception 3 would
  // hold anyway — but an `anchovy fillets` row with a weight need is exactly
  // what this catches, and that row is one import away.
  "canned tuna",
  "canned salmon",
  "tuna in water",
  "tuna in oil",
  "anchovy",
  "anchovies",
  "sardine",
  "sardines",
  // ruled ADDITION — sold only in small fixed packs.
  "smoked salmon",
  "lox",
];

// ── exception 2 — bought by the whole item ─────────────────────────────────
//
// "Write `1 whole chicken` whatever weight the recipe names." Rotisserie
// chicken is here and its two catalog rows render two different lines today
// ("1 rotisserie chicken" and "1 whole rotisserie chicken (~2 lb)"). Ruled
// September 30: leave them. That is a duplicate-names question, not F1's.
export const WHOLE_ITEM_MEATS: readonly string[] = [
  "whole chicken",
  "rotisserie chicken",
  "whole turkey",
  "cornish hen",
  "cornish game hen",
  "whole ham",
  "spiral ham",
  "rack of ribs",
  "rack of lamb",
  "frenched rack",
  "whole duck",
  "whole fish",
];

// ── exception 3's piece weights ────────────────────────────────────────────
//
// Keyed on a substring of the name, longest match wins, so "boneless skinless
// chicken breasts" and "bone-in skin-on chicken breast" both reach `chicken
// breast`. EVERY ENTRY NAMES ITS SOURCE. Adding one without a source is the
// failure this table's docblock exists to prevent.
export const PIECE_WEIGHT_LB: readonly { match: string; lb: number; source: string }[] = [
  {
    match: "chicken breast",
    lb: 0.5,
    source: "Hans, 2026-09-30: \"a chicken breast is probably 1/2 lb on average, so 4 breasts = 2 lbs\"",
  },
  {
    match: "pork chop",
    lb: 0.5,
    source:
      "4 catalog pack displays agree — \"2 lb pack (4 chops)\" on bone-in center-cut, bone-in ~1 inch, and two bone-in rib-chop rows",
  },
  {
    match: "salmon fillet",
    lb: 0.375,
    source: "INGREDIENT_CONVERSIONS curated `salmon fillets`: \"1.5 lb (4 fillets)\"",
  },
  {
    match: "porterhouse steak",
    lb: 1,
    source: "catalog pack display \"2 lb pack (2 steaks, ~1.25 in thick)\"",
  },
];

/**
 * 🔴 CUTS DELIBERATELY ABSENT, AND THE ONE THAT MATTERS.
 *
 * `chicken thigh` is not here. It is the commonest count-need cut on the
 * corpus — three of the five count rows are `3 lb pack bone-in chicken thighs
 * (4 each)` — and NOTHING IN THE REPOSITORY STATES ITS PIECE WEIGHT: no
 * Protein row carries `gramsPerEach`, no catalog pack states a thigh count,
 * and the prose sweep returns only glyph splits. Picking a number here would be
 * inventing the one datum the whole rule rests on, so those rows keep today's
 * pack and are reported.
 *
 * The same is true of chicken drumsticks, chicken wings, ribeye / strip /
 * sirloin steaks, lamb chops and lamb shanks. Each needs one sourced figure to
 * join the table and nothing else.
 */
export const UNSOURCED_COUNT_CUTS: readonly string[] = [
  "chicken thigh",
  "chicken drumstick",
  "chicken wing",
  "ribeye steak",
  "strip steak",
  "sirloin steak",
  "lamb chop",
  "lamb shank",
];

function longestMatch<T extends { match: string }>(
  table: readonly T[],
  haystack: string,
): T | null {
  let best: T | null = null;
  for (const row of table) {
    if (haystack.includes(row.match) && (best === null || row.match.length > best.match.length)) {
      best = row;
    }
  }
  return best;
}

function firstKeyword(list: readonly string[], haystack: string): string | null {
  let best: string | null = null;
  for (const k of list) {
    if (haystack.includes(k) && (best === null || k.length > best.length)) best = k;
  }
  return best;
}

/** Round a buy weight UP to the next ¼ lb. Never down (R2). */
export function roundBuyWeightLb(lb: number): number {
  if (!(lb > 0)) return 0;
  return Math.ceil(lb / BUY_WEIGHT_STEP_LB - QTY_EPSILON) * BUY_WEIGHT_STEP_LB;
}

export type FreshProteinVerdict =
  /** D-WS9-292 applies: buy `buyLb` pounds, no pack word. */
  | { kind: "by_weight"; buyLb: number; needLb: number; via: "weight" | "count"; pieceLb?: number }
  /** Exception 1 — keep the stored pack. */
  | { kind: "fixed_package"; keyword: string }
  /** Exception 2 — keep the stored pack / count. */
  | { kind: "whole_item"; keyword: string }
  /** Exception 3, unsourced half — a count with no piece weight. Keep the pack. */
  | { kind: "count_unsourced"; cut: string | null }
  /** Not this rule's business at all. */
  | { kind: "not_fresh_protein" };

export interface FreshProteinInput {
  /** The consolidated row's store section. `meat_seafood` is the gate. */
  sectionKey: string;
  canonicalName: string;
  displayName: string;
  /** The summed need. */
  quantity: number;
  unit: string;
  /** `conversionRef.gramsPerEach`, when the catalog carries one. */
  gramsPerEach?: number | null;
}

/**
 * Which D-WS9-292 branch this row takes.
 *
 * ⚠️ THE GATE IS THE SECTION, NOT THE NAME, and that is measured rather than
 * assumed. Twenty-five corpus rows have a protein word in the name and are NOT
 * in this section — every one of them a broth or a stock, correctly filed under
 * `canned`. A name-keyed gate would have bought chicken broth by the pound.
 *
 * The section is `Ingredient.category` mapped through CATEGORY_TO_SECTION, and
 * F4 fixes the rows where that column is wrong — including the one row this
 * classifier could not place before F4 landed (`cream of chicken soup`, filed
 * Protein, need in cans).
 */
export function classifyFreshProtein(item: FreshProteinInput): FreshProteinVerdict {
  if (item.sectionKey !== "meat_seafood") return { kind: "not_fresh_protein" };
  const hay = `${item.canonicalName} ${item.displayName}`.toLowerCase();

  // Exception 2 before exception 1: "whole ham" must not be read as deli meat,
  // and a whole bird is a whole bird however it is packaged.
  const whole = firstKeyword(WHOLE_ITEM_MEATS, hay);
  if (whole) return { kind: "whole_item", keyword: whole };
  const fixed = firstKeyword(FIXED_PACKAGE_MEATS, hay);
  if (fixed) return { kind: "fixed_package", keyword: fixed };

  if (!(item.quantity > 0)) return { kind: "not_fresh_protein" };

  // The need is already a weight — the plain rule.
  const perUnitLb = weightUnitToLb(item.unit);
  if (perUnitLb !== null) {
    const needLb = item.quantity * perUnitLb;
    return { kind: "by_weight", buyLb: roundBuyWeightLb(needLb), needLb, via: "weight" };
  }

  // Exception 3 — a COUNT need converts through a piece weight.
  if (isCountNeed(item.unit)) {
    // The catalog's own per-each weight wins over the curated table: it is
    // per-ROW where the table is per-CUT, and a catalog that learns the number
    // should not be overruled by a default.
    const pieceLb =
      typeof item.gramsPerEach === "number" && item.gramsPerEach > 0
        ? item.gramsPerEach / G_PER_LB
        : (longestMatch(PIECE_WEIGHT_LB, hay)?.lb ?? null);
    if (pieceLb === null) {
      return { kind: "count_unsourced", cut: firstKeyword(UNSOURCED_COUNT_CUTS, hay) };
    }
    const needLb = item.quantity * pieceLb;
    return { kind: "by_weight", buyLb: roundBuyWeightLb(needLb), needLb, via: "count", pieceLb };
  }

  // A need in cups of shredded meat, or anything else. Not this rule's.
  return { kind: "not_fresh_protein" };
}

/**
 * The pack fields D-WS9-292 writes for a `by_weight` row.
 *
 * ⚠️ `purchaseDisplay` IS A BARE WEIGHT WITH NO PACK NOUN, and that is what
 * makes the line read right without a client change. composePackName's Rule 2
 * prints "{display} {name}": with a display of "2.5 lb" and a residue of "lb"
 * that does not name the item, the line is "2.5 lb boneless skinless chicken
 * breasts" — Hans's shape exactly. The glyph ("2½ lb") is applied at RENDER by
 * the client, never stored, which is the standing discipline.
 *
 * ⚠️ `packCount` IS 1, NOT THE WEIGHT. D-WS9-286: packCount is a COUNT of packs
 * and `purchaseQuantity` is the size of one. One parcel of the stated weight is
 * one pack, so the Instacart order's `packCount × purchaseQuantity` is the
 * weight itself.
 */
export function freshProteinPurchase(buyLb: number): {
  purchaseUnit: string;
  purchaseQuantity: number;
  purchaseDisplay: string;
  packCount: number;
} {
  // toFixed(2) then parseFloat: the ¼ ladder is exact in binary, but the
  // multiply that produced it can leave 2.7500000000000004.
  const lb = parseFloat(buyLb.toFixed(2));
  return {
    purchaseUnit: "lb",
    purchaseQuantity: lb,
    purchaseDisplay: `${lb} lb`,
    packCount: 1,
  };
}

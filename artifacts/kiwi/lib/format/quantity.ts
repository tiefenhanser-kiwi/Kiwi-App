// PRD §11.3 — quantity rounding for cooking-measure display. Shared by the
// Meal Detail ingredient scaler and the WS7-8b BUG-003 step amount-ref render
// so step amounts and ingredient amounts round identically.
// Approximate; per-unit precision is a polish pass (WS9).

// WS7-8b fraction-glyph block — shared vulgar-fraction map. Eighths give the
// fine-grained "need" granularity B1's ⅛ ladder emits; thirds (⅓/⅔) are kept
// because cooks recognize them and they are NOT representable as eighths.
// `value` is the exact fractional part; `glyph` its Unicode vulgar fraction.
const FRACTION_GLYPHS: ReadonlyArray<{ value: number; glyph: string }> = [
  { value: 1 / 8, glyph: "⅛" },
  { value: 1 / 4, glyph: "¼" },
  { value: 1 / 3, glyph: "⅓" },
  { value: 3 / 8, glyph: "⅜" },
  { value: 1 / 2, glyph: "½" },
  { value: 5 / 8, glyph: "⅝" },
  { value: 2 / 3, glyph: "⅔" },
  { value: 3 / 4, glyph: "¾" },
  { value: 7 / 8, glyph: "⅞" },
];

// Nearest-glyph tolerance. Wide enough that lightly-rounded inputs still match
// (1.667 → ⅔, |0.667 − 0.6667| ≈ 3e-4), tight enough that a genuine non-glyph
// decimal stays unmatched (1.9 → frac 0.9 is > ε from ⅞ 0.875, so it falls
// back to its decimal). Half the smallest gap between adjacent glyphs
// (⅓→⅜ = 0.0417, ⅝→⅔ = 0.0417) is ~0.021 — 0.02 keeps matches disjoint.
const GLYPH_EPSILON = 0.02;

// Return the glyph whose value is within ε of `frac`, or null. When two glyphs
// are within ε (only possible if ε were too wide), the nearest wins.
function matchGlyph(frac: number): string | null {
  let best: { glyph: string; dist: number } | null = null;
  for (const { value, glyph } of FRACTION_GLYPHS) {
    const dist = Math.abs(frac - value);
    if (dist <= GLYPH_EPSILON && (best === null || dist < best.dist)) {
      best = { glyph, dist };
    }
  }
  return best?.glyph ?? null;
}

/**
 * WS7-8b fraction-glyph block — grocery NEED-quantity display formatter.
 *
 * Maps a numeric need quantity to a shopper-friendly amount string with a
 * Unicode vulgar-fraction glyph (1.125 → "1⅛", 1.333… → "1⅓", 0.5 → "½").
 * ε-EXACT: only values that land on a known fraction (eighths ∪ thirds) within
 * GLYPH_EPSILON are glyphed; anything else — including an off-ladder AI-merge
 * value — falls back to its plain decimal string (1.9 → "1.9"), never an
 * invented glyph. Amount-only; the caller appends the unit.
 *
 * Display-only: callers must NOT feed this back into an editor or persist it —
 * it is lossy for non-glyph fractions and emits non-parseable glyph chars.
 */
export function formatNeedGlyph(qty: number): string {
  if (!Number.isFinite(qty)) return String(qty);
  if (Number.isInteger(qty)) return String(qty);

  const sign = qty < 0 ? "-" : "";
  const abs = Math.abs(qty);
  const whole = Math.floor(abs);
  const frac = abs - whole;

  const glyph = matchGlyph(frac);
  if (!glyph) return String(qty); // off-glyph → plain decimal fallback

  if (whole === 0) return `${sign}${glyph}`; // bare fraction, no leading 0
  return `${sign}${whole}${glyph}`;
}

/** The units formatQuantity ceils to a whole number ("you cannot use ⅓ of a clove").
 *  FIX-7 (BUG-437) — sprig, slice, leaf and strip join them: "1½ slices bacon"
 *  and "½ sprig thyme" are the same impossibility. Matched on the singular,
 *  because a step's amountRef carries the authored "cloves"/"slices". */
const WHOLE_UNITS = ["whole", "clove", "sprig", "slice", "leaf", "strip"];

// ── 🔴 FIX-7 (BUG-437) — A SCALED AMOUNT A COOK CAN MEASURE ─────────────────
//
// Recipes are written for 4. At household 2, FIX-4's bulk check found "½ Large
// eggs", "½ egg yolks", "⅜ teaspoon" salt and "⅝ pound ground beef" in saved
// plans. DISPLAY ONLY: the catalog row and the grocery list are untouched (the
// grocery list never reads this file's rounding — it uses formatNeedGlyph).
//
// The rule, MEASURED against the whole public dev catalog (31,283 lines over
// 3,151 dishes, e2e/out/fix7/analyze.out) before it was written:
//
//   1. A WHOLE COUNTED ITEM rounds UP. Not every count does: the catalog
//      authors ½ white onion 155×, ½ lemon 72×, ½ cucumber 64× at household 4,
//      and halving those is fine. So the ceiling goes by NAME (WHOLE_ITEM_NAME)
//      and only on a count unit. Zero whole-item lines are authored fractional,
//      so household 4 cannot move.
//   2. SPOONS snap to ⅛ ¼ ½ ¾; CUPS to ⅛ ¼ ⅓ ½ ⅔ ¾ (whole numbers plus those).
//      ⅛ STAYS, though the proposal left it out: ⅛ tsp is authored 268× at
//      household 4, and ¼ cup halves to ⅛ cup on 1,157 lines — snapping that to
//      ¼ would print the household-4 amount at household 2. Thirds are for cups
//      only: no measuring spoon is ⅓ tsp, and no spoon third is authored
//      anywhere in the catalog (an exact third that arrives anyway is kept —
//      see the thirds check, which runs first). Never rounds to 0: the floor is ⅛.
//   3. POUNDS show in ¼ lb steps, nearest, ties up, never below ¼. Applied to
//      every pound amount, not only meat and fish: "⅝ pound broccoli florets"
//      and "⅝ pound Russet potatoes" are in the same FIX-4 list, nobody weighs
//      either to the eighth, and a meat-name list would be a second classifier
//      the step text could disagree with. No pound amount is authored off the
//      ¼ grid, so household 4 cannot move.
//   4. A WHOLE BIRD is never scaled DOWN by weight — see wholeItemMultiplier.
//
// Ties go UP everywhere (⅜ tsp → ½, ⅝ lb → ¾, ⅞ cup → 1).

/** Count tokens: no unit word, so the number counts the ingredient itself. */
const COUNT_UNITS: ReadonlySet<string> = new Set([
  "", "each", "piece", "pieces", "count", "ct", "unit", "units", "whole", "large", "medium", "small",
]);

/**
 * Things a cook cannot use a fraction of. Checked against the ingredient NAME
 * (or, for a step amount, the words that follow it in the step text). The
 * catalog's own count-unit names were read to build it; produce that halves
 * cleanly (onion, lemon, lime, cucumber, pepper, avocado, cabbage) is absent on
 * purpose. "eggplant" and "egg noodles" do not match `\beggs?\b` + the guard.
 */
const WHOLE_ITEM_NAME = new RegExp(
  String.raw`\b(eggs?(?! noodles)|yolks?|egg whites?|tortillas?|taco shells?|tostadas?|tostada shells?|buns?|rolls?|hoagies?|pitas?|english muffins?|bagels?|chops?|fillets?|breasts?|thighs?|drumsticks?|wings?|links?|sausages?|bratwursts?|hot dogs?|patt(?:y|ies)|burgers?|skewers?|toothpicks?|bay lea(?:f|ves)|cloves?|sprigs?|slices?|strips?|pouch(?:es)?|wedges?|lasagna (?:noodles|sheets)|pie crusts?)\b`,
  "i",
);

/** A whole bird, by name: never halved by weight, never shown as ½ a bird. */
const WHOLE_BIRD = new RegExp(
  String.raw`\b(whole (?:chickens?|turkeys?|ducks?|hens?|birds?|goose|geese)|rotisserie chickens?|(?:cornish|game) hens?|spatchcock(?:ed)? (?:chicken|turkey))\b`,
  "i",
);

const SPOON_UNITS = /^(teaspoons?|tsp|tablespoons?|tbsp|tbs)$/;
const CUP_UNITS = /^(cups?|c)$/;
const POUND_UNITS = /^(lbs?|pounds?)$/;
const WEIGHT_UNITS = /^(lbs?|pounds?|oz|ounces?|g|grams?|kg|kilograms?)$/;

const SPOON_STEPS = [0, 1 / 8, 1 / 4, 1 / 2, 3 / 4, 1];
const CUP_STEPS = [0, 1 / 8, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 1];
const TIE = 1e-9;

/** "Cloves" → "clove", "leaves" → "leaf": the ceiling list is singular. */
function singularUnit(u: string): string {
  if (u === "leaves") return "leaf";
  return u.endsWith("s") ? u.slice(0, -1) : u;
}

/** Nearest step for the fractional part, ties up, whole part kept. */
function snapToSteps(qty: number, steps: readonly number[]): number {
  const whole = Math.floor(qty);
  const frac = qty - whole;
  let best = steps[0];
  for (const s of steps) if (Math.abs(frac - s) <= Math.abs(frac - best) + TIE) best = s;
  return whole + best;
}

/** True when this unit+name is a whole bird by weight (rule 4). */
function isWholeBirdByWeight(unit: string, name: string): boolean {
  return WEIGHT_UNITS.test(unit.trim().toLowerCase()) && WHOLE_BIRD.test(name);
}

/**
 * FIX-7 rule 4 — the multiplier a line should actually scale by. A whole bird
 * bought by weight is one bird: at household 2 the 4-pound chicken is still a
 * 4-pound chicken (and the 14-pound Thanksgiving turkey still 14), so a
 * multiplier below 1 does not apply to it. Above 1 it scales as before (a
 * bigger bird). A bird by COUNT needs no help here — rule 1 ceils it.
 */
export function wholeItemMultiplier(multiplier: number, unit: string, name = ""): number {
  return multiplier < 1 && isWholeBirdByWeight(unit, name) ? 1 : multiplier;
}

/**
 * WS9 BUG-321 — THE NUMBER {@link formatQuantity} WILL ACTUALLY SHOW, as a
 * number. Extracted so the amount and the UNIT WORD beside it cannot disagree.
 *
 * 🔴 WHY IT EXISTS. formatQuantity is lossy on purpose: whole units ceil, and
 * everything else rounds to the nearest ⅛. BUG-321 puts a pluralizer next to it
 * (`pluralizeUnitWord`), and a pluralizer that reads the RAW quantity answers a
 * different question from the renderer beside it. 1.05 cup renders "1" —
 * Math.round(8.4)/8 = 1 — while 1.05 > 1 pluralizes, giving "1 cups". A
 * servings multiplier reaches those values routinely (0.7 cup × 1.5 = 1.05).
 *
 * So the rounding rule lives HERE, once, and formatQuantity renders from its
 * result rather than re-deriving it. One implementation, two readers, and they
 * cannot drift — the same discipline COUNT_NOUN_SINGULARS uses in grocery.ts.
 *
 * Display-only, exactly as formatQuantity is: never persist this, never feed it
 * back to an editor.
 *
 * FIX-7 — `name` is the ingredient name (or a step amount's following words);
 * it decides rule 1, the whole-item ceiling. Omitted, only the unit decides.
 */
export function displayedQuantity(qty: number, unit: string, name = ""): number {
  const u = unit.trim().toLowerCase();
  // Rule 1 — whole counted items, by unit word or by name on a count unit. The
  // TIE keeps float noise (3.0000000004) from ceiling a whole number up.
  if (
    WHOLE_UNITS.includes(singularUnit(u)) ||
    (COUNT_UNITS.has(u) && (WHOLE_ITEM_NAME.test(name) || WHOLE_BIRD.test(name)))
  ) {
    return Math.ceil(qty - TIE);
  }
  // Rule 3 — pounds in quarter steps, ties up, floor ¼.
  if (POUND_UNITS.test(u)) return Math.max(1 / 4, Math.floor(qty * 4 + 0.5 + TIE) / 4);
  const whole = Math.floor(qty);
  const frac = qty - whole;
  // WS7-8b — thirds first: ⅓/⅔ are not representable as eighths, so match them
  // before the eighth-rounding below (which would otherwise mangle ⅓→⅜, ⅔→⅝).
  if (Math.abs(frac - 1 / 3) <= GLYPH_EPSILON) return whole + 1 / 3;
  if (Math.abs(frac - 2 / 3) <= GLYPH_EPSILON) return whole + 2 / 3;
  // Rule 2 — spoons and cups snap to what a measuring set holds, floor ⅛.
  if (SPOON_UNITS.test(u) || CUP_UNITS.test(u)) {
    const snapped = snapToSteps(qty, SPOON_UNITS.test(u) ? SPOON_STEPS : CUP_STEPS);
    return snapped === 0 && qty > 0 ? 1 / 8 : snapped;
  }
  // Round to nearest 1/8 for cooking measures (approximate — WS9 polish).
  return Math.round(qty * 8) / 8;
}

// The fractional parts formatQuantity can spell, keyed by `frac.toFixed(3)`.
// Thirds are in the map now because displayedQuantity returns them as NUMBERS
// (whole + 1/3) rather than returning a string early — the two branches that
// used to `return` mid-function are the same two rows here.
const FRACTION_STRINGS: Record<string, string> = {
  "0.125": "⅛",
  "0.250": "¼",
  "0.333": "⅓",
  "0.375": "⅜",
  "0.500": "½",
  "0.625": "⅝",
  "0.667": "⅔",
  "0.750": "¾",
  "0.875": "⅞",
};

export function formatQuantity(qty: number, unit: string, name = ""): string {
  const shown = displayedQuantity(qty, unit, name);
  if (Number.isInteger(shown)) return String(shown);
  const rWhole = Math.floor(shown);
  const rFrac = shown - rWhole;
  const fracStr = FRACTION_STRINGS[rFrac.toFixed(3)] ?? "";
  if (rWhole === 0 && fracStr) return fracStr;
  if (rWhole > 0 && fracStr) return `${rWhole}${fracStr}`;
  if (rWhole > 0 && !fracStr) return String(rWhole);
  // Fallback: tiny non-mappable fraction (shouldn't happen after 1/8 rounding).
  return shown.toFixed(2);
}

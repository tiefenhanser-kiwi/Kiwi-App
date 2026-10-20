// THX-3 (BUG-444) — THE AMOUNT A COOK CAN MEASURE, IN PREP TEXT.
//
// Prep the Week's text is written on the server, so FIX-7's display rule
// (BUG-437, `artifacts/kiwi/lib/format/quantity.ts` displayedQuantity) never
// reached it: at household 2 a prep step read "4.8 cloves", "0.8 lemon", "⅞ tbsp"
// and "1⅝ lb" while the recipe beside it read whole cloves and quarter pounds.
//
// 🔴 THIS IS A COPY OF THAT RULE, NOT AN IMPORT. Nothing in api-server/src
// imports across into artifacts/kiwi (the server's build tree is bundled
// separately — see the `mixedNumber` note in prepWeekAssembly.ts), and there is
// no shared package. So the TABLES are spelled the same, and
// prepQuantity.test.ts pins them literally AND reads the client file to fail on
// drift. If one changes, change both.
//
// The rule, as FIX-7 built it (measured over 31,283 public catalog lines):
//   1. A WHOLE COUNTED ITEM rounds UP: cloves, sprigs, slices, leaves, strips
//      (by unit) and tortillas, buns, fillets, bay leaves… (by name, on a count).
//      Produce that halves cleanly (onion, lemon) is not on the list.
//   2. SPOONS snap to ⅛ ¼ ½ ¾; CUPS to ⅛ ¼ ⅓ ½ ⅔ ¾; ties up, never below ⅛. An
//      exact third is kept wherever it arrives.
//   3. POUNDS go in ¼ lb steps, ties up, never below ¼.
//   4. A WHOLE BIRD scales down only to the smallest of its kind (WEB-4's floors,
//      THX-3b), and the rest of its dish follows the bird (`dishRowMultipliers`).
//   Everything else rounds to the nearest ⅛.
//
// ⚠️ ONE DELIBERATE DIFFERENCE — EGGS. Hans, October 19: eggs (and yolks and
// whites) round to the NEAREST whole number, never below 1, halves up. FIX-7's
// client still ceils them (rule 1); the prep text follows Hans's rule, and the
// client lane owns aligning its own.
//
// Two server rules are kept that the client does not have: ml and g print whole
// (a scale reads grams), and the placeholder count unit prints no word.

/** Count tokens: no unit word, so the number counts the ingredient itself. */
const COUNT_UNITS: ReadonlySet<string> = new Set([
  "", "each", "piece", "pieces", "count", "ct", "unit", "units", "whole", "large", "medium", "small",
]);

/** FIX-7 rule 1 — units a cook cannot use a fraction of (singular). */
export const WHOLE_UNITS: readonly string[] = ["whole", "clove", "sprig", "slice", "leaf", "strip"];

/** FIX-7 rule 1 — whole counted items by NAME (client's WHOLE_ITEM_NAME, verbatim). */
export const WHOLE_ITEM_NAME = new RegExp(
  String.raw`\b(eggs?(?! noodles)|yolks?|egg whites?|tortillas?|taco shells?|tostadas?|tostada shells?|buns?|rolls?|hoagies?|pitas?|english muffins?|bagels?|chops?|fillets?|breasts?|thighs?|drumsticks?|wings?|links?|sausages?|bratwursts?|hot dogs?|patt(?:y|ies)|burgers?|skewers?|toothpicks?|bay lea(?:f|ves)|cloves?|sprigs?|slices?|strips?|pouch(?:es)?|wedges?|lasagna (?:noodles|sheets)|pie crusts?)\b`,
  "i",
);

/** FIX-7 rule 4 — a whole bird, by name (client's WHOLE_BIRD, verbatim). */
export const WHOLE_BIRD = new RegExp(
  String.raw`\b(whole (?:chickens?|turkeys?|ducks?|hens?|birds?|goose|geese)|rotisserie chickens?|(?:cornish|game) hens?|spatchcock(?:ed)? (?:chicken|turkey))\b`,
  "i",
);

/** Hans, October 19 — the egg family, rounded to the nearest whole, never below 1. */
const EGG_NAME = /\b(eggs?(?! noodles)|yolks?|egg whites?)\b/i;

export const SPOON_STEPS: readonly number[] = [0, 1 / 8, 1 / 4, 1 / 2, 3 / 4, 1];
export const CUP_STEPS: readonly number[] = [0, 1 / 8, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 1];
const TIE = 1e-9;
/** Same constant as lib/format/quantity.ts: half the smallest gap between glyphs. */
const GLYPH_EPSILON = 0.02;

const SPOON_TOKENS = /^(tsp|tbsp|teaspoons?|tablespoons?|tbs)$/;
const CUP_TOKENS = /^(cups?|c)$/;
const POUND_TOKENS = /^(lbs?|pounds?)$/;
const WEIGHT_TOKENS = /^(lbs?|pounds?|oz|ounces?|g|grams?|kg|kilograms?)$/;

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

/** True when this unit+name is a whole bird by weight (rule 4) — the client's detector. */
export function isWholeBirdByWeight(unit: string, name: string): boolean {
  return WEIGHT_TOKENS.test(unit.trim().toLowerCase()) && WHOLE_BIRD.test(name);
}

/**
 * THX-3b (BUG-454) — WEB-4's BIRD_FLOOR_LB (`artifacts/kiwi/lib/format/quantity.ts`,
 * b1f404b), VERBATIM: the smallest whole bird of each kind a grocer commonly
 * stocks, in pounds. Checked in order (a "cornish hen" is not a "hen"). The test
 * pins it literally and reads the client file for drift.
 */
export const BIRD_FLOOR_LB: ReadonlyArray<readonly [RegExp, number]> = [
  [/\bturkeys?\b/i, 10],
  [/\b(?:cornish|game) hens?\b/i, 1],
  [/\brotisserie chickens?\b/i, 2],
  [/\bducks?\b/i, 4],
  [/\b(?:goose|geese)\b/i, 8],
  [/\b(?:chickens?|hens?)\b/i, 3],
];

/** Pounds per one of this weight unit; null for a unit that is not a weight (client's poundsPer). */
function poundsPer(unit: string): number | null {
  const u = unit.trim().toLowerCase();
  if (POUND_TOKENS.test(u)) return 1;
  if (/^(oz|ounces?)$/.test(u)) return 1 / 16;
  if (/^(g|grams?)$/.test(u)) return 1 / 453.59237;
  if (/^(kg|kilograms?)$/.test(u)) return 2.20462262;
  return null;
}

/** The floor for this bird, in pounds, or null when its kind has none. */
export function birdFloorPounds(name: string): number | null {
  for (const [re, lb] of BIRD_FLOOR_LB) if (re.test(name)) return lb;
  return null;
}

/**
 * FIX-7 rule 4, as WEB-4 (BUG-453) left it — the multiplier a whole bird bought by
 * weight scales by. Above 1 it scales as before (a bigger bird). Below 1 it scales
 * DOWN, never below the smallest bird of its kind and never above the recipe's own
 * weight: the 14 lb turkey at 4 of 10 servings is a 10 lb turkey. `quantity` is the
 * line's own (unscaled) amount; without it, or for a kind with no floor, a bird
 * does not scale down. The client's function, line for line.
 */
export function wholeItemMultiplier(multiplier: number, unit: string, name = "", quantity?: number): number {
  if (multiplier >= 1 || !isWholeBirdByWeight(unit, name)) return multiplier;
  const floor = birdFloorPounds(name);
  const per = poundsPer(unit);
  if (floor === null || per === null || quantity === undefined || !(quantity > 0)) return 1;
  return Math.max(multiplier, Math.min(1, floor / (quantity * per)));
}

/** THX-3b (BUG-454) — a bird's own parts, which come with the one bird: never scaled. */
const BIRD_PART = /\b(?:turkey|chicken|duck|goose|hen)\s+(?:necks?|giblets?)\b|\bgiblets?\b/i;

// ── THX-3b (BUG-454) — ONE BIRD RULE FOR THE WHOLE DISH ──────────────────────
//
// Prep the Week said 14 lb where meal detail said 10 lb (WEB-4 floors the bird;
// the server never scaled it down), and the brine scaled by servings while the
// bird did not: at 8 the closing line read "¾ turkey neck". The rule, the same on
// both sides (WEB-4b pins the same inputs):
//   1. the bird's weight is `wholeItemMultiplier`'s (the floors above);
//   2. the bird's FACTOR is its SHOWN weight ÷ the recipe's weight, and every other
//      row of a whole-bird dish (by `isWholeBirdByWeight`) scales by it, not by
//      servings — the brine's salt, sugar and water, the butter, herbs, aromatics;
//   3. a bird's own parts (neck, giblets) are the authored count, in any dish;
//   4. above the recipe's servings it stays linear (no cap).
// "Shown" is the displayed number (¼ lb steps): 8 of 10 servings is an 11¼ lb bird,
// so its brine is 11¼ / 14 of the recipe's.

/**
 * The multiplier each row of ONE dish scales by, in row order, given the dish's
 * servings multiplier. Rows are the dish's raw (unscaled) ingredient rows.
 */
export function dishRowMultipliers(
  rows: readonly { quantity: number; unit: string; name: string }[],
  multiplier: number,
): number[] {
  const bird = rows.find((r) => r.quantity > 0 && isWholeBirdByWeight(r.unit, r.name));
  let factor = multiplier;
  if (bird) {
    const shown = displayedPrepQuantity(bird.quantity * wholeItemMultiplier(multiplier, bird.unit, bird.name, bird.quantity), bird.unit, bird.name);
    factor = shown / bird.quantity;
  }
  return rows.map((r) => (BIRD_PART.test(r.name) ? 1 : factor));
}

/**
 * The number the prep text shows for `qty` of `unit` (a raw or canonical unit
 * string) of the ingredient `name`. Display only: the engine's sums and the
 * grocery list never read it.
 */
export function displayedPrepQuantity(qty: number, unit: string, name = ""): number {
  const u = unit.trim().toLowerCase();
  // Hans's egg rule — before rule 1, which would ceil them.
  if (COUNT_UNITS.has(u) && EGG_NAME.test(name)) return Math.max(1, Math.floor(qty + 0.5 + TIE));
  // ⚠️ SERVER-ONLY, NOT IN FIX-7's TABLE: a pinch, a dash and a cinnamon stick
  // are whole. At household 8 the feast printed "¾ pinch" salt and "¾ cinnamon
  // stick" — measured, not a guess. The client prints the same today (reported to
  // the client lane); kept outside the pinned table so the drift guard holds.
  if (/^(pinch(?:es)?|dash(?:es)?)$/.test(u) || (COUNT_UNITS.has(u) && /\b(cinnamon sticks?|star anise|vanilla beans?)\b/i.test(name))) {
    return Math.max(1, Math.round(qty));
  }
  // Rule 1 — whole counted items, by unit word or by name on a count unit.
  if (WHOLE_UNITS.includes(singularUnit(u)) || (COUNT_UNITS.has(u) && (WHOLE_ITEM_NAME.test(name) || WHOLE_BIRD.test(name)))) {
    return Math.max(1, Math.ceil(qty - TIE));
  }
  // Rule 3 — pounds in quarter steps, ties up, floor ¼.
  if (POUND_TOKENS.test(u)) return Math.max(1 / 4, Math.floor(qty * 4 + 0.5 + TIE) / 4);
  const whole = Math.floor(qty);
  const frac = qty - whole;
  // Thirds first: an exact third is kept wherever it arrives.
  if (Math.abs(frac - 1 / 3) <= GLYPH_EPSILON) return whole + 1 / 3;
  if (Math.abs(frac - 2 / 3) <= GLYPH_EPSILON) return whole + 2 / 3;
  // Rule 2 — spoons and cups snap to what a measuring set holds, floor ⅛.
  if (SPOON_TOKENS.test(u) || CUP_TOKENS.test(u)) {
    const snapped = snapToSteps(qty, SPOON_TOKENS.test(u) ? SPOON_STEPS : CUP_STEPS);
    return snapped === 0 && qty > 0 ? 1 / 8 : snapped;
  }
  const eighths = Math.round(qty * 8) / 8;
  return eighths === 0 && qty > 0 ? 1 / 8 : eighths;
}

const GLYPHS: ReadonlyArray<[number, string]> = [
  [1 / 8, "⅛"], [1 / 4, "¼"], [1 / 3, "⅓"], [3 / 8, "⅜"], [1 / 2, "½"], [5 / 8, "⅝"], [2 / 3, "⅔"], [3 / 4, "¾"], [7 / 8, "⅞"],
];

/** "1½", "⅔", "3" — the app's one mixed-number spelling (unspaced, D-WS9-297 ruling 7). */
export function mixedGlyph(q: number): string {
  const whole = Math.floor(q + TIE);
  const frac = q - whole;
  if (frac < TIE) return String(whole);
  const hit = GLYPHS.find(([v]) => Math.abs(frac - v) <= GLYPH_EPSILON);
  if (!hit) return String(Number(q.toFixed(2)));
  return whole > 0 ? `${whole}${hit[1]}` : hit[1];
}

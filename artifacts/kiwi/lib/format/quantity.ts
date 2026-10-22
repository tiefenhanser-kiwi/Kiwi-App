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
//      WEB-4 (BUG-453): it scales down now, to the smallest whole bird of its
//      kind commonly sold (BIRD_FLOOR_LB), never below it.
//
// Ties go UP everywhere (⅜ tsp → ½, ⅝ lb → ¾, ⅞ cup → 1).
//
// WEB-4 — EGGS ARE THE ONE COUNT THAT ROUNDS TO THE NEAREST, not up (Hans,
// October 19): eggs, yolks and whites go to the nearest whole number, halves
// up, never below 1 — ¾ egg is 1, 1¼ is 1, 1½ is 2. Every other whole item
// (tortillas, cloves, bay leaves …) keeps rule 1's ceiling. Ingredient lists add
// the true amount as a note when it differs (lib/format/ingredientLine.ts's
// ingredientAmountNote); steps and Cook Mode print the whole number only.

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

/** WEB-4 — eggs, yolks, whites: the nearest-whole count (see the header). */
const EGG_NAME = /\b(eggs?(?! noodles)|yolks?|egg whites?)\b/i;

/** True when this unit+name is an egg COUNT (not "1 cup egg whites"). */
export function isEggCount(unit: string, name: string): boolean {
  return COUNT_UNITS.has(unit.trim().toLowerCase()) && EGG_NAME.test(name);
}

/**
 * WEB-4b (BUG-458) — "¾ pinch" salt and "¾ cinnamon stick" at household 8 of a
 * feast for 10. A pinch, a dash, and a cinnamon stick, star anise or vanilla bean
 * by count print as a whole number: the NEAREST, halves up, never below 1. This
 * is the server's prep-text rule token for token (api-server
 * lib/prepQuantity.ts displayedPrepQuantity), so a step and its prep line agree.
 * By NAME for the stick: a "stick" unit is butter, and ½ stick is a real measure.
 */
const PINCH_UNITS = /^(pinch(?:es)?|dash(?:es)?)$/;
const WHOLE_SPICE_NAME = /\b(cinnamon sticks?|star anise|vanilla beans?)\b/i;

function isWholeSpice(unit: string, name: string): boolean {
  return PINCH_UNITS.test(unit) || (COUNT_UNITS.has(unit) && WHOLE_SPICE_NAME.test(name));
}

/**
 * WEB-4c (BUG-464) — a stalk or a rib (celery, lemongrass) prints whole: the
 * same rule and tokens as a pinch (nearest, halves up, never below 1). Classic
 * at household 8 printed "4¾ stalks celery". By the UNIT (stalk, rib), or on a
 * count unit by the NAME: "celery stalks", "lemongrass stalk", or a step's
 * following words "ribs" ("2 ribs of celery"). Not "pork rib chops". The
 * server's tokens (THX-3c, prepQuantity WHOLE_STALK_*), plus the step's
 * leading "ribs", which the server never reads.
 */
const STALK_UNITS = /^(stalks?|ribs?)$/;
const STALK_NAME = /\bstalks?\b|\bcelery ribs?\b|^\s*ribs?\b/i;

function isStalk(unit: string, name: string): boolean {
  return STALK_UNITS.test(unit) || (COUNT_UNITS.has(unit) && STALK_NAME.test(name));
}

/**
 * WEB-4c (BUG-464) — EQUIPMENT never scales: a brining bag, twine, foil,
 * parchment, cheesecloth. One bag holds the bird at any size; the line prints
 * as written, never below 1. By NAME, any unit ("1 each large brining bag",
 * "1 sheet parchment paper"). In a step the name is the words that follow the
 * amount up to the first preposition (followingWords), so "8 flour tortillas in
 * foil" and "2 garlic cloves on a foil-lined sheet" are not equipment.
 *
 * ⚠️ SKEWERS AND TOOTHPICKS ARE NOT IN IT, though the prompt listed skewers:
 * they are one per piece of food, so they follow the food (rule 1's ceiling,
 * WHOLE_ITEM_NAME). MEASURED on the public dev catalog at household 8: 24 lines
 * would hold at 8 while the food doubled — "8 wooden skewers" for 2 lb shrimp
 * beside the step's own "4–5 shrimp per skewer", "16 toothpicks" for 16
 * flautas' worth at 32. "toothpicks or kitchen twine" is per piece too.
 */
// The server's equipment tokens VERBATIM (api-server prepCombineEngine EQUIPMENT),
// so a prep line and a recipe line agree on what is equipment.
const EQUIPMENT_NAME =
  /\b(?:brining|oven|roasting|zip[- ]?top|freezer|plastic|resealable|ziploc)\s+bags?\b|\bbrining bag\b|\b(?:aluminum\s+)?foil\b|\bparchment(?:\s+paper)?\b|\b(?:kitchen|butcher'?s)\s+twine\b|\bcheesecloth\b|\bpaper towels?\b/i;
const PER_PIECE = /\b(?:skewers?|toothpicks?)\b/i;

/** True for a piece of equipment listed as an ingredient: always as written. */
export function isEquipment(name: string): boolean {
  return EQUIPMENT_NAME.test(name) && !PER_PIECE.test(name);
}

/** A whole bird, by name: never halved by weight, never shown as ½ a bird. */
const WHOLE_BIRD = new RegExp(
  String.raw`\b(whole (?:chickens?|turkeys?|ducks?|hens?|birds?|goose|geese)|rotisserie chickens?|(?:cornish|game) hens?|spatchcock(?:ed)? (?:chicken|turkey))\b`,
  "i",
);

// ── 🔴 WEB-4d (R5) — THE DISPLAY TABLE: OUNCES, PRODUCE, PACKAGES, PIECES ───
//
// THX-3d pins the same rows on the server (prepQuantity). Checked BEFORE FIX-7's
// rule 1, in new constants: WHOLE_UNITS / WHOLE_ITEM_NAME / WHOLE_BIRD are
// literal-pinned against the server's copy (its drift guard), so they are not
// edited — a sprig or a bay leaf simply never reaches rule 1 now.
//
//   - OUNCES: 4 oz and up → whole ounces; under 4 → the nearest ½ oz, never
//     below ½. Ties up. "9⅝ oz" → 10, "4¾" → 5, "2⅜" → 2½. Fluid ounces too.
//   - WHOLE PRODUCE by the piece (WHOLE_PRODUCE_HEAD, on a count unit; chiles
//     too) → the nearest ½, halves up, never below ½: "¾ onion" → 1, "⅜ onion"
//     → ½, "2⅜ shallots" → 2½. An item CUT WHOLE (CUT_WHOLE: "quartered",
//     "halved", "whole" — in the unit, the name, the prep note or the step's
//     words) is the nearest whole, never below 1: the cut word decides. Read by
//     the HEAD noun (the last word before a comma, a parenthesis or "in …"), so
//     "lime wedges", "potato buns" and "orange bell pepper" are not produce.
//     Each share rounds on its own (consolidateMealIngredients).
//   - PACKAGES (can, box, bag, jar, package, packet — the unit, or the name on a
//     count unit) → whole, ROUNDED UP, never below 1. Up, not nearest: the line
//     keeps the use ("1 can (15 oz) pumpkin purée, use 6 oz", packageUse), and
//     1¼ cans cannot be "1 can, use 19 oz". The size in the unit or name is never
//     scaled.
//   - PIECES: caps, sheets, crusts, crackers, leaves, sprigs → the nearest
//     whole, halves up, never below 1 ("7¼ crackers" → 7, "1⅝ caps" → 2). For
//     sprigs and leaves that replaces rule 1's ceiling (3.2 sprigs → 3, not 4).
//
// 🔴 AN UNSCALED AMOUNT IS NEVER ROUNDED BY ANY OF THIS (Hans, October 22): at
// its own servings "½ lemon" and "14½ ounces" print as written. Callers pass
// `scaled: false` (RoundingContext) when the line's multiplier is 1.
const OUNCE_UNITS = /^(?:oz|ounces?|fl\.?\s*oz|fluid\s+ounces?)$/;
const WHOLE_PRODUCE_HEAD =
  /^(?:onions?|carrots?|lemons?|oranges?|limes?|shallots?|jalape[nñ]os?|apples?|potato(?:es)?|chil(?:e|es|i|is|ies|li|lies)|chipotles?|serranos?|habaneros?|poblanos?)$/i;
/** "chipotle peppers in adobo" is a chile, though its head says peppers. */
const CHIPOTLE_PEPPER = /\bchipotle peppers?\b/i;
/** The cut word that keeps produce whole: "1 quartered onion", "lemon, halved",
 *  "a whole chile". */
const CUT_WHOLE = /\b(?:quartered|halved|whole|cut (?:in|into) (?:half|halves|quarters|wedges))\b/i;
/** A packaged mix prepared per package directions is the whole package, with no
 *  "use": a cornbread box is baked whole. */
const PACKAGE_DIRECTIONS =
  /\b(?:cornbread|muffin|cake|brownie|biscuit|pancake|waffle|cookie|bread) mix(?:es)?\b|\b(?:per|according to)(?: the)? package (?:directions|instructions)\b/i;

/** WEB-4d — what the rounding needs beyond the amount: whether it was scaled at
 *  all (an unscaled amount is never rounded by R5), and the prep note or the
 *  step's words after the noun, where a cut word or "per package directions" sits. */
export interface RoundingContext {
  scaled?: boolean;
  note?: string;
}
const PACKAGE_WORD = /\b(?:cans?|box(?:es)?|bags?|jars?|packages?|packets?)\b/i;
const WHOLE_PIECE_UNITS = /^(?:sheets?|caps?|crusts?|crackers?|lea(?:f|ves)|sprigs?)$/;
// Not after a hyphen: "flat-leaf parsley" is not a leaf ("½ packed cup flat-leaf
// parsley" — a step's following words — read "1 packed cup").
const WHOLE_PIECE_NAME = /(?<![-‑])\b(?:caps?|sheets?|crusts?|crackers?|lea(?:f|ves)|sprigs?)\b/i;

/** The head noun of a name: its last word before a comma, a parenthesis, or
 *  "in"/"from"/"packed" ("chipotle chiles in adobo sauce" → chiles). */
function headNoun(name: string): string {
  const words = name.split(/[,(]|\s(?:in|from|packed)\s/i)[0].trim().split(/\s+/);
  return words[words.length - 1] ?? "";
}

/** WEB-4d — onion, carrot, lemon … counted by the piece. */
export function isWholeProduce(unit: string, name: string): boolean {
  return COUNT_UNITS.has(unit.trim().toLowerCase()) && (WHOLE_PRODUCE_HEAD.test(headNoun(name)) || CHIPOTLE_PEPPER.test(name));
}

/** WEB-4d — a can, box, bag, jar or package: by its unit, or by name on a count. */
export function isPackage(unit: string, name: string): boolean {
  const u = unit.trim().toLowerCase();
  return PACKAGE_WORD.test(u) || (COUNT_UNITS.has(u) && PACKAGE_WORD.test(name));
}

function isWholePiece(unit: string, name: string): boolean {
  return WHOLE_PIECE_UNITS.test(unit) || (COUNT_UNITS.has(unit) && WHOLE_PIECE_NAME.test(name));
}

/** WEB-4d — the rules a share rounds by on its own, before shares are summed. */
export function roundsPerShare(unit: string, name: string): boolean {
  const u = unit.trim().toLowerCase();
  return isWholeProduce(u, name) || isPackage(u, name) || isWholePiece(u, name);
}

/** A package's own size, from its unit or name: "can (15 oz)", "15-ounce can",
 *  "cornbread mix (8.5 oz box)". A count size ("package (2-count)") is not one. */
const PACKAGE_SIZE = /(\d+(?:\.\d+)?)\s*[-‑]?\s*(fl\.?\s*oz|oz|ounces?|lbs?|pounds?|g|grams?|ml)\b/i;

/**
 * WEB-4d — "use 6 oz": how much of a package the recipe takes, when the package
 * count was rounded up and the recipe gives the package's size. `scaled` is the
 * true package count (⅜ of a can); null when nothing was rounded or there is no
 * size to say it in.
 */
export function packageUse(scaled: number, unit: string, name: string, note = ""): string | null {
  if (!(scaled > 0) || !isPackage(unit, name)) return null;
  if (PACKAGE_DIRECTIONS.test(`${name} ${note}`)) return null;
  if (Math.abs(displayedQuantity(scaled, unit, name) - scaled) < 1e-6) return null;
  const size = PACKAGE_SIZE.exec(`${unit} ${name}`);
  if (!size) return null;
  const sizeUnit = size[2];
  const amount = scaled * Number(size[1]);
  const shown = displayedQuantity(amount, sizeUnit);
  const word = /^(oz|fl\.?\s*oz|g|ml)$/i.test(sizeUnit) ? sizeUnit : shown > 1 ? `${sizeUnit.replace(/s$/i, "")}s` : sizeUnit.replace(/s$/i, "");
  return `use ${formatQuantity(amount, sizeUnit)} ${word}`;
}

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
 * WEB-4c (BUG-462) — a whole bird by COUNT ("1 whole turkey", Buttermilk-Brined
 * Roast Turkey). A ROTISSERIE chicken is not one: it is cooked meat bought for
 * the dish (12 weeknight catalog dishes — wraps, quesadillas, soups), and the
 * tortillas beside it are for the people, not the bird. It keeps rule 1's
 * ceiling and its dish keeps the servings multiplier.
 */
const ROTISSERIE = /\brotisserie\b/i;

function isWholeBirdByCount(unit: string, name: string): boolean {
  return COUNT_UNITS.has(unit.trim().toLowerCase()) && WHOLE_BIRD.test(name) && !ROTISSERIE.test(name);
}

/** The birds a by-count bird shows: the nearest whole, halves up, never below 1. */
function birdsShown(qty: number): number {
  return Math.max(1, Math.floor(qty + 0.5 + TIE));
}

/**
 * WEB-4 (BUG-453) — the smallest whole bird of each kind a grocer commonly
 * stocks, in pounds. A scaled-down bird stops here: below it there is no bird
 * to buy. Checked in order (a "cornish hen" is not a "hen").
 *
 * MEASURED, the catalog's whole birds by weight (public dev catalog,
 * 2026-10-20): turkey 14 lb written for 10 (2 lines); chicken 3½–4 lb written
 * for 4 (and 2) (16 lines). No duck, goose or hen is authored by weight; their
 * floors are for user meals. The sizes: turkeys are sold from about 10 lb (an
 * 8 lb bird exists but is rare); whole broiler-fryers 3–4½ lb; a rotisserie
 * chicken is about 2 lb cooked; ducks 4–6 lb; geese 8 lb and up; Cornish hens
 * 1–2 lb. A whole bird of no listed kind keeps FIX-7's rule (no scale-down).
 */
const BIRD_FLOOR_LB: ReadonlyArray<readonly [RegExp, number]> = [
  [/\bturkeys?\b/i, 10],
  [/\b(?:cornish|game) hens?\b/i, 1],
  [/\brotisserie chickens?\b/i, 2],
  [/\bducks?\b/i, 4],
  [/\b(?:goose|geese)\b/i, 8],
  [/\b(?:chickens?|hens?)\b/i, 3],
];

/** Pounds per one of this weight unit; null for a unit that is not a weight. */
function poundsPer(unit: string): number | null {
  const u = unit.trim().toLowerCase();
  if (POUND_UNITS.test(u)) return 1;
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
 * FIX-7 rule 4 — the multiplier a line should actually scale by. A whole bird
 * bought by weight is one bird. Above 1 it scales as before (a bigger bird).
 * A bird by COUNT needs no help here — rule 1 ceils it.
 *
 * WEB-4 (BUG-453) — below 1 it now scales DOWN, but never below the smallest
 * bird of its kind (BIRD_FLOOR_LB), and never above the recipe's own weight:
 * the 14 lb turkey at 4 of 10 servings is a 10 lb turkey, not 5.6 lb and not
 * 14. `quantity` is the line's own (unscaled) amount; without it, or for a
 * kind with no floor, the old rule holds (no scale-down).
 */
export function wholeItemMultiplier(
  multiplier: number,
  unit: string,
  name = "",
  quantity?: number,
): number {
  if (multiplier >= 1 || !isWholeBirdByWeight(unit, name)) return multiplier;
  const floor = birdFloorPounds(name);
  const per = poundsPer(unit);
  if (floor === null || per === null || quantity === undefined || !(quantity > 0)) return 1;
  return Math.max(multiplier, Math.min(1, floor / (quantity * per)));
}

// ── WEB-4b (BUG-454) — ONE BIRD RULE, FOR THE WHOLE DISH ────────────────────
//
// BUG-453's floor kept the turkey at 10 lb when Classic (written for 10) was
// scaled to 4, but the rest of the dish still scaled by servings: a 10 lb bird
// in a brine of ⅛ cup salt and ⅜ gallon water. The brine, the butter, the
// herbs and the aromatics are for THE BIRD, so in a dish with a whole bird by
// weight every other line scales by the bird's factor — its weight after the
// floor ÷ the recipe's bird weight — not by servings.
//
//   - The factor is the floored weight BEFORE the ¼ lb display rounding, so it
//     equals the servings multiplier whenever the floor does not bind: scaling
//     UP stays exactly linear, with no cap (20 servings of a recipe for 10 is
//     a 28 lb bird and twice the brine), and only a floored dish changes.
//   - The bird's own parts (neck, giblets) never scale: one bird, one neck. They
//     sit in a different dish (Classic's Pan Gravy), so this is a line rule.
//   - WEB-4c (BUG-462) — a whole bird by COUNT shows max(1, nearest whole)
//     birds (halves up), everywhere. In a FEAST (a `thanksgiving-feast` meal,
//     isFeastMeal) the rest of its dish scales by birds shown ÷ birds written:
//     Buttermilk-Brined Roast Turkey (1 bird, for 10) at 4 is one bird in its
//     whole brine — it was one bird in ⅖ of it; at 15 it is two birds in two
//     brines — it was two birds in 1½. Its parts are one per bird shown.
//     ELSEWHERE the dish follows servings (Hans, Oct 21): Chicken Pho's one
//     chicken at household 2 had printed the whole 4-serving pot.
//   - Equipment (isEquipment) never scales, in any dish.

/** The meal tag that marks the feast (THX-2G-E's contract; hubModel FEAST_MEAL_TAG,
 *  pinned equal in birdRule.test.ts). */
const FEAST_MEAL_TAG = "thanksgiving-feast";

/** WEB-4c — true for a `thanksgiving-feast` meal: the one place a dish follows a
 *  bird written by count. */
export function isFeastMeal(tags: readonly string[] | undefined): boolean {
  return tags?.includes(FEAST_MEAL_TAG) ?? false;
}

/** A bird's own parts, by name. Not "littleneck clams". */
const BIRD_PART = /\b(?:(?:turkey|chicken|duck|goose|hen|bird)s?\s+necks?|giblets?)\b/i;

/** True for the neck or the giblets of a bird: one per bird (see birdPartsFactor). */
export function isBirdPart(name: string): boolean {
  return BIRD_PART.test(name);
}

/** "(12–14 lb)", "(14 pounds)", "(6 kg)" in a bird's name: the weight in
 *  pounds, the upper end of a range; null when the name gives none. */
const NAME_WEIGHT = /(\d+(?:\.\d+)?)(?:\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?))?\s*[-‑]?\s*(lbs?|pounds?|kg|kilograms?)\b/i;

function birdWeightInName(name: string): number | null {
  const m = NAME_WEIGHT.exec(name);
  if (!m) return null;
  const n = Number(m[2] ?? m[1]);
  const per = poundsPer(m[3]);
  return n > 0 && per !== null ? n * per : null;
}

/**
 * The bird a dish is built around, if any: by weight first, else — in a feast
 * only — by count. A count must be written whole: "½ whole chicken" at its own
 * servings would show one bird and double the dish, so it keeps servings.
 */
function dishBird(
  ingredients: readonly ScalableIngredient[],
  feast: boolean,
): { byWeight: boolean; ing: ScalableIngredient } | null {
  const w = ingredients.find((i) => i.quantity > 0 && isWholeBirdByWeight(i.unit ?? "", i.name));
  if (w) return { byWeight: true, ing: w };
  if (!feast) return null;
  const c = ingredients.find(
    (i) => i.quantity >= 1 && Number.isInteger(i.quantity) && isWholeBirdByCount(i.unit ?? "", i.name),
  );
  if (!c) return null;
  // WEB-4d (R5 / BUG-462's edge) — "1 whole turkey (12–14 lb)", New Twist's
  // bird: written by count, but its line gives the weight, so it takes the
  // WEIGHT rule (BIRD_FLOOR_LB, 10 lb for 14 → 10/14 at 4 of 10), not the
  // count's one-bird-whole-brine. The upper end of a range is the recipe's bird.
  const lb = birdWeightInName(c.name);
  if (lb !== null) return { byWeight: true, ing: { name: c.name, quantity: lb * c.quantity, unit: "pound" } };
  return { byWeight: false, ing: c };
}

/** The fields of an ingredient the bird rule reads. */
export interface ScalableIngredient {
  name: string;
  quantity: number;
  unit?: string | null;
}

/**
 * The multiplier every line of this dish scales by: the servings multiplier,
 * or — when the dish holds a whole bird — the bird's own factor: by weight, the
 * floored weight ÷ the recipe's (BIRD_FLOOR_LB applied); by count (WEB-4c), in a
 * feast only, the birds shown ÷ the birds written. A bird by weight decides first.
 */
export function dishScaleFactor(
  ingredients: readonly ScalableIngredient[],
  multiplier: number,
  feast = false,
): number {
  const bird = dishBird(ingredients, feast);
  if (!bird) return multiplier;
  const { ing } = bird;
  if (!bird.byWeight) return birdsShown(ing.quantity * multiplier) / ing.quantity;
  return wholeItemMultiplier(multiplier, (ing.unit ?? "").trim(), ing.name, ing.quantity);
}

/**
 * WEB-4c (BUG-462, BUG-464) — what scales by the BIRD, not by servings: a
 * bird's parts, the equipment, and a bird's own size in a step ("a frozen
 * 14-lb turkey"). There is one bird unless a bird by count shows more (birds
 * shown ÷ birds written):
 *   - `parts`: the MEAL's bird (Classic's neck sits in its Pan Gravy, not the
 *     turkey dish) — the first dish holding a bird decides;
 *   - `birds`: the line's OWN dish's bird. Equipment never scales by servings
 *     (one brining bag holds the bird at any size), but two turkeys need two
 *     bags; and two 14-lb turkeys are not one 28-lb turkey. A dish with no bird
 *     by count: 1.
 */
export interface BirdLine {
  parts: number;
  birds: number;
}

/** No bird by count: parts and equipment as written. */
export const ONE_BIRD: BirdLine = { parts: 1, birds: 1 };

/** Birds shown ÷ birds written for a feast dish's bird by count; 1 otherwise. */
function countBirdFactor(ingredients: readonly ScalableIngredient[], multiplier: number, feast: boolean): number {
  const bird = dishBird(ingredients, feast);
  return bird && !bird.byWeight ? birdsShown(bird.ing.quantity * multiplier) / bird.ing.quantity : 1;
}

/** The parts' factor for a whole meal: the first dish with a bird decides; no bird, 1. */
export function birdPartsFactor(
  dishes: readonly { ingredients: readonly ScalableIngredient[] }[],
  multiplier: number,
  feast = false,
): number {
  const withBird = dishes.find((d) => dishBird(d.ingredients, feast) !== null);
  return withBird ? countBirdFactor(withBird.ingredients, multiplier, feast) : 1;
}

/**
 * One dish's BirdLine. `parts` defaults to this dish alone — right for a screen
 * that shows one dish; a meal screen passes the meal's (birdPartsFactor).
 */
export function dishBirdLine(
  ingredients: readonly ScalableIngredient[],
  multiplier: number,
  feast = false,
  parts = birdPartsFactor([{ ingredients }], multiplier, feast),
): BirdLine {
  return { parts, birds: countBirdFactor(ingredients, multiplier, feast) };
}

/**
 * The multiplier ONE line scales by, given its dish's factor: equipment and a
 * bird part are one per bird (`birds`); a whole bird gets its floor (a no-op
 * once the factor is the bird's).
 */
export function lineMultiplier(
  dishFactor: number,
  unit: string,
  name: string,
  quantity?: number,
  birds: BirdLine = ONE_BIRD,
): number {
  if (isEquipment(name)) return birds.birds;
  if (isBirdPart(name)) return birds.parts;
  return wholeItemMultiplier(dishFactor, unit, name, quantity);
}

/**
 * Every dish's factor, keyed by dishId, for the screens that render a whole
 * meal (meal detail, Cook Mode). `mealOwned` is for steps that name no dish:
 * a one-dish meal's steps are that dish's; otherwise servings. `birds` and
 * `mealOwnedBirds` are the same for the parts and the equipment (BirdLine).
 * `feast` is isFeastMeal(meal.tags): only there does a dish follow a bird by count.
 */
export function mealScaleFactors(
  dishes: readonly { dishId: string; ingredients: readonly ScalableIngredient[] }[],
  multiplier: number,
  feast = false,
): {
  byDish: Readonly<Record<string, number>>;
  mealOwned: number;
  birds: Readonly<Record<string, BirdLine>>;
  mealOwnedBirds: BirdLine;
} {
  const byDish: Record<string, number> = {};
  const birds: Record<string, BirdLine> = {};
  const parts = birdPartsFactor(dishes, multiplier, feast);
  for (const d of dishes) {
    byDish[d.dishId] = dishScaleFactor(d.ingredients, multiplier, feast);
    birds[d.dishId] = dishBirdLine(d.ingredients, multiplier, feast, parts);
  }
  const only = dishes.length === 1 ? dishes[0].dishId : undefined;
  return {
    byDish,
    mealOwned: only !== undefined ? byDish[only] : multiplier,
    birds,
    mealOwnedBirds: only !== undefined ? birds[only] : { parts, birds: 1 },
  };
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
export function displayedQuantity(qty: number, unit: string, name = "", ctx: RoundingContext = {}): number {
  const u = unit.trim().toLowerCase();
  const r5 = ctx.scaled !== false && qty > 0;
  // WEB-4 — eggs: the nearest whole, halves up, never below 1.
  if (qty > 0 && isEggCount(u, name)) return Math.max(1, Math.floor(qty + 0.5 + TIE));
  // WEB-4c (BUG-464) — equipment is as written, never below 1.
  if (qty > 0 && isEquipment(name)) return Math.max(1, qty);
  // WEB-4b (BUG-458) — a pinch, a dash and a cinnamon stick are whole; WEB-4c
  // (BUG-464) — so are a stalk and a rib.
  if (qty > 0 && (isWholeSpice(u, name) || isStalk(u, name))) return Math.max(1, Math.round(qty));
  // WEB-4c (BUG-462) — a whole bird by count: the nearest whole, never below 1.
  if (qty > 0 && isWholeBirdByCount(u, name)) return birdsShown(qty);
  // WEB-4d (R5) — a package rounds up; produce to the nearest ½ (whole when the
  // cut word says so); pieces to the nearest whole. Never an unscaled amount.
  if (r5 && isPackage(u, name)) return Math.max(1, Math.ceil(qty - TIE));
  if (r5 && isWholeProduce(u, name)) {
    if (u === "whole" || CUT_WHOLE.test(`${name} ${ctx.note ?? ""}`)) return Math.max(1, Math.floor(qty + 0.5 + TIE));
    return Math.max(1 / 2, Math.floor(qty * 2 + 0.5 + TIE) / 2);
  }
  if (r5 && isWholePiece(u, name)) return Math.max(1, Math.floor(qty + 0.5 + TIE));
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
  // WEB-4d (R5) — ounces: whole from 4 oz, the nearest ½ below it, floor ½.
  if (r5 && OUNCE_UNITS.test(u)) {
    return qty >= 4 - TIE ? Math.floor(qty + 0.5 + TIE) : Math.max(1 / 2, Math.floor(qty * 2 + 0.5 + TIE) / 2);
  }
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

export function formatQuantity(qty: number, unit: string, name = "", ctx: RoundingContext = {}): string {
  const shown = displayedQuantity(qty, unit, name, ctx);
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

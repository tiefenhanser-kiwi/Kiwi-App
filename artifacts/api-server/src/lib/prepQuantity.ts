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

import { EQUIPMENT } from "./prepCombineEngine";

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

// ── 🔴 THX-3d (R5) — THE DISPLAY TABLE: OUNCES, PRODUCE, PACKAGES, PIECES ───
//
// WEB-4d's rows (`artifacts/kiwi/lib/format/quantity.ts`, 42907c2e), VERBATIM — the
// test pins them literally and reads the client file for drift:
//   - OUNCES: 4 oz and up → whole ounces; under 4 → the nearest ½ oz, never below ½.
//   - WHOLE PRODUCE by the piece (the head noun) → the nearest whole, never below 1,
//     PER SHARE: each portion line rounds on its own and the step's total is their
//     sum ("Work through 3 yellow onions" over 1 · 1 · 1, not 1⅞).
//   - PACKAGES (can, box, bag, jar, package, packet) → whole, ROUNDED UP, never below 1.
//   - PIECES (caps, sheets, crusts, crackers, leaves, sprigs) → the nearest whole,
//     never below 1 (3.2 sprigs → 3, where rule 1 ceiled to 4).
export const OUNCE_UNITS = /^(?:oz|ounces?|fl\.?\s*oz|fluid\s+ounces?)$/;
export const WHOLE_PRODUCE_HEAD =
  /^(?:onions?|carrots?|lemons?|oranges?|limes?|shallots?|jalape[nñ]os?|apples?|potato(?:es)?|chil(?:e|es|i|is|ies|li|lies)|chipotles?|serranos?|habaneros?|poblanos?)$/i;
/** THX-3d round 2 (O) — "chipotle peppers in adobo" is a chile, though its head says peppers (WEB-4d's). */
export const CHIPOTLE_PEPPER = /\bchipotle peppers?\b/i;
/** THX-3d round 2 (P) — the cut word that keeps produce whole (WEB-4d's CUT_WHOLE). */
export const CUT_WHOLE = /\b(?:quartered|halved|whole|cut (?:in|into) (?:half|halves|quarters|wedges))\b/i;
/** THX-3d round 2 (O) — a packaged mix made by its directions is the whole package (WEB-4d's). */
export const PACKAGE_DIRECTIONS =
  /\b(?:cornbread|muffin|cake|brownie|biscuit|pancake|waffle|cookie|bread) mix(?:es)?\b|\b(?:per|according to)(?: the)? package (?:directions|instructions)\b/i;
export const PACKAGE_WORD = /\b(?:cans?|box(?:es)?|bags?|jars?|packages?|packets?)\b/i;
export const WHOLE_PIECE_UNITS = /^(?:sheets?|caps?|crusts?|crackers?|lea(?:f|ves)|sprigs?)$/;
export const WHOLE_PIECE_NAME = /(?<![-‑])\b(?:caps?|sheets?|crusts?|crackers?|lea(?:f|ves)|sprigs?)\b/i;

/** THX-3d round 2 (P) — how a share is shown: as the recipe wrote it (unscaled), and its cut. */
export interface DisplayOptions {
  /** The share is the row's own amount at its own servings: printed as written. */
  asWritten?: boolean;
  /** The row's preparation note: "quartered" and "halved" keep produce whole. */
  note?: string | null;
  /** SERVER-12 C — a total of amounts at their own servings: a cup stays a cup (spoonedCup). */
  keepCup?: boolean;
}

/** The head noun of a name: its last word before a comma, a parenthesis, or
 *  "in"/"from"/"packed" ("chipotle chiles in adobo sauce" → chiles). WEB-4d's. */
function headNoun(name: string): string {
  const words = name.split(/[,(]|\s(?:in|from|packed)\s/i)[0].trim().split(/\s+/);
  return words[words.length - 1] ?? "";
}

/** THX-3d (R5) — onion, carrot, lemon … counted by the piece. */
export function isWholeProduce(unit: string, name: string): boolean {
  return COUNT_UNITS.has(unit.trim().toLowerCase()) && (WHOLE_PRODUCE_HEAD.test(headNoun(name)) || CHIPOTLE_PEPPER.test(name));
}

/** THX-3d (R5) — a can, box, bag, jar or package: by its unit, or by name on a count. */
export function isPackage(unit: string, name: string): boolean {
  const u = unit.trim().toLowerCase();
  return PACKAGE_WORD.test(u) || (COUNT_UNITS.has(u) && PACKAGE_WORD.test(name));
}

/** A package's own size, from its unit or name: "can (15 oz)", "15-ounce can",
 *  "cornbread mix (8.5 oz box)". A count size ("package (2-count)") is not one. WEB-4d's. */
const PACKAGE_SIZE = /(\d+(?:\.\d+)?)\s*[-‑]?\s*(fl\.?\s*oz|oz|ounces?|lbs?|pounds?|g|grams?|ml)\b/i;

/**
 * THX-3d (R5) — "use 6 oz": how much of a package the recipe takes, when the package
 * count was rounded up and the recipe gives the package's size (WEB-4d's packageUse).
 * `scaled` is the true package count (⅜ of a can); null when nothing was rounded or
 * there is no size to say it in.
 */
export function packageUse(scaled: number, unit: string, name: string, note = ""): string | null {
  if (!(scaled > 0) || !isPackage(unit, name)) return null;
  // THX-3d round 2 (O) — a packaged mix made by its directions: the whole package, no "use".
  if (PACKAGE_DIRECTIONS.test(`${name} ${note}`)) return null;
  if (Math.abs(displayedPrepQuantity(scaled, unit, name) - scaled) < 1e-6) return null;
  const size = PACKAGE_SIZE.exec(`${unit} ${name}`);
  if (!size) return null;
  const sizeUnit = size[2];
  const amount = scaled * Number(size[1]);
  const shown = displayedPrepQuantity(amount, sizeUnit.toLowerCase());
  const word = /^(oz|fl\.?\s*oz|g|ml)$/i.test(sizeUnit) ? sizeUnit : shown > 1 ? `${sizeUnit.replace(/s$/i, "")}s` : sizeUnit.replace(/s$/i, "");
  return `use ${mixedGlyph(shown)} ${word}`;
}

/** THX-3d (R5) — the rules a share rounds by on its own, before shares are summed (WEB-4d's). */
export function roundsPerShare(unit: string, name: string): boolean {
  const u = unit.trim().toLowerCase();
  return isWholeProduce(u, name) || isPackage(u, name) || isWholePiece(u, name);
}

/** THX-3d (R5) — what the grocery list buys whole per share: produce by the piece, a package.
 *  SERVER-10 B (BUG-606) — and a garlic clove, which prep counts whole per share. */
export function buysWholePerShare(unit: string, name: string): boolean {
  const u = unit.trim().toLowerCase();
  return isWholeProduce(u, name) || isPackage(u, name) || isClove(u, name);
}

/** A garlic clove: the unit says clove, or a count of a name that does ("6 each garlic cloves"). */
function isClove(unit: string, name: string): boolean {
  return /^cloves?$/.test(unit) || (COUNT_UNITS.has(unit) && /\bcloves?\b/i.test(name));
}

/**
 * SERVER-10 B (BUG-587, BUG-606) — what the GROCERY LIST buys of one share, before
 * the shares are summed. Never less than the share.
 *
 * THX-3d (R5) rounded a share by the prep card's DISPLAY rule, which rounds to the
 * nearest: h7's Make-Ahead feast needed 3.2 shallots and the list bought 3, because
 * the share showed as 3. The card may show the nearest; the list may not buy less
 * than the recipe. So, on the list:
 *   - produce by the piece rounds UP to the next ½ (½ + ½ is still one onion, cut
 *     from one), or to a whole when the cut keeps it whole ("halved", "whole");
 *   - a package and a garlic clove round UP to a whole (a clove is minced whole,
 *     and prep counts it per share: h7's prep asked for 16 cloves where the list,
 *     summing 13⅝ raw, bought fewer).
 * The summed row is then whole (consolidatePlanIngredients, and D-WS9-360 in
 * needQuantity.ts). Prep and Cook Mode keep displayedPrepQuantity.
 */
export function listShareQuantity(qty: number, unit: string, name: string, opts: { note?: string | null } = {}): number {
  if (!(qty > 0)) return qty;
  const u = unit.trim().toLowerCase();
  if (isPackage(u, name) || isClove(u, name)) return Math.max(1, Math.ceil(qty - TIE));
  if (isWholeProduce(u, name)) {
    if (u === "whole" || CUT_WHOLE.test(`${name} ${opts.note ?? ""}`)) return Math.max(1, Math.ceil(qty - TIE));
    return Math.max(1 / 2, Math.ceil(qty * 2 - TIE) / 2);
  }
  return qty;
}

function isWholePiece(unit: string, name: string): boolean {
  const u = unit.trim().toLowerCase();
  return WHOLE_PIECE_UNITS.test(u) || (COUNT_UNITS.has(u) && WHOLE_PIECE_NAME.test(name));
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

/** "(12–14 lb)", "(14 pounds)", "(6 kg)" in a bird's name: the weight in
 *  pounds, the upper end of a range; null when the name gives none. WEB-4d's, verbatim. */
export const NAME_WEIGHT = /(\d+(?:\.\d+)?)(?:\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?))?\s*[-‑]?\s*(lbs?|pounds?|kg|kilograms?)\b/i;

export function birdWeightInName(name: string): number | null {
  const m = NAME_WEIGHT.exec(name);
  if (!m) return null;
  const n = Number(m[2] ?? m[1]);
  const per = poundsPer(m[3]);
  return n > 0 && per !== null ? n * per : null;
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

/** THX-3c (BUG-464) — a stalk or rib unit, and a count of a food named by its stalks. */
const WHOLE_STALK_UNIT = /^(stalks?|ribs?)$/;
const WHOLE_STALK_NAME = /\bstalks?\b|\bcelery ribs?\b/i;

/**
 * THX-3c (BUG-464) — EQUIPMENT NEVER SCALES: a brining bag, twine, foil, parchment,
 * cheesecloth. At 4 of 10 servings the turkey's "1 large brining bag" scaled with the
 * servings. The engine's own equipment list (prepCombineEngine EQUIPMENT, read by
 * `isNeverMeasured`), the same regex WEB-4c copied. Printed as written, never below 1
 * — and one per bird beside a bird written by count (two turkeys, two bags).
 *
 * ⚠️ NOT SKEWERS OR TOOTHPICKS (WEB-4c, aa4b148, measured): they are one per piece of
 * food, so they keep rule 1's whole-item ceiling and scale with it — "8 wooden
 * skewers" held at 8 beside 2 lb of shrimp at "4–5 per skewer" is wrong.
 */
export function isEquipmentItem(name: string): boolean {
  return EQUIPMENT.test(name);
}

/** The multiplier that prints an equipment row as written (never below 1). */
function asWritten(quantity: number): number {
  return quantity > 0 ? Math.max(1, quantity) / quantity : 1;
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
//   2. the bird's FACTOR is its weight ÷ the recipe's weight, and every other
//      row of a whole-bird dish (by `isWholeBirdByWeight`) scales by it, not by
//      servings — the brine's salt, sugar and water, the butter, herbs, aromatics;
//   3. a bird's own parts (neck, giblets) are the authored count, in any dish;
//   4. above the recipe's servings it stays linear (no cap).
// THX-3c (BUG-454 · BUG-462) — WEB-4b's definition of the factor, so both sides
// agree: the bird's weight AFTER the floor and BEFORE the ¼ lb display rounding ÷
// the recipe's weight. It equals the servings multiplier wherever the floor does
// not bind (8 of 10 is 0.8, not 11¼ / 14); the shown amounts did not move.
//
// THX-3c (BUG-462) — A BIRD WRITTEN BY COUNT ("1 whole turkey", the Buttermilk-
// Brined turkey) is that many whole birds: max(1, the nearest whole, halves up). Its
// dish's other rows scale by the SHOWN count ÷ the recipe's count, and a neck or
// giblets in that dish are one per bird (they scale with it). WEB-4c pins the same
// inputs at 1, 4, 10, 15 and 20 servings.

/** True for a whole bird written by count ("1 each whole turkey"). */
export function isWholeBirdByCount(unit: string, name: string): boolean {
  return COUNT_UNITS.has(unit.trim().toLowerCase()) && WHOLE_BIRD.test(name);
}

/** The number of birds a count-written bird shows at `multiplier`: the nearest whole, never below 1. */
export function wholeBirdCount(quantity: number, multiplier: number): number {
  return Math.max(1, Math.floor(quantity * multiplier + 0.5 + TIE));
}

// ── THX-4 (D-WS9-324) — THE TURKEY'S WEIGHT, SET BY THE COOK ─────────────────
//
// A plan item may carry the weight the cook chose (MealPlanItem.birdWeightLb). Then
// that one bird is bought and roasted, in place of the servings rule: the bird's row
// shows the chosen weight (or ONE bird, written by count), every other row of its dish
// follows chosen ÷ the recipe's weight (no floor — the cook chose it), a neck or
// giblets is the one bird's, and equipment prints as written. Turkeys only (v1): by
// weight ("14 pound whole turkey"), or by count with a weight in its name or its note
// ("1 whole turkey (12–14 lb)", the Buttermilk-Brined turkey's "12–14 lb" note) — the
// upper end, as the name rule reads it. A breast is not a whole bird (WHOLE_BIRD).

const TURKEY = /\bturkeys?\b/i;

/** The turkey a cook can weigh, in a dish's rows: its row, the recipe's weight, how it is written. */
export interface WeighedTurkey { row: number; recipeLb: number; byCount: boolean }

export function weighedTurkeyOf(rows: readonly { quantity: number; unit: string; name: string; note?: string | null }[]): WeighedTurkey | null {
  for (const [row, r] of rows.entries()) {
    if (!(r.quantity > 0) || !TURKEY.test(r.name)) continue;
    if (isWholeBirdByWeight(r.unit, r.name)) {
      const per = poundsPer(r.unit);
      if (per !== null) return { row, recipeLb: r.quantity * per, byCount: false };
    }
    if (isWholeBirdByCount(r.unit, r.name)) {
      const each = birdWeightInName(r.name) ?? (r.note ? birdWeightInName(r.note) : null);
      if (each !== null) return { row, recipeLb: each * r.quantity, byCount: true };
    }
  }
  return null;
}

/**
 * The multiplier each row of ONE dish scales by, in row order, given the dish's
 * servings multiplier. Rows are the dish's raw (unscaled) ingredient rows.
 */
export function dishRowMultipliers(
  rows: readonly { quantity: number; unit: string; name: string; note?: string | null }[],
  multiplier: number,
  /**
   * THX-3c (item 2, chat-Claude's ruling) — the dish is a `thanksgiving-feast` meal's.
   * Only there does a dish FOLLOW a bird written by count: Chicken Pho at household 2
   * printed its whole 4-serving pot (noodles, sprouts) for its "1 whole chicken".
   * Elsewhere the bird still shows whole birds and everything else follows servings.
   * The weight rule (the floor and its factor) is the same everywhere.
   *
   * THX-4 (D-WS9-324) — `birdLb`: the weight the cook chose for this dish's turkey
   * (weighedTurkeyOf). Absent, nothing below changes.
   */
  opts: { feast?: boolean; birdLb?: number } = {},
): number[] {
  if (opts.birdLb !== undefined) {
    const t = weighedTurkeyOf(rows);
    if (t) {
      const factor = opts.birdLb / t.recipeLb;
      const birds = rows[t.row].quantity;
      return rows.map((r, i) => {
        // The bird: the chosen weight, or one bird written by count.
        if (i === t.row) return t.byCount ? 1 / birds : factor;
        if (isEquipmentItem(r.name)) return asWritten(r.quantity);
        // A part is the one bird's.
        if (BIRD_PART.test(r.name)) return t.byCount ? 1 / birds : 1;
        return factor;
      });
    }
  }
  // THX-3d (G) — "1 whole turkey (12–14 lb)", New Twist's bird: written by count, but
  // its line gives the weight, so it takes the WEIGHT rule (the floor: 10 lb for 14, a
  // factor of 10/14 at 4 of 10) and its butter, garlic and citrus scale with it. In a
  // feast only, like the count rule; WEB-4d pins the same (dishBird, birdWeightInName).
  const named = opts.feast
    ? rows.find((r) => r.quantity > 0 && isWholeBirdByCount(r.unit, r.name) && !/\brotisserie\b/i.test(r.name) && birdWeightInName(r.name) !== null)
    : undefined;
  const bird = rows.find((r) => r.quantity > 0 && isWholeBirdByWeight(r.unit, r.name)) ??
    (named ? { ...named, unit: "pound", quantity: birdWeightInName(named.name)! * named.quantity } : undefined);
  // ⚠️ THX-3c — NOT A ROTISSERIE CHICKEN. It is bought cooked and shredded into a
  // soup, salad or wrap (18 of dev's 25 count-written birds); the dish is not FOR the
  // bird, and following it doubled a Chicken Noodle Soup at half servings (census, 80
  // plans). Its own line still shows whole birds.
  const byCount = bird ? undefined : rows.find((r) => r.quantity > 0 && isWholeBirdByCount(r.unit, r.name));
  const counted = byCount && opts.feast && !/\brotisserie\b/i.test(byCount.name) ? byCount : undefined;
  const factor = bird
    ? wholeItemMultiplier(multiplier, bird.unit, bird.name, bird.quantity)
    : counted
      ? wholeBirdCount(counted.quantity, multiplier) / counted.quantity
      : multiplier;
  return rows.map((r) => {
    // THX-3c (BUG-464) — equipment as written, in any dish.
    if (isEquipmentItem(r.name)) return asWritten(r.quantity) * (counted ? factor : 1);
    // A part is one per bird: one for a bird by weight (or in another dish), the
    // count's factor beside a bird written by count.
    if (BIRD_PART.test(r.name)) return counted ? factor : 1;
    // A bird by count that its dish does not follow is still whole birds.
    if (r === byCount && !counted) return wholeBirdCount(r.quantity, multiplier) / r.quantity;
    return factor;
  });
}

/**
 * The number the prep text shows for `qty` of `unit` (a raw or canonical unit
 * string) of the ingredient `name`. Display only: the engine's sums and the
 * grocery list never read it.
 */
export function displayedPrepQuantity(qty: number, unit: string, name = "", opts: DisplayOptions = {}): number {
  const u = unit.trim().toLowerCase();
  // THX-3d round 2 (P) — an UNSCALED amount is never rounded by R5 (packages, produce,
  // pieces, ounces): "½ lemon" and "14½ oz" print as written at the recipe's own servings.
  const r5 = !opts.asWritten && qty > 0;
  // Hans's egg rule — before rule 1, which would ceil them.
  if (COUNT_UNITS.has(u) && EGG_NAME.test(name)) return Math.max(1, Math.floor(qty + 0.5 + TIE));
  // ⚠️ SERVER-ONLY, NOT IN FIX-7's TABLE: a pinch, a dash and a cinnamon stick
  // are whole. At household 8 the feast printed "¾ pinch" salt and "¾ cinnamon
  // stick" — measured, not a guess. The client prints the same today (reported to
  // the client lane); kept outside the pinned table so the drift guard holds.
  if (/^(pinch(?:es)?|dash(?:es)?)$/.test(u) || (COUNT_UNITS.has(u) && /\b(cinnamon sticks?|star anise|vanilla beans?)\b/i.test(name))) {
    return Math.max(1, Math.round(qty));
  }
  // THX-3c (BUG-464) — a stalk or a rib is whole too, by the same token rule: the
  // unit word, or a count of a name that says it ("6 each celery stalks"). At 8 of
  // 10 servings Classic's stuffing printed "4¾ stalks" of celery. Matched with WEB-4c.
  if (WHOLE_STALK_UNIT.test(u) || (COUNT_UNITS.has(u) && WHOLE_STALK_NAME.test(name))) {
    return Math.max(1, Math.round(qty));
  }
  // THX-3d (R5) — a package rounds up; produce and pieces to the nearest whole (the
  // client's order: before rule 1, which would ceil a sprig).
  if (r5 && isPackage(u, name)) return Math.max(1, Math.ceil(qty - TIE));
  // THX-3d round 2 (P) — produce by the piece to the nearest ½, never below ½ ("⅜ onion"
  // → ½, "2⅜ shallots" → 2½); a quartered onion or a halved lemon for the cavity stays
  // whole — the cut word decides. Pieces (sprigs, leaves, caps …) to the nearest whole.
  if (r5 && isWholeProduce(u, name)) {
    if (u === "whole" || CUT_WHOLE.test(`${name} ${opts.note ?? ""}`)) return Math.max(1, Math.floor(qty + 0.5 + TIE));
    return Math.max(1 / 2, Math.floor(qty * 2 + 0.5 + TIE) / 2);
  }
  if (r5 && isWholePiece(u, name)) return Math.max(1, Math.floor(qty + 0.5 + TIE));
  // Rule 1 — whole counted items, by unit word or by name on a count unit.
  if (WHOLE_UNITS.includes(singularUnit(u)) || (COUNT_UNITS.has(u) && (WHOLE_ITEM_NAME.test(name) || WHOLE_BIRD.test(name)))) {
    return Math.max(1, Math.ceil(qty - TIE));
  }
  // Rule 3 — pounds in quarter steps, ties up, floor ¼.
  if (POUND_TOKENS.test(u)) return Math.max(1 / 4, Math.floor(qty * 4 + 0.5 + TIE) / 4);
  // THX-3d (R5) — ounces: whole from 4 oz, the nearest ½ below it, floor ½.
  if (r5 && OUNCE_UNITS.test(u)) {
    return qty >= 4 - TIE ? Math.floor(qty + 0.5 + TIE) : Math.max(1 / 2, Math.floor(qty * 2 + 0.5 + TIE) / 2);
  }
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

/**
 * SERVER-12 C (BUG-623) — A SMALL SCALED CUP AMOUNT IS SAID IN SPOONS. Classic Crispy
 * Sesame Chicken at 3 of 4 needs 3 tbsp flour (¼ cup × ¾ = 3⁄16 cup), and the cup ladder
 * snapped the tie UP to "¼ cup", a third more than the recipe. Spoons measure what a cup
 * ladder cannot, so a scaled cup amount below ¼ cup (4 tbsp) is said in tablespoons, and
 * below 1 tbsp in teaspoons; the cup ladder starts at ¼ cup. An amount at its own servings
 * (`asWritten`) is printed as the recipe wrote it ("⅛ cup" stays).
 *
 * ⚠️ SERVER-ONLY, LIKE THE EGG RULE: the client's formatter (lib/format/quantity.ts) still
 * snaps 3⁄16 cup to ¼ in Cook Mode; that half is the client lane's.
 *
 * 🔴 NOT IN THE FEAST (yet): Thanksgiving is frozen, and the rule moves 15 of 30 feast
 * reads ("¼ cup" → "3¼ tbsp" at Classic ×4). The feast session builds and finishes
 * inside `withCupLadder`, the ladder as it was, until Hans rules.
 */
let cupLadderOnly = 0;
/** Run a synchronous `build` with the cup ladder as it was (no spoons under ¼ cup): the feast session. */
export function withCupLadder<T>(build: () => T): T {
  cupLadderOnly++;
  try {
    return build();
  } finally {
    cupLadderOnly--;
  }
}
export function spoonedCup(qty: number, unit: string, opts: DisplayOptions = {}): { qty: number; unit: string } | null {
  if (cupLadderOnly > 0 || opts.asWritten || opts.keepCup || !(qty > 0) || !CUP_TOKENS.test(unit.trim().toLowerCase()) || qty >= 1 / 4 - TIE) return null;
  const tbsp = qty * 16;
  // (Just under ¼ cup that the spoons would say as 4 tbsp is ¼ cup.)
  if (displayedPrepQuantity(tbsp, "tbsp") >= 4 - TIE) return null;
  return tbsp >= 1 - TIE ? { qty: tbsp, unit: "tbsp" } : { qty: tbsp * 3, unit: "tsp" };
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

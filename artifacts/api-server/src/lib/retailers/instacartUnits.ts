// Row 8 · Block 1 — unit mapping for the Instacart Developer Platform
// "Create Shopping List Page" payload. Two tables, two pure functions, no I/O.
//
// Instacart's line item carries TWO unit fields with different jobs:
//   • `quantity` + `unit`            — the ORDER line: how much to put in the
//                                      cart, in a countable or weighed unit.
//   • `line_item_measurements[]`     — the MEASURED NEED: a recipe amount the
//                                      shopper (and Instacart's matcher) can
//                                      read against product sizes.
// An unlisted unit is assumed to be silently dropped or mismatched on their
// side, so both mappers emit ONLY spellings from Instacart's own vocabulary
// (their reference, September 19, 2026; note `tbsp` is NOT in it — `tb`,
// `tbs`, `tablespoon` are).
//
// The order-line table deliberately does NOT carry teaspoon/tablespoon/cup:
// a need of "2 teaspoon cumin" with no pack behind it is ONE JAR, not two
// teaspoons in the cart. Those needs ride in the measurement; the order line
// falls to `1 each` and the unit is reported in `unmappedUnits` so the census
// (§3 of the block prompt) stays visible rather than being quietly absorbed.
//
// ⚠️ Instacart also offers SIZE-BEARING units (`oz can`, `fl oz jar`, `lb
// bag`, `oz container`…) whose quantity semantics — size, or count — their
// docs do not state. They are NOT in this table on purpose; the Part D probe
// sends one and chat-Claude rules from what the landing page shows. Container
// words map to `each` with the size kept in `display_text`.

export type InstacartOrderUnit =
  | "each"
  | "can"
  | "bunch"
  | "head"
  | "package"
  | "packet"
  | "large"
  | "medium"
  | "small"
  | "ears"
  | "pound"
  | "ounce"
  | "pint"
  | "gram";

export type InstacartMeasureUnit =
  | "teaspoon"
  | "tablespoon"
  | "cup"
  | "ounce"
  | "pound"
  | "gram"
  | "kilogram"
  | "pint"
  | "quart"
  | "milliliter"
  | "liter"
  | "gallon";

/** Lower-case, trimmed, inner whitespace collapsed. "" for null/undefined. */
export function normalizeUnitToken(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// ── ORDER LINE (R3) ────────────────────────────────────────────────────

interface OrderRule {
  unit: InstacartOrderUnit;
  /** Quantity multiplier (dozen → each × 12). 1 for everything else. */
  factor: number;
}

const passThrough = (unit: InstacartOrderUnit): OrderRule => ({ unit, factor: 1 });

/**
 * Pack-unit token → Instacart order unit. Countable units pass through;
 * weight/volume units send the TOTAL in that unit (the caller multiplies
 * count × per-pack size before calling — see instacartPayload.ts); container
 * words become `each` (the size stays in display_text); `dozen` is twelve
 * `each`. Keys are normalized tokens; plurals and the common abbreviations
 * seen in the live census are listed explicitly rather than stemmed, so an
 * unexpected spelling surfaces as unmapped instead of guessing.
 */
export const INSTACART_ORDER_UNITS: Readonly<Record<string, OrderRule>> = {
  // countable — pass through
  each: passThrough("each"),
  ea: passThrough("each"),
  piece: passThrough("each"),
  pieces: passThrough("each"),
  can: passThrough("can"),
  cans: passThrough("can"),
  bunch: passThrough("bunch"),
  bunches: passThrough("bunch"),
  head: passThrough("head"),
  heads: passThrough("head"),
  package: passThrough("package"),
  packages: passThrough("package"),
  pack: passThrough("package"),
  packet: passThrough("packet"),
  packets: passThrough("packet"),
  large: passThrough("large"),
  medium: passThrough("medium"),
  small: passThrough("small"),
  ear: passThrough("ears"),
  ears: passThrough("ears"),
  // weight / volume — TOTAL in the unit
  lb: passThrough("pound"),
  lbs: passThrough("pound"),
  pound: passThrough("pound"),
  pounds: passThrough("pound"),
  oz: passThrough("ounce"),
  ounce: passThrough("ounce"),
  ounces: passThrough("ounce"),
  pint: passThrough("pint"),
  pints: passThrough("pint"),
  pt: passThrough("pint"),
  g: passThrough("gram"),
  gram: passThrough("gram"),
  grams: passThrough("gram"),
  // dozen → each × 12
  dozen: { unit: "each", factor: 12 },
  // container words → each; the size lives in display_text
  container: passThrough("each"),
  containers: passThrough("each"),
  bottle: passThrough("each"),
  bottles: passThrough("each"),
  jar: passThrough("each"),
  jars: passThrough("each"),
  bag: passThrough("each"),
  bags: passThrough("each"),
  box: passThrough("each"),
  boxes: passThrough("each"),
  block: passThrough("each"),
  blocks: passThrough("each"),
  carton: passThrough("each"),
  cartons: passThrough("each"),
  loaf: passThrough("each"),
  loaves: passThrough("each"),
  tube: passThrough("each"),
  tubes: passThrough("each"),
  wedge: passThrough("each"),
  wedges: passThrough("each"),
};

export interface OrderLine {
  quantity: number;
  unit: InstacartOrderUnit;
  /** False when the unit was not in the table and `each` was substituted. */
  mapped: boolean;
}

/**
 * Compose the order line from a quantity already TOTALLED in `rawUnit`
 * (count × per-pack size for weighed packs; the pack count for countable
 * ones). An unknown unit yields `each` at the same quantity with
 * `mapped: false` so the caller can report it. Quantity is rounded to two
 * decimals (Instacart accepts decimals; float noise like 2.9999 does not
 * belong on an order).
 */
export function mapOrderUnit(rawUnit: string | null | undefined, quantity: number): OrderLine {
  const token = normalizeUnitToken(rawUnit);
  const rule = token.length > 0 ? INSTACART_ORDER_UNITS[token] : undefined;
  if (!rule) {
    return { quantity: roundQuantity(quantity), unit: "each", mapped: false };
  }
  return {
    quantity: roundQuantity(quantity * rule.factor),
    unit: rule.unit,
    mapped: true,
  };
}

// ── MEASUREMENT (R4, tightened in Part E2) ──────────────────────────────
//
// A measurement is only unambiguous when it is a TRUE MEASURE. The live +8
// list sent chipotle as order line `1 can` beside measurement `[2 each]` and
// limes as `2 each` + `[5 each]` — two of WHAT, cans or peppers? — so count
// needs (each, can, bunch, head, large, package, packet, dozen …) send NO
// measurement element; the order line carries the count. Only weight and
// volume units are in this table.

interface MeasureRule {
  unit: InstacartMeasureUnit;
  factor: number;
}

const measure = (unit: InstacartMeasureUnit): MeasureRule => ({ unit, factor: 1 });

/**
 * Need-unit token → Instacart measurement unit, WEIGHT AND VOLUME ONLY.
 * Anything absent here — every count unit, and the no-equivalent set (clove,
 * sprig, slice, pinch, pod, stalk, pepper, second, container nouns) — has NO
 * measurement; the caller omits the array element rather than sending a
 * count or a unit Instacart does not list.
 */
export const INSTACART_MEASURE_UNITS: Readonly<Record<string, MeasureRule>> = {
  teaspoon: measure("teaspoon"),
  teaspoons: measure("teaspoon"),
  tsp: measure("teaspoon"),
  tablespoon: measure("tablespoon"),
  tablespoons: measure("tablespoon"),
  tbsp: measure("tablespoon"),
  tbs: measure("tablespoon"),
  tb: measure("tablespoon"),
  cup: measure("cup"),
  cups: measure("cup"),
  ounce: measure("ounce"),
  ounces: measure("ounce"),
  oz: measure("ounce"),
  pound: measure("pound"),
  pounds: measure("pound"),
  lb: measure("pound"),
  lbs: measure("pound"),
  gram: measure("gram"),
  grams: measure("gram"),
  g: measure("gram"),
  kilogram: measure("kilogram"),
  kilograms: measure("kilogram"),
  kg: measure("kilogram"),
  pint: measure("pint"),
  pints: measure("pint"),
  quart: measure("quart"),
  quarts: measure("quart"),
  milliliter: measure("milliliter"),
  milliliters: measure("milliliter"),
  ml: measure("milliliter"),
  liter: measure("liter"),
  liters: measure("liter"),
  l: measure("liter"),
  gallon: measure("gallon"),
  gallons: measure("gallon"),
};

export interface Measurement {
  quantity: number;
  unit: InstacartMeasureUnit;
}

/** Null when the need unit has no Instacart measurement (omit the element). */
export function mapMeasurement(
  rawUnit: string | null | undefined,
  quantity: number,
): Measurement | null {
  const token = normalizeUnitToken(rawUnit);
  const rule = token.length > 0 ? INSTACART_MEASURE_UNITS[token] : undefined;
  if (!rule) return null;
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  return { quantity: roundQuantity(quantity * rule.factor), unit: rule.unit };
}

function roundQuantity(n: number): number {
  return Math.round(n * 100) / 100;
}

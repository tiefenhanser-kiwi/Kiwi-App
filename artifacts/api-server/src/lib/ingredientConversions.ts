// WS7-8b Block B2 (D-WS7-197 / BUG-025-1) — shared ingredient unit-conversion
// + purchase-size table. ONE service, two consumers:
//   1. Grocery (consolidation) — purchase sizing, head↔clove equivalence, and
//      density-aware merge of same-canonical/different-unit rows.
//   2. Macros (nutrition.ingredient_estimate) — quantity→grams grounding that
//      replaces the AI's kitchen-density guess (closes D-WS6-024 Step 2).
//
// This module ABSORBS the former ingredientPurchaseDefaults.ts — it is the
// single source of truth for purchase packs AND conversion factors. Do NOT
// re-introduce a second density map; if a consumer needs a factor, it reads it
// from here (or from the persisted `Ingredient.conversionRef`, which the seed +
// backfill populate from this table + USDA foodPortions).
//
// Provenance discipline (Phase 0 correction — there is NO `dataSource` scalar
// column; USDA nutrition provenance is a `source` discriminator inside the
// nutritionRefPerUnit JSON, ingredientEnrichment.ts:34-50). We mirror that: the
// conversion payload is a `conversionRef Json?` column whose `source` field
// stamps every row 'curated' | 'usda_derived' | 'ai_estimated'. An AI guess is
// NEVER laundered into the shared catalog unstamped.

export type ConversionSource = "curated" | "usda_derived" | "ai_estimated";

// Sub-unit equivalence — the head↔clove case (BUG-025-1). `perParent` children
// make up one `parent` (1 head = 10 cloves). Keeps count↔count conversions and
// purchase-pack sanity ("need 2 cloves" → "1 head", not "2 heads") off the AI.
export interface SubUnitEquivalence {
  parent: string; // e.g. "head"
  perParent: number; // e.g. 10 cloves per head
}

// One conversion/purchase row. Every field except `source` is optional: a
// USDA-derived row may carry only gramsPerCup/gramsPerEach with no purchase
// pack; a purchase-only row may carry no density. The shape is identical for
// the code table (INGREDIENT_CONVERSIONS) and the persisted conversionRef JSON.
export interface IngredientConversion {
  // Volume↔weight: grams per 1 US cup. Fixed volume ratios (1 cup = 16 tbsp =
  // 48 tsp) derive every other volume unit, so one number covers them all.
  gramsPerCup?: number;
  // Count↔weight: grams per one whole "each" (1 medium onion ≈ 110 g).
  gramsPerEach?: number;
  // Sub-unit equivalence (head↔clove).
  subUnit?: SubUnitEquivalence;
  // Purchase pack (absorbed from ingredientPurchaseDefaults).
  purchaseUnit?: string;
  purchaseQuantity?: number;
  purchaseDisplay?: string;
  source: ConversionSource;
  confidence?: "high" | "medium" | "low";
}

// Purchase-only subset — the back-compat shape the create-time upsert
// (ingredientResolve) and the synthetic-recurring path (groceryList) consume.
export interface IngredientPurchase {
  purchaseUnit: string;
  purchaseQuantity: number;
  purchaseDisplay: string;
}

// ── unit factor maps (pure kitchen math; no per-ingredient data) ───────────

// Volume unit → US cups. gramsPerCup × (unit-in-cups) × qty = grams.
const VOLUME_UNIT_TO_CUPS: Record<string, number> = {
  cup: 1,
  cups: 1,
  tablespoon: 1 / 16,
  tablespoons: 1 / 16,
  tbsp: 1 / 16,
  tbsps: 1 / 16,
  teaspoon: 1 / 48,
  teaspoons: 1 / 48,
  tsp: 1 / 48,
  tsps: 1 / 48,
  "fl oz": 1 / 8,
  "fluid ounce": 1 / 8,
  "fluid ounces": 1 / 8,
  pint: 2,
  pints: 2,
  quart: 4,
  quarts: 4,
  gallon: 16,
  gallons: 16,
  ml: 1 / 236.588,
  milliliter: 1 / 236.588,
  milliliters: 1 / 236.588,
  l: 1000 / 236.588,
  liter: 1000 / 236.588,
  liters: 1000 / 236.588,
};

// Weight unit → grams. Direct, ingredient-independent.
const WEIGHT_UNIT_TO_GRAMS: Record<string, number> = {
  g: 1,
  gram: 1,
  grams: 1,
  kg: 1000,
  kilogram: 1000,
  kilograms: 1000,
  oz: 28.349523125,
  ounce: 28.349523125,
  ounces: 28.349523125,
  lb: 453.59237,
  lbs: 453.59237,
  pound: 453.59237,
  pounds: 453.59237,
};

// Count-ish units — one whole item (or a subUnit child). gramsPerEach applies
// to "each"/"whole"; subUnit children (clove) convert via SubUnitEquivalence.
const COUNT_UNITS = new Set<string>([
  "each",
  "whole",
  "",
  "piece",
  "pieces",
  "count",
  "ct",
]);

export function normalizeUnit(unit: string): string {
  return unit.trim().toLowerCase();
}

export function isVolumeUnit(unit: string): boolean {
  return normalizeUnit(unit) in VOLUME_UNIT_TO_CUPS;
}

export function isWeightUnit(unit: string): boolean {
  return normalizeUnit(unit) in WEIGHT_UNIT_TO_GRAMS;
}

export function isCountUnit(unit: string): boolean {
  return COUNT_UNITS.has(normalizeUnit(unit));
}

/**
 * True when converting this unit to grams REQUIRES a per-ingredient factor
 * (density for volume, grams-per-each for count) — i.e. a table/AI lookup can
 * help. Weight units need no factor; unmappable units ("to taste") can't be
 * helped. Used by the macro path to decide whether an AI conversion fallback
 * is worth attempting.
 */
export function needsConversionFactor(unit: string): boolean {
  return isVolumeUnit(unit) || isCountUnit(unit);
}

/**
 * Convert (qty, unit) → grams for one ingredient, using its conversion row.
 * Returns null when the conversion is not determinable (e.g. a volume unit with
 * no gramsPerCup, or a count unit with no gramsPerEach) — callers fall back to
 * the AI path rather than fabricate a number.
 *
 * Weight units convert with no per-ingredient data. Volume needs gramsPerCup.
 * Count ("each"/"whole") needs gramsPerEach. A subUnit child (e.g. "clove")
 * converts to parent-equivalents first, then to grams via gramsPerEach when the
 * gramsPerEach describes the parent — but because gramsPerEach semantics are
 * per-"each", we only grams-convert count via gramsPerEach for plain each/whole.
 */
export function convertToGrams(
  qty: number,
  unit: string,
  conv: IngredientConversion | null | undefined,
): number | null {
  if (!(qty >= 0)) return null;
  const u = normalizeUnit(unit);

  const weight = WEIGHT_UNIT_TO_GRAMS[u];
  if (weight !== undefined) return qty * weight;

  const cups = VOLUME_UNIT_TO_CUPS[u];
  if (cups !== undefined) {
    if (!conv || conv.gramsPerCup == null) return null;
    return qty * cups * conv.gramsPerCup;
  }

  if (COUNT_UNITS.has(u)) {
    if (!conv || conv.gramsPerEach == null) return null;
    return qty * conv.gramsPerEach;
  }

  // A sub-unit child (e.g. "clove") does not grams-convert here: head↔clove is
  // a count↔count ratio used for purchase-pack sanity + merge, not a density.
  // Grams-for-a-clove is deliberately out of scope (BUG-025-4 territory).
  return null;
}

/**
 * Inverse of convertToGrams: grams → (qty in `unit`). Weight units invert with
 * no per-ingredient data; volume needs gramsPerCup; count needs gramsPerEach.
 * Returns null when not determinable. Used by the density-aware merge to express
 * a summed gram total back in a shopper-friendly unit.
 */
export function gramsToUnit(
  grams: number,
  unit: string,
  conv: IngredientConversion | null | undefined,
): number | null {
  if (!(grams >= 0)) return null;
  const u = normalizeUnit(unit);

  const weight = WEIGHT_UNIT_TO_GRAMS[u];
  if (weight !== undefined) return grams / weight;

  const cups = VOLUME_UNIT_TO_CUPS[u];
  if (cups !== undefined) {
    if (!conv || conv.gramsPerCup == null) return null;
    return grams / (cups * conv.gramsPerCup);
  }

  if (COUNT_UNITS.has(u)) {
    if (!conv || conv.gramsPerEach == null) return null;
    return grams / conv.gramsPerEach;
  }

  return null;
}

// ── curated core (source:'curated') ────────────────────────────────────────
// Absorbs the former ingredientPurchaseDefaults rows verbatim (purchase packs)
// and layers density (gramsPerCup) / count (gramsPerEach) / subUnit onto the
// rows where a confident kitchen value exists. Density-only staples (flour,
// sugar, oils) are added for the macro consumer even though they carry no
// purchase pack. Numbers are standard USDA/kitchen references; provenance is
// 'curated' so the backfill's USDA sweep + runtime AI-fallback only ever fill
// GAPS, never overwrite these.
export const INGREDIENT_CONVERSIONS: Record<string, IngredientConversion> = {
  // — proteins (purchase packs; weight units need no density) —
  "ground beef": { purchaseUnit: "lb", purchaseQuantity: 1, purchaseDisplay: "1 lb", source: "curated" },
  bacon: { purchaseUnit: "package", purchaseQuantity: 1, purchaseDisplay: "1 package (12 oz)", source: "curated" },
  "chicken thighs": { purchaseUnit: "lb", purchaseQuantity: 2, purchaseDisplay: "2 lb", source: "curated" },
  "chicken breast": { purchaseUnit: "lb", purchaseQuantity: 1, purchaseDisplay: "1 lb", source: "curated" },
  shrimp: { purchaseUnit: "lb", purchaseQuantity: 1, purchaseDisplay: "1 lb", source: "curated" },
  "salmon fillets": { purchaseUnit: "lb", purchaseQuantity: 1.5, purchaseDisplay: "1.5 lb (4 fillets)", source: "curated" },
  // — produce (count → gramsPerEach; head↔clove subUnit) —
  lettuce: { purchaseUnit: "head", purchaseQuantity: 1, purchaseDisplay: "1 head", gramsPerEach: 600, source: "curated" },
  tomato: { purchaseUnit: "each", purchaseQuantity: 3, purchaseDisplay: "3 tomatoes", gramsPerEach: 123, gramsPerCup: 180, source: "curated" },
  "cherry tomatoes": { purchaseUnit: "pint", purchaseQuantity: 1, purchaseDisplay: "1 pint", gramsPerCup: 149, source: "curated" },
  garlic: {
    purchaseUnit: "head",
    purchaseQuantity: 1,
    purchaseDisplay: "1 head",
    subUnit: { parent: "head", perParent: 10 },
    gramsPerEach: 45,
    source: "curated",
  },
  parsley: { purchaseUnit: "bunch", purchaseQuantity: 1, purchaseDisplay: "1 bunch", gramsPerCup: 60, source: "curated" },
  // WS7-8b B2 (Hans, July 12) — parsley variants curated at the same known
  // value (60 g/cup) rather than left to an AI guess after an FDC batch
  // omission dropped their usda_derived source (all pointed at fdcId 170416).
  "flat-leaf parsley": { purchaseUnit: "bunch", purchaseQuantity: 1, purchaseDisplay: "1 bunch", gramsPerCup: 60, source: "curated" },
  "fresh flat-leaf parsley": { purchaseUnit: "bunch", purchaseQuantity: 1, purchaseDisplay: "1 bunch", gramsPerCup: 60, source: "curated" },
  "fresh parsley": { purchaseUnit: "bunch", purchaseQuantity: 1, purchaseDisplay: "1 bunch", gramsPerCup: 60, source: "curated" },
  cilantro: { purchaseUnit: "bunch", purchaseQuantity: 1, purchaseDisplay: "1 bunch", gramsPerCup: 16, source: "curated" },
  "fresh dill": { purchaseUnit: "bunch", purchaseQuantity: 1, purchaseDisplay: "1 bunch", source: "curated" },
  "yellow onion": { purchaseUnit: "each", purchaseQuantity: 2, purchaseDisplay: "2 onions", gramsPerEach: 110, gramsPerCup: 160, source: "curated" },
  onion: { purchaseUnit: "each", purchaseQuantity: 2, purchaseDisplay: "2 onions", gramsPerEach: 110, gramsPerCup: 160, source: "curated" },
  ginger: { purchaseUnit: "piece", purchaseQuantity: 1, purchaseDisplay: "1 piece (2 in)", source: "curated" },
  cucumber: { purchaseUnit: "each", purchaseQuantity: 1, purchaseDisplay: "1 cucumber", gramsPerEach: 300, source: "curated" },
  lemon: { purchaseUnit: "each", purchaseQuantity: 2, purchaseDisplay: "2 lemons", gramsPerEach: 100, source: "curated" },
  banana: { purchaseUnit: "bunch", purchaseQuantity: 1, purchaseDisplay: "1 bunch", gramsPerEach: 118, source: "curated" },
  bananas: { purchaseUnit: "bunch", purchaseQuantity: 1, purchaseDisplay: "1 bunch", gramsPerEach: 118, source: "curated" },
  scallions: { purchaseUnit: "bunch", purchaseQuantity: 1, purchaseDisplay: "1 bunch", source: "curated" },
  "green onions": { purchaseUnit: "bunch", purchaseQuantity: 1, purchaseDisplay: "1 bunch", source: "curated" },
  kale: { purchaseUnit: "bunch", purchaseQuantity: 1, purchaseDisplay: "1 bunch", gramsPerCup: 67, source: "curated" },
  lime: { purchaseUnit: "each", purchaseQuantity: 2, purchaseDisplay: "2 limes", gramsPerEach: 67, source: "curated" },
  "bean sprouts": { purchaseUnit: "bag", purchaseQuantity: 1, purchaseDisplay: "1 bag (8 oz)", source: "curated" },
  "bell peppers": { purchaseUnit: "each", purchaseQuantity: 3, purchaseDisplay: "3 peppers", gramsPerEach: 120, gramsPerCup: 149, source: "curated" },
  "bell pepper": { purchaseUnit: "each", purchaseQuantity: 3, purchaseDisplay: "3 peppers", gramsPerEach: 120, gramsPerCup: 149, source: "curated" },
  // — dairy (grated/shredded cheese density is the parmesan test case) —
  cheddar: { purchaseUnit: "block", purchaseQuantity: 1, purchaseDisplay: "1 block (8 oz)", gramsPerCup: 113, source: "curated" },
  parmesan: { purchaseUnit: "wedge", purchaseQuantity: 1, purchaseDisplay: "1 wedge (6 oz)", gramsPerCup: 100, source: "curated" },
  feta: { purchaseUnit: "block", purchaseQuantity: 1, purchaseDisplay: "1 block (8 oz)", gramsPerCup: 150, source: "curated" },
  "sour cream": { purchaseUnit: "container", purchaseQuantity: 1, purchaseDisplay: "1 container (16 oz)", gramsPerCup: 230, source: "curated" },
  eggs: { purchaseUnit: "dozen", purchaseQuantity: 1, purchaseDisplay: "1 dozen", gramsPerEach: 50, source: "curated" },
  egg: { purchaseUnit: "dozen", purchaseQuantity: 1, purchaseDisplay: "1 dozen", gramsPerEach: 50, source: "curated" },
  butter: { purchaseUnit: "package", purchaseQuantity: 1, purchaseDisplay: "1 package (1 lb, 4 sticks)", gramsPerCup: 227, source: "curated" },
  milk: { gramsPerCup: 240, source: "curated" },
  // — pantry / dry goods —
  "taco shells": { purchaseUnit: "box", purchaseQuantity: 1, purchaseDisplay: "1 box (12 ct)", source: "curated" },
  "flour tortillas": { purchaseUnit: "package", purchaseQuantity: 1, purchaseDisplay: "1 package (10 ct)", source: "curated" },
  spaghetti: { purchaseUnit: "box", purchaseQuantity: 1, purchaseDisplay: "1 box (1 lb)", source: "curated" },
  "rice noodles": { purchaseUnit: "package", purchaseQuantity: 1, purchaseDisplay: "1 package (8 oz)", source: "curated" },
  "basmati rice": { purchaseUnit: "bag", purchaseQuantity: 1, purchaseDisplay: "1 bag (2 lb)", gramsPerCup: 185, source: "curated" },
  farro: { purchaseUnit: "bag", purchaseQuantity: 1, purchaseDisplay: "1 bag (16 oz)", gramsPerCup: 200, source: "curated" },
  salsa: { purchaseUnit: "jar", purchaseQuantity: 1, purchaseDisplay: "1 jar (16 oz)", gramsPerCup: 240, source: "curated" },
  tahini: { purchaseUnit: "jar", purchaseQuantity: 1, purchaseDisplay: "1 jar (16 oz)", gramsPerCup: 240, source: "curated" },
  "tikka masala paste": { purchaseUnit: "jar", purchaseQuantity: 1, purchaseDisplay: "1 jar (10 oz)", source: "curated" },
  "tamarind paste": { purchaseUnit: "jar", purchaseQuantity: 1, purchaseDisplay: "1 jar (8 oz)", source: "curated" },
  "fish sauce": { purchaseUnit: "bottle", purchaseQuantity: 1, purchaseDisplay: "1 bottle (8 oz)", gramsPerCup: 270, source: "curated" },
  "olive oil": { purchaseUnit: "bottle", purchaseQuantity: 1, purchaseDisplay: "1 bottle (17 oz)", gramsPerCup: 216, source: "curated" },
  "vegetable broth": { purchaseUnit: "carton", purchaseQuantity: 1, purchaseDisplay: "1 carton (32 oz)", gramsPerCup: 240, source: "curated" },
  peanuts: { purchaseUnit: "bag", purchaseQuantity: 1, purchaseDisplay: "1 bag (8 oz)", gramsPerCup: 146, source: "curated" },
  "taco seasoning": { purchaseUnit: "packet", purchaseQuantity: 1, purchaseDisplay: "1 packet", source: "curated" },
  "fajita seasoning": { purchaseUnit: "packet", purchaseQuantity: 1, purchaseDisplay: "1 packet", source: "curated" },
  "black pepper": { purchaseUnit: "container", purchaseQuantity: 1, purchaseDisplay: "1 container", source: "curated" },
  salt: { purchaseUnit: "container", purchaseQuantity: 1, purchaseDisplay: "1 container", gramsPerCup: 273, source: "curated" },
  "coconut milk": { purchaseUnit: "can", purchaseQuantity: 1, purchaseDisplay: "1 can (13.5 oz)", gramsPerCup: 226, source: "curated" },
  "diced tomatoes": { purchaseUnit: "can", purchaseQuantity: 1, purchaseDisplay: "1 can (14.5 oz)", gramsPerCup: 240, source: "curated" },
  chickpeas: { purchaseUnit: "can", purchaseQuantity: 1, purchaseDisplay: "1 can (15 oz)", gramsPerCup: 164, source: "curated" },
  // — density-only baking/cooking staples (macro consumer; no purchase pack) —
  "all-purpose flour": { gramsPerCup: 125, source: "curated" },
  flour: { gramsPerCup: 125, source: "curated" },
  "granulated sugar": { gramsPerCup: 200, source: "curated" },
  sugar: { gramsPerCup: 200, source: "curated" },
  "brown sugar": { gramsPerCup: 220, source: "curated" },
  "vegetable oil": { gramsPerCup: 218, source: "curated" },
  honey: { gramsPerCup: 340, source: "curated" },
  "peanut butter": { gramsPerCup: 258, source: "curated" },
  "rolled oats": { gramsPerCup: 90, source: "curated" },
  breadcrumbs: { gramsPerCup: 108, source: "curated" },
  rice: { gramsPerCup: 185, source: "curated" },
  water: { gramsPerCup: 236, source: "curated" },
};

// ── lookups ─────────────────────────────────────────────────────────────

function normalizeKey(name: string): string {
  return name.toLowerCase().trim();
}

/** Full conversion row from the curated code table, or null on miss. */
export function lookupConversion(
  canonicalName: string,
): IngredientConversion | null {
  const key = normalizeKey(canonicalName);
  if (!key) return null;
  return INGREDIENT_CONVERSIONS[key] ?? null;
}

/**
 * Back-compat purchase-only lookup (former ingredientPurchaseDefaults). Returns
 * the purchase pack ONLY when all three purchase fields are present; density-
 * only rows (flour, sugar) return null here so the create-time upsert leaves
 * purchase fields null and the gap-fill path still handles them.
 */
export function lookupPurchaseDefault(
  canonicalName: string,
): IngredientPurchase | null {
  const conv = lookupConversion(canonicalName);
  if (
    conv &&
    conv.purchaseUnit != null &&
    conv.purchaseQuantity != null &&
    conv.purchaseDisplay != null
  ) {
    return {
      purchaseUnit: conv.purchaseUnit,
      purchaseQuantity: conv.purchaseQuantity,
      purchaseDisplay: conv.purchaseDisplay,
    };
  }
  return null;
}

/**
 * Validate + narrow a persisted Ingredient.conversionRef JSON into an
 * IngredientConversion. Returns null for null/malformed values so callers fall
 * back to the code table then the AI path. Only the fields we consume are
 * checked; unknown extra keys are ignored (forward-compatible).
 */
export function parseConversionRef(value: unknown): IngredientConversion | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  const source = v.source;
  if (source !== "curated" && source !== "usda_derived" && source !== "ai_estimated") {
    return null;
  }
  const out: IngredientConversion = { source };
  if (typeof v.gramsPerCup === "number" && v.gramsPerCup > 0) out.gramsPerCup = v.gramsPerCup;
  if (typeof v.gramsPerEach === "number" && v.gramsPerEach > 0) out.gramsPerEach = v.gramsPerEach;
  if (
    v.subUnit &&
    typeof v.subUnit === "object" &&
    typeof (v.subUnit as Record<string, unknown>).parent === "string" &&
    typeof (v.subUnit as Record<string, unknown>).perParent === "number"
  ) {
    out.subUnit = {
      parent: (v.subUnit as Record<string, unknown>).parent as string,
      perParent: (v.subUnit as Record<string, unknown>).perParent as number,
    };
  }
  if (typeof v.purchaseUnit === "string") out.purchaseUnit = v.purchaseUnit;
  if (typeof v.purchaseQuantity === "number") out.purchaseQuantity = v.purchaseQuantity;
  if (typeof v.purchaseDisplay === "string") out.purchaseDisplay = v.purchaseDisplay;
  if (v.confidence === "high" || v.confidence === "medium" || v.confidence === "low") {
    out.confidence = v.confidence;
  }
  return out;
}

/**
 * Head↔clove purchase scaling (BUG-025-1 symptom: "1 head garlic" for a recipe
 * needing 30 cloves — a shopper buys 3 heads, not 1). Given a need quantity in
 * the sub-unit CHILD (e.g. cloves) or the PARENT (heads), compute how many
 * parent packs to buy. Only fires when the ingredient has a subUnit AND its
 * purchase pack is sold by the parent unit. Returns null otherwise (normal
 * purchase display stands).
 */
export function scalePurchaseForSubUnit(
  conv: IngredientConversion | null | undefined,
  needQuantity: number,
  needUnit: string,
): { purchaseQuantity: number; purchaseDisplay: string } | null {
  if (!conv?.subUnit || !conv.purchaseUnit) return null;
  if (!(needQuantity > 0)) return null;
  const parent = normalizeUnit(conv.subUnit.parent);
  if (normalizeUnit(conv.purchaseUnit) !== parent) return null;

  const u = normalizeUnit(needUnit);
  const packs =
    u === parent
      ? Math.ceil(needQuantity - 1e-9)
      : Math.ceil(needQuantity / conv.subUnit.perParent - 1e-9);
  const n = Math.max(1, packs);
  const display = `${n} ${parent}${n === 1 ? "" : "s"}`;
  return { purchaseQuantity: n, purchaseDisplay: display };
}

/**
 * Resolve the effective conversion for an ingredient at runtime: the persisted
 * conversionRef (seed/backfill) wins; the curated code table is the fallback.
 * (AI-fallback-on-miss is layered above this by the grocery/macro callers.)
 */
export function resolveConversion(
  canonicalName: string,
  conversionRef: unknown,
): IngredientConversion | null {
  return parseConversionRef(conversionRef) ?? lookupConversion(canonicalName);
}

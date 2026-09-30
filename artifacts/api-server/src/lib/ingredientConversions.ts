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

const QTY_EPSILON = 1e-9;

/**
 * [grocery] B1 (D-WS9-280) — how far past a whole pack a need may go before it
 * costs another pack. An eighth.
 *
 * Hans, September 28: "on vegetables, I don't want them to have to throw out
 * 3/4 head of cilantro because they needed a little more than their head."
 * 1 bunch + 2 tbsp cilantro is 1 bunch; 1 bunch + ½ cup is 2.
 */
export const PACK_FORGIVENESS_FRACTION = 0.125;

/**
 * …and the pack it applies to. See {@link forgivesPartPack} for the ruling and
 * for the measurement that narrowed it from a category to this one token.
 */
export const PACK_FORGIVENESS_UNIT = "bunch";

// Sub-unit equivalence — the head↔clove case (BUG-025-1). `perParent` children
// make up one `parent` (1 head = 10 cloves). Keeps count↔count conversions and
// purchase-pack sanity ("need 2 cloves" → "1 head", not "2 heads") off the AI.
//
// ── [grocery] B1 (D-WS9-280 / D-WS9-225) — `childUnit`, AND WHY IT IS THE WHOLE
//    GENERALISATION ───────────────────────────────────────────────────────────
//
// This shape was already the pack yield: `parent` is the pack noun, `perParent`
// is how much one pack gives. The ONE thing it could not say was what
// `perParent` COUNTS, because garlic's child was always a clove and the code
// simply assumed a bare count. That assumption is why a bunch of cilantro
// against a need in cups had no ladder at all, and why scalePurchaseForSubUnit
// divided by `perParent` for ANY non-parent unit — 3 oz of cilantro against
// {bunch, 2} would have computed 1.5 bunches of nothing.
//
// With `childUnit` named, the same ladder carries `{bunch, 2, "cup"}` and
// `{head, 4, "cup"}` and `{jar, 1.5, "cup"}` without a second mechanism.
//
// `childUnit` UNDEFINED is today's shape and keeps today's meaning: the child is
// a bare count. Garlic's persisted conversionRef still parses to that, and the
// pack-yield columns now supply `{head, 10, "clove"}` for the same row — the two
// must agree, and a test says so.
export interface SubUnitEquivalence {
  parent: string; // e.g. "head"
  perParent: number; // e.g. 10 cloves per head
  /** The unit `perParent` counts. Undefined = a bare count (the pre-B1 shape). */
  childUnit?: string;
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

// ── WS9 BUG-174 — canonical unit token ─────────────────────────────────────
//
// normalizeUnit above is `trim().toLowerCase()` and NOTHING ELSE, so `tsp` and
// `teaspoon` are two different strings everywhere a unit is used as a key. The
// grocery bucket key (bucketKeyOf) is one of those places, which is how one
// ingredient reached in two spellings of ONE unit becomes two shopping rows.
//
// ⚠️ THIS IS A READER OVER THE TABLES ABOVE, NOT A FIFTH ALIAS MAP. This module
// already spells every alias — `tsp` and `teaspoon` are both literally `1 / 48`
// in VOLUME_UNIT_TO_CUPS — so the equivalence is already stated; nothing read
// it. Two keys of the same table sharing a factor ARE the same unit, and that
// shared number is the proof. No spelling is added here, and adding one to this
// module means adding it to the factor table where it belongs.
//
// SCOPE — volume + weight ONLY, deliberately. COUNT_UNITS is a SET with no
// factor, so it offers no proof that two of its members are one unit: `whole`,
// `piece` and `ct` sit in it because they all resolve grams via gramsPerEach,
// which is a statement about density lookup, not about the words being
// spellings of each other. Collapsing them would also need an arbitrary elected
// representative for a class that has no natural one. `each` therefore stays
// `each`, and a bucket keyed on it is unchanged.
//
// KNOWN GAP, deliberate: a spelling family in NO factor table is untouched —
// clove/cloves (977 live dish-ingredient rows), can/cans (89), stalk/stalks
// (30), inch/inches (26). Covering them means putting them in a factor table,
// which is a data decision, not this one.
//
// REPRESENTATIVE: shortest key in the class, ties broken lexicographically.
// Deterministic and independent of the tables' declaration order, and it elects
// the token a cook would write (cup / tbsp / tsp / fl oz / oz / lb / g / ml).
// Nothing DISPLAYS this token — it is a Map key and an in-request join key
// (bucketKeyOf is never persisted), so the election only has to be stable
// WITHIN one run, not across releases.
function electCanonicalTokens(table: Record<string, number>): Map<string, string> {
  const byFactor = new Map<number, string[]>();
  for (const key of Object.keys(table)) {
    const list = byFactor.get(table[key]);
    if (list) list.push(key);
    else byFactor.set(table[key], [key]);
  }
  const out = new Map<string, string>();
  for (const keys of byFactor.values()) {
    const rep = keys.reduce((a, b) =>
      b.length < a.length || (b.length === a.length && b < a) ? b : a,
    );
    for (const k of keys) out.set(k, rep);
  }
  return out;
}

const UNIT_CANONICAL_TOKEN: ReadonlyMap<string, string> = new Map([
  ...electCanonicalTokens(VOLUME_UNIT_TO_CUPS),
  ...electCanonicalTokens(WEIGHT_UNIT_TO_GRAMS),
]);

// ── WS9 BUG-174 follow-through — COUNT-unit spelling aliases ────────────────
//
// The election above derives its equivalences from a shared FACTOR, which is
// why it reaches volume and weight and stops there. Count units have no factor
// to share — COUNT_UNITS is a bare Set — so a spelling pair like clove/cloves
// is invisible to it, and BUG-137's garlic fold stayed blocked: mergeGroup's
// sub-unit path saw {clove, cloves} as TWO children and refused a group it can
// obviously reconcile.
//
// ⚠️ THIS IS NOT THE "FIFTH MAP". That rule forbade DUPLICATING alias data the
// factor tables already hold. For count units no such data exists anywhere in
// the project — this is the missing piece, not a copy of one.
//
// ⚠️ AND IT IS NOT A SINGULARISING NORMALIZER. It must never become one.
// ws9-bug096-ingredient-merge.ts:16-20 records that a general write-path
// singulariser was measured and REFUTED: 468 collateral renames against 67 real
// merges, molasses→molass, couscous→couscou. This module's own data reproduces
// the same trap — `inches` and `inch` are BOTH live, but strip-the-s yields
// `inche` and pairs nothing. That is precisely why the four rows below are
// written out by hand rather than computed.
//
// SCOPE: the four families where BOTH spellings are live in dish_ingredients,
// with their row counts at the time of writing:
//   cloves(16) → clove(961) · cans(1) → can(88) · stalks(1) → stalk(29) ·
//   inches(1) → inch(25)
// A mechanical scan for "plural whose singular is also live" returns exactly
// these four plus cups/cup, and cups is already folded by the volume table.
// No fifth family is added on speculation: `heads`, `sprigs`, `leaves`,
// `bunches` and `slices` have ZERO live rows, so folding them would be
// inventing data, which is the failure this map exists to avoid.
//
// UNITS ONLY. `cloves` is also a real INGREDIENT — the catalog carries
// `cloves`, `ground cloves` and `whole cloves`, the spice, measured in
// teaspoons. This map is consulted with a UNIT string and never with a name,
// so the spice is untouched; there is a test that says so.
// ── [grocery] B1 — THE PACK NOUNS, ADDED ON A RULING, AND THE MEASUREMENT THAT
//    QUALIFIES IT ──────────────────────────────────────────────────────────────
//
// ⚠️ THE SCOPE NOTE ABOVE IS STILL TRUE AND WAS RE-MEASURED ON 2026-09-28, so
// read this before concluding the rule was abandoned. `heads`, `bunches`,
// `jars`, `loaves`, `sprigs`, `leaves` and `slices` STILL have ZERO live rows in
// `dish_ingredients` (42 distinct unit spellings) and ZERO in
// `grocery_list_items` (34 spellings, 5,003 items). By the scope rule above,
// none of them qualifies as a live family.
//
// They are here anyway, on Hans's ruling of September 28, and the reason they do
// no harm is exactly the measurement: with zero live rows on either side, adding
// them folds NOTHING that exists, so no bucket changes and no stored row
// re-keys. The reconcile guard below is what turns that into a fact rather than
// a claim.
//
// AND THERE IS A SECOND CONSUMER THAT MADE IT WORTH DOING. B1's pack line
// compares a stored purchaseDisplay's RESIDUE against the pack noun — "4 heads"
// against `head` — to decide whether to synthesise "1 head" or rewrite only the
// leading count. That residue is authored PROSE, not a unit column, and it is
// plural in the live data. Without these rows the comparison failed and the
// rewrite produced "1 heads iceberg lettuce". Putting the fold HERE rather than
// in a second private map is what keeps it to one map.
//
// ⚠️ STILL NOT A SINGULARISING NORMALIZER, and these rows must not be taken as
// licence to become one. Every entry is written out by hand for the same reason
// the original four were.
const COUNT_UNIT_ALIASES: Record<string, string> = {
  cloves: "clove",
  cans: "can",
  stalks: "stalk",
  inches: "inch",
  // pack nouns (B1) — zero live rows on either side; see the note above
  heads: "head",
  bunches: "bunch",
  jars: "jar",
  loaves: "loaf",
  bulbs: "bulb",
  ears: "ear",
  sprigs: "sprig",
  wedges: "wedge",
  bottles: "bottle",
  packages: "package",
  blocks: "block",
  containers: "container",
  boxes: "box",
  bags: "bag",
  slices: "slice",
  sticks: "stick",
  leaves: "leaf",
};

/**
 * Fold a unit to the one token that stands for every spelling of it, so two
 * spellings of ONE unit key the same bucket. Identity for anything this module
 * carries no factor for — an unknown unit buckets alone and is never
 * force-merged with something it might not be.
 *
 * ⚠️ This is for KEYS ONLY. It must never be written back onto an item's
 * `unit`: GroceryListItem.unit is persisted and groceryReconcile's matchKey
 * compares a stored unit against a freshly consolidated one, so rewriting the
 * unit would make every stored `teaspoon` row reconcile as delete+add.
 */
export function canonicalUnitToken(unit: string): string {
  const u = normalizeUnit(unit);
  // Factor-derived first, then the hand-written count aliases, then identity.
  return UNIT_CANONICAL_TOKEN.get(u) ?? COUNT_UNIT_ALIASES[u] ?? u;
}

// ── [grocery] F (F5.2) — THE SAME TABLE, READ BACKWARDS ─────────────────────
//
// `formatMeasure` (prepWeekAssembly.ts) prints the CANONICAL token, and the
// canonical token is the singular — so the Prep the Week text said "Finely dice
// 3 stalk celery and transfer to a container". A count unit above one inflects;
// a measure unit never does ("1½ cup", "2 lb" are correct recipe English and
// "2 lbs" is not).
//
// DERIVED from COUNT_UNIT_ALIASES rather than authored, exactly as the client's
// COUNT_NOUN_SINGULARS is derived from COUNT_NOUN_PLURALS (BUG-144), and for the
// same reason: two hand-written directions drift, one table cannot. It also
// inherits that table's discipline for free — the map is the hand-written
// count-unit list whose docblock explains at length why it must never become a
// mechanical singulariser, and reading it backwards cannot introduce a pair it
// does not already contain.
//
// ⚠️ IT IS NOT A GENERAL PLURALISER AND MUST NOT BECOME ONE. A unit absent from
// the table returns unchanged, which is right for every measure unit (`tsp`,
// `cup`, `oz`, `lb`, `g`, `ml`) and right for an unknown one. `each` is absent
// and stays absent: BUG-317 ruled that a count unit is SUPPRESSED on a recipe
// line, not pluralised.
const COUNT_UNIT_PLURALS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(COUNT_UNIT_ALIASES).map(([many, one]) => [one, many]),
  ),
);

/**
 * A count unit agreed with its quantity: `pluralizeCountUnit("stalk", 3)` is
 * "stalks", `(…, 1)` is "stalk", and a measure or unknown unit passes through
 * at every quantity.
 *
 * Quantity ≤ 1 is singular — the same threshold BUG-329 ruled for the grocery
 * line, and for the same reason: `¼ bunches` is not English either.
 */
export function pluralizeCountUnit(unit: string, quantity: number): string {
  if (!(quantity > 1)) return unit;
  return COUNT_UNIT_PLURALS[normalizeUnit(unit)] ?? unit;
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

// ── WS9 BUG-176 — same-dimension conversion, WITHOUT a density ─────────────
//
// convertToGrams is the only cross-unit path this module offered, and it routes
// EVERYTHING through grams. For a volume unit that requires gramsPerCup, so
// `1 tablespoon + 1 teaspoon` of an ingredient carrying no density row declines
// — even though 1 tbsp = 3 tsp is fixed kitchen math that needs no ingredient
// data at all. The pair then partnered into the AI subset for free-form
// arithmetic, and the BUG-142 conservation guard refused it on the same missing
// grams. Two rows for one bottle of hot sauce, twice on live lists.
//
// Within ONE dimension the density cancels: (q · cupsFrom · gpc) / (cupsTo ·
// gpc) = q · cupsFrom / cupsTo. So this returns exactly what the grams path
// returns whenever the grams path CAN run, and an answer where it cannot.
//
// ⚠️ It does NOT loosen anything. Volume↔weight still needs gramsPerCup and
// still goes through convertToGrams; count units are in neither table, so
// `each` + `cup`, `pinch` + `tsp` and `bunch` + `cup` return null here exactly
// as before and still reach the conservation guard that was built for them.
export type UnitDimension = "volume" | "weight";

/**
 * The dimension a unit measures, or null when this module carries no factor for
 * it (count units, `bunch`, `pinch`, `to taste`). Two units convert without any
 * per-ingredient data if and only if they share a non-null dimension.
 */
export function unitDimension(unit: string): UnitDimension | null {
  const u = normalizeUnit(unit);
  if (u in VOLUME_UNIT_TO_CUPS) return "volume";
  if (u in WEIGHT_UNIT_TO_GRAMS) return "weight";
  return null;
}

/**
 * Convert (qty, fromUnit) → toUnit using only the fixed ratios in this module.
 * Returns null unless BOTH units share one dimension — a cross-dimension pair
 * genuinely needs a density and must go through convertToGrams instead.
 */
export function convertWithinDimension(
  qty: number,
  fromUnit: string,
  toUnit: string,
): number | null {
  if (!(qty >= 0)) return null;
  const from = normalizeUnit(fromUnit);
  const to = normalizeUnit(toUnit);
  const dim = unitDimension(from);
  if (dim === null || dim !== unitDimension(to)) return null;
  const table = dim === "volume" ? VOLUME_UNIT_TO_CUPS : WEIGHT_UNIT_TO_GRAMS;
  return (qty * table[from]) / table[to];
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
  // ── D-WS9-284 ruling 3 — `milk` gains a pack, and the pack is a GALLON ─────
  //
  // Hans, D-WS9-188: "we usually get a gallon of milk". This key is the
  // RECURRING default (ruling 2's step 1), not a recipe pack — no recipe ever
  // buys a gallon for a half cup, and none can reach this entry:
  //
  //   • There is no catalog row named `milk`, so no row reads it directly.
  //   • No catalog row folds to `milk` through baseStapleName with a null
  //     conversionRef, so the groceryMerge.ts:152 / groceryListAI.ts:417
  //     fallbacks cannot reach it either (measured: 0 rows).
  //   • `resolveIngredients` cannot mint a `milk` row, because `milk` is an
  //     ALIAS on `whole milk` and lookupIngredientsByName resolves it to that
  //     row before the upsert is considered. Removing that alias would expose
  //     this entry to the create path — do not remove it without re-reading
  //     this comment.
  //
  // gramsPerCup is untouched, so every density consumer is byte-identical.
  milk: { purchaseUnit: "gallon", purchaseQuantity: 1, purchaseDisplay: "1 gallon", gramsPerCup: 240, source: "curated" },
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
  // ── D-WS9-284 ruling 3 — THE RECURRING VOCABULARY THAT NAMES NO FOOD ──────
  //
  // Four texts in the live recurring vocabulary resolve to no catalog row, and
  // none of them ever will: paper towels and toilet paper are not food, pet
  // treats are not human food, and coffee is a food nobody has written a recipe
  // for. Before D-WS9-284 each was a purchase-default MISS, which made it a
  // gap-fill cache miss, which meant Haiku authored its pack on EVERY generation
  // and the answer was thrown away (groceryListAI.ts skips write-back when
  // ingredientId is null). Across the census corpus that cost 74 of 96 recurring
  // rows a model call per run, and two of them disagreed with themselves —
  // `paper towels` came back "(6-pack)" 49 times and "(6 rolls)" 7.
  //
  // These four entries are that answer, written down once. Ruling 2: a recurring
  // synthetic is never gap-filled again; a text that misses this table renders
  // its name with no pack, which is stable and free.
  //
  // The figures: paper towels and pet treats are Haiku's own majority answer
  // (49 of 56, 54 of 56); coffee is Hans's words in D-WS9-188, "my weekly 1 lb
  // bag of coffee"; toilet paper is the 12-roll pack stated in rolls to match
  // paper towels.
  //
  // NONE of these keys names a catalog row and none is reachable by a
  // baseStapleName fold (measured: 0). They ARE reachable by
  // `resolveIngredients` if a recipe ever mentions one by name, which would
  // create the row seeded with this pack — correct for coffee, and the other
  // three do not appear in recipes.
  "paper towels": { purchaseUnit: "pack", purchaseQuantity: 1, purchaseDisplay: "1 pack (6 rolls)", source: "curated" },
  "toilet paper": { purchaseUnit: "pack", purchaseQuantity: 1, purchaseDisplay: "1 pack (12 rolls)", source: "curated" },
  "pet treats": { purchaseUnit: "bag", purchaseQuantity: 1, purchaseDisplay: "1 bag", source: "curated" },
  coffee: { purchaseUnit: "bag", purchaseQuantity: 1, purchaseDisplay: "1 bag (1 lb)", source: "curated" },
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
    const sv = v.subUnit as Record<string, unknown>;
    out.subUnit = {
      parent: sv.parent as string,
      perParent: sv.perParent as number,
      // B1 — forward-compatible. No persisted conversionRef carries this today
      // (the pack yield lives in its own columns), but a blob that gained one
      // must not have it silently dropped.
      ...(typeof sv.childUnit === "string" && sv.childUnit.trim().length > 0
        ? { childUnit: sv.childUnit }
        : {}),
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
  opts?: ScalePurchaseOptions,
): { purchaseQuantity: number; purchaseDisplay: string } | null {
  if (!conv?.subUnit || !conv.purchaseUnit) return null;
  if (!(needQuantity > 0)) return null;
  const parent = normalizeUnit(conv.subUnit.parent);
  if (normalizeUnit(conv.purchaseUnit) !== parent) return null;

  const child = toSubUnitChild(needQuantity, needUnit, conv);
  if (child === null || !(child > 0)) return null;

  const floor = opts?.packFloor ?? 0;
  const n = Math.max(
    floor,
    packsForNeed(child / conv.subUnit.perParent, forgivesPartPack(conv.purchaseUnit)),
  );
  if (!(n > 0)) return null;
  return {
    purchaseQuantity: n,
    purchaseDisplay: renderPackDisplay(n, parent, opts?.storedDisplay ?? conv.purchaseDisplay ?? null),
  };
}

/**
 * Convert a need into the ladder's CHILD unit, or null when nothing in the data
 * relates them. B1's single conversion seam: the merge and the pack line both
 * go through it, so they cannot disagree about what six cloves are.
 *
 * Returns null rather than guessing — the caller declines and PRINTS, which is
 * BUG-208's discipline and the reason A1's invented yields were caught.
 */
export function toSubUnitChild(
  quantity: number,
  fromUnit: string,
  conv: IngredientConversion | null | undefined,
): number | null {
  const sub = conv?.subUnit;
  if (!sub) return null;
  const from = canonicalUnitToken(fromUnit);
  // The need is stated in WHOLE PACKS: one bunch IS perParent of the child.
  if (from === canonicalUnitToken(sub.parent)) return quantity * sub.perParent;

  const childUnit = sub.childUnit ? normalizeUnit(sub.childUnit) : null;
  if (childUnit === null) {
    // ── THE PRE-B1 SHAPE, PRESERVED BYTE FOR BYTE ──────────────────────────
    //
    // A ladder with no child unit named cannot check anything, so it assumes
    // what this code has always assumed: ANY non-parent unit IS the child. That
    // is exactly the old `u === parent ? … : quantity` branch.
    //
    // ⚠️ AND NARROWING IT TO `isCountUnit(fromUnit)` IS WRONG — measured. That
    // looked like the safe reading and turned five BUG-025-1 tests red at once,
    // because COUNT_UNITS holds each/whole/piece/count and NOT "clove": the one
    // ladder that has shipped since BUG-025-1 states its need in the very unit
    // the narrowed test rejects. The assumption is only safe BECAUSE it is
    // unchecked, which is precisely why `childUnit` exists for every new row.
    return quantity;
  }
  if (from === canonicalUnitToken(childUnit)) return quantity;

  // ── WS9 BUG-211, PRESERVED — A BARE COUNT AGAINST A COUNT CHILD IS THAT CHILD
  //
  // `garlic cloves` is authored defaultUnit "each" and `garlic` "cloves", so a
  // plan drawing on both arrives as {each, clove}. Without this the density path
  // below turns 6 "each" into grams and back and gets a different number for the
  // same six cloves.
  //
  // ⚠️ THE TEST IS NOT `isCountUnit(childUnit)`. COUNT_UNITS does not carry
  // "clove" — it holds each/whole/piece/count and the empty string — so asking
  // whether the CHILD is a count unit returns false for the one ladder that has
  // shipped since BUG-025-1. The honest test is that the child is not a MEASURE.
  if (isCountUnit(fromUnit) && unitDimension(childUnit) === null) return quantity;

  const same = convertWithinDimension(quantity, fromUnit, childUnit);
  if (same !== null) return same;
  // Cross-dimension needs the row's own density (the broccoli case, A3).
  const grams = convertToGrams(quantity, fromUnit, conv);
  if (grams === null) return null;
  return gramsToUnit(grams, childUnit, conv);
}

/**
 * How many WHOLE PACKS cover `rawPacks`, with the forgiveness.
 *
 * R2 (D-WS9-280, Hans, September 28): "I don't want users to not have enough.
 * and on vegetables, I don't want them to have to throw out 3/4 head of
 * cilantro because they needed a little more than their head."
 *
 * So: ceil, always — under-buying is never acceptable — with ONE narrowing. When
 * the need exceeds a whole number of packs by PACK_FORGIVENESS_FRACTION or less
 * AND the pack is one that wilts, do not add a pack.
 */
export function packsForNeed(rawPacks: number, forgives: boolean): number {
  if (!(rawPacks > 0)) return 0;
  const whole = Math.floor(rawPacks + QTY_EPSILON);
  const over = rawPacks - whole;
  if (over <= QTY_EPSILON) return Math.max(1, whole);
  if (forgives && over <= PACK_FORGIVENESS_FRACTION + QTY_EPSILON) {
    return Math.max(1, whole);
  }
  return Math.max(1, whole + 1);
}

/**
 * Does a part-pack overage get forgiven for this pack?
 *
 * 🔴 RULED September 28, and the discriminator is THE PACK UNIT, NOT THE
 * CATEGORY. Hans: "The forgiveness exists so nobody throws out ¾ of a bunch that
 * wilts in days. Garlic, onions, cabbage and citrus keep for weeks, so they
 * round straight up. Garlic 21 cloves → 3 heads."
 *
 * ⚠️ THE MEASUREMENT THAT PRODUCED THE RULING, so nobody re-widens it: B1's
 * first design read `Ingredient.category === "Produce"`, and across all 20
 * golden-corpus lists that rule changed EXACTLY ONE row — it bought 2 heads of
 * garlic against a 21-clove need. Every other forgiveness on the corpus was
 * below one pack, where `max(1, …)` already gives 1 and the branch decides
 * nothing. So the category rule's entire live effect was the one case it got
 * wrong.
 *
 * One token, no map, no category lookup.
 */
export function forgivesPartPack(purchaseUnit: string | null | undefined): boolean {
  if (!purchaseUnit) return false;
  return canonicalUnitToken(purchaseUnit) === PACK_FORGIVENESS_UNIT;
}

export interface ScalePurchaseOptions {
  /**
   * A minimum pack count the row must not fall below, because a coHarvestable
   * PART was pooled onto it and rides free (poolComponentNeeds). The part adds
   * no need — that is what "rides free" means — but it can still mean one more
   * pack.
   */
  packFloor?: number | null;
  /** The row's stored purchaseDisplay, when it differs from the table's. */
  storedDisplay?: string | null;
}

/**
 * The pack display at `n` packs.
 *
 * ⚠️ TWO BRANCHES, AND THE SECOND ONE EXISTS BECAUSE THE FIRST WAS WRONG FOR
 * EVERYTHING BUT GARLIC. Synthesising `${n} ${parent}s` is exactly right for
 * BUG-025-1's "1 head" → "3 heads", and it destroyed every pack whose display
 * says more than its noun: B1's first dry run turned "1 small knob (~2 oz) fresh
 * ginger" into "1 each fresh ginger" and "1 head red cabbage" into "1 each red
 * cabbage".
 *
 * So synthesise ONLY when the stored residue IS the bare pack noun, and
 * otherwise rewrite the leading count and leave the words alone — the same
 * decomposition the client's packResidue / scalePackDisplay already make.
 *
 * The residue comparison goes through canonicalUnitToken because the live data
 * is plural: iceberg's pack read "4 heads", and a bare string compare against
 * "head" missed it and produced "1 heads".
 */
/** English plural suffix for a pack noun. `box` -> `boxes`, `bunch` -> `bunches`. */
function packPlural(n: number, noun: string): string {
  if (n === 1) return "";
  return /(?:s|x|z|ch|sh)$/i.test(noun) ? "es" : "s";
}

/** The inverse, for a stored display that already carries a plural. */
function singularisePackNoun(noun: string): string {
  if (/(?:s|x|z|ch|sh)es$/i.test(noun)) return noun.slice(0, -2);
  if (/s$/i.test(noun) && !/ss$/i.test(noun)) return noun.slice(0, -1);
  return noun;
}

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderPackDisplay(n: number, parent: string, storedDisplay: string | null): string {
  const plural = packPlural(n, parent);
  if (!storedDisplay) return `${n} ${parent}${plural}`;
  const residue = storedDisplay.replace(/^\s*\d+(?:\.\d+)?\s+/, "").trim();
  // Synthesise when the residue LEADS with the pack noun and states no SIZE.
  //
  // Two conditions, and each one is a measured case:
  //   · leading word, not the whole residue — `garlic cloves` is stored as
  //     "1 head of garlic", whose residue is not the bare noun; rewriting only
  //     the count gave "2 head of garlic", which is ungrammatical and lost
  //     BUG-025-1's "2 heads". The trailing words only re-name the item.
  //   · no digits — "1 bunch (~12 oz)" also leads with its noun, and
  //     synthesising would DROP the ~12 oz. That parenthetical is real
  //     information: the client's packSizeHint reads it, and B1's own broccolini
  //     yield was derived from it.
  const lead = residue.split(/\s+/)[0] ?? "";
  if (canonicalUnitToken(lead) === canonicalUnitToken(parent) && !/\d/.test(residue)) {
    return `${n} ${parent}${plural}`;
  }
  // ── [grocery] B4 — PLURALISE THE LEAD NOUN WHEN IT IS THE PACK NOUN ───────
  //
  // The residue leads with the pack noun but states a SIZE too ("can (14.5 oz)",
  // "container (5 oz)"), so the branch above declines to synthesise — dropping
  // the size would lose real information. But rewriting only the count left
  // "4 can (14.5 oz)" on nine corpus rows the moment B4's pack yields moved the
  // scaling from the client to here.
  //
  // ⚠️ AND THE CLIENT CANNOT FIX IT. The note this replaces said the client owns
  // plurals (BUG-321 / BUG-329) — but the client only pluralises a pack noun
  // when IT does the scaling, from "1 can" to "4 cans". Handed a display that
  // already reads "4 can" it leaves it alone, measured on both the committed and
  // the in-flight version. Whoever writes the count owns its plural.
  //
  // Only the LEAD WORD moves, and only when it is the pack noun, so authored
  // prose is still untouched: "1 small knob (~2 oz)" leads with "small", which
  // is not the parent, and comes through exactly as before.
  // The stored display may ALREADY carry a plural ("2 cans (15 oz each)"), and a
  // yield that lands on one pack must not leave "1 cans" behind. So the lead is
  // matched through its singular and rewritten as the correctly inflected parent,
  // in both directions.
  const leadSingular = singularisePackNoun(lead);
  const scaledLead =
    /^\s*\d/.test(storedDisplay) &&
    canonicalUnitToken(leadSingular) === canonicalUnitToken(parent)
      ? storedDisplay
          .replace(/^\s*\d+(?:\.\d+)?/, String(n))
          .replace(
            new RegExp(`^(\\s*${String(n)}\\s+)${escapeForRegExp(lead)}\\b`),
            (_m, head: string) => `${head}${parent}${packPlural(n, parent)}`,
          )
      : null;
  if (scaledLead !== null) return scaledLead;
  return /^\s*\d/.test(storedDisplay)
    ? storedDisplay.replace(/^\s*\d+(?:\.\d+)?/, String(n))
    : `${n} ${storedDisplay}`;
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

/**
 * The columns `Ingredient.packYield*` + `purchaseUnit` arrive as, carried on a
 * consolidated row so this module never imports Prisma.
 */
export interface PackYieldFields {
  packYieldUnit?: string | null;
  packYieldPerPack?: number | null;
  purchaseUnit?: string | null;
}

/**
 * [grocery] B1 — LAYER THE PERSISTED PACK YIELD ONTO A CONVERSION, AND MAKE IT
 * AUTHORITATIVE.
 *
 * D-WS9-220 left unruled whether the garlic factor lives in the ladder or in the
 * yield. This is the ruling: THE PER-INGREDIENT YIELD WINS, and
 * `conversionRef.subUnit` is the fallback for a row that has no yield yet.
 * Garlic's two agree — {head, 10, clove} both ways — and a test asserts it, so
 * BUG-025-1's "3 heads" render is reached by either route.
 *
 * The pack NOUN comes from `purchaseUnit`, not from the yield: a yield is
 * (unit, perPack) and repeating the noun would be a second place for it to be
 * wrong.
 *
 * Returns the conversion UNCHANGED when there is no yield, so a row that never
 * gets one behaves exactly as it does today.
 */
export function withPackYield(
  conv: IngredientConversion | null,
  row: PackYieldFields | null | undefined,
): IngredientConversion | null {
  const unit = row?.packYieldUnit;
  const perPack = row?.packYieldPerPack;
  const pack = row?.purchaseUnit ?? conv?.purchaseUnit ?? null;
  if (!unit || perPack == null || !(perPack > 0) || !pack) return conv;
  const base: IngredientConversion = conv ?? { source: "curated" };
  return {
    ...base,
    // The pack columns travel with the yield: a ladder whose parent is not the
    // pack it is sold in never fires (scalePurchaseForSubUnit's own guard), and
    // a row seeded from the code table can carry a different pack than the
    // catalog row does.
    purchaseUnit: pack,
    subUnit: { parent: pack, perParent: perPack, childUnit: unit },
  };
}

/**
 * [grocery] B1 — THE ONE PLACE A CONSOLIDATED ROW BECOMES A CONVERSION.
 *
 * `resolveConversion` reads the persisted `conversionRef` then the curated code
 * table; `withPackYield` layers the row's own pack-yield columns on top and they
 * WIN (D-WS9-220's unruled half, ruled here). Every caller that used to write
 * `resolveConversion(it.canonicalName, it.conversionRef)` on a consolidated row
 * goes through this instead, so the merge, the pack line and the conservation
 * guard cannot disagree about what one bunch is.
 *
 * ⚠️ IT LIVES HERE, IN THE LEAF MODULE, and not beside ConsolidatedItem. That
 * type is declared in groceryList.ts, which imports groceryMerge; a value
 * exported from there and imported back would be a runtime cycle. The structural
 * parameter keeps this module free of every other one, which is the same reason
 * ingredientRelations declares PoolableItem instead of importing the real type.
 */
export function rowConversion(
  row: PackYieldFields & { canonicalName: string; conversionRef?: unknown },
): IngredientConversion | null {
  return withPackYield(resolveConversion(row.canonicalName, row.conversionRef), row);
}

/**
 * WS9 BUG-215 — THE SUB-UNIT LADDER TRAVELS WITH THE MERGE GROUP, NOT WITH THE
 * ROW THAT WON THE NAME.
 *
 * A fold collapses several catalog rows into one line, and only ONE of them
 * supplies the surviving row's `conversionRef`. Three rows share the `garlic`
 * fold key and only one of them carries the ladder: `garlic` (e6753984) has
 * `subUnit {parent: head, perParent: 10}`; `garlic cloves` (7835b896) and
 * `garlic head` (1493c942) have none, and the curated code table has exactly
 * one key — `garlic` — so a name-based fallback misses them too. When the
 * ladder row supplies the payload, 25 cloves resolves to "3 heads". When a
 * sibling does, `scalePurchaseForSubUnit` returns null and the stored pack
 * prints verbatim: "1 head of garlic" against a 16-clove need. Buy one, need
 * two.
 *
 * This is BUG-209's sentence one field further along. That fix severed the
 * PACK from the name contest ("the pack is not part of the prize for winning
 * the name"); the CONVERSION was still riding on it, via the `{ ...rep }`
 * spread every merge branch ends with.
 *
 * ⚠️ ONLY THE LADDER TRAVELS, AND ONLY ONTO A ROW THAT HAS NONE. `own` wins
 * outright whenever it carries a subUnit, and every non-ladder field — the
 * densities the merge arithmetic already used — is left exactly as the row
 * resolved it. A group conversion is reached by `groupConversion`'s
 * first-member-that-resolves rule, which is deliberately not a merge of
 * densities; widening this to those fields would silently re-base grams for
 * every folded group in the catalog to fix a pack on one.
 *
 * ⚠️ `purchaseUnit` comes along because it is HALF THE LADDER, not as a pack
 * choice: scalePurchaseForSubUnit fires only when `purchaseUnit` equals
 * `subUnit.parent`, so a subUnit arriving without it is inert. It is read
 * nowhere else on this path — the row's OWN purchaseUnit/Quantity/Display
 * columns are what the shopper is shown, and BUG-209's pickPackBasis still
 * settles those.
 *
 * ⚠️ MEASURED BLAST RADIUS: exactly ONE row in the 1,569-row catalog carries a
 * subUnit ladder (BUG-211's Phase 0 count, unchanged by A3). `groupConv` has no
 * subUnit for every other ingredient there is, so this returns `own`
 * unmodified for all of them. It is a garlic fix wearing general syntax.
 */
export function withGroupLadder(
  own: IngredientConversion | null,
  groupConv: IngredientConversion | null | undefined,
): IngredientConversion | null {
  if (own?.subUnit) return own;
  if (!groupConv?.subUnit) return own;
  if (!own) return groupConv;
  return {
    ...own,
    subUnit: groupConv.subUnit,
    ...(groupConv.purchaseUnit !== undefined
      ? { purchaseUnit: groupConv.purchaseUnit }
      : {}),
  };
}

// WS7-5d Block 2 — shared purchase-pack defaults for the grocery-list
// gap-fill cache gate.
//
// Block 1 (commit 03a5da4) introduced this table in prisma/seeds/devData.ts
// for the seeded dev ingredients. Block 2 extracts it here so both the seed
// AND wizardActivation's runtime upsert path read from one source of truth.
// Without that, freshly-wizarded plans write Ingredient rows with null
// purchase fields → guaranteed miss on the cache gate in
// groceryListAI.fillPurchaseSizesWithWriteBack → serial Haiku gap-fill storm
// on every generate-grocery-list call (the live 502 root cause).
//
// Keys are lower-case + trimmed canonical names — matches both seed's
// canonicalize() and wizardActivation's `ing.name.toLowerCase().trim()` so
// the same key shape lands a hit from either write path.

export interface IngredientPurchase {
  purchaseUnit: string;
  purchaseQuantity: number;
  purchaseDisplay: string;
}

export const INGREDIENT_PURCHASE_DEFAULTS: Record<string, IngredientPurchase> = {
  "ground beef": { purchaseUnit: "lb", purchaseQuantity: 1, purchaseDisplay: "1 lb" },
  bacon: { purchaseUnit: "package", purchaseQuantity: 1, purchaseDisplay: "1 package (12 oz)" },
  "chicken thighs": { purchaseUnit: "lb", purchaseQuantity: 2, purchaseDisplay: "2 lb" },
  "chicken breast": { purchaseUnit: "lb", purchaseQuantity: 1, purchaseDisplay: "1 lb" },
  shrimp: { purchaseUnit: "lb", purchaseQuantity: 1, purchaseDisplay: "1 lb" },
  "salmon fillets": { purchaseUnit: "lb", purchaseQuantity: 1.5, purchaseDisplay: "1.5 lb (4 fillets)" },
  lettuce: { purchaseUnit: "head", purchaseQuantity: 1, purchaseDisplay: "1 head" },
  tomato: { purchaseUnit: "each", purchaseQuantity: 3, purchaseDisplay: "3 tomatoes" },
  "cherry tomatoes": { purchaseUnit: "pint", purchaseQuantity: 1, purchaseDisplay: "1 pint" },
  garlic: { purchaseUnit: "head", purchaseQuantity: 1, purchaseDisplay: "1 head" },
  parsley: { purchaseUnit: "bunch", purchaseQuantity: 1, purchaseDisplay: "1 bunch" },
  cilantro: { purchaseUnit: "bunch", purchaseQuantity: 1, purchaseDisplay: "1 bunch" },
  "fresh dill": { purchaseUnit: "bunch", purchaseQuantity: 1, purchaseDisplay: "1 bunch" },
  "yellow onion": { purchaseUnit: "each", purchaseQuantity: 2, purchaseDisplay: "2 onions" },
  ginger: { purchaseUnit: "piece", purchaseQuantity: 1, purchaseDisplay: "1 piece (2 in)" },
  cucumber: { purchaseUnit: "each", purchaseQuantity: 1, purchaseDisplay: "1 cucumber" },
  lemon: { purchaseUnit: "each", purchaseQuantity: 2, purchaseDisplay: "2 lemons" },
  // WS7-8b B1 (BUG-025-3) — common recurring produce sold by the bunch, so a
  // recurring "bananas" reminder renders "1 bunch" instead of "each".
  banana: { purchaseUnit: "bunch", purchaseQuantity: 1, purchaseDisplay: "1 bunch" },
  bananas: { purchaseUnit: "bunch", purchaseQuantity: 1, purchaseDisplay: "1 bunch" },
  lime: { purchaseUnit: "each", purchaseQuantity: 2, purchaseDisplay: "2 limes" },
  "bean sprouts": { purchaseUnit: "bag", purchaseQuantity: 1, purchaseDisplay: "1 bag (8 oz)" },
  "bell peppers": { purchaseUnit: "each", purchaseQuantity: 3, purchaseDisplay: "3 peppers" },
  cheddar: { purchaseUnit: "block", purchaseQuantity: 1, purchaseDisplay: "1 block (8 oz)" },
  parmesan: { purchaseUnit: "wedge", purchaseQuantity: 1, purchaseDisplay: "1 wedge (6 oz)" },
  feta: { purchaseUnit: "block", purchaseQuantity: 1, purchaseDisplay: "1 block (8 oz)" },
  "sour cream": { purchaseUnit: "container", purchaseQuantity: 1, purchaseDisplay: "1 container (16 oz)" },
  eggs: { purchaseUnit: "dozen", purchaseQuantity: 1, purchaseDisplay: "1 dozen" },
  butter: { purchaseUnit: "package", purchaseQuantity: 1, purchaseDisplay: "1 package (1 lb, 4 sticks)" },
  "taco shells": { purchaseUnit: "box", purchaseQuantity: 1, purchaseDisplay: "1 box (12 ct)" },
  "flour tortillas": { purchaseUnit: "package", purchaseQuantity: 1, purchaseDisplay: "1 package (10 ct)" },
  spaghetti: { purchaseUnit: "box", purchaseQuantity: 1, purchaseDisplay: "1 box (1 lb)" },
  "rice noodles": { purchaseUnit: "package", purchaseQuantity: 1, purchaseDisplay: "1 package (8 oz)" },
  "basmati rice": { purchaseUnit: "bag", purchaseQuantity: 1, purchaseDisplay: "1 bag (2 lb)" },
  farro: { purchaseUnit: "bag", purchaseQuantity: 1, purchaseDisplay: "1 bag (16 oz)" },
  salsa: { purchaseUnit: "jar", purchaseQuantity: 1, purchaseDisplay: "1 jar (16 oz)" },
  tahini: { purchaseUnit: "jar", purchaseQuantity: 1, purchaseDisplay: "1 jar (16 oz)" },
  "tikka masala paste": { purchaseUnit: "jar", purchaseQuantity: 1, purchaseDisplay: "1 jar (10 oz)" },
  "tamarind paste": { purchaseUnit: "jar", purchaseQuantity: 1, purchaseDisplay: "1 jar (8 oz)" },
  "fish sauce": { purchaseUnit: "bottle", purchaseQuantity: 1, purchaseDisplay: "1 bottle (8 oz)" },
  "olive oil": { purchaseUnit: "bottle", purchaseQuantity: 1, purchaseDisplay: "1 bottle (17 oz)" },
  "vegetable broth": { purchaseUnit: "carton", purchaseQuantity: 1, purchaseDisplay: "1 carton (32 oz)" },
  peanuts: { purchaseUnit: "bag", purchaseQuantity: 1, purchaseDisplay: "1 bag (8 oz)" },
  "taco seasoning": { purchaseUnit: "packet", purchaseQuantity: 1, purchaseDisplay: "1 packet" },
  "fajita seasoning": { purchaseUnit: "packet", purchaseQuantity: 1, purchaseDisplay: "1 packet" },
  "black pepper": { purchaseUnit: "container", purchaseQuantity: 1, purchaseDisplay: "1 container" },
  salt: { purchaseUnit: "container", purchaseQuantity: 1, purchaseDisplay: "1 container" },
  "coconut milk": { purchaseUnit: "can", purchaseQuantity: 1, purchaseDisplay: "1 can (13.5 oz)" },
  "diced tomatoes": { purchaseUnit: "can", purchaseQuantity: 1, purchaseDisplay: "1 can (14.5 oz)" },
  chickpeas: { purchaseUnit: "can", purchaseQuantity: 1, purchaseDisplay: "1 can (15 oz)" },
};

/**
 * Lookup with the same lower-case + trim normalization both write paths use.
 * Returns null when the ingredient is not in the table — callers leave the
 * row's purchase fields null so the gap-fill path still handles genuine
 * unknowns. The goal here is to kill the cache-miss storm for COMMON items,
 * not to pretend we know every pack size.
 */
export function lookupPurchaseDefault(
  canonicalName: string,
): IngredientPurchase | null {
  const key = canonicalName.toLowerCase().trim();
  if (!key) return null;
  return INGREDIENT_PURCHASE_DEFAULTS[key] ?? null;
}

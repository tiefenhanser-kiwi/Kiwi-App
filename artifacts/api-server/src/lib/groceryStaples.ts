// WS6 6c-4 Block A — Universal staples seed.
// Hardcoded const (not DB) per Phase 1 D-WS6-066. Originally 14 items;
// WS7-5d Block 5 Fix 1 adds "water" (15) — recipes calling for "1/2 cup
// water" must not put a bottle of water on the shopping list. Eggs/milk
// remain excluded because they're per-household variable. defaultSection
// values match the StoreSection enum (PRD §12.4 / schema).

export const UNIVERSAL_STAPLES = [
  { canonicalName: "salt", defaultSection: "pantry", defaultUnit: "container" },
  { canonicalName: "black pepper", defaultSection: "pantry", defaultUnit: "container" },
  // WS7-5d Block 5 Fix 1: "water" as a staple. Exact-match (UNIVERSAL_STAPLE_KEYS
  // in groceryList.ts) catches the canonical "water" the wizard AI emits for
  // "1/2 cup water". Variants like "tap water" / "filtered water" are NOT
  // caught — same as "salt" doesn't catch "sea salt"; that's the existing
  // exact-match staple model, not a new path. defaultSection "pantry" is a
  // placeholder for the dimmed default-staple row; the user opts in only if
  // they actually want bottled water on the trip.
  { canonicalName: "water", defaultSection: "pantry", defaultUnit: "bottle" },
  { canonicalName: "butter", defaultSection: "dairy_eggs", defaultUnit: "stick" },
  { canonicalName: "olive oil", defaultSection: "pantry", defaultUnit: "bottle" },
  { canonicalName: "vegetable oil", defaultSection: "pantry", defaultUnit: "bottle" },
  { canonicalName: "sugar", defaultSection: "pantry", defaultUnit: "bag" },
  { canonicalName: "all-purpose flour", defaultSection: "pantry", defaultUnit: "bag" },
  { canonicalName: "baking soda", defaultSection: "pantry", defaultUnit: "box" },
  { canonicalName: "baking powder", defaultSection: "pantry", defaultUnit: "container" },
  { canonicalName: "ketchup", defaultSection: "pantry", defaultUnit: "bottle" },
  { canonicalName: "soy sauce", defaultSection: "pantry", defaultUnit: "bottle" },
  { canonicalName: "yellow mustard", defaultSection: "pantry", defaultUnit: "bottle" },
  { canonicalName: "dijon mustard", defaultSection: "pantry", defaultUnit: "jar" },
  { canonicalName: "mayonnaise", defaultSection: "pantry", defaultUnit: "jar" },
] as const;

export type UniversalStaple = (typeof UNIVERSAL_STAPLES)[number];

// WS7-8b B1 (BUG-025-5) — variant→base staple normalization.
// The staple flag is an exact-string membership test against
// UNIVERSAL_STAPLE_KEYS (groceryList.ts), so common named variants
// ("kosher salt", "cracked black pepper", "extra-virgin olive oil") miss the
// base staple and leak onto the buy-list instead of rendering greyed
// (PRD §2.2 + §12.7 [LOCKED] — a universal staple must render greyed).
// Map the known variants of the three families the staples list supports
// (salt / black pepper / olive oil) to their base BEFORE the membership check.
//
// EXACT-STRING keys (not substring): a seasoning that merely CONTAINS a staple
// word — "garlic salt", "celery salt", "onion salt", "seasoned salt",
// "salted butter", "bell pepper", "white pepper", "red pepper flakes" — is
// absent from this map and therefore never swept in. This deliberately does
// NOT map bare "flour"→"all-purpose flour" (bread/almond flour) or bare
// "pepper" (bell/white/chili), to avoid false positives.
const STAPLE_VARIANT_TO_BASE: Record<string, string> = {
  // salt
  "kosher salt": "salt",
  "sea salt": "salt",
  "table salt": "salt",
  "coarse salt": "salt",
  "coarse sea salt": "salt",
  "flaky salt": "salt",
  "flaky sea salt": "salt",
  "fine salt": "salt",
  "fine sea salt": "salt",
  "kosher sea salt": "salt",
  // black pepper
  "cracked black pepper": "black pepper",
  "ground black pepper": "black pepper",
  "freshly ground black pepper": "black pepper",
  "fresh ground black pepper": "black pepper",
  "cracked pepper": "black pepper",
  "ground pepper": "black pepper",
  "black peppercorns": "black pepper",
  // olive oil
  "extra-virgin olive oil": "olive oil",
  "extra virgin olive oil": "olive oil",
  "virgin olive oil": "olive oil",
  "light olive oil": "olive oil",
  evoo: "olive oil",
};

/**
 * Map a normalized ingredient name to its base staple when it is a known
 * variant; otherwise return it unchanged. Input MUST already be
 * normalizeIngredientName()-normalized (lowercase, collapsed whitespace,
 * leading-article stripped) — the same shape UNIVERSAL_STAPLE_KEYS holds.
 * Pure lookup: does NOT mutate or imply any change to the ingredient's stored
 * canonicalName / displayName (the user still sees "Kosher salt").
 */
export function baseStapleName(normalized: string): string {
  return STAPLE_VARIANT_TO_BASE[normalized] ?? normalized;
}

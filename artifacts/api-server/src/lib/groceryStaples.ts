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

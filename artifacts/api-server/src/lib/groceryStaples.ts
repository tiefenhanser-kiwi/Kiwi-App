// WS6 6c-4 Block A — Universal staples seed.
// Hardcoded const (not DB) per Phase 1 D-WS6-066. 14 items; eggs/milk
// excluded because they're per-household variable. defaultSection values
// match the StoreSection enum (PRD §12.4 / schema).

export const UNIVERSAL_STAPLES = [
  { canonicalName: "salt", defaultSection: "pantry", defaultUnit: "container" },
  { canonicalName: "black pepper", defaultSection: "pantry", defaultUnit: "container" },
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

// WS6 6c-4 Block A — Universal staples seed.
// Hardcoded const (not DB) per Phase 1 D-WS6-066. Originally 14 items;
// WS7-5d Block 5 Fix 1 adds "water" (15) — recipes calling for "1/2 cup
// water" must not put a bottle of water on the shopping list. Eggs/milk
// remain excluded because they're per-household variable. defaultSection
// values match the StoreSection enum (PRD §12.4 / schema).

export const UNIVERSAL_STAPLES = [
  { canonicalName: "salt", defaultSection: "pantry", defaultUnit: "container" },
  { canonicalName: "black pepper", defaultSection: "pantry", defaultUnit: "container" },
  // WS9 BUG-169 — "water" REMOVED from this list (it was added by WS7-5d Block 5
  // Fix 1 on 2026-06-03). That fix had the right intent — "a recipe's '1/2 cup
  // water' must not render as a buyable bottle" — but the wrong mechanism: a
  // universal staple is still a ROW, just a dimmed one. It was never an
  // exclusion, so nothing regressed; BUG-125's order line simply made the
  // long-standing row conspicuous by printing "1 bottle (16.9 oz)" next to it.
  //
  // Water is now in NEVER_ORDER_CANONICALS below and is dropped outright.
  // Deleted here rather than left alongside the exclusion: two mechanisms for
  // one concern drift, and the staple entry would have been dead weight that
  // still reserved a flag, a section and a default unit for a row that can no
  // longer exist.
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

// WS9 BUG-169 — never-order canonicals.
//
// Hans's ruling: "we shouldn't tell someone to order water. I can't think of a
// need to order water for groceries for a meal." A recipe's water comes out of
// the tap; it is an instruction, not a purchase, so the row should not exist at
// all rather than exist and be dimmed.
//
// EXACT-STRING, never substring — the same discipline STAPLE_VARIANT_TO_BASE
// uses. The catalog holds 17 rows whose canonicalName contains "water", and a
// substring rule gets 5 of them wrong. Classified in full:
//
//   EXCLUDE (8, below)   water · warm water · cold water · ice water ·
//                        ice-cold water · boiling water · pasta cooking water ·
//                        reserved pasta cooking water
//   KEEP, purchasable (3) rose water · kewra water · cold sparkling water
//                        — none of these come out of a tap; you buy a bottle.
//   KEEP, not a match (6) canned tuna in water · canned albacore tuna in water ·
//                        canned solid white albacore tuna in water ·
//                        solid white albacore tuna in water · seedless
//                        watermelon · watercress
//
// KNOWN LIMITATION, accepted: an authored list goes stale. Nothing stops a
// future recipe emitting "lukewarm water" or "filtered water", and it would
// render fully buyable with no signal. The durable never-order CLASS (and the
// judgement that separates tap water from bottled sparkling water) belongs to
// the ingredient-relationship program, D-WS9-189. Do not grow a pattern-matcher
// here to cover it — that is how this file accumulated its current shape.
const NEVER_ORDER_CANONICALS: ReadonlySet<string> = new Set([
  "water",
  "warm water",
  "cold water",
  "ice water",
  "ice-cold water",
  "boiling water",
  "pasta cooking water",
  "reserved pasta cooking water",
]);

/**
 * True when a PLAN-DERIVED ingredient must never reach the grocery list at all.
 * Input MUST already be normalizeIngredientName()-normalized, the same contract
 * baseStapleName has.
 *
 * SCOPE: the consolidator applies this to dish-derived ingredients only. A user
 * who types "water" into their recurring groceries, or adds it to a list by
 * hand, is stating an explicit intent to buy it — that is not this rule's
 * business, and silently dropping it would be a worse bug than the one being
 * fixed.
 */
export function isNeverOrdered(normalized: string): boolean {
  return NEVER_ORDER_CANONICALS.has(normalized);
}

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

// WS9 BUG-170 / BUG-168 — variant→base folding for MERGE GROUPING only.
//
// STAPLE_VARIANT_TO_BASE above answers "do I already have this in the pantry?"
// and every entry belongs there: kosher salt IS a pantry staple and must render
// greyed, not land on the buy-list (BUG-025-5, PRD §2.2 + §12.7 [LOCKED]).
//
// This map answers a DIFFERENT question — "is this literally the same thing to
// buy?" — and the answers diverge. Hans (device item 8): "salts are super
// different so keeping them separate is probably needed and best… iodized salt
// is NOT kosher is NOT flaky sea salt." And on pepper: "peppercorns as an
// ingredient are different than black pepper (ground)… the big thing to avoid
// here is needing 1 tsp ground black pepper and telling a user to buy
// peppercorns they need to grind."
//
// So this map is the staple map MINUS the rows that are distinct PRODUCTS:
//   dropped — all 10 salts (grain size is the product) and `black peppercorns`
//             (whole; you would have to grind them). BUG-168.
//   kept    — the 6 ground-black-pepper spellings, which are one container of
//             the same thing, and all 5 olive-oil entries, where
//             "extra virgin" / "extra-virgin" / "evoo" are the same bottle.
//
// ⚠️ This does NOT weaken BUG-142. Two rows of the SAME variant — kosher salt
// in teaspoons and kosher salt in tablespoons — share a raw canonical name and
// so still group together without any folding at all; groupConversion's
// separate base-staple fallback still lends them base salt's density. That pair
// merging was the actual bug. Folding kosher INTO flaky sea salt never was.
const MERGE_GROUP_VARIANT_TO_BASE: Record<string, string> = {
  // black pepper — ground forms only; `black peppercorns` is deliberately absent
  "cracked black pepper": "black pepper",
  "ground black pepper": "black pepper",
  "freshly ground black pepper": "black pepper",
  "fresh ground black pepper": "black pepper",
  "cracked pepper": "black pepper",
  "ground pepper": "black pepper",
  // olive oil
  "extra-virgin olive oil": "olive oil",
  "extra virgin olive oil": "olive oil",
  "virgin olive oil": "olive oil",
  "light olive oil": "olive oil",
  evoo: "olive oil",
};

/**
 * Fold a normalized name to the name it should GROUP under when deciding
 * whether two grocery rows are the same purchase. Identity for anything not
 * listed — including every salt, which is why two different salts stay two
 * rows. Same normalized-input contract as {@link baseStapleName}.
 */
export function mergeGroupBaseName(normalized: string): string {
  return MERGE_GROUP_VARIANT_TO_BASE[normalized] ?? normalized;
}

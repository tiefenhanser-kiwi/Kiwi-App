// [grocery] B2 — THE DATA. Everything the digest, the defaults list and the dry
// run read their figures from HERE, so Hans's rulings land in one place. B1's
// `scripts/grocery-b1/proposals.ts` has the same job and the same shape.
//
// Nothing in this file touches the database.
//
// ── THE MODEL, AFTER HANS'S SEPTEMBER 28 RULINGS (H1–H7) ────────────────────
//
// Part A classified every subsumes edge as QUALIFIER / KEEP / GENERIC and
// folded the QUALIFIER ones onto the generic with an "at least one X" rider.
// Hans ruled that wrong in three messages. The replacement:
//
//   H1  BUY WHAT THE RECIPE SAYS. A variety, colour, cut or state a recipe
//       names is bought as named, on its own line. Varieties NEVER merge with
//       each other.
//   H2  A plain name with a ruled everyday DEFAULT joins the default's line and
//       is named as the default. (`chicken thighs` -> `bone-in chicken thighs`.)
//   H3  A plain name with NO default stays generic and CARRIES the called-out
//       varieties — but ONLY when a recipe demanded the generic itself, and only
//       in WHOLE UNITS of the line's buy unit. "5 bell peppers, at least 2 red
//       and at least 2 yellow."
//   H4  A plain name is never upgraded to a specific. "1 tbsp parsley" buys
//       parsley. Hedge, size and prep words are not varieties — they are
//       stripped (the GENERIC class).
//   H5  Weight- and volume-sold generics never carry shares.
//   H6  After any fold, B1's arithmetic runs on the group total.
//   H7  The retailer hand-off keeps the shopper's constraint.
//
// So an edge now answers ONE question — what happens when BOTH names are on the
// list — and the three answers are:
//
//   H1       two lines, always. The specific is a different product.
//   H3       one line IF the generic was demanded and the generic is count-sold;
//            two lines otherwise. The specific is a real store product that the
//            generic can stand in for when the shopper is choosing anyway.
//   GENERIC  one line, always, no rider. The "specific" is a hedge, a size or a
//            prep note, not a product.

// ── THE RULES LIVE IN PRODUCTION, NOT HERE ────────────────────────────────
//
// The H1-H7 classifier, the token families, the per-edge overrides, the two
// DEFAULTS and H5's count-pack set moved to `src/lib/subsumesClasses.ts` in
// Part C. They are re-exported so every digest and dry run in this folder keeps
// reading the same names — but there is now exactly ONE copy, and it is the one
// production applies. A rule Hans rules on and a rule the pipeline uses cannot
// drift apart any more.
export {
  type HClass,
  type EdgeRuling,
  type DefaultRuling,
  H1_TOKENS,
  H3_TOKENS,
  distinguishingTokens,
  classifyEdge,
  DEFAULTS,
  RULED_DEFAULTS,
  COUNT_PACK_UNITS,
  packUnitCarriesShares,
} from "../../src/lib/subsumesClasses";

// 7 — C: CASING (BUG-323), unchanged except for the go-ahead's one correction.
// ---------------------------------------------------------------------------

// The casing rule moved to `src/lib/ingredientNameCase.ts` in Part C, because the
// INTAKE path has to apply the same rule to every row minted after the one-time
// fix. Re-exported so this sheet and the digests keep reading the same names.
export { PROPER_NOUN_LEADS, lowercaseLead } from "../../src/lib/ingredientNameCase";

// ---------------------------------------------------------------------------
// 8 — N: BUY NAMES (R7), with the go-ahead's chicken rulings applied.
// ---------------------------------------------------------------------------

export interface NameCleaning {
  current: string;
  line: string;
  why: string;
  uncertain: boolean;
}

const NEUTRAL_OIL_SPELLINGS = [
  "neutral oil", "neutral cooking oil", "neutral oil (for frying)",
  "neutral oil for frying", "neutral oil (such as avocado or canola oil)",
  "neutral oil (such as canola or grapeseed)", "neutral oil (such as canola)",
  "neutral oil (such as grapeseed or avocado)",
  "neutral oil (such as grapeseed or canola)", "neutral oil (such as vegetable oil)",
  "neutral oil (such as vegetable or avocado oil)",
  "neutral oil (such as vegetable or canola oil)",
  "neutral oil (such as vegetable or canola)",
  "neutral oil (such as vegetable or peanut oil)",
  "neutral oil (vegetable or canola)", "neutral vegetable oil",
];

export const NAME_CLEANINGS: readonly NameCleaning[] = [
  ...NEUTRAL_OIL_SPELLINGS.map((current) => ({
    current, line: "vegetable oil",
    why: "Hans: neutral oil can be considered vegetable oil — a store sells vegetable oil and sells nothing called neutral oil",
    uncertain: false,
  })),
  { current: "neutral cooking spray", line: "cooking spray", why: "same ruling, the spray form", uncertain: false },
  { current: "lard or neutral oil", line: "lard or vegetable oil", why: "go-ahead N #399 YES — the or-alternative is not rewritten; only the neutral half is renamed", uncertain: false },

  // ── the chicken cuts, as the go-ahead ruled them (#400-#403) ─────────────
  //
  // ⚠️ "skin-on" IS DROPPED FROM THE LINE unless the recipe's own text carries
  // it. Not a simplification: under H1 the cut is the product, and the go-ahead
  // ruled the product here is `bone-in chicken thighs`.
  { current: "bone-in, skin-on chicken thighs", line: "bone-in chicken thighs", why: "go-ahead N #400 — skin-on dropped from the line", uncertain: false },
  { current: "bone-in skin-on chicken thighs", line: "bone-in chicken thighs", why: "go-ahead N #401 — same, the comma-less spelling", uncertain: false },
  { current: "bone-in, skin-on chicken drumsticks", line: "bone-in chicken drumsticks", why: "go-ahead N #402", uncertain: false },
  { current: "bone-in skin-on chicken drumsticks", line: "bone-in chicken drumsticks", why: "go-ahead N #402 — same, the comma-less spelling", uncertain: false },
  {
    current: "boneless skinless chicken thighs", line: "boneless skinless chicken thighs",
    why: "go-ahead N #403 — STAYS, and is searched as exactly that (H7)", uncertain: false,
  },
  // ── the rest of the 13 rows that say skin-on ──────────────────────────────
  //
  // The Parts B-E go-ahead: "drop it from the DISPLAY line under N (13 catalog
  // rows)". Four are above; these are the other nine.
  //
  // ⚠️ A CONCERN, STATED AND THEN APPLIED AS RULED. For chicken the drop costs
  // nothing: bone-in chicken at retail is skin-on, so `bone-in chicken thighs`
  // names the same pack. For SALMON and PORK BELLY it is not the same pack — a
  // fish counter sells skin-on and skinless side by side, `skinless salmon
  // fillet` is its own catalog row, and H1 says the cut is the product. After
  // this, three rows (`salmon fillets`, `salmon fillets, skin-on`, `skin-on
  // salmon fillets`) all read "salmon fillets" while the skinless one reads
  // "skinless salmon fillet". Reported; the ruling is applied as given.
  { current: "bone-in skin-on chicken breast", line: "bone-in chicken breast", why: "the skin-on drop, chicken", uncertain: false },
  { current: "bone-in, skin-on chicken breasts", line: "bone-in chicken breasts", why: "the skin-on drop, chicken", uncertain: false },
  { current: "bone-in, skin-on chicken pieces (drumsticks and thighs)", line: "bone-in chicken pieces (drumsticks and thighs)", why: "the skin-on drop, chicken", uncertain: false },
  { current: "bone-in, skin-on chicken pieces (thighs and drumsticks)", line: "bone-in chicken pieces (thighs and drumsticks)", why: "the skin-on drop, chicken", uncertain: false },
  { current: "bone-in, skin-on turkey breast half", line: "bone-in turkey breast half", why: "the skin-on drop, poultry", uncertain: false },
  { current: "whole chicken halves (bone-in, skin-on)", line: "whole chicken halves (bone-in)", why: "the skin-on drop, chicken", uncertain: false },
  { current: "salmon fillets, skin-on", line: "salmon fillets", why: "the skin-on drop as ruled — see the concern above", uncertain: false },
  { current: "skin-on salmon fillets", line: "salmon fillets", why: "the skin-on drop as ruled — see the concern above", uncertain: false },
  { current: "pork belly, skin-on", line: "pork belly", why: "the skin-on drop as ruled — see the concern above", uncertain: false },

  { current: "corn tortillas (6-inch)", line: "corn tortillas (6-inch)", why: "already R7's shape; only the search term changes, and it already does", uncertain: false },
  { current: "large flour tortillas (10-inch)", line: "flour tortillas (large, 10-inch)", why: "R7's verbatim shape", uncertain: false },
  { current: "large flour tortillas (12-inch)", line: "flour tortillas (large, 12-inch)", why: "same", uncertain: false },
  { current: "flour tortillas (10-inch)", line: "flour tortillas (10-inch)", why: "already the shape", uncertain: false },
  { current: "mozzarella cheese, shredded", line: "shredded mozzarella cheese", why: "the comma inversion is not a search term", uncertain: false },
  { current: "day-old cooked long-grain white rice", line: "long-grain white rice (day-old, cooked)", why: "day-old and cooked are recipe states, not things a store stocks", uncertain: false },
  { current: "80/20 ground beef", line: "ground beef (80/20)", why: "go-ahead N #410 YES", uncertain: false },
  { current: "fresh basil leaves", line: "fresh basil (leaves)", why: "go-ahead N #411 YES", uncertain: false },
  { current: "fresh sage leaves", line: "fresh sage (leaves)", why: "go-ahead N #412 YES", uncertain: false },
  { current: "iceberg lettuce leaves", line: "iceberg lettuce (leaves)", why: "go-ahead N #413 YES", uncertain: false },
];

export const NAME_REFUSALS: readonly { name: string; why: string }[] = [
  { name: "bay leaves", why: "go-ahead N9 — NOT a part. A store sells a container of bay leaves and sells no bay; the census part-word regex is over-broad. Casing is the only change." },
  { name: "fennel fronds", why: "gets a PARENT EDGE, not a rename — see PART_EDGES." },
];

export const PART_EDGES: readonly {
  parent: string; child: string; yieldQuantity: number; yieldUnit: string;
  coHarvestable: boolean; why: string; uncertain: boolean;
}[] = [
  {
    parent: "fennel bulb", child: "fennel fronds", yieldQuantity: 3, yieldUnit: "tablespoon",
    coHarvestable: true, uncertain: false,
    why: "go-ahead N #416 YES. Hans: tops are part of the bulb and come with it. The bulb row ALREADY EXISTS (purchaseUnit `each`, pack '1 fennel bulb'), so `each` is in COMPONENT_BASIS_UNITS and the edge is admitted as authored.",
  },
];

// ---------------------------------------------------------------------------
// BUG-330 — the pint of cherry tomatoes that under-orders.
// ---------------------------------------------------------------------------

/**
 * A8's Gate 1 caught one row failing at HEAD as well as after: `1 pint cherry
 * tomatoes (12 ounce)` buys 298 g against a 340 g need. The pack is a PINT (a
 * volume) and the need is in OUNCES (a weight), and nothing said how much of
 * the need one pint gives — so `resolvePurchaseFields` left the count at 1.
 * B1's per-ingredient pack yield is exactly the home for that.
 *
 * THE FIGURE: 10 ounces per dry pint. Two independent sources, and they agree:
 *   • USDA FoodData Central, "Tomatoes, cherry, raw" — 1 cup = 149 g. A dry pint
 *     is 2 cups, so 298 g = 10.51 oz. This is the same 149 g/cup already in the
 *     row's own curated conversionRef, so the arithmetic is self-consistent.
 *   • US retail: the clamshell labelled "pint" is netted at 10 oz (Sunset,
 *     NatureSweet, and the store brands all print 10 oz).
 *
 * 10 is the LOWER of the two and that is the direction the ruling requires: a
 * yield is a claim about how much a pack GIVES, so understating it buys one more
 * pack and overstating it leaves the shopper short. D-WS9-182's rule, unchanged.
 * 12 oz / 10 = 1.2 -> ceil -> TWO pints, 20 oz bought against 12 needed.
 *
 * ⚠️ `grape tomatoes` HAS NO CATALOG ROW. The figure is the same (grape and
 * cherry are sold in the identical 10-oz clamshell) and is recorded here so the
 * next lane does not re-derive it, but the apply will SKIP it with that reason
 * rather than mint a row this block has no ruling for.
 */
export const PACK_YIELDS: readonly {
  ingredient: string;
  unit: string;
  perPack: number;
  source: string;
  why: string;
}[] = [
  {
    ingredient: "cherry tomatoes", unit: "ounce", perPack: 10, source: "human",
    why: "BUG-330 — USDA FDC 149 g/cup gives 10.51 oz per dry pint; the retail clamshell is netted at 10 oz. 10 is the lower figure, so it never over-claims what a pint gives.",
  },
  {
    ingredient: "grape tomatoes", unit: "ounce", perPack: 10, source: "human",
    why: "BUG-330 — the same 10-oz clamshell. No catalog row today; recorded so the figure is not re-derived.",
  },
];

/** go-ahead N6 — the label is wrong, not the edge. */
export const RELABEL_TO_SYNONYM: readonly { from: string; to: string; why: string }[] = [
  {
    from: "romaine lettuce", to: "romaine lettuce hearts",
    why: "go-ahead N6 — Hans: 'Romaine lettuce hearts are just romaine in my opinion.' The row is labelled `component`, which asserts a yield relation that does not exist. Relabel to `synonym`, reviewedByHuman.",
  },
];

/**
 * go-ahead S.1 #298 — H1 AND never-order. Both endpoints are a by-product of
 * cooking, not a purchase. `isNeverOrdered` (groceryStaples.ts) is the existing
 * home; these are candidates for it, reported rather than written by this file.
 */
export const NEVER_ORDER_CANDIDATES: readonly {
  name: string;
  onADish: boolean;
  why: string;
}[] = [
  { name: "reserved birria braising liquid", onADish: true, why: "go-ahead S.1 #298, named" },
  { name: "reserved braising liquid from chicken birria", onADish: true, why: "go-ahead S.1 #298, named" },
  { name: "reserved braising liquid from goat birria", onADish: true, why: "the same by-product under the third spelling — swept in by the same argument" },
  { name: "braising liquid from pot roast", onADish: false, why: "same; no dish reaches it today" },
  { name: "reserved frying oil", onADish: true, why: "oil the shopper already bought, set aside mid-recipe" },
  { name: "reserved pineapple juice", onADish: true, why: "the juice in the can of pineapple already on the list" },
  { name: "reserved zucchini flesh", onADish: true, why: "scooped out of the zucchini already on the list" },
  { name: "reserved pasta water", onADish: false, why: "a spelling NEVER_ORDER_CANONICALS does not carry — the set has `pasta cooking water` and `reserved pasta cooking water`, not this one" },
];

/**
 * Already in `NEVER_ORDER_CANONICALS` (groceryStaples.ts) — listed so the Part B
 * apply does not "add" them and report a change that is not one.
 */
export const NEVER_ORDER_ALREADY: readonly string[] = [
  "pasta cooking water",
  "reserved pasta cooking water",
];

// [grocery] B1 · Part A — THE PROPOSALS. DATA ONLY, applied by nothing yet.
//
// Y — per-ingredient PACK YIELDS: how much of the need unit one PACK yields.
//     The pack noun is NOT repeated here: it is `Ingredient.purchaseUnit`,
//     which already exists. A yield is (unit, perPack) and nothing else, which
//     is exactly the shape D-WS9-225 proposed and exactly what the garlic
//     `subUnit {parent, perParent}` ladder already is, minus the child unit it
//     never had to name because its child was always a clove.
//
// P — part -> parent COMPONENT edges (coHarvestable where the part rides free).
// X — refusals and data fixes.
//
// PRECEDENCE, applied throughout and stated once: Hans's ruled figures (§2)
// beat pack_yields_REVIEWED.csv, which beats a web reference, which beats a
// figure derived from the row's own gramsPerCup / gramsPerEach. A food whose
// need and pack are ALREADY relatable by the existing density path gets NO
// yield row — see NO_YIELD_NEEDED.

export type YieldSource =
  | "Hans Sept 7"
  | "Hans Sept 28"
  | "D-WS9-182"
  | "D-WS9-220"
  | "CSV(usable)"
  | "relation-edge"
  | "web"
  | "derived";

export interface PackYield {
  ingredient: string;
  /** the unit `perPack` is counted in */
  unit: string;
  perPack: number;
  source: YieldSource;
  /** one-line citation / derivation */
  note: string;
  /** true when this lane had to CHOOSE — Hans sees a `?` on the digest line */
  chose?: boolean;
}

// ── Y ───────────────────────────────────────────────────────────────────────
export const PACK_YIELDS: PackYield[] = [
  // --- the ladder's first row, and the one that must not change behaviour ---
  { ingredient: "garlic", unit: "clove", perPack: 10, source: "D-WS9-220",
    note: "Hans: 'garlic heads have ~10 cloves'; identical to today's conversionRef.subUnit {head, 10}" },

  // --- herbs sold by the bunch: Hans's Sept 7 convention ---
  // "a supermarket herb bunch is about 1 oz; a bunch yields 2 cups of leaves
  //  uncut, 1 cup chopped; '1 cup cilantro' with no cut named = leaves and
  //  stems as bought" -> an UNQUALIFIED herb name takes the 2-cup figure.
  { ingredient: "fresh cilantro", unit: "cup", perPack: 2, source: "Hans Sept 7", note: "uncut leaves+stems, 2 cup/bunch" },
  { ingredient: "cilantro", unit: "cup", perPack: 2, source: "Hans Sept 7", note: "same food, same figure" },
  { ingredient: "fresh flat-leaf parsley", unit: "cup", perPack: 2, source: "Hans Sept 7", note: "uncut, 2 cup/bunch" },
  { ingredient: "fresh parsley", unit: "cup", perPack: 2, source: "Hans Sept 7", note: "uncut, 2 cup/bunch" },
  { ingredient: "parsley", unit: "cup", perPack: 2, source: "Hans Sept 7", note: "uncut, 2 cup/bunch" },
  { ingredient: "flat-leaf parsley", unit: "cup", perPack: 2, source: "Hans Sept 7", note: "uncut, 2 cup/bunch" },
  { ingredient: "fresh basil", unit: "cup", perPack: 2, source: "relation-edge", note: "fresh basil -> fresh basil leaves 2 cup, high + human-reviewed; agrees with Hans Sept 7" },
  { ingredient: "thai basil", unit: "cup", perPack: 2, source: "Hans Sept 7", note: "herb-bunch convention", chose: true },
  { ingredient: "fresh dill", unit: "cup", perPack: 2, source: "Hans Sept 7", note: "herb-bunch convention" },
  { ingredient: "fresh mint", unit: "cup", perPack: 2, source: "Hans Sept 7", note: "herb-bunch convention; the live `fresh mint -> fresh mint leaves 1 cup` edge is high but NOT human-reviewed and disagrees", chose: true },
  { ingredient: "fresh oregano", unit: "cup", perPack: 2, source: "Hans Sept 7", note: "herb-bunch convention; the live `-> fresh oregano leaves 4 tbsp` edge is high, unreviewed, and disagrees", chose: true },
  { ingredient: "fresh sage", unit: "cup", perPack: 0.5, source: "relation-edge", note: "fresh sage -> fresh sage leaves 0.5 cup (high, unreviewed); sage leaves are large and sparse, so the 2-cup convention overstates", chose: true },
  // woody herbs: the reviewed thyme edge is the precedent, rosemary takes parity
  { ingredient: "fresh thyme", unit: "tbsp", perPack: 3, source: "relation-edge", note: "fresh thyme -> fresh thyme leaves 3 tbsp, high + human-reviewed" },
  { ingredient: "fresh rosemary", unit: "tbsp", perPack: 3, source: "relation-edge", note: "parity with the reviewed thyme figure — both woody, leaves stripped from the stem", chose: true },
  { ingredient: "fresh rosemary, finely chopped", unit: "tbsp", perPack: 3, source: "relation-edge", note: "parity with fresh rosemary", chose: true },
  { ingredient: "fresh chives", unit: "tbsp", perPack: 8, source: "CSV(usable)", note: "pack_yields_REVIEWED.csv, claude_pass=RULED (Hans)" },
  // the CUT-NAMED variants take Hans's 1-cup chopped figure
  { ingredient: "fresh cilantro, roughly chopped", unit: "cup", perPack: 1, source: "Hans Sept 7", note: "CHOPPED: 1 cup/bunch" },
  { ingredient: "fresh flat-leaf parsley, finely chopped", unit: "tbsp", perPack: 16, source: "Hans Sept 7", note: "= 1 cup chopped per bunch" },

  // --- heads and whole produce ---
  { ingredient: "iceberg lettuce", unit: "cup", perPack: 4, source: "Hans Sept 28", note: "'iceberg probably shreds to 4 cups'; the row's own 539 g/head ÷ 57 g/cup would say 9.5, and Hans's ruled figure wins" },
  { ingredient: "green cabbage", unit: "cup", perPack: 8, source: "CSV(usable)", note: "CSV PROPOSED (high); the row's own 908 g/head ÷ 89 g/cup says 10.2 — the lower figure buys more, never less", chose: true },
  { ingredient: "red cabbage", unit: "cup", perPack: 8, source: "CSV(usable)", note: "CSV PROPOSED (high); own density says 12.0 — same argument as green", chose: true },
  { ingredient: "romaine lettuce", unit: "cup", perPack: 6, source: "web", note: "a romaine head ~300 g ÷ its own 47 g/cup = 6.4 cup shredded", chose: true },
  { ingredient: "radicchio", unit: "cup", perPack: 6, source: "web", note: "a radicchio head ~250 g ÷ its own 40 g/cup = 6.2 cup", chose: true },
  { ingredient: "broccoli", unit: "cup", perPack: 4, source: "relation-edge", note: "broccoli -> broccoli florets 4 cup, high + human-reviewed" },
  { ingredient: "fresh pineapple", unit: "cup", perPack: 4, source: "Hans Sept 7", note: "'pineapple 4 cups of chunks'" },
  { ingredient: "seedless watermelon", unit: "pound", perPack: 6, source: "Hans Sept 7", note: "'a recipe's pound is flesh (~6 lb of a ~10 lb melon)'" },
  { ingredient: "yellow onion", unit: "cup", perPack: 1, source: "web", note: "1 medium onion ≈ 1 cup chopped (standard kitchen reference)", chose: true },
  { ingredient: "white onion", unit: "cup", perPack: 1, source: "web", note: "1 medium onion ≈ 1 cup chopped; this row carries NO conversionRef at all, which is why f5556c19 ships two white-onion rows", chose: true },
  { ingredient: "red onion", unit: "cup", perPack: 1, source: "web", note: "1 medium onion ≈ 1 cup chopped", chose: true },
  { ingredient: "fresh ginger", unit: "tbsp", perPack: 9, source: "derived", note: "the pack says ~2 oz = 56.7 g; the row's own 96 g/cup makes that 0.59 cup = 9.4 tbsp grated", chose: true },
  { ingredient: "broccolini", unit: "ounce", perPack: 12, source: "CSV(usable)", note: "CSV PROPOSED (high), read off the pack display '1 bunch (~12 oz)'" },
  { ingredient: "fresh lacinato kale", unit: "ounce", perPack: 10, source: "derived", note: "read off the pack display '1 bunch (~10 oz)' — the same move the CSV made for broccolini" },
  { ingredient: "sliced scallions", unit: "cup", perPack: 1, source: "web", note: "1 bunch (~6 scallions) ≈ 1 cup sliced", chose: true },
  { ingredient: "crusty bread", unit: "ounce", perPack: 16, source: "web", note: "a crusty loaf ≈ 1 lb", chose: true },
  { ingredient: "rotisserie chicken", unit: "cup", perPack: 3.5, source: "relation-edge", note: "rotisserie chicken -> shredded rotisserie chicken 3.5 cup (medium, unreviewed)", chose: true },
  // --- the jalapeño jar. Hans's named case; the jar is a container, NOT
  //     perishable, so it never takes the forgiveness. ---
  { ingredient: "pickled jalapeños", unit: "cup", perPack: 1.5, source: "web", note: "a 12-oz jar of pickled jalapeño slices drains to ~1.5 cup; without this the brine cannot reach the jar and the pool declines", chose: true },
  { ingredient: "pickled jalapeño slices", unit: "cup", perPack: 1.5, source: "web", note: "same jar, same figure", chose: true },
];

// Foods in the R2 population that need NO yield row, and why. Reuse-first: the
// relation they need already exists in data the catalog carries.
export const NO_YIELD_NEEDED: { ingredient: string; reason: string }[] = [
  { ingredient: "roma tomatoes", reason: "pack unit is `each` and the row carries gramsPerEach 123 — convertToGrams/gramsToUnit already relate a pound need to a count pack. The blocker is the merge's isMeasured gate, not missing data." },
  { ingredient: "lime juice", reason: "a PART — see P. Its buy line is a lime, not a bottle of juice." },
  { ingredient: "fresh lime juice", reason: "a PART — see P." },
  { ingredient: "lime juice, fresh", reason: "a PART — see P." },
  { ingredient: "lime juice, freshly squeezed", reason: "a PART — see P." },
  { ingredient: "fresh lemon juice", reason: "a PART — see P." },
  { ingredient: "lemon zest", reason: "a PART — see P." },
  { ingredient: "lime zest", reason: "a PART — see P." },
  { ingredient: "fresh cilantro leaves", reason: "a PART — the edge already exists and is human-reviewed." },
  { ingredient: "fresh cilantro stems", reason: "a PART — the edge already exists and is human-reviewed." },
  { ingredient: "fresh basil leaves", reason: "a PART — the edge already exists and is human-reviewed." },
  { ingredient: "fresh thyme leaves", reason: "a PART — the edge already exists and is human-reviewed." },
  { ingredient: "fresh mint leaves", reason: "a PART — the edge exists; only its basis unit blocks it (see P)." },
  { ingredient: "fresh flat-leaf parsley leaves", reason: "a PART — the edge exists; only its basis unit blocks it (see P)." },
  { ingredient: "fresh thai basil leaves", reason: "a PART — the edge exists; only its basis unit blocks it (see P)." },
  { ingredient: "fresh corn kernels", reason: "a PART — fresh corn -> fresh corn kernels 0.75 cup is admitted today." },
  { ingredient: "romaine lettuce hearts", reason: "a PART — the edge is admitted today." },
  { ingredient: "rotisserie chicken, meat shredded", reason: "a PART of a rotisserie chicken; the parent's yield carries it." },
  { ingredient: "shredded rotisserie chicken", reason: "a PART — the edge is admitted today." },
  { ingredient: "fennel fronds", reason: "a PART that must never buy its own line (D-WS9-225) — and it has no parent catalog row, so the edge cannot be authored. See X." },
];

// Yields added after the first dry run, because the run showed the POOL
// degrading these rows ("1 bunch fresh rosemary (1 bunch)" replacing "1 bunch
// fresh rosemary sprigs (1 each)"). A sprig / stalk is not a part that rides
// free — it is the SAME food under a portion name, which is D-WS9-220's shape
// (sum in the child unit, render the parent), i.e. the LADDER, not the pool.
export const PACK_YIELDS_PORTION_NAMES: PackYield[] = [
  { ingredient: "fresh rosemary sprigs", unit: "each", perPack: 8, source: "CSV(usable)", note: "8 sprigs/bunch" },
  { ingredient: "fresh thyme sprigs", unit: "each", perPack: 30, source: "relation-edge", note: "30 sprigs/bunch, human-reviewed" },
  { ingredient: "fresh cilantro sprigs", unit: "each", perPack: 50, source: "relation-edge", note: "50 sprigs/bunch, human-reviewed" },
  { ingredient: "celery stalks", unit: "each", perPack: 8, source: "Hans Sept 7", note: "'celery 8 stalks/bunch'" },
  { ingredient: "celery", unit: "each", perPack: 8, source: "Hans Sept 7", note: "'celery 8 stalks/bunch'" },
  { ingredient: "butter lettuce leaves", unit: "each", perPack: 16, source: "relation-edge", note: "16 leaves/head, human-reviewed" },
  { ingredient: "iceberg lettuce leaves", unit: "each", perPack: 16, source: "derived", note: "parity with the reviewed butter-lettuce figure", chose: true },
  { ingredient: "romaine lettuce leaves", unit: "each", perPack: 16, source: "derived", note: "parity with butter lettuce", chose: true },
];

// ── P — part -> parent component edges ───────────────────────────────────────
export interface PartEdge {
  parent: string;
  child: string;
  yieldQuantity: number | null;
  yieldUnit: string | null;
  coHarvestable: boolean;
  source: string;
  note: string;
  chose?: boolean;
  /** already in the table, and only its BASIS blocks it */
  existsButRefused?: boolean;
}

export const PART_EDGES: PartEdge[] = [
  // the jalapeño jar — Hans's named case. Two rows, one purchase.
  { parent: "pickled jalapeños", child: "pickled jalapeño brine", yieldQuantity: 3, yieldUnit: "tbsp", coHarvestable: true,
    source: "web/derived", note: "the brine in a 12-oz jar of slices is roughly a third of it; 3 tbsp is a conservative per-jar figure and the brine RIDES FREE either way (coHarvestable)", chose: true },
  // the zest/juice figures D-WS9-182 ruled, where the live edge disagrees
  { parent: "lime", child: "lime wedges", yieldQuantity: 8, yieldUnit: "each", coHarvestable: false,
    source: "D-WS9-182", note: "ruled 8 wedges per lime; the live edge says 6" },
  { parent: "lemon", child: "lemon wedges", yieldQuantity: 8, yieldUnit: "each", coHarvestable: false,
    source: "D-WS9-182", note: "ruled 8 wedges per lemon; the live edge says 6" },
  { parent: "fresh lime", child: "fresh lime wedges", yieldQuantity: 8, yieldUnit: "each", coHarvestable: false,
    source: "D-WS9-182", note: "the `fresh lime` spelling has juice edges but no wedge edge, so `fresh lime wedges` buys its own limes on 96a94410" },
  { parent: "orange", child: "orange juice", yieldQuantity: 5, yieldUnit: "tbsp", coHarvestable: true,
    source: "D-WS9-182", note: "ruled 5 tbsp juice per orange; the live edge says 0.25 cup = 4 tbsp" },
  { parent: "orange", child: "orange zest", yieldQuantity: 2, yieldUnit: "tbsp", coHarvestable: true,
    source: "D-WS9-182", note: "ruled 2 tbsp zest per orange; the live edge says 1 tbsp" },
  // edges that EXIST and are refused only because the basis is read off
  // defaultUnit instead of the pack
  { parent: "fresh mint", child: "fresh mint leaves", yieldQuantity: 2, yieldUnit: "cup", coHarvestable: true,
    source: "Hans Sept 7", note: "exists (1 cup, high, unreviewed), refused on basis `sprig`; the pack is a bunch", existsButRefused: true, chose: true },
  { parent: "fresh flat-leaf parsley", child: "fresh flat-leaf parsley leaves", yieldQuantity: 2, yieldUnit: "cup", coHarvestable: true,
    source: "Hans Sept 7", note: "exists (1 cup, high, unreviewed), refused on basis `cup`; the pack is a bunch, and Hans's uncut figure is 2", existsButRefused: true, chose: true },
  { parent: "fresh sage", child: "fresh sage leaves", yieldQuantity: 0.5, yieldUnit: "cup", coHarvestable: true,
    source: "relation-edge", note: "exists, refused on basis `tablespoon`; the pack is a bunch", existsButRefused: true },
  { parent: "fresh oregano", child: "fresh oregano leaves", yieldQuantity: 2, yieldUnit: "cup", coHarvestable: true,
    source: "Hans Sept 7", note: "exists (4 tbsp), refused on basis `tablespoon`; the pack is a bunch", existsButRefused: true, chose: true },
  { parent: "thai basil", child: "fresh thai basil leaves", yieldQuantity: 2, yieldUnit: "cup", coHarvestable: true,
    source: "Hans Sept 7", note: "exists (1 cup), refused on basis `cup`; the pack is a bunch", existsButRefused: true, chose: true },
  { parent: "parmesan", child: "parmesan rind", yieldQuantity: 1, yieldUnit: "each", coHarvestable: true,
    source: "relation-edge", note: "exists, refused on basis `cup`; the pack is '1 wedge (6 oz)' and one wedge has one rind", existsButRefused: true },
  { parent: "dill pickle", child: "dill pickle brine", yieldQuantity: 2, yieldUnit: "tbsp", coHarvestable: true,
    source: "relation-edge", note: "exists, refused on basis `slice`; the pack is a 32-oz jar", existsButRefused: true },
  { parent: "kimchi", child: "kimchi brine", yieldQuantity: 0.5, yieldUnit: "cup", coHarvestable: true,
    source: "relation-edge", note: "exists, refused on basis `cup`; kimchi has NO pack either, so this stays refused until the pack exists", existsButRefused: true },
];

/**
 * Reading the basis off the PACK makes 45 refused component edges reachable.
 * BLANKET ADMISSION IS WRONG AND THE FIRST DRY RUN PROVED IT: it absorbed the
 * OLIVE OIL row into `canned tuna in olive oil` and ordered six cans of tuna to
 * get 11 tablespoons of oil. D-WS9-218's own note names that edge as the
 * arithmetically-correct one whose correctness would hide the error class — and
 * the error is not arithmetic, it is that OLIVE OIL IS ITS OWN PRODUCT.
 *
 * So the widening is DEFAULT-REFUSE. An edge whose `from`.defaultUnit already
 * names one purchasable whole is admitted exactly as today; anything the pack
 * basis newly reaches must be listed here.
 */
export const WIDENED_ADMIT: { edge: string; why: string; chose?: boolean }[] = [
  { edge: "parmesan -> parmesan rind", why: "one wedge carries one rind and it rides free — D-WS9-225's fennel-frond ruling" },
  { edge: "dill pickle -> dill pickle brine", why: "the brine rides free with the jar" },
  { edge: "fresh flat-leaf parsley -> fresh flat-leaf parsley leaves", why: "leaves come off the bunch you bought" },
  { edge: "fresh mint -> fresh mint leaves", why: "same" },
  { edge: "fresh oregano -> fresh oregano leaves", why: "same" },
  { edge: "fresh sage -> fresh sage leaves", why: "same" },
  { edge: "thai basil -> fresh thai basil leaves", why: "same" },
];

/** Refusals worth stating by name, so nobody re-proposes them. */
export const WIDENED_REFUSE_NOTES: { edge: string; why: string }[] = [
  { edge: "canned tuna in olive oil -> olive oil", why: "🔴 olive oil is its own product with its own bottle. Absorbing it ordered SIX CANS OF TUNA for 11 tbsp of oil on f5556c19. A part rides free only when it is not separately bought." },
  { edge: "garlic -> garlic cloves", why: "D-WS9-189 A3 ruled garlic OUT of the pool: the LADDER renders '3 heads Garlic (25 cloves)' and the pool loses the clove need" },
  { edge: "garlic -> garlic cloves, peeled", why: "same ruling" },
  { edge: "celery -> celery stalks", why: "a stalk is a PORTION of the same food, not a part that rides free — the ladder's shape (D-WS9-220). Moved to Y." },
  { edge: "celery -> celery sticks", why: "same" },
  { edge: "fresh rosemary -> fresh rosemary sprigs", why: "same — a sprig is a portion. Moved to Y." },
  { edge: "water -> pasta cooking water", why: "pasta water is a by-product of cooking pasta, not something a bottle of water yields on the shelf" },
  { edge: "water -> reserved pasta cooking water", why: "same" },
  { edge: "large eggs -> egg whites", why: "a dozen is a pack of twelve, not one whole — D-WS9-218's 12× error, unchanged. The `egg [each]` edge already carries this correctly." },
  { edge: "large eggs -> large egg yolks", why: "same" },
  { edge: "jasmine rice -> cooked day-old jasmine rice", why: "a cooked form is not a part of the raw pack; the yield is a recipe step, and the pack basis (a 2-lb bag) is not one whole" },
  { edge: "parmigiano-reggiano -> parmigiano-reggiano rind", why: "the pack is '1 lb block' — a pound is a measure, not a countable whole, so the basis is still not derivable" },
];

/** New `synonym` edges — same product, two catalog rows. */
export const SYNONYM_EDGES: { a: string; b: string; why: string; chose?: boolean }[] = [
  { a: "pickled jalapeño slices", b: "pickled jalapeños",
    why: "the same 12-oz jar under two names; D-WS9-223's test ('does the distinction change the dish?') says no. Without this the jar is bought twice on 163875ec and the brine's parent has no pack to inherit.", chose: true },
];

// ── X — refusals and data fixes ─────────────────────────────────────────────
export const X_ITEMS: { kind: string; target: string; change: string; why: string; chose?: boolean }[] = [
  { kind: "relation", target: "a30858b7 coarse kosher salt --synonym--> kosher salt",
    change: "label synonym -> distinct, reviewedByHuman = true",
    why: "D-WS9-217 is PERMANENT and the code-level NEVER_FOLD_PAIRS veto already refuses this pair at runtime. The row is medium/ai_judge/unreviewed, so it is a standing invitation for a confidence upgrade to fold it." },
  { kind: "pack", target: "iceberg lettuce.purchaseQuantity / purchaseDisplay",
    change: '4 / "4 heads"  ->  1 / "1 head"',
    why: "THIS is why two corpus lists order '4 heads iceberg lettuce (2 cup)'. No rounding rule can fix a pack that says four heads is one pack." },
  { kind: "pack", target: "red cabbage.purchaseUnit", change: '"each" -> "head"',
    why: 'the display already reads "1 head"; the ladder fires only when purchaseUnit equals the pack noun' },
  { kind: "pack", target: "broccoli.purchaseUnit", change: '"each" -> "head"', why: 'display reads "1 head"' },
  { kind: "pack", target: "radicchio.purchaseUnit", change: '"each" -> "head"', why: 'display reads "1 head"' },
  { kind: "pack", target: "crusty bread.purchaseUnit", change: '"each" -> "loaf"', why: 'display reads "1 loaf (crusty bread)"' },
  { kind: "report-only", target: "fennel fronds", change: "no edge can be authored",
    why: "D-WS9-225 rules fronds off the list, and the mechanism is a coHarvestable edge to the bulb — but there is NO `fennel` catalog row, and a relation is row->row. Needs a `fennel` row first; that is a catalog write outside this block's ruling." },
  { kind: "report-only", target: "`lemons` / `limes` rows with no catalog row",
    change: "none proposed", chose: true,
    why: "11 corpus rows ship a bare plural beside the singular — `lemon 1 each` + `lemons 1 each`, two packs for one fruit. There is no catalog row for the plural, so no relation edge can hold it; the fix is a singularising fold in normalizeIngredientName or the hand map. NOT a yield, NOT in this block's ruling — Hans's call." },
  { kind: "report-only", target: "`parsley` vs `flat-leaf parsley` group keys",
    change: "none proposed", chose: true,
    why: "they fold to DIFFERENT keys, so 425da049 ships `fresh flat-leaf parsley 4 tbsp` and `fresh parsley 3 tbsp` as two bunches. A3 reverted this fold deliberately, 'for unit reasons, not the yield' — with a pack yield the unit reason is gone. Hans's call whether B1 re-folds it." },
];

// ── the two named constants ─────────────────────────────────────────────────
export const PACK_FORGIVENESS_FRACTION = 0.125;

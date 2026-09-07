// WS7-8b Block B2 — density-aware consolidation merge (BUG-031 / BUG-025).
//
// The consolidator buckets by (canonical, unit), so the same ingredient reached
// in two units — parmesan 3 oz + ½ cup, garlic 1 head + 3 cloves — lands as TWO
// rows. B1 shipped this to the AI (grocery.generate_list rule 2) to reconcile,
// but the AI did the cross-unit conversion with NO density data (the 3.97-oz
// bug) and its output bypassed the ⅛ ladder.
//
// This helper does the merge DETERMINISTICALLY from the conversion table, for
// the two cases the table covers:
//   • measured↔measured (weight/volume) via grams (needs gramsPerCup for volume)
//   • sub-unit count (head↔clove) via SubUnitEquivalence
// Groups the table can't convert are left untouched → they still reach the AI,
// and the AI-merge re-sweep (generateFinalGroceryList) re-applies the ladder.
//
// CRITICAL ORDERING (Hans, load-bearing): MERGE FIRST, then round ONCE. This
// helper sums RAW quantities and returns them un-rounded; the single final
// roundNeedQuantity sweep in consolidatePlanIngredients rounds the merged total
// exactly once. Never round the parts and then merge — that double-rounds and
// inflates.

import { normalizeIngredientName } from "./groceryNormalization";
import { baseStapleName, mergeGroupBaseName } from "./groceryStaples";
import {
  EMPTY_RELATION_INDEX,
  type RelationIndex,
} from "./ingredientRelations";
import type { ConsolidatedItem, GrocerySource } from "./groceryList";
import {
  convertToGrams,
  convertWithinDimension,
  gramsToUnit,
  isCountUnit,
  isVolumeUnit,
  isWeightUnit,
  lookupConversion,
  canonicalUnitToken,
  normalizeUnit,
  resolveConversion,
  unitDimension,
  withGroupLadder,
  type IngredientConversion,
} from "./ingredientConversions";

function isMeasured(unit: string): boolean {
  return isWeightUnit(unit) || isVolumeUnit(unit);
}

// Prefer a shopper-friendly target unit for a merged measured group: weight
// wins over volume (cheese/meat are bought by weight), and "cup" is the
// friendly volume default. Falls back to the first unit seen.
function pickMeasuredTarget(units: string[]): string {
  const weight = units.find((u) => isWeightUnit(u));
  if (weight) return weight;
  if (units.some((u) => normalizeUnit(u) === "cup" || normalizeUnit(u) === "cups")) {
    return "cup";
  }
  return units[0];
}

// Union two source lists, deduped on the (mealId, dishId) pair.
function unionSources(a: GrocerySource[], b: GrocerySource[]): GrocerySource[] {
  const out = a.slice();
  for (const s of b) {
    if (!out.some((x) => x.mealId === s.mealId && x.dishId === s.dishId)) out.push(s);
  }
  return out;
}

// Fold group members (beyond the base) into the base item: raw-sum quantity is
// set by the caller; here we union sources, OR the flags, and keep the first
// non-null purchase/context fields.
function foldMetadata(base: ConsolidatedItem, member: ConsolidatedItem): void {
  base.sources = unionSources(base.sources, member.sources);
  base.isUniversalStaple = base.isUniversalStaple || member.isUniversalStaple;
  base.isUserPantryStaple = base.isUserPantryStaple || member.isUserPantryStaple;
  base.isRecurringItem = base.isRecurringItem || member.isRecurringItem;
  if (base.ingredientId === null && member.ingredientId !== null) {
    base.ingredientId = member.ingredientId;
  }
  if (base.purchaseUnit === null && member.purchaseUnit !== null) {
    base.purchaseUnit = member.purchaseUnit;
    base.purchaseQuantity = member.purchaseQuantity;
    base.purchaseDisplay = member.purchaseDisplay;
  }
  if (base.conversionRef == null && member.conversionRef != null) {
    base.conversionRef = member.conversionRef;
  }
  if (base.preparationNote === null && member.preparationNote !== null) {
    base.preparationNote = member.preparationNote;
  }
}

// Resolve the conversion for a group — prefer a member carrying a persisted
// conversionRef, else the code-table fallback by canonical name.
//
// BUG-142 — LAST RESORT: the BASE STAPLE's code-table row. A named staple
// variant ("kosher salt", "extra-virgin olive oil") is its own catalog row with
// its own canonicalName, and 9 of the 1,570 catalog rows carry conversionRef
// NULL with no code-table entry of their own. Density is a property of the
// SUBSTANCE, not of the shopper-facing name: kosher salt is salt, so base
// salt's gramsPerCup: 273 is the right factor for it.
//
// Without this, grouping by baseStapleName alone changes NOTHING for the case
// that motivated it — every member of a {kosher salt tsp, kosher salt tbsp}
// group still resolves against "kosher salt" and still misses, mergeGroup still
// returns null, and the pair still partners into the AI subset for free-form
// cross-unit arithmetic. The grouping key and this fallback are one fix.
//
// Deliberately narrow: it consults STAPLE_VARIANT_TO_BASE (an EXACT-string map
// of the three families the staples list supports), never a substring or stem.
// "garlic salt" and "celery salt" are absent from that map and are therefore
// never handed salt's density.
function groupConversion(group: ConsolidatedItem[]): IngredientConversion | null {
  for (const it of group) {
    const c = resolveConversion(it.canonicalName, it.conversionRef);
    if (c) return c;
  }
  for (const it of group) {
    const base = baseStapleName(normalizeIngredientName(it.canonicalName));
    if (base === normalizeIngredientName(it.canonicalName)) continue;
    const c = lookupConversion(base);
    if (c) return c;
  }
  return null;
}

// Attempt to merge a same-canonical group (≥2 distinct units) into ONE item
// with a raw (un-rounded) summed quantity. Returns the merged item, or null when
// the table can't convert the group (caller leaves it unmerged).
// WS9 D-WS9-189 A2 — WHICH MEMBER SUPPLIES THE SURVIVING NAME.
//
// Every branch below used to spread `group[0]`, so the merged row kept whichever
// member the consolidator happened to bucket FIRST. That was invisible while the
// only cross-name folds were MERGE_GROUP_VARIANT_TO_BASE's 11 near-identical
// entries. With the `synonym` reader a group can hold "yellow onion" beside
// "yellow onions, thinly sliced", and first-seen is then a coin-flip over what
// the SHOPPER READS.
//
// The rule is SHORTEST normalized name, ties broken alphabetically.
//
// ⚠️ NAMED SIDE BENEFIT, so nobody "fixes" it later: shortest-wins also steers
// away from the legacy rows carrying the purchase pack baked into displayName
// — "1 block (8 oz) parmesan cheese", "2 packages (8 buns per package) brioche
// burger bun". Those are BUG-136 and they are exactly the long names this rule
// avoids. ⚠️ IT DOES NOT FIX BUG-136: the rule only chooses among members that
// are ALREADY folding together, so a baked-pack row that folds with nothing
// keeps its name untouched.
//
// Only the NAME-bearing fields ride on this choice. `units` below is still read
// in group order, so pickMeasuredTarget and the dimension probe select exactly
// the unit they always did.
function pickRepresentative(group: ConsolidatedItem[]): ConsolidatedItem {
  return group.reduce((best, it) => {
    const a = normalizeIngredientName(it.canonicalName);
    const b = normalizeIngredientName(best.canonicalName);
    if (a.length !== b.length) return a.length < b.length ? it : best;
    return a < b ? it : best;
  });
}

// ── WS9 BUG-209 — THE PACK IS NOT PART OF THE PRIZE FOR WINNING THE NAME ────
//
// `pickRepresentative` above decides what the shopper READS. Until this fix it
// also decided what the shopper BUYS, because every branch of mergeGroup spread
// `...rep` — so the merged row inherited the representative's purchaseUnit /
// purchaseQuantity / purchaseDisplay, and the pack basis flipped whenever the
// name contest flipped. Measured over all 53 live lists: 36 merge groups hold
// members with DIFFERENT packs today, 48 once the synonym reader is wired, and
// in 6 of them the shortest name is the one carrying a SIZELESS pack — the
// catalog's `black pepper` row is literally `1 container`, and it beat a
// sibling carrying `1 container (2.3 oz)` for no reason but being shorter.
//
// D-WS9-221 (Hans, September 6 2026): "pack is derived from sum of demand, for
// sure … I'd rather say I need 8 oz cheese, buy 8 oz cheese. or I need cheese,
// buy 8oz. not I need 8 oz buy cheese". The buy half must carry a concrete size.
//
// ⚠️ WHAT IS AND IS NOT IMPLEMENTED HERE. The ruling's second clause — "the
// purchase pack would be the smallest normal size to retire the demand" —
// presumes a SET of retail sizes per ingredient. Phase 0 measured that data:
// it does not exist. 1,569 catalog rows, 486 carrying a scalar pack, 236 with a
// conversionRef, and ZERO carrying an array of packs or sizes. One pack per
// ingredient is all there is. So this ranks the packs the GROUP ALREADY HOLDS
// against the group's SUMMED demand; it does not invent sizes and it is not the
// retail-size catalog that clause needs.
//
// ⚠️ IT NEVER NULLS A PACK, AND THAT IS A SAFETY PROPERTY, NOT A STYLE CHOICE.
// fillPurchaseSizesWithWriteBack treats a null pack as a cache MISS: it asks
// Haiku to invent one and then WRITES IT BACK to Ingredient.purchaseUnit/
// Quantity/Display for that row's ingredientId — the same three columns
// consolidatePlanIngredients reads on the next generation. "Emit no pack rather
// than a wrong one" would therefore not emit no pack; it would launder an AI
// guess into the shared catalog under the representative's name. The candidate
// set here is a SUBSET-preserving choice among packs that already exist, so a
// merged row is a write-back miss only if it was one before this fix too.

// The pack's own magnitude, for comparison against a demand. Two kinds, never
// mixed: a MEASURED pack states grams ("1 container (2.3 oz)", "1 lb pack"),
// a COUNT pack states items ("2 lemons", "4 jalapeños"). A pack whose size is
// not stated at all ("1 container", "1 bunch") returns null — that is exactly
// the shape D-WS9-221 rejects, and null ranks last.
type PackMagnitude = { kind: "grams" | "count"; value: number };

function packMagnitude(
  purchaseDisplay: string,
  conv: IngredientConversion | null,
): PackMagnitude | null {
  // A parenthetical size wins over the leading count: in "1 lb pack (4 sticks)"
  // the leading "1 lb" is the real magnitude and "4 sticks" is a description,
  // while in "1 container (2.3 oz)" the leading "1" is the count and the
  // parenthetical is the magnitude. Try both, prefer whichever yields grams.
  const paren = /\(\s*~?\s*([\d.]+)\s*([a-zA-Z]+)/.exec(purchaseDisplay);
  const lead = /^\s*([\d.]+)\s+([a-zA-Z]+)/.exec(purchaseDisplay);
  for (const m of [lead, paren]) {
    if (!m) continue;
    const amt = Number(m[1]);
    if (!(amt > 0)) continue;
    if (!isWeightUnit(m[2]) && !isVolumeUnit(m[2])) continue;
    const g = convertToGrams(amt, m[2], conv);
    if (g !== null && g > 0) return { kind: "grams", value: g };
  }
  // No measurable size. A pure count pack ("2 lemons") still states a concrete
  // magnitude in the only unit that ingredient has.
  if (lead && !paren) {
    const n = Number(lead[1]);
    if (n > 0 && !isWeightUnit(lead[2]) && !isVolumeUnit(lead[2])) {
      return { kind: "count", value: n };
    }
  }
  return null;
}

function demandMagnitude(
  quantity: number,
  unit: string,
  conv: IngredientConversion | null,
): PackMagnitude | null {
  const g = convertToGrams(quantity, unit, conv);
  if (g !== null && g > 0) return { kind: "grams", value: g };
  if (isCountUnit(unit) && quantity > 0) return { kind: "count", value: quantity };
  return null;
}

// How much of the product the shopper ends up holding if this pack is the
// basis: whole packs, ceiled to cover the demand. Lower is a tighter buy.
// Returns null when the two magnitudes are not the same kind — the criterion
// then abstains rather than guessing.
function totalBought(
  pack: PackMagnitude | null,
  demand: PackMagnitude | null,
): number | null {
  if (!pack || !demand || pack.kind !== demand.kind) return null;
  return Math.ceil(demand.value / pack.value - 1e-9) * pack.value;
}

/**
 * BUG-209 — choose the merged row's PURCHASE PACK from the group, by the pack's
 * own properties and the group's SUMMED demand. Never by which name won.
 *
 * Ranked, first difference decides:
 *   1. How well the pack states a size the DEMAND can be measured against
 *      (see {@link sizeTier}).
 *   2. The tighter buy: fewest whole packs × pack size to cover the summed
 *      demand. (parmesan, need 9 oz: a 6 oz wedge buys 12 oz, an 8 oz block
 *      buys 16 oz — the wedge wins, which "largest pack" would have got wrong.)
 *   3. The smaller pack.
 *   4. The more informative display — one carrying a parenthetical.
 *   5. Lexicographic, so the outcome is DEFINED rather than incidental.
 *
 * Returns null when the group offers no choice to make (fewer than two members
 * carry a complete pack, or they all carry the same one) — the caller then
 * leaves whatever foldMetadata already settled on, untouched.
 */
function pickPackBasis(
  group: ConsolidatedItem[],
  quantity: number,
  unit: string,
  conv: IngredientConversion | null,
): ConsolidatedItem | null {
  const candidates = group.filter(
    (g) =>
      g.purchaseUnit !== null &&
      g.purchaseQuantity !== null &&
      g.purchaseDisplay !== null,
  );
  if (candidates.length < 2) return null;
  const distinct = new Set(
    candidates.map((c) => `${c.purchaseUnit} ${c.purchaseDisplay}`),
  );
  if (distinct.size < 2) return null;

  const demand = demandMagnitude(quantity, unit, conv);
  const mag = new Map<ConsolidatedItem, PackMagnitude | null>();
  for (const c of candidates) mag.set(c, packMagnitude(c.purchaseDisplay!, conv));

  return candidates.reduce((best, it) => (better(it, best) ? it : best));

  // How useful this pack's stated size is, against THIS demand. Lower is better.
  //
  // ⚠️ THE COUNT TIER IS WHY THIS IS A LADDER AND NOT A BOOLEAN, and a
  // deliberate break found it. "1 container" parses as a count of one — the
  // leading number is a pack COUNT, not a size — so a plain "is it sized?"
  // test called it sized and let it beat "1 lb bag", which is the exact
  // sizeless shape D-WS9-221 rejects. A count only states a size when the
  // DEMAND is a count too ("2 lemons" against a need of 3 each); against a
  // measured need it says nothing, and grams — which is absolute — wins.
  function sizeTier(m: PackMagnitude | null): number {
    if (m === null) return 3;
    if (demand !== null && m.kind === demand.kind) return 0; // comparable
    if (m.kind === "grams") return 1; // an absolute size, just not this demand's
    return 2; // a bare pack count
  }

  function better(a: ConsolidatedItem, b: ConsolidatedItem): boolean {
    const ma = mag.get(a) ?? null;
    const mb = mag.get(b) ?? null;
    // 1. the better-stated size
    const sa = sizeTier(ma);
    const sb = sizeTier(mb);
    if (sa !== sb) return sa < sb;
    // 2. the tighter buy
    const ta = totalBought(ma, demand);
    const tb = totalBought(mb, demand);
    if (ta !== null && tb !== null && Math.abs(ta - tb) > 1e-9) return ta < tb;
    // 3. the smaller pack
    if (ma && mb && ma.kind === mb.kind && Math.abs(ma.value - mb.value) > 1e-9) {
      return ma.value < mb.value;
    }
    // 4. the more informative display
    const pa = a.purchaseDisplay!.includes("(");
    const pb = b.purchaseDisplay!.includes("(");
    if (pa !== pb) return pa;
    // 5. defined, not incidental
    return a.purchaseDisplay! < b.purchaseDisplay!;
  }
}

// Every merge branch ends the same way: fold the non-representative members in,
// then settle the pack against the merged demand. Kept as one function so a
// future branch cannot forget the second half (all four branches predate
// BUG-209 and all four had the defect).
function finishMerge(
  base: ConsolidatedItem,
  rest: ConsolidatedItem[],
  group: ConsolidatedItem[],
  conv: IngredientConversion | null,
): ConsolidatedItem {
  for (const m of rest) foldMetadata(base, m);
  const basis = pickPackBasis(group, base.quantity, base.unit, conv);
  if (basis) {
    base.purchaseUnit = basis.purchaseUnit;
    base.purchaseQuantity = basis.purchaseQuantity;
    base.purchaseDisplay = basis.purchaseDisplay;
  }
  // ── WS9 BUG-215 — the LADDER is not part of the prize for winning the name
  //    either ──
  //
  // Every branch above builds `base` as `{ ...rep }`, so the merged row keeps
  // the REPRESENTATIVE's conversionRef — chosen by pickRepresentative on name
  // length alone, which never looks at a conversion. `conv` right here is the
  // GROUP's conversion (groupConversion: any member that resolves, then the
  // base-staple fallback) and it is the one the merge arithmetic above was
  // actually done with, so the merged row disagreeing with it is incoherent
  // regardless of the pack it costs.
  //
  // Concretely: the `garlic` fold key holds `garlic` (ladder), `garlic cloves`
  // and `garlic head` (neither). Whenever the ladder row is not the shortest
  // name present, resolvePurchaseFields downstream resolves no subUnit and a
  // 16-clove need prints "1 head of garlic".
  //
  // Written onto the row rather than passed alongside because the group is GONE
  // by the time the pack is resolved — buildDeterministicOutputItem sees one
  // merged ConsolidatedItem and nothing else. conversionRef is read-only
  // pipeline input (GenerateListOutputItem does not carry it and nothing writes
  // it back to Ingredient), so this is in-memory for the length of one
  // generation.
  const own = resolveConversion(base.canonicalName, base.conversionRef);
  const withLadder = withGroupLadder(own, conv);
  if (withLadder !== own) base.conversionRef = withLadder;
  return base;
}

function mergeGroup(group: ConsolidatedItem[]): ConsolidatedItem | null {
  const conv = groupConversion(group);
  const units = group.map((g) => g.unit);
  const rep = pickRepresentative(group);
  const rest = group.filter((g) => g !== rep);

  // ── WS9 BUG-181: same NAME-GROUP, same UNIT → exact sum, no factor ──
  //
  // Runs FIRST, before any path that consults a conversion. Same unit means the
  // sum is arithmetic: no density, no sub-unit ratio, no dimension check, and
  // therefore nothing to refuse. The conservation invariant BUG-142 protects is
  // not weakened here, it is trivially satisfied — 3 tbsp + 5 tbsp + 5 tbsp is
  // 13 tbsp under every conversion table there could ever be.
  //
  // ⚠️ WHY THIS IS SAFE, AND IT IS THE WHOLE ARGUMENT: `bucketKeyOf` already
  // keys on (normalizedCanonical, canonicalUnitToken), so two rows sharing a
  // canonical name AND a unit token are ONE bucket and can never both reach
  // here. A same-unit multiple inside a group can therefore only exist because
  // MERGE_GROUP_VARIANT_TO_BASE folded two DIFFERENT canonical names together.
  // This branch reaches exactly the 11 folded family members (5 olive-oil
  // spellings, 6 ground-black-pepper spellings) and nothing else in the catalog.
  //
  // BUG-181 was three olive oil rows — "olive oil" 3 tbsp, "extra virgin olive
  // oil" 5 tbsp, "extra-virgin olive oil" 5 tbsp — reaching ONE merge group and
  // being shipped as three bottles. The fold was already correct; the group was
  // refused downstream because every member carried the same unit, which the
  // cross-unit paths below read as "nothing to reconcile".
  //
  // The comparison is canonicalUnitToken, not normalizeUnit: {tablespoon, tbsp}
  // across two folded names is one unit reached by two spellings and must sum.
  // The row keeps group[0].unit — a spelling that actually occurs in the data —
  // for the same reason BUG-174 gives: writing a canonical token onto `unit`
  // would make groceryReconcile.matchKey see a delete+add on the next pass.
  const unitTokens = new Set(units.map(canonicalUnitToken));
  if (unitTokens.size === 1) {
    let total = 0;
    for (const it of group) total += it.quantity;
    if (total > 0) {
      const base = { ...rep, quantity: total };
      return finishMerge(base, rest, group, conv);
    }
  }

  // ── WS9 BUG-176: same dimension → NO density needed ──
  //
  // Runs BEFORE the grams path deliberately. Within one dimension the density
  // cancels, so where the grams path can also run this returns the identical
  // number; where it cannot — an ingredient with no gramsPerCup reached in
  // tbsp and tsp — this still answers instead of shipping two rows for one
  // bottle. That refusal was BUG-176: hot sauce, ketchup and cilantro on live
  // lists, all of them arithmetic no ingredient data is needed for.
  //
  // ⚠️ THE GUARD IS `unitDimension` AGREEING ACROSS EVERY MEMBER, and it is
  // load-bearing. A cross-dimension group (each + cup, pinch + tsp, bunch +
  // cup) has at least one member whose dimension is null, falls straight
  // through to the grams path, and is refused there exactly as before — the
  // BUG-142 conservation guard keeps every case it was built for.
  const dim = unitDimension(units[0]);
  if (dim !== null && units.every((u) => unitDimension(u) === dim)) {
    const target = pickMeasuredTarget(units);
    let total = 0;
    let convertible = true;
    for (const it of group) {
      const q = convertWithinDimension(it.quantity, it.unit, target);
      if (q === null) {
        convertible = false;
        break;
      }
      total += q;
    }
    if (convertible && total > 0) {
      const base = { ...rep, unit: target, quantity: total };
      return finishMerge(base, rest, group, conv);
    }
  }

  // ── measured↔measured via grams ──
  if (units.every(isMeasured)) {
    let grams = 0;
    for (const it of group) {
      const g = convertToGrams(it.quantity, it.unit, conv);
      if (g === null) return null; // e.g. a volume unit with no gramsPerCup
      grams += g;
    }
    const target = pickMeasuredTarget(units);
    const qty = gramsToUnit(grams, target, conv);
    if (qty === null || !(qty > 0)) return null;
    const base = { ...rep, unit: target, quantity: qty };
    return finishMerge(base, rest, group, conv);
  }

  // ── sub-unit count (head↔clove) ──
  if (conv?.subUnit) {
    // WS9 BUG-174 follow-through (BUG-137) — compare on the CANONICAL token,
    // not normalizeUnit. normalizeUnit is trim+lowercase, so a recipe writing
    // `cloves` and another writing `clove` put TWO entries in childSet, the
    // size check below failed, and a garlic group the table can obviously
    // reconcile was refused. `head + clove + cloves` shipped as three rows.
    const parent = canonicalUnitToken(conv.subUnit.parent);
    const others = units
      .map(canonicalUnitToken)
      .filter((u) => u !== parent);
    // ── WS9 BUG-211 (D-WS9-189 A3) — A BARE COUNT IS THE CHILD, NOT A THIRD
    //    UNIT ──
    //
    // The catalog authors `garlic cloves` with defaultUnit "each" and `garlic`
    // with "cloves", so a plan drawing on both arrives here as {clove, each}.
    // childSet then had size 2, this branch refused, and the group shipped as
    // two rows — one of them "11 garlic cloves (1 head of garlic)", a pack that
    // covers 10 of the 11 cloves it names, because the ladder never ran and the
    // pack came from the Haiku gap-fill instead.
    //
    // "each" against an ingredient whose subUnit child is a clove MEANS a
    // clove. Fold the bare count onto the named child when there is exactly one
    // named child to fold it onto; a genuinely mixed group (clove + slice)
    // still has two named children and is still refused.
    //
    // ⚠️ SCOPE, MEASURED: exactly ONE ingredient in the 1,569-row catalog
    // carries a subUnit ladder — `garlic`. This branch cannot reach anything
    // else, so the widening is a garlic fix wearing general syntax, not a
    // general rule that happens to fix garlic.
    const named = new Set(others.filter((u) => !isCountUnit(u)));
    const childSet =
      named.size === 1 ? named : new Set(others);
    // Mergeable only when the non-parent units are a SINGLE child unit
    // (e.g. all "clove"); mixed children (clove + slice) can't be summed.
    if (childSet.size === 1) {
      const child = [...childSet][0];
      let totalChild = 0;
      for (const it of group) {
        const u = canonicalUnitToken(it.unit);
        totalChild += u === parent ? it.quantity * conv.subUnit.perParent : it.quantity;
      }
      // The canonical token decided WHICH rows sum together; the row keeps a
      // spelling that actually occurs in the data. canonicalUnitToken is for
      // keys and comparisons — writing it onto `unit` would change a stored
      // `cloves` row into `clove` and make groceryReconcile.matchKey see a
      // delete+add on the first pass after deploy.
      const childUnit =
        group.find((g) => canonicalUnitToken(g.unit) === child)?.unit ?? child;
      const base = { ...rep, unit: childUnit, quantity: totalChild };
      return finishMerge(base, rest, group, conv);
    }
  }

  return null;
}

/**
 * Merge same-canonical / different-unit rows the conversion table can reconcile.
 * Preserves first-seen order. Rows in an un-mergeable group pass through
 * untouched. Quantities are RAW (un-rounded) — the caller applies the single
 * roundNeedQuantity sweep afterward (merge-then-round-once).
 */
export function mergeConvertibleGroups(
  items: ConsolidatedItem[],
  relations: RelationIndex = EMPTY_RELATION_INDEX,
): ConsolidatedItem[] {
  // Group by BASE STAPLE name, preserving first-seen order.
  //
  // BUG-142, NARROWED by BUG-170 — group by mergeGroupBaseName, not
  // baseStapleName.
  //
  // BUG-142 keyed this on baseStapleName (the PANTRY-STAPLE map). That folded
  // every salt onto "salt", so kosher salt and flaky sea salt became one row.
  // Hans ruled that out: "iodized salt is NOT kosher is NOT flaky sea salt."
  // mergeGroupBaseName is the same idea restricted to rows that are genuinely
  // one purchase — the ground-pepper spellings and the olive-oil family — and
  // is the identity function for every salt and for `black peppercorns`.
  //
  // ⚠️ BUG-142's fix is NOT weakened. Its actual case is ONE variant reached in
  // TWO units (kosher salt 7.75 tsp + kosher salt 1 tbsp = 10.75 tsp). Those
  // share a raw canonical name, so they group together with no folding at all,
  // and groupConversion's base-staple fallback above — which still uses
  // baseStapleName and is deliberately untouched — still lends them base salt's
  // gramsPerCup. Only CROSS-variant folding is withdrawn.
  //
  // mergeGroup still refuses any group the conversion table can't reconcile, so
  // a folded group that isn't genuinely convertible passes through untouched.
  //
  // ── WS9 D-WS9-189 A2 — THE SYNONYM READER LANDS HERE ──
  //
  // `relations.groupKey` is the COMPOSED key: the `synonym` fold FIRST, then
  // mergeGroupBaseName, iterated to fixpoint. It defaults to
  // EMPTY_RELATION_INDEX, whose groupKey is exactly the old expression
  // `mergeGroupBaseName(normalizeIngredientName(...))` — so a caller that
  // passes no index gets byte-identical behaviour and every pre-A2 test stays
  // green for the right reason.
  //
  // ⚠️ COMPOSE, NOT REPLACE, AND THE HAND MAP KEEPS THE LAST WORD. Phase 0
  // measured MERGE_GROUP_VARIANT_TO_BASE's coverage in `ingredient_relations`
  // at 0/11: the 5 entries whose both endpoints are catalog rows all carry
  // `subsumes` (a label this block does not read), and the other 6 have no
  // catalog row at all, so no row->row edge can ever exist for them. The two
  // mechanisms answer different questions with zero overlap — the same
  // argument that split MERGE_GROUP_VARIANT_TO_BASE out of
  // STAPLE_VARIANT_TO_BASE in BUG-170. Deleting the hand map here would
  // REOPEN BUG-181 (three olive-oil rows shipped as three bottles) and
  // BUG-168's kept half.
  //
  // ⚠️ WHEN THE `subsumes` READER SHIPS on the other track, those 5 entries
  // become ITS territory and this map shrinks. Do not delete them before that
  // reader exists. handMapSynonymCollisions() is the guard that fires if the
  // zero-overlap measurement ever stops holding.
  const groups = new Map<string, ConsolidatedItem[]>();
  const order: string[] = [];
  for (const it of items) {
    const key = relations.groupKey(it.canonicalName);
    let g = groups.get(key);
    if (!g) {
      g = [];
      groups.set(key, g);
      order.push(key);
    }
    g.push(it);
  }

  const out: ConsolidatedItem[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    // WS9 BUG-181 — the DISTINCT-UNIT PRECONDITION IS GONE. It used to read
    // `group.length < 2 || distinctUnits.size < 2`, which made this helper a
    // CROSS-unit reconciler only: a group whose members all carried the same
    // unit took this early-out and shipped unmerged. That is precisely how
    // three olive oil rows, all in tablespoons, reached one merge group and
    // still printed three bottles — and it made
    // MERGE_GROUP_VARIANT_TO_BASE dead for the commonest case it exists for.
    //
    // Only the arity test survives. A one-member group has nothing to merge;
    // every group of two or more is now offered to mergeGroup, which decides
    // on its own terms and still returns null for anything it cannot
    // reconcile. Nothing became less conservative: the same-unit branch is
    // exact arithmetic, and every cross-unit path below is unchanged.
    if (group.length < 2) {
      out.push(...group);
      continue;
    }
    const merged = mergeGroup(group);
    if (merged) out.push(merged);
    // ⚠️ A REFUSED GROUP PASSES THROUGH UNMERGED — AND NOTHING ROUTES IT TO
    // SONNET. This line used to read "table can't convert → leave for the AI
    // path", which is FALSE and cost the next reader an hour. partitionForAI's
    // rule 3 pairs rows sharing a canonical name with DIFFERENT units; a group
    // refused here holds rows with DIFFERENT canonical names (that is the only
    // reason they were grouped), so rule 3 never fires on them and they land on
    // the deterministic side as two rows for one purchase.
    //
    // The claim was already wrong for MERGE_GROUP_VARIANT_TO_BASE's 11 entries;
    // the A2 synonym reader widens the surface rather than creating it. Routing
    // a refused cross-name group to Sonnet is a SEPARATE decision and is
    // deliberately NOT taken here (D-WS9-189 A2 §5).
    else out.push(...group);
  }
  return out;
}

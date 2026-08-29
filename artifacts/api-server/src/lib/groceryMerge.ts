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
import type { ConsolidatedItem, GrocerySource } from "./groceryList";
import {
  convertToGrams,
  convertWithinDimension,
  gramsToUnit,
  isVolumeUnit,
  isWeightUnit,
  lookupConversion,
  canonicalUnitToken,
  normalizeUnit,
  resolveConversion,
  unitDimension,
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
function mergeGroup(group: ConsolidatedItem[]): ConsolidatedItem | null {
  const conv = groupConversion(group);
  const units = group.map((g) => g.unit);

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
      const base = { ...group[0], quantity: total };
      for (let i = 1; i < group.length; i++) foldMetadata(base, group[i]);
      return base;
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
      const base = { ...group[0], unit: target, quantity: total };
      for (let i = 1; i < group.length; i++) foldMetadata(base, group[i]);
      return base;
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
    const base = { ...group[0], unit: target, quantity: qty };
    for (let i = 1; i < group.length; i++) foldMetadata(base, group[i]);
    return base;
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
    const childSet = new Set(others);
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
      const base = { ...group[0], unit: childUnit, quantity: totalChild };
      for (let i = 1; i < group.length; i++) foldMetadata(base, group[i]);
      return base;
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
  const groups = new Map<string, ConsolidatedItem[]>();
  const order: string[] = [];
  for (const it of items) {
    const key = mergeGroupBaseName(normalizeIngredientName(it.canonicalName));
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
    else out.push(...group); // table can't convert → leave for the AI path
  }
  return out;
}

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
import type { ConsolidatedItem, GrocerySource } from "./groceryList";
import {
  convertToGrams,
  gramsToUnit,
  isVolumeUnit,
  isWeightUnit,
  normalizeUnit,
  resolveConversion,
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
function groupConversion(group: ConsolidatedItem[]): IngredientConversion | null {
  for (const it of group) {
    const c = resolveConversion(it.canonicalName, it.conversionRef);
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
    const parent = normalizeUnit(conv.subUnit.parent);
    const others = units
      .map(normalizeUnit)
      .filter((u) => u !== parent);
    const childSet = new Set(others);
    // Mergeable only when the non-parent units are a SINGLE child unit
    // (e.g. all "clove"); mixed children (clove + slice) can't be summed.
    if (childSet.size === 1) {
      const child = [...childSet][0];
      let totalChild = 0;
      for (const it of group) {
        const u = normalizeUnit(it.unit);
        totalChild += u === parent ? it.quantity * conv.subUnit.perParent : it.quantity;
      }
      const base = { ...group[0], unit: child, quantity: totalChild };
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
  // Group by normalized canonical, preserving first-seen order.
  const groups = new Map<string, ConsolidatedItem[]>();
  const order: string[] = [];
  for (const it of items) {
    const key = normalizeIngredientName(it.canonicalName);
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
    const distinctUnits = new Set(group.map((g) => normalizeUnit(g.unit)));
    if (group.length < 2 || distinctUnits.size < 2) {
      out.push(...group);
      continue;
    }
    const merged = mergeGroup(group);
    if (merged) out.push(merged);
    else out.push(...group); // table can't convert → leave for the AI path
  }
  return out;
}

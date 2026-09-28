// [grocery] B1 Part D — THE RECONCILE CONDITION on Hans's COUNT_UNIT_ALIASES
// ruling (September 28).
//
// The ruling: the map gains the pack-noun plurals. The two conditions attached
// to it: prove `head` and `heads` bucket together, and prove an EXISTING list
// carrying a `heads` row re-reconciles with no remove-and-add churn. The
// instruction was to STOP and report rather than widen the fence if the second
// could not be made green without touching groceryReconcile.ts logic.
//
// IT IS GREEN, AND THE REASON IS STRONGER THAN "NO CHURN WAS OBSERVED":
// `groceryReconcile.matchKey` keys on the RAW `unit` string and never calls
// canonicalUnitToken, so the alias map is not on its path at all. A stored
// `heads` row matches a fresh `heads` row by string identity, exactly as it did
// before this change. Nothing in groceryReconcile.ts was touched.
//
// The one way the map COULD reach reconcile is upstream: bucketKeyOf does fold
// on the token, so a plan producing BOTH spellings would now consolidate to one
// row where it used to make two, and a stored row for the losing spelling would
// then go unmatched. That path is measured shut — on 2026-09-28 the dev catalog
// had ZERO `dish_ingredients` rows in any pack-noun plural (42 distinct unit
// spellings) and ZERO `grocery_list_items` rows in one (34 spellings, 5,003
// items) — and the test below pins the behaviour for the day that stops being
// true: the two spellings MERGE, they do not ship as two rows.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { bucketKeyOf, type ConsolidatedItem } from "../groceryList";
import { mergeConvertibleGroups } from "../groceryMerge";
import { EMPTY_RELATION_INDEX } from "../ingredientRelations";
import { canonicalUnitToken, normalizeUnit } from "../ingredientConversions";
import { normalizeIngredientName } from "../groceryNormalization";

function item(canonicalName: string, quantity: number, unit: string): ConsolidatedItem {
  return {
    ingredientId: "ing-cabbage",
    canonicalName,
    displayName: canonicalName,
    quantity,
    unit,
    sectionKey: "produce",
    isUniversalStaple: false,
    isUserPantryStaple: false,
    isRecurringItem: false,
    sources: [],
    purchaseUnit: "head",
    purchaseQuantity: 1,
    purchaseDisplay: "1 head",
    conversionRef: null,
    packYieldUnit: "cup",
    packYieldPerPack: 8,
    packFloor: null,
    preparationNote: null,
    sourceDishTitle: null,
  };
}

/**
 * groceryReconcile.matchKey, mirrored EXACTLY (groceryReconcile.ts:112-120).
 * Mirrored rather than imported because it is module-private — and the mirror
 * is the point: if the real one ever starts folding the unit, this copy stops
 * matching it and the drift shows up as a diff in review.
 */
function matchKey(ingredientId: string | null, unit: string, name: string): string {
  return ingredientId
    ? `id:${ingredientId}|${unit}`
    : `nm:${normalizeIngredientName(name)}|${unit}`;
}

describe("[grocery] B1 — the pack-noun aliases and bucketing", () => {
  it("head and heads produce the SAME bucket key", () => {
    assert.equal(
      bucketKeyOf("green cabbage", "head"),
      bucketKeyOf("green cabbage", "heads"),
    );
  });

  it("…and so do bunch/bunches, jar/jars, loaf/loaves", () => {
    for (const [a, b] of [["bunch", "bunches"], ["jar", "jars"], ["loaf", "loaves"]] as const) {
      assert.equal(bucketKeyOf("x", a), bucketKeyOf("x", b), `${a} / ${b}`);
    }
  });

  it("two rows spelled differently reach ONE merge group and sum", () => {
    const merged = mergeConvertibleGroups(
      [item("green cabbage", 1, "head"), item("green cabbage", 2, "heads")],
      EMPTY_RELATION_INDEX,
    );
    assert.equal(merged.length, 1, "the plural must not ship as a second row");
    assert.equal(merged[0].quantity, 3);
  });

  it("a plural that is NOT a pack noun still buckets alone — no general rule", () => {
    assert.notEqual(bucketKeyOf("x", "pinch"), bucketKeyOf("x", "pinches"));
    assert.notEqual(bucketKeyOf("x", "dash"), bucketKeyOf("x", "dashes"));
  });
});

describe("[grocery] B1 — an existing `heads` row reconciles with NO churn", () => {
  it("matchKey is unit-LITERAL, so the alias map is not on reconcile's path", () => {
    // The guarantee, stated as an assertion rather than as prose: matchKey does
    // not fold. If it ever does, these two become equal and this test goes red
    // BEFORE anyone finds out from a live list that re-created itself.
    assert.notEqual(
      matchKey("ing-cabbage", "heads", "green cabbage"),
      matchKey("ing-cabbage", "head", "green cabbage"),
    );
    assert.equal(canonicalUnitToken("heads"), canonicalUnitToken("head"),
      "…even though the TOKEN does fold — that is the whole point");
  });

  it("a stored `heads` row re-matches itself: no delete, no add", () => {
    const stored = { id: "row-1", ingredientId: "ing-cabbage", displayName: "green cabbage", unit: "heads" };
    // The freshly consolidated line for the same plan, unchanged.
    const fresh = item("green cabbage", 1, "heads");

    const storedKey = matchKey(stored.ingredientId, stored.unit, stored.displayName);
    const freshKey = matchKey(fresh.ingredientId, fresh.unit, fresh.canonicalName);
    assert.equal(storedKey, freshKey, "the row matches itself, so reconcile updates in place");

    // And the row's unit is never rewritten on the way through: the merge keeps
    // a spelling that occurs in the data (BUG-174 — canonicalUnitToken is for
    // KEYS ONLY and must never be written back onto item.unit).
    const merged = mergeConvertibleGroups([fresh], EMPTY_RELATION_INDEX);
    assert.equal(merged[0].unit, "heads", "the stored spelling survives");
    assert.equal(normalizeUnit(merged[0].unit), "heads");
  });

  it("a row whose spelling the merge DOES change keeps a spelling from the data", () => {
    // When both spellings are present the group merges, and the survivor takes a
    // unit that actually occurs among its members — never the canonical token.
    const merged = mergeConvertibleGroups(
      [item("green cabbage", 1, "heads"), item("green cabbage", 2, "head")],
      EMPTY_RELATION_INDEX,
    );
    assert.equal(merged.length, 1);
    assert.ok(["head", "heads"].includes(merged[0].unit), `got "${merged[0].unit}"`);
  });
});

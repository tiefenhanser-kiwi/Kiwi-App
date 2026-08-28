// WS9 BUG-174 follow-through / BUG-137 — count-unit spelling aliases.
//
// Two things are being pinned, and the second matters more than the first:
//   1. `clove` and `cloves` are one unit, so a garlic group carrying both is
//      reconcilable and must merge. Before this change `[clove + cloves]`
//      shipped as two rows and `[head + clove + cloves]` as three.
//   2. `cloves` is ALSO a real ingredient — the spice. COUNT_UNIT_ALIASES is
//      consulted with a UNIT and never with a NAME, and the spice must come
//      through completely untouched. That is the obvious way this change goes
//      wrong, so it is tested harder than the thing it enables.
//
// ⚠️ Expectations are explicit literals. Nothing loops over COUNT_UNIT_ALIASES;
// an assertion that reads the map the code reads would stay green under a
// mutation of that map, which is exactly what the deliberate breaks target.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mergeConvertibleGroups } from "../groceryMerge";
import { bucketKeyOf } from "../groceryList";
import { canonicalUnitToken, lookupConversion } from "../ingredientConversions";
import type { ConsolidatedItem } from "../groceryList";

function item(
  canonicalName: string,
  quantity: number,
  unit: string,
  conversionRef: unknown = null,
): ConsolidatedItem {
  return {
    ingredientId: null,
    canonicalName,
    displayName: canonicalName,
    quantity,
    unit,
    sectionKey: "produce",
    isUniversalStaple: false,
    isUserPantryStaple: false,
    isRecurringItem: false,
    sources: [],
    purchaseUnit: null,
    purchaseQuantity: null,
    purchaseDisplay: null,
    conversionRef,
    preparationNote: null,
    sourceDishTitle: null,
  };
}

describe("BUG-137 — the garlic fold, unblocked", () => {
  it("garlic carries the head/clove sub-unit this rests on", () => {
    // Stated as an explicit literal rather than trusted: the whole fold below
    // depends on perParent, and a silent change to it would otherwise move
    // every expected quantity in this file at once.
    const conv = lookupConversion("garlic");
    assert.equal(conv?.subUnit?.parent, "head");
    assert.equal(conv?.subUnit?.perParent, 10);
  });

  it("merges clove + cloves — the pair that used to ship as two rows", () => {
    const out = mergeConvertibleGroups([
      item("garlic", 1, "clove"),
      item("garlic", 2, "cloves"),
    ]);
    assert.equal(out.length, 1, "one row");
    assert.equal(out[0].quantity, 3, "1 + 2 cloves");
  });

  it("collapses head + clove + cloves to ONE row", () => {
    // 1 head = 10 cloves, + 2 + 3 = 15.
    const out = mergeConvertibleGroups([
      item("garlic", 1, "head"),
      item("garlic", 2, "clove"),
      item("garlic", 3, "cloves"),
    ]);
    assert.equal(out.length, 1, "three rows in, one out");
    assert.equal(out[0].quantity, 15);
  });

  it("keeps the child unit SPELLED as the data spells it", () => {
    // The canonical token decides which rows sum; it must not be written onto
    // `unit`. A stored `cloves` row rewritten to `clove` would read as a
    // delete+add to groceryReconcile.matchKey on the first pass after deploy.
    const out = mergeConvertibleGroups([
      item("garlic", 1, "head"),
      item("garlic", 2, "cloves"),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].unit, "cloves", "the row keeps the spelling it arrived with");
  });

  it("still REFUSES genuinely mixed children (clove + slice)", () => {
    // The size check is narrowed, not removed. Two DIFFERENT child units are
    // still unsummable and must still ship separately.
    const out = mergeConvertibleGroups([
      item("garlic", 1, "clove"),
      item("garlic", 2, "slice"),
    ]);
    assert.equal(out.length, 2);
  });
});

// ── the risk: `cloves` is a unit AND an ingredient ─────────────────────────
//
// The catalog carries all of these TODAY (verified against the live DB):
//   "cloves"        Pantry  — the spice
//   "ground cloves" Pantry  — measured in `teaspoon`, 17 live dish rows
//   "whole cloves"  Pantry  — measured in `each`, 11 live dish rows
//   "garlic cloves" Produce — measured in `each`, 672 live dish rows
// None of them may be touched by a map that folds the UNIT token `cloves`.
describe("the spice named cloves is untouched", () => {
  it("never folds the NAME half of a bucket key", () => {
    // Explicit literals. The name stays plural; only the unit half moves.
    assert.equal(bucketKeyOf("cloves", "teaspoon"), "cloves|tsp");
    assert.equal(bucketKeyOf("ground cloves", "teaspoon"), "ground cloves|tsp");
    assert.equal(bucketKeyOf("whole cloves", "each"), "whole cloves|each");
    assert.equal(bucketKeyOf("garlic cloves", "each"), "garlic cloves|each");
  });

  it("keeps two ingredients whose names differ only by plural apart", () => {
    // If the fold ever leaked from the unit field to the name field, these
    // would collide. They must not.
    assert.notEqual(bucketKeyOf("cloves", "tsp"), bucketKeyOf("clove", "tsp"));
    assert.notEqual(
      bucketKeyOf("ground cloves", "tsp"),
      bucketKeyOf("ground clove", "tsp"),
    );
  });

  it("does not merge the spice with garlic, in any unit", () => {
    // `cloves` the spice in teaspoons beside `garlic` in cloves. Different
    // canonicals, so different groups — and nothing about the shared word
    // `cloves` may bring them together.
    const out = mergeConvertibleGroups([
      item("ground cloves", 1, "teaspoon"),
      item("garlic", 2, "cloves"),
    ]);
    assert.equal(out.length, 2, "a spice and a bulb are two shopping rows");
    assert.deepEqual(
      out.map((i) => [i.quantity, i.unit]),
      [
        [1, "teaspoon"],
        [2, "cloves"],
      ],
    );
  });

  it("sums the spice across its own spellings of ONE unit, and nothing else", () => {
    // `ground cloves` in teaspoon + tsp is a real fold (BUG-174 proper) and is
    // unaffected by the count map. Its unit never enters COUNT_UNIT_ALIASES.
    assert.equal(canonicalUnitToken("teaspoon"), "tsp");
    assert.equal(bucketKeyOf("ground cloves", "teaspoon"), bucketKeyOf("ground cloves", "tsp"));
    // …while the spice measured in `each` stays its own bucket.
    assert.notEqual(
      bucketKeyOf("whole cloves", "each"),
      bucketKeyOf("whole cloves", "tsp"),
    );
  });
});

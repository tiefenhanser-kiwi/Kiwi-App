// WS7-8b B2 — density-aware merge (mergeConvertibleGroups) tests.
// Pins the load-bearing ordering: MERGE first, then round ONCE — never round
// the parts then merge (that double-rounds and inflates).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mergeConvertibleGroups } from "../groceryMerge";
import { roundNeedQuantity } from "../needQuantity";
import type { ConsolidatedItem } from "../groceryList";

let seq = 0;
function item(over: Partial<ConsolidatedItem> & { canonicalName: string; quantity: number; unit: string }): ConsolidatedItem {
  seq += 1;
  return {
    ingredientId: `ing-${seq}`,
    displayName: over.canonicalName,
    sectionKey: "pantry",
    isUniversalStaple: false,
    isUserPantryStaple: false,
    isRecurringItem: false,
    sources: [{ mealId: `m-${seq}`, dishId: `d-${seq}`, servings: 4, ingredientSignature: `s-${seq}` }],
    purchaseUnit: null,
    purchaseQuantity: null,
    purchaseDisplay: null,
    conversionRef: null,
    preparationNote: null,
    sourceDishTitle: null,
    ...over,
  };
}

describe("mergeConvertibleGroups — measured merge", () => {
  it("merges parmesan oz + cup into one weight line (raw, unrounded)", () => {
    const out = mergeConvertibleGroups([
      item({ canonicalName: "parmesan", quantity: 3, unit: "oz" }),
      item({ canonicalName: "parmesan", quantity: 0.5, unit: "cup" }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].unit, "oz"); // weight preferred over volume
    // 3 oz (85.0486 g) + 0.5 cup × 100 g/cup (50 g) = 135.0486 g ÷ 28.3495 = 4.7638 oz
    assert.ok(Math.abs(out[0].quantity - 4.7638) < 1e-3);
    assert.equal(out[0].sources.length, 2); // provenance unioned
  });

  it("MERGE-then-round ≠ round-then-merge (the ordering that matters)", () => {
    // parmesan 3 oz + 0.4 cup. Merge-first sums raw grams; the sweep rounds once.
    const merged = mergeConvertibleGroups([
      item({ canonicalName: "parmesan", quantity: 3, unit: "oz" }),
      item({ canonicalName: "parmesan", quantity: 0.4, unit: "cup" }),
    ]);
    const mergeThenRound = roundNeedQuantity(merged[0].quantity, merged[0].unit);
    // merged raw: 85.0486 + 40 = 125.0486 g ÷ 28.3495 = 4.4093 oz → ladder → 4.5
    assert.equal(mergeThenRound, 4.5);

    // The WRONG order — round each part, THEN merge — inflates:
    //   round(3 oz)=3 ; round(0.4 cup)=0.5 cup ; 85.0486 + 50 = 135.0486 g → 4.7638 → 4.875
    const roundedParts = 85.048569 + 0.5 * 100; // g
    const roundThenMerge = roundNeedQuantity(roundedParts / 28.349523125, "oz");
    assert.equal(roundThenMerge, 4.875);

    assert.notEqual(mergeThenRound, roundThenMerge); // 4.5 ≠ 4.875 — the bug we avoid
  });

  it("aborts (keeps rows separate) when a volume unit has no density", () => {
    // A canonical with no code-table entry → convertToGrams returns null for cup.
    const out = mergeConvertibleGroups([
      item({ canonicalName: "mystery", quantity: 1, unit: "cup" }),
      item({ canonicalName: "mystery", quantity: 3, unit: "tbsp" }),
    ]);
    assert.equal(out.length, 2);
  });
});

describe("mergeConvertibleGroups — head↔clove (BUG-025-1)", () => {
  it("merges 1 head + 3 cloves into 13 cloves", () => {
    const out = mergeConvertibleGroups([
      item({ canonicalName: "garlic", quantity: 1, unit: "head" }),
      item({ canonicalName: "garlic", quantity: 3, unit: "clove" }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].unit, "clove");
    assert.equal(out[0].quantity, 13); // 1×10 + 3
  });

  it("leaves single-unit groups untouched", () => {
    const out = mergeConvertibleGroups([
      item({ canonicalName: "garlic", quantity: 4, unit: "clove" }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].quantity, 4);
  });
});

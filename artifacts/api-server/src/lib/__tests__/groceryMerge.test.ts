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

// ── BUG-142 Layer 1 — staple variants reach their base's conversion data ──
//
// `kosher salt` is its own catalog row: conversionRef NULL, no code-table entry
// of its own. Grouping on the RAW canonical meant it never shared a group with
// `salt` and never saw base salt's gramsPerCup: 273, so mergeGroup returned
// null, the pair stayed split, and partitionForAI rule 3 handed BOTH rows to
// Sonnet for free-form cross-unit arithmetic. Six runs on byte-identical input
// then produced three different salt totals.
//
// The observed live shape: salt reaches nine dishes — eight teaspoon sources
// summing to 7.75 tsp, plus one dish calling for 1 tablespoon.
describe("BUG-142 — staple-variant merge via the base staple's conversion", () => {
  it("merges the nine-source kosher-salt case to exactly 10.75 tsp with all 9 sources", () => {
    const tsp = item({
      canonicalName: "kosher salt",
      quantity: 7.75,
      unit: "teaspoon",
      conversionRef: null, // as in the live catalog row
    });
    // Eight distinct dishes contributed the teaspoon bucket.
    tsp.sources = Array.from({ length: 8 }, (_, i) => ({
      mealId: `m-salt-${i}`,
      dishId: `d-salt-${i}`,
      servings: 4,
      ingredientSignature: `sig-salt-${i}`,
    }));
    const tbsp = item({
      canonicalName: "kosher salt",
      quantity: 1,
      unit: "tablespoon",
      conversionRef: null,
    });
    tbsp.sources = [
      { mealId: "m-rigatoni", dishId: "d-rigatoni", servings: 4, ingredientSignature: "sig-rig" },
    ];

    const out = mergeConvertibleGroups([tsp, tbsp]);

    assert.equal(out.length, 1, "the variant pair must merge deterministically");
    assert.equal(out[0].unit, "teaspoon");
    // 7.75 tsp + 1 tbsp. 1 tbsp = 3 tsp, so the plan needs 10.75 tsp. Stated as
    // a literal on purpose: deriving it from gramsPerCup would just restate the
    // code under test and pin nothing.
    //
    // mergeGroup returns the RAW gram round-trip (10.749999999999998), which is
    // why this helper's contract is merge-then-round-ONCE: the consolidator's
    // single roundNeedQuantity sweep is what the shopper sees, and it must land
    // on exactly 10.75 — not 10.875, and not the 13.75 the AI path produced.
    assert.ok(Math.abs(out[0].quantity - 10.75) < 1e-9);
    assert.equal(roundNeedQuantity(out[0].quantity, out[0].unit), 10.75);
    // BUG-165 — provenance is the UNION. All nine dishes still account for the
    // quantity on the one surviving row.
    assert.equal(out[0].sources.length, 9);
    // The shopper-facing name is untouched — this is a conversion lookup, not a
    // rename to "salt".
    assert.equal(out[0].canonicalName, "kosher salt");
  });

  it("groups TWO DIFFERENT variants of one base staple into a single mergeable group", () => {
    // This is what the GROUPING KEY buys, and it is separable from the
    // conversion fallback: "sea salt" and "kosher salt" are distinct canonicals,
    // so under the old raw-canonical key they were two groups of one and
    // mergeGroup was never even called, no matter what conversion data existed.
    // Keyed by base staple they are one group, and base salt's density
    // reconciles them.
    const out = mergeConvertibleGroups([
      item({ canonicalName: "sea salt", quantity: 1, unit: "teaspoon" }),
      item({ canonicalName: "kosher salt", quantity: 1, unit: "tablespoon" }),
    ]);
    assert.equal(out.length, 1, "one base staple → one group → one row");
    assert.equal(out[0].unit, "teaspoon");
    // 1 tsp + 1 tbsp = 1 + 3 = 4 tsp. Literal, not derived from gramsPerCup.
    assert.ok(Math.abs(out[0].quantity - 4) < 1e-9);
    assert.equal(out[0].sources.length, 2);
  });

  it("does NOT merge a staple variant with its base across an unconvertible unit", () => {
    // Live shape on one plan: kosher salt 6.75 tsp alongside salt 1 "pinch".
    // They now share a group, but "pinch" converts to nothing, so mergeGroup
    // must refuse and BOTH rows pass through — the widened group must not be
    // able to merge things the table cannot actually reconcile.
    const out = mergeConvertibleGroups([
      item({ canonicalName: "kosher salt", quantity: 6.75, unit: "teaspoon" }),
      item({ canonicalName: "salt", quantity: 1, unit: "pinch" }),
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].quantity, 6.75);
    assert.equal(out[1].unit, "pinch");
  });

  it("does not hand salt's density to a seasoning that merely contains the word", () => {
    // STAPLE_VARIANT_TO_BASE is an EXACT-string map. "garlic salt" is absent
    // from it, so it must not inherit base salt's gramsPerCup and must not
    // group with "kosher salt".
    const out = mergeConvertibleGroups([
      item({ canonicalName: "garlic salt", quantity: 2, unit: "teaspoon" }),
      item({ canonicalName: "garlic salt", quantity: 1, unit: "tablespoon" }),
    ]);
    assert.equal(out.length, 2, "no conversion data → left for the AI path");
  });

  it("leaves the 1,561 non-variant canonicals grouped exactly as before", () => {
    // Two unrelated canonicals that are not staple variants must not collide.
    const out = mergeConvertibleGroups([
      item({ canonicalName: "yellow onion", quantity: 2, unit: "each" }),
      item({ canonicalName: "onion", quantity: 1, unit: "each" }),
    ]);
    assert.equal(out.length, 2);
  });
});

// WS7-8b B2 — density-aware merge (mergeConvertibleGroups) tests.
// Pins the load-bearing ordering: MERGE first, then round ONCE — never round
// the parts then merge (that double-rounds and inflates).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mergeConvertibleGroups } from "../groceryMerge";
import { baseStapleName, mergeGroupBaseName } from "../groceryStaples";
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

  // WS9 BUG-176 — REWRITTEN, not deleted. This used to assert that
  // `mystery 1 cup + 3 tbsp` stays TWO rows because convertToGrams returns null
  // for a volume unit with no density. That abort was the defect: cup and tbsp
  // are one dimension and 1 cup = 16 tbsp needs no ingredient data at all, so
  // the pair now merges (see groceryMergeSameDimension.test.ts). What this test
  // was really for — the table refusing a group it genuinely cannot reconcile —
  // is unchanged and is pinned here at the boundary that still exists: ACROSS
  // dimensions, where a density is genuinely required and absent.
  it("aborts (keeps rows separate) when a CROSS-dimension pair has no density", () => {
    // A canonical with no code-table entry → weight↔volume needs gramsPerCup
    // and there is none, so convertToGrams returns null and the group stands.
    const out = mergeConvertibleGroups([
      item({ canonicalName: "mystery", quantity: 1, unit: "cup" }),
      item({ canonicalName: "mystery", quantity: 3, unit: "oz" }),
    ]);
    assert.equal(out.length, 2);
  });

  it("merges a SAME-dimension pair that has no density (BUG-176)", () => {
    // The counterpart of the above, kept beside it so the boundary is legible:
    // 1 cup + 3 tbsp = 1.1875 cup, arithmetic no ingredient data is needed for.
    const out = mergeConvertibleGroups([
      item({ canonicalName: "mystery", quantity: 1, unit: "cup" }),
      item({ canonicalName: "mystery", quantity: 3, unit: "tbsp" }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].unit, "cup");
    assert.equal(out[0].quantity, 1.1875);
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

  // ⚠️ SUPERSEDED RULING — this test was INVERTED, not fixed.
  //
  // As written for BUG-142 it asserted the opposite: that "sea salt 1 tsp" and
  // "kosher salt 1 tbsp" merge into ONE 4-tsp row. That was a correct test of
  // the code as shipped, and it passed. Hans has since ruled the behaviour
  // itself wrong (BUG-170, device item 8): "salts are super different so
  // keeping them separate is probably needed and best… iodized salt is NOT
  // kosher is NOT flaky sea salt."
  //
  // Changed because the RULING changed — not because the assertion was wrong
  // when it was written.
  it("keeps TWO DIFFERENT salts as two rows — they are different products", () => {
    const out = mergeConvertibleGroups([
      item({ canonicalName: "sea salt", quantity: 1, unit: "teaspoon" }),
      item({ canonicalName: "kosher salt", quantity: 1, unit: "tablespoon" }),
    ]);
    assert.equal(out.length, 2, "two salts → two rows");
    // Each keeps its own name and its own quantity — nothing was folded.
    const sea = out.find((i) => i.canonicalName === "sea salt")!;
    const kosher = out.find((i) => i.canonicalName === "kosher salt")!;
    assert.equal(sea.quantity, 1);
    assert.equal(sea.unit, "teaspoon");
    assert.equal(kosher.quantity, 1);
    assert.equal(kosher.unit, "tablespoon");
  });

  it("BUG-168: whole peppercorns never fold into ground black pepper", () => {
    // Hans: "the big thing to avoid here is needing 1 tsp ground black pepper
    // and telling a user to buy peppercorns they need to grind."
    const out = mergeConvertibleGroups([
      item({ canonicalName: "ground black pepper", quantity: 1, unit: "teaspoon" }),
      item({ canonicalName: "black peppercorns", quantity: 1, unit: "tablespoon" }),
    ]);
    assert.equal(out.length, 2, "ground and whole are different purchases");
    assert.ok(out.some((i) => i.canonicalName === "black peppercorns"));
  });

  it("still folds the GROUND black-pepper spellings onto one grouping key", () => {
    // ⚠️ Asserted on the KEY, not on a merged row, and that is deliberate.
    // `black pepper` carries NO gramsPerCup in the conversion table (unlike
    // olive oil's 216), so mergeGroup cannot reconcile tsp against tbsp for it
    // and refuses — these two spellings share a group but still emit two rows
    // today. An earlier draft of this test asserted `out.length === 1` and
    // failed for exactly that reason; it was the assertion that was wrong, not
    // the code.
    //
    // So what is pinned here is the half that IS true and IS load-bearing: the
    // ground spellings are one purchase and fold together, while peppercorns
    // and every salt do not. If black pepper ever gains a density, the merge
    // follows from this without another change.
    assert.equal(mergeGroupBaseName("freshly ground black pepper"), "black pepper");
    assert.equal(mergeGroupBaseName("cracked black pepper"), "black pepper");
    assert.equal(mergeGroupBaseName("ground pepper"), "black pepper");
    // …and the two classes Hans ruled distinct are the identity function.
    assert.equal(mergeGroupBaseName("black peppercorns"), "black peppercorns");
    assert.equal(mergeGroupBaseName("kosher salt"), "kosher salt");
    assert.equal(mergeGroupBaseName("flaky sea salt"), "flaky sea salt");
    // The pantry-staple map is UNCHANGED — kosher salt must still render greyed
    // (BUG-025-5, PRD §2.2 + §12.7 [LOCKED]). Two maps, two questions.
    assert.equal(baseStapleName("kosher salt"), "salt");
    assert.equal(baseStapleName("black peppercorns"), "black pepper");
  });

  it("still folds the olive-oil family — extra virgin / extra-virgin / evoo are one bottle", () => {
    // This is what the GROUPING KEY still buys, and it is separable from the
    // conversion fallback: these are distinct canonicals, so without folding
    // they would be two groups of one and mergeGroup would never be called.
    const out = mergeConvertibleGroups([
      item({ canonicalName: "extra virgin olive oil", quantity: 1, unit: "tablespoon" }),
      item({ canonicalName: "extra-virgin olive oil", quantity: 1, unit: "cup" }),
    ]);
    assert.equal(out.length, 1, "one bottle → one group → one row");
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

  // WS9 BUG-176 — ASSERTION REWRITTEN, rule unchanged. The pair used to be
  // `garlic salt` in tsp + tbsp, and "two rows out" stood in for "it inherited
  // no density". That proxy no longer holds: tsp and tbsp are one dimension and
  // now merge with no density whatsoever, so a merge here proves nothing about
  // what conversion was resolved. The pair is now CROSS-dimension, where the
  // density is the only thing that could merge it — so the refusal tests the
  // actual claim instead of a side effect of it.
  it("does not hand salt's density to a seasoning that merely contains the word", () => {
    // STAPLE_VARIANT_TO_BASE is an EXACT-string map. "garlic salt" is absent
    // from it, so it must not inherit base salt's gramsPerCup. With that
    // density it would merge oz into cup; without it, it cannot.
    const out = mergeConvertibleGroups([
      item({ canonicalName: "garlic salt", quantity: 2, unit: "ounce" }),
      item({ canonicalName: "garlic salt", quantity: 1, unit: "cup" }),
    ]);
    assert.equal(out.length, 2, "no density inherited → nothing can merge these");
  });

  it("DOES merge base salt across the same pair, proving the density is the difference", () => {
    // The control. "salt" has gramsPerCup in the code table, so the identical
    // cross-dimension shape merges — which is what makes the refusal above a
    // statement about garlic salt and not about the units.
    const out = mergeConvertibleGroups([
      item({ canonicalName: "salt", quantity: 2, unit: "ounce" }),
      item({ canonicalName: "salt", quantity: 1, unit: "cup" }),
    ]);
    assert.equal(out.length, 1, "base salt HAS a density, so this one merges");
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

// ── WS9 BUG-181 — same name-group, same unit ────────────────────────────────
// The defect: MERGE_GROUP_VARIANT_TO_BASE folded the olive-oil spellings into
// one group correctly, and mergeConvertibleGroups then refused the group
// because every member carried the same unit. Three tablespoon rows shipped as
// three bottles. Every expected value below is a hand-written literal; nothing
// reads MERGE_GROUP_VARIANT_TO_BASE or any conversion table.
describe("mergeConvertibleGroups — same-unit fold (BUG-181)", () => {
  it("merges the three olive oil spellings, all in tablespoons, into ONE 13-tbsp row", () => {
    // The live defect, verbatim from Hans's plan export d0d1bea8:
    //   olive oil              3 tablespoon  (Spicy Arrabbiata)
    //   extra virgin olive oil 5 tablespoon  (Salmon | Cherry Tomatoes | Garlic Spinach)
    //   extra-virgin olive oil 5 tablespoon  (Sheet-Pan Chicken | Smashed Potatoes)
    // 13 tablespoons of one product, ordered as three bottles.
    const out = mergeConvertibleGroups([
      item({ canonicalName: "olive oil", quantity: 3, unit: "tablespoon" }),
      item({ canonicalName: "extra virgin olive oil", quantity: 5, unit: "tablespoon" }),
      item({ canonicalName: "extra-virgin olive oil", quantity: 5, unit: "tablespoon" }),
    ]);
    assert.equal(out.length, 1, "three spellings of one bottle must be one row");
    assert.equal(out[0].quantity, 13, "3 + 5 + 5 = 13, exactly");
    assert.equal(out[0].unit, "tablespoon", "keeps a spelling that occurs in the data");
    // Provenance from all three rows must survive onto the survivor.
    assert.equal(out[0].sources.length, 3);
  });

  it("merges the ground-black-pepper spellings the same way", () => {
    // The other folded family. `black pepper` carries no gramsPerCup, so this
    // could only ever merge through the same-unit path — which is the point.
    const out = mergeConvertibleGroups([
      item({ canonicalName: "black pepper", quantity: 2, unit: "teaspoon" }),
      item({ canonicalName: "ground black pepper", quantity: 1.5, unit: "teaspoon" }),
      item({ canonicalName: "freshly ground black pepper", quantity: 0.5, unit: "teaspoon" }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].quantity, 4, "2 + 1.5 + 0.5 = 4");
  });

  it("sums across two SPELLINGS of one unit (tablespoon + tbsp)", () => {
    // canonicalUnitToken, not normalizeUnit: these are one unit reached twice.
    const out = mergeConvertibleGroups([
      item({ canonicalName: "olive oil", quantity: 2, unit: "tablespoon" }),
      item({ canonicalName: "extra-virgin olive oil", quantity: 3, unit: "tbsp" }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].quantity, 5, "2 + 3 = 5 tablespoons");
  });

  it("consults NO conversion factor — an ingredient with no density still sums", () => {
    // `black peppercorns` has no gramsPerCup and is deliberately absent from
    // the merge map, so it groups under its own name; two rows of it in one
    // unit must still sum without any table being reachable.
    const out = mergeConvertibleGroups([
      item({ canonicalName: "black peppercorns", quantity: 1, unit: "teaspoon" }),
      item({ canonicalName: "black peppercorns", quantity: 2, unit: "teaspoon" }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].quantity, 3);
  });

  it("does NOT merge two salts in the same unit — the fold is what licenses this", () => {
    // The negative that proves the change rides on MERGE_GROUP_VARIANT_TO_BASE
    // and not on "same unit" alone. BUG-170/168: iodized is not kosher is not
    // flaky sea salt, so these group separately and must stay two rows even
    // though both are teaspoons.
    const out = mergeConvertibleGroups([
      item({ canonicalName: "kosher salt", quantity: 2, unit: "teaspoon" }),
      item({ canonicalName: "flaky sea salt", quantity: 1, unit: "teaspoon" }),
    ]);
    assert.equal(out.length, 2, "different salts are different products");
  });

  it("merges a DIMENSIONLESS same-unit pair — the case only this branch can serve", () => {
    // THE DISCRIMINATING TEST. `pinch` has no dimension and is neither a weight
    // nor a volume unit, so BUG-176's same-dimension path refuses it, the grams
    // path never runs (isMeasured is false), and there is no subUnit parent.
    // Every other route to a merge is closed; only the same-unit branch can
    // answer. Without it these two folded pepper spellings ship as two rows.
    const out = mergeConvertibleGroups([
      item({ canonicalName: "black pepper", quantity: 1, unit: "pinch" }),
      item({ canonicalName: "ground black pepper", quantity: 2, unit: "pinch" }),
    ]);
    assert.equal(out.length, 1, "one pepper container, not two");
    assert.equal(out[0].quantity, 3, "1 + 2 = 3 pinches");
    assert.equal(out[0].unit, "pinch");
  });

  it("does NOT merge two unrelated canonicals that happen to share a unit", () => {
    const out = mergeConvertibleGroups([
      item({ canonicalName: "yellow onion", quantity: 2, unit: "each" }),
      item({ canonicalName: "white onion", quantity: 3, unit: "each" }),
    ]);
    assert.equal(out.length, 2);
  });
});

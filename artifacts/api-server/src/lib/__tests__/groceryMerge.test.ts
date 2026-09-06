// WS7-8b B2 — density-aware merge (mergeConvertibleGroups) tests.
// Pins the load-bearing ordering: MERGE first, then round ONCE — never round
// the parts then merge (that double-rounds and inflates).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mergeConvertibleGroups } from "../groceryMerge";
import { buildRelationIndex } from "../ingredientRelations";
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

// -- WS9 D-WS9-189 A2 -- the synonym reader lands in the grouping key --------
//
// Two things are pinned here that no earlier test could reach, because before
// A2 the only cross-name folds were MERGE_GROUP_VARIANT_TO_BASE's 11 entries
// and every one of them has the short name as its base:
//   1. a relation-driven fold happens at all, and
//   2. WHICH member supplies the surviving name (shortest normalized, ties
//      alphabetical) -- which is what the SHOPPER READS.
describe("mergeConvertibleGroups -- relation-driven folding (D-WS9-189 A2)", () => {
  it("does NOT fold two synonym-related rows without an index", () => {
    // The negative that proves the fold rides on the index and not on anything
    // already in the file. Default arg = EMPTY_RELATION_INDEX.
    const out = mergeConvertibleGroups([
      item({ canonicalName: "1 block (8 oz) parmesan cheese", quantity: 2, unit: "ounce" }),
      item({ canonicalName: "parmesan cheese", quantity: 3, unit: "ounce" }),
    ]);
    assert.equal(out.length, 2);
  });

  it("folds them WITH an index, and the SHORT name survives", () => {
    const idx = buildRelationIndex([
      {
        label: "synonym",
        fromCanonicalName: "1 block (8 oz) parmesan cheese",
        toCanonicalName: "parmesan cheese",
        yieldQuantity: null,
        yieldUnit: null,
        coHarvestable: null,
        confidence: "high",
        reviewedByHuman: false,
        fromDefaultUnit: "ounce",
      },
    ]);
    // The LONG name is deliberately first, so a surviving `group[0]` spread
    // would keep it. This is the expression that changes if the defect ships.
    const out = mergeConvertibleGroups(
      [
        item({ canonicalName: "1 block (8 oz) parmesan cheese", quantity: 2, unit: "ounce" }),
        item({ canonicalName: "parmesan cheese", quantity: 3, unit: "ounce" }),
      ],
      idx,
    );
    assert.equal(out.length, 1, "the synonym edge must fold these into one row");
    assert.equal(out[0].quantity, 5, "2 + 3 = 5 ounces");
    assert.equal(
      out[0].canonicalName,
      "parmesan cheese",
      "shortest normalized name wins -- first-seen would have kept the baked-pack name",
    );
    assert.equal(out[0].displayName, "parmesan cheese");
    assert.equal(out[0].sources.length, 2, "provenance from both rows survives");
  });

  it("breaks an equal-length tie alphabetically", () => {
    const idx = buildRelationIndex([
      {
        label: "synonym",
        fromCanonicalName: "bbbb cheese",
        toCanonicalName: "aaaa cheese",
        yieldQuantity: null,
        yieldUnit: null,
        coHarvestable: null,
        confidence: "high",
        reviewedByHuman: false,
        fromDefaultUnit: "ounce",
      },
    ]);
    const out = mergeConvertibleGroups(
      [
        item({ canonicalName: "bbbb cheese", quantity: 1, unit: "ounce" }),
        item({ canonicalName: "aaaa cheese", quantity: 1, unit: "ounce" }),
      ],
      idx,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].canonicalName, "aaaa cheese");
  });
});

// ── WS9 BUG-209 (D-WS9-221) — THE NAME AND THE PACK ARE DECIDED SEPARATELY ──
//
// pickRepresentative decides what the shopper READS. Until A2b it also decided
// what the shopper BUYS, because every merge branch spread `...rep`. The pack
// must instead come from the group's packs measured against the group's SUMMED
// demand. These are written so that in every one of them the name winner and
// the pack winner are DIFFERENT rows — a test where they coincide cannot fail.
describe("mergeConvertibleGroups -- BUG-209 pack basis (D-WS9-221)", () => {
  // A synonym edge is the cheapest way to force two differently-named rows into
  // one group without leaning on the hand map's specific contents.
  function synonym(a: string, b: string, unit = "ounce") {
    return buildRelationIndex([
      {
        label: "synonym" as const,
        fromCanonicalName: a,
        toCanonicalName: b,
        yieldQuantity: null,
        yieldUnit: null,
        coHarvestable: null,
        confidence: "high" as const,
        reviewedByHuman: false,
        fromDefaultUnit: unit,
      },
    ]);
  }

  it("a SIZED pack beats a sizeless one, even when the sizeless row wins the name", () => {
    // The live shape, and the one Hans named: the catalog's `black pepper` row
    // carries `1 container` with no size at all, and it is also the SHORTEST
    // name, so it won both contests. D-WS9-221: "not I need 8 oz buy cheese".
    const out = mergeConvertibleGroups(
      [
        item({
          canonicalName: "black pepper",
          quantity: 2.75,
          unit: "teaspoon",
          purchaseUnit: "container",
          purchaseQuantity: 1,
          purchaseDisplay: "1 container",
        }),
        item({
          canonicalName: "freshly ground black pepper",
          quantity: 0.25,
          unit: "teaspoon",
          purchaseUnit: "container",
          purchaseQuantity: 1,
          purchaseDisplay: "1 container (2.3 oz)",
        }),
      ],
      synonym("black pepper", "freshly ground black pepper", "teaspoon"),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].quantity, 3, "2.75 + 0.25 teaspoon");
    // The NAME still comes from the shortest row — unchanged by this fix.
    assert.equal(out[0].canonicalName, "black pepper");
    // The PACK comes from the other row. This is the expression that changes
    // if the defect ships: pre-fix it read "1 container".
    assert.equal(out[0].purchaseDisplay, "1 container (2.3 oz)");
  });

  it("a sized pack with NO parenthetical still beats a sizeless one", () => {
    // ⚠️ THIS TEST EXISTS BECAUSE THE ONE ABOVE STAYED GREEN UNDER A DELIBERATE
    // BREAK. Deleting the sized-beats-sizeless rule did not fail it: "1 container
    // (2.3 oz)" also wins on the later "prefer a parenthetical" tiebreak, so two
    // criteria were covering one case and only one of them was under test.
    //
    // Here the sized pack states its size WITHOUT parentheses ("1 lb bag"), so
    // the parenthetical rule abstains, the tighter-buy rule abstains (a sizeless
    // pack has no magnitude to compare), and the lexicographic last resort
    // actively prefers the WRONG one — "1 container" < "1 lb bag". The
    // sized-beats-sizeless rule is the only thing that can produce this answer.
    const out = mergeConvertibleGroups(
      [
        item({
          canonicalName: "aaa",
          quantity: 2,
          unit: "ounce",
          purchaseUnit: "container",
          purchaseQuantity: 1,
          purchaseDisplay: "1 container",
        }),
        item({
          canonicalName: "bbbbbb",
          quantity: 3,
          unit: "ounce",
          purchaseUnit: "bag",
          purchaseQuantity: 1,
          purchaseDisplay: "1 lb bag",
        }),
      ],
      synonym("aaa", "bbbbbb"),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].canonicalName, "aaa", "name: shortest, unchanged");
    assert.equal(out[0].purchaseDisplay, "1 lb bag");
    assert.equal(out[0].purchaseUnit, "bag");
  });

  it("picks the TIGHTER buy, not the largest pack and not the name winner", () => {
    // Need 9 oz. A 6 oz wedge buys 12 oz; an 8 oz block buys 16 oz. The wedge
    // is the right basis even though it is the SMALLER pack and neither pack
    // covers the need alone — "buy the largest when none covers" gets this
    // wrong, and so does "keep the representative's".
    //
    // "aaa" is deliberately the shorter name AND the wrong pack, so the name
    // winner and the pack winner cannot be the same row.
    const out = mergeConvertibleGroups(
      [
        item({
          canonicalName: "aaa",
          quantity: 5,
          unit: "ounce",
          purchaseUnit: "block",
          purchaseQuantity: 1,
          purchaseDisplay: "1 block (8 oz)",
        }),
        item({
          canonicalName: "bbbbbb",
          quantity: 4,
          unit: "ounce",
          purchaseUnit: "wedge",
          purchaseQuantity: 1,
          purchaseDisplay: "1 wedge (6 oz)",
        }),
      ],
      synonym("aaa", "bbbbbb"),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].quantity, 9);
    assert.equal(out[0].canonicalName, "aaa", "name: shortest, unchanged");
    assert.equal(out[0].purchaseUnit, "wedge");
    assert.equal(out[0].purchaseDisplay, "1 wedge (6 oz)");
  });

  it("a BIGGER pack wins when it is the tighter buy", () => {
    // ⚠️ THIS TEST EXISTS BECAUSE A DELIBERATE BREAK STAYED GREEN. Deleting the
    // tighter-buy rule did not fail the parmesan or lemon cases above, because
    // in both of those the tighter buy is ALSO the smaller pack, and the
    // smaller-pack tiebreak below reaches the same answer. Two criteria, one
    // outcome, one of them untested.
    //
    // Here they disagree. Need 10 oz: a 6 oz bag buys ceil(10/6) x 6 = 12 oz,
    // a 10 oz box buys exactly 10. The BOX is right and it is the LARGER pack,
    // so the smaller-pack rule actively prefers the wrong one. Only the
    // tighter-buy rule produces this answer.
    const out = mergeConvertibleGroups(
      [
        item({
          canonicalName: "aaa",
          quantity: 6,
          unit: "ounce",
          purchaseUnit: "bag",
          purchaseQuantity: 1,
          purchaseDisplay: "1 bag (6 oz)",
        }),
        item({
          canonicalName: "bbbbbb",
          quantity: 4,
          unit: "ounce",
          purchaseUnit: "box",
          purchaseQuantity: 1,
          purchaseDisplay: "1 box (10 oz)",
        }),
      ],
      synonym("aaa", "bbbbbb"),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].quantity, 10);
    assert.equal(out[0].canonicalName, "aaa", "name: shortest, unchanged");
    assert.equal(out[0].purchaseDisplay, "1 box (10 oz)");
  });

  it("counts too: three lemons buy as 1-lemon units, not 2-lemon units", () => {
    // ceil(3/1)x1 = 3 lemons; ceil(3/2)x2 = 4. The count pack is compared the
    // same way the measured one is.
    const out = mergeConvertibleGroups(
      [
        item({
          canonicalName: "lemon",
          quantity: 2,
          unit: "each",
          purchaseUnit: "each",
          purchaseQuantity: 2,
          purchaseDisplay: "2 lemons",
          conversionRef: null,
        }),
        item({
          canonicalName: "fresh lemon",
          quantity: 1,
          unit: "each",
          purchaseUnit: "each",
          purchaseQuantity: 1,
          purchaseDisplay: "1 lemon",
          conversionRef: null,
        }),
      ],
      synonym("lemon", "fresh lemon", "each"),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].quantity, 3);
    assert.equal(out[0].canonicalName, "lemon");
    assert.equal(out[0].purchaseDisplay, "1 lemon");
  });

  // ⚠️ THE SAFETY PROPERTY, AND IT IS NOT COSMETIC.
  // fillPurchaseSizesWithWriteBack treats a null pack as a cache MISS: it asks
  // Haiku for one and WRITES IT BACK to Ingredient.purchaseUnit/Quantity/Display
  // — the same columns consolidatePlanIngredients reads next time. A merged row
  // that lost its pack would therefore not render "no pack"; it would launder an
  // AI guess into the shared catalog under the representative's ingredientId.
  it("NEVER nulls a pack the group already had (catalog write-back safety)", () => {
    const out = mergeConvertibleGroups(
      [
        // The name winner has NO pack …
        item({ canonicalName: "aaa", quantity: 2, unit: "ounce" }),
        // … and the only pack in the group belongs to the loser.
        item({
          canonicalName: "bbbbbb",
          quantity: 3,
          unit: "ounce",
          purchaseUnit: "bag",
          purchaseQuantity: 1,
          purchaseDisplay: "1 bag (12 oz)",
        }),
      ],
      synonym("aaa", "bbbbbb"),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].canonicalName, "aaa");
    assert.notEqual(out[0].purchaseDisplay, null, "a merged row must not become a write-back miss");
    assert.equal(out[0].purchaseDisplay, "1 bag (12 oz)");
    assert.equal(out[0].purchaseUnit, "bag");
  });

  it("fabricates nothing when the group genuinely has no pack", () => {
    // The control for the test above: null in, null out. If this ever returns a
    // pack, something is inventing one.
    const out = mergeConvertibleGroups(
      [
        item({ canonicalName: "aaa", quantity: 2, unit: "ounce" }),
        item({ canonicalName: "bbbbbb", quantity: 3, unit: "ounce" }),
      ],
      synonym("aaa", "bbbbbb"),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].purchaseDisplay, null);
    assert.equal(out[0].purchaseUnit, null);
    assert.equal(out[0].purchaseQuantity, null);
  });

  it("BUG-200/208/211 — head, clove and each become ONE garlic row", () => {
    // D-WS9-220, Hans: "if they need a head of garlic and 3 cloves, they should
    // buy 2 heads." The catalog splits that demand across three names and two
    // units, so it used to ship as three lines — one of them "11 garlic cloves
    // (1 head of garlic)", a pack covering 10 of the 11 cloves it names.
    //
    // Every quantity here is a live one: 2 heads + 30 cloves is list 8908a51a,
    // and `garlic cloves` arriving in "each" is list bd29f91a.
    const garlicRef = { subUnit: { parent: "head", perParent: 10 }, purchaseUnit: "head", purchaseQuantity: 1, purchaseDisplay: "1 head", source: "curated" };
    const out = mergeConvertibleGroups([
      item({ canonicalName: "head of garlic", quantity: 2, unit: "head", conversionRef: garlicRef, purchaseUnit: "each", purchaseQuantity: 2, purchaseDisplay: "2 heads" }),
      item({ canonicalName: "garlic", quantity: 30, unit: "clove", conversionRef: garlicRef, purchaseUnit: "head", purchaseQuantity: 1, purchaseDisplay: "1 head" }),
      item({ canonicalName: "garlic cloves", quantity: 11, unit: "each", conversionRef: garlicRef, purchaseUnit: "each", purchaseQuantity: 1, purchaseDisplay: "1 head of garlic" }),
    ]);
    assert.equal(out.length, 1, "BUG-200: one garlic row, not three");
    // 2 heads x 10 + 30 + 11 = 61 cloves. The `each` row counts as cloves
    // (BUG-211); before the fix childSet was {clove, each} and the whole group
    // was refused.
    assert.equal(out[0].quantity, 61);
    assert.equal(out[0].unit, "clove", "the merged row states the CLOVE need, not a head count");
    assert.equal(out[0].canonicalName, "garlic", "shortest name across the folded family");
  });

  it("a head-only garlic demand still merges, and a mixed child still refuses", () => {
    // Two controls for the widening above. First: no `each` row at all — the
    // pre-existing head+clove case must be untouched.
    const garlicRef = { subUnit: { parent: "head", perParent: 10 }, source: "curated" };
    const headClove = mergeConvertibleGroups([
      item({ canonicalName: "head of garlic", quantity: 2, unit: "head", conversionRef: garlicRef }),
      item({ canonicalName: "garlic", quantity: 9, unit: "clove", conversionRef: garlicRef }),
    ]);
    assert.equal(headClove.length, 1);
    assert.equal(headClove[0].quantity, 29, "2 heads x 10 + 9 cloves");

    // Second: TWO named children (clove and slice) is a genuinely mixed group
    // and must still be refused — the widening folds a bare count onto ONE
    // named child, it does not make every unit summable.
    const mixed = mergeConvertibleGroups([
      item({ canonicalName: "garlic", quantity: 4, unit: "clove", conversionRef: garlicRef }),
      item({ canonicalName: "garlic cloves", quantity: 3, unit: "slice", conversionRef: garlicRef }),
    ]);
    assert.equal(mixed.length, 2, "clove + slice cannot be summed and must pass through");
  });

  it("leaves a single-row group's pack untouched", () => {
    // Nothing folds, so there is no choice to make and no basis to re-pick.
    const out = mergeConvertibleGroups([
      item({
        canonicalName: "black pepper",
        quantity: 2,
        unit: "teaspoon",
        purchaseUnit: "container",
        purchaseQuantity: 1,
        purchaseDisplay: "1 container",
      }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].purchaseDisplay, "1 container");
  });
});

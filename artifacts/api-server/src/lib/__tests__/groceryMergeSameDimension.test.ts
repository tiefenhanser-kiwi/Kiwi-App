// WS9 BUG-176 — same-dimension merge needs no density.
//
// Two halves, and BOTH are load-bearing:
//   • a same-dimension pair with NO conversion row must now merge, because
//     1 tbsp = 3 tsp is fixed kitchen math;
//   • a CROSS-dimension pair must still refuse, WITH or WITHOUT a density,
//     because `1 each` of milk and `0.5 cup` of milk cannot be added without
//     a gramsPerEach nobody has. Two honest rows beat an invented number —
//     that is BUG-142's ruling and this change must not erode it.
//
// ⚠️ Every expected quantity below is an EXPLICIT LITERAL chosen so the
// arithmetic is exact in floating point (0.5 cup + 2 tbsp = 0.625 cup, not a
// repeating fraction). Nothing is read back off the row under test, and nothing
// is derived from VOLUME_UNIT_TO_CUPS / WEIGHT_UNIT_TO_GRAMS.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mergeConvertibleGroups } from "../groceryMerge";
import {
  convertWithinDimension,
  unitDimension,
} from "../ingredientConversions";
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
    sectionKey: "pantry",
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

describe("unitDimension / convertWithinDimension", () => {
  it("names the dimension of a unit it carries a factor for", () => {
    assert.equal(unitDimension("tsp"), "volume");
    assert.equal(unitDimension("teaspoon"), "volume");
    assert.equal(unitDimension("cup"), "volume");
    assert.equal(unitDimension("oz"), "weight");
    assert.equal(unitDimension("pounds"), "weight");
  });

  it("returns null for a unit no factor table carries", () => {
    for (const u of ["each", "pinch", "bunch", "head", "clove", "large", ""]) {
      assert.equal(unitDimension(u), null, `${u} has no dimension`);
    }
  });

  it("converts inside one dimension with no ingredient data at all", () => {
    assert.equal(convertWithinDimension(1, "tablespoon", "tsp"), 3);
    assert.equal(convertWithinDimension(1, "cup", "tbsp"), 16);
    assert.equal(convertWithinDimension(1, "lb", "oz"), 16);
    assert.equal(convertWithinDimension(2, "cups", "pint"), 1);
  });

  it("REFUSES across dimensions, and refuses an unknown unit", () => {
    assert.equal(convertWithinDimension(1, "each", "cup"), null);
    assert.equal(convertWithinDimension(1, "cup", "each"), null);
    assert.equal(convertWithinDimension(1, "cup", "oz"), null);
    assert.equal(convertWithinDimension(1, "oz", "cup"), null);
    assert.equal(convertWithinDimension(1, "pinch", "tsp"), null);
    assert.equal(convertWithinDimension(1, "bunch", "cup"), null);
  });
});

describe("mergeConvertibleGroups — BUG-176 same-dimension, no density", () => {
  it("merges cup + tbsp for an ingredient with NO conversion row", () => {
    // 0.5 cup + 2 tbsp. 2 tbsp is ⅛ cup, so the total is 0.625 cup exactly.
    const out = mergeConvertibleGroups([
      item("ketchup", 0.5, "cup"),
      item("ketchup", 2, "tablespoon"),
    ]);
    assert.equal(out.length, 1, "one row");
    assert.equal(out[0].unit, "cup");
    assert.equal(out[0].quantity, 0.625);
  });

  it("merges tbsp + tsp for an ingredient with NO conversion row", () => {
    // The live hot-sauce case. 1 tbsp + 1 tsp = 1⅓ tbsp.
    const out = mergeConvertibleGroups([
      item("hot sauce", 1, "tablespoon"),
      item("hot sauce", 1, "teaspoon"),
    ]);
    assert.equal(out.length, 1, "one row");
    assert.equal(out[0].unit, "tablespoon");
    // Stated as thirds rather than a decimal, so the literal is exact.
    assert.ok(Math.abs(out[0].quantity - 4 / 3) < 1e-12, out[0].quantity.toString());
  });

  it("merges oz + lb with no conversion row (weight was always density-free)", () => {
    const out = mergeConvertibleGroups([
      item("ground beef", 8, "oz"),
      item("ground beef", 1, "lb"),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].unit, "oz");
    assert.equal(out[0].quantity, 24);
  });

  it("gives the SAME answer as the grams path when a density does exist", () => {
    // 1 cup + 8 tbsp = 1.5 cup. The density is present and irrelevant: within
    // one dimension it cancels. The literal is the kitchen answer, not a
    // recomputation of the code's own arithmetic.
    const dense = { gramsPerCup: 240, source: "curated" as const };
    const out = mergeConvertibleGroups([
      item("flour", 1, "cup", dense),
      item("flour", 8, "tablespoon", dense),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].unit, "cup");
    assert.equal(out[0].quantity, 1.5);
  });

  it("carries the folded row's metadata, as the grams path does", () => {
    const a = item("hot sauce", 1, "tablespoon");
    const b = item("hot sauce", 1, "teaspoon");
    b.isUserPantryStaple = true;
    b.purchaseUnit = "bottle";
    b.purchaseQuantity = 1;
    b.purchaseDisplay = "1 bottle";
    const out = mergeConvertibleGroups([a, b]);
    assert.equal(out.length, 1);
    assert.equal(out[0].isUserPantryStaple, true);
    assert.equal(out[0].purchaseDisplay, "1 bottle");
  });
});

// ── the half that must NOT move ────────────────────────────────────────────
describe("mergeConvertibleGroups — BUG-176 must not force cross-dimension", () => {
  it("REFUSES each + cup even though the ingredient HAS a density", () => {
    // The live whole-milk shape. gramsPerCup is present; gramsPerEach is not,
    // so `1 each` of milk is not a quantity anything can add. Two rows is the
    // correct output — BUG-142's designed failure mode.
    const dense = { gramsPerCup: 244, source: "usda_derived" as const };
    const out = mergeConvertibleGroups([
      item("whole milk", 1, "each", dense),
      item("whole milk", 0.5, "cup", dense),
    ]);
    assert.equal(out.length, 2, "each + cup must stay two rows");
    assert.deepEqual(
      out.map((i) => [i.quantity, i.unit]),
      [
        [1, "each"],
        [0.5, "cup"],
      ],
      "both parts survive with their own quantity and unit",
    );
  });

  it("REFUSES pinch + tsp (BUG-172 salt narrowing)", () => {
    const out = mergeConvertibleGroups([
      item("salt", 1, "pinch", { gramsPerCup: 273, source: "curated" as const }),
      item("salt", 0.75, "tsp", { gramsPerCup: 273, source: "curated" as const }),
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map((i) => [i.quantity, i.unit]),
      [
        [1, "pinch"],
        [0.75, "tsp"],
      ],
    );
  });

  it("REFUSES bunch + cup", () => {
    const dense = { gramsPerCup: 16, source: "usda_derived" as const };
    const out = mergeConvertibleGroups([
      item("fresh cilantro", 2, "bunch", dense),
      item("fresh cilantro", 0.25, "cup", dense),
    ]);
    assert.equal(out.length, 2);
  });

  it("still merges oz + cup THROUGH GRAMS — BUG-031 is untouched", () => {
    // Cross-dimension, so the same-dimension path must decline and the grams
    // path must take it. 3 oz + 0.5 cup at 120 g/cup: 0.5 cup is 60 g, which
    // is 60/28.349523125 oz. Asserted as a range so the literal stays honest
    // about the irrational factor rather than pretending to exactness.
    const out = mergeConvertibleGroups([
      item("parmesan", 3, "oz", { gramsPerCup: 120, source: "curated" as const }),
      item("parmesan", 0.5, "cup", { gramsPerCup: 120, source: "curated" as const }),
    ]);
    assert.equal(out.length, 1, "cross-dimension WITH density still merges");
    assert.equal(out[0].unit, "oz");
    assert.ok(out[0].quantity > 5.11 && out[0].quantity < 5.12, out[0].quantity.toString());
  });

  it("REFUSES a group with no density once ANY member is dimensionless", () => {
    // cup + tbsp would merge on their own; the `each` member poisons the group
    // and the whole thing must pass through untouched.
    const out = mergeConvertibleGroups([
      item("hot sauce", 1, "cup"),
      item("hot sauce", 1, "tablespoon"),
      item("hot sauce", 1, "each"),
    ]);
    assert.equal(out.length, 3, "all three rows survive");
  });
});

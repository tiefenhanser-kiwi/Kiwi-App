// WS7-8b USDA Block 1 — estimator grounding assembly tests.
//
// resolveEffectiveIngredients is the input-assembly seam: it produces the
// ingredient objects (with/without nutritionRefPer100g) that flow verbatim
// into estimateDishMacros' estimateInput. These tests pin that a MATCHED usda
// record grounds the ingredient, while miss-markers and null refs stay
// ungrounded (exactly as today).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveEffectiveIngredients } from "../overrideResolver";
import type { DishWithIngredients } from "../overrideResolver";
import type {
  NutritionRefMatched,
  NutritionRefMiss,
} from "../usda/ingredientEnrichment";

const NO_OVERRIDES = { ingredientOverrides: null, recipeOverrideJson: null };

const matchedRef: NutritionRefMatched = {
  basis: "per100g",
  per100g: { calories: 40, protein: 1.1, carbs: 9.3, fat: 0.1 },
  source: "usda",
  fdcId: 42,
  dataType: "SR Legacy",
  foodCategory: "Vegetables",
  fetchedAt: "2026-07-06T12:00:00.000Z",
};
const missRef: NutritionRefMiss = {
  source: "usda",
  matched: false,
  fetchedAt: "2026-07-06T12:00:00.000Z",
};

// Build a DishWithIngredients whose ingredients carry the given refs.
function makeDish(
  ingredients: Array<{ name: string; ref: unknown }>,
): DishWithIngredients {
  return {
    dishIngredients: ingredients.map((ing, i) => ({
      quantity: 1,
      unit: "cup",
      isOptional: false,
      positionIndex: i,
      ingredient: {
        displayName: ing.name,
        nutritionRefPerUnit: ing.ref,
      },
    })),
  } as unknown as DishWithIngredients;
}

describe("resolveEffectiveIngredients — USDA grounding", () => {
  it("attaches nutritionRefPer100g when the ingredient has a matched record", () => {
    const dish = makeDish([{ name: "Yellow onion", ref: matchedRef }]);
    const result = resolveEffectiveIngredients(NO_OVERRIDES, dish);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].nutritionRefPer100g, {
      calories: 40,
      protein: 1.1,
      carbs: 9.3,
      fat: 0.1,
    });
  });

  it("omits grounding for a miss-marker ingredient", () => {
    const dish = makeDish([{ name: "Harissa paste", ref: missRef }]);
    const result = resolveEffectiveIngredients(NO_OVERRIDES, dish);
    assert.equal("nutritionRefPer100g" in result[0], false);
  });

  it("omits grounding for a null ref (never enriched)", () => {
    const dish = makeDish([{ name: "Mystery spice", ref: null }]);
    const result = resolveEffectiveIngredients(NO_OVERRIDES, dish);
    assert.equal("nutritionRefPer100g" in result[0], false);
  });

  it("grounds only the matched ingredients in a mixed dish", () => {
    const dish = makeDish([
      { name: "Yellow onion", ref: matchedRef },
      { name: "Harissa paste", ref: missRef },
      { name: "Mystery spice", ref: null },
    ]);
    const result = resolveEffectiveIngredients(NO_OVERRIDES, dish);
    assert.ok(result[0].nutritionRefPer100g);
    assert.equal("nutritionRefPer100g" in result[1], false);
    assert.equal("nutritionRefPer100g" in result[2], false);
    // Non-grounding fields are still mapped as before.
    assert.equal(result[0].name, "Yellow onion");
    assert.equal(result[0].quantity, 1);
    assert.equal(result[0].unit, "cup");
  });
});

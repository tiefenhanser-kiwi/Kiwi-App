// WS6 6b-3 — overrideResolver pure-function tests.
// No DB, no AI, no async. Documents the D-WS6-003 stub contract:
//   - resolveEffectiveIngredients = pass-through over dish.dishIngredients
//   - hasOverrides = true iff item carries either Json override field

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  hasOverrides,
  resolveEffectiveIngredients,
  type DishWithIngredients,
} from "../overrideResolver";

function makeDish(): DishWithIngredients {
  return {
    dishIngredients: [
      {
        id: "di-1",
        dishId: "dish-1",
        ingredientId: "ing-1",
        quantity: 1,
        unit: "lb",
        preparationNote: null,
        isOptional: false,
        positionIndex: 0,
        componentKey: null,
        pathKey: null,
        ingredient: {
          id: "ing-1",
          canonicalName: "ground beef",
          displayName: "Ground beef",
          category: "Protein",
          subcategory: null,
          defaultUnit: "lb",
          nutritionRefPerUnit: null,
          aliases: [],
          isOptionalDefault: false,
          purchaseUnit: null,
          purchaseQuantity: null,
          purchaseDisplay: null,
          conversionRef: null,
        },
      },
      {
        id: "di-2",
        dishId: "dish-1",
        ingredientId: "ing-2",
        quantity: 2,
        unit: "tbsp",
        preparationNote: null,
        isOptional: true,
        positionIndex: 1,
        componentKey: null,
        pathKey: null,
        ingredient: {
          id: "ing-2",
          canonicalName: "olive oil",
          displayName: "Olive oil",
          category: "Pantry",
          subcategory: null,
          defaultUnit: "tbsp",
          nutritionRefPerUnit: null,
          aliases: [],
          isOptionalDefault: false,
          purchaseUnit: null,
          purchaseQuantity: null,
          purchaseDisplay: null,
          conversionRef: null,
        },
      },
    ],
  };
}

describe("resolveEffectiveIngredients", () => {
  it("passes dish.dishIngredients through using ingredient.displayName", () => {
    const dish = makeDish();
    const item = {
      ingredientOverrides: null,
      recipeOverrideJson: null,
    };
    const result = resolveEffectiveIngredients(item, dish);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], {
      name: "Ground beef",
      quantity: 1,
      unit: "lb",
      isOptional: false,
      // WS7-8b B2 — identity threaded for the quantity→grams table lookup.
      ingredientId: "ing-1",
      canonicalName: "ground beef",
      conversionRef: null,
    });
    assert.deepEqual(result[1], {
      name: "Olive oil",
      quantity: 2,
      unit: "tbsp",
      isOptional: true,
      ingredientId: "ing-2",
      canonicalName: "olive oil",
      conversionRef: null,
    });
  });

  it("ignores override fields on the item (D-WS6-003 pass-through)", () => {
    const dish = makeDish();
    const item = {
      ingredientOverrides: [{ replaced: true }] as unknown as object,
      recipeOverrideJson: { dishes: [] } as unknown as object,
    };
    const result = resolveEffectiveIngredients(
      item as Parameters<typeof resolveEffectiveIngredients>[0],
      dish,
    );
    // Pass-through: the override is intentionally ignored at the MVP stub.
    // WS7 will replace this with a real merger.
    assert.equal(result.length, 2);
    assert.equal(result[0].name, "Ground beef");
  });
});

describe("hasOverrides", () => {
  it("returns false when both override fields are null", () => {
    assert.equal(
      hasOverrides({
        ingredientOverrides: null,
        recipeOverrideJson: null,
      }),
      false,
    );
  });

  it("returns true when ingredientOverrides is set", () => {
    assert.equal(
      hasOverrides({
        ingredientOverrides: [{ id: "x" }] as unknown as object,
        recipeOverrideJson: null,
      }),
      true,
    );
  });

  it("returns true when recipeOverrideJson is set", () => {
    assert.equal(
      hasOverrides({
        ingredientOverrides: null,
        recipeOverrideJson: { dishes: [] } as unknown as object,
      }),
      true,
    );
  });

  it("returns true when both fields are set", () => {
    assert.equal(
      hasOverrides({
        ingredientOverrides: [] as unknown as object,
        recipeOverrideJson: {} as unknown as object,
      }),
      true,
    );
  });
});

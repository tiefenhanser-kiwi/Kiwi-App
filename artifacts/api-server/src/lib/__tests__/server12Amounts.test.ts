// SERVER-12 C (BUG-623) — small scaled amounts keep their spoons. Classic Crispy Sesame
// Chicken at 3 of 4: the ¼ cup flour row is 3 tbsp, and the prep text said "¼ cup" (the
// cup ladder's tie, ⅛ vs ¼, goes up). Below ¼ cup a scaled amount is said in tablespoons,
// below a tablespoon in teaspoons; the cup ladder starts at ¼ cup; an amount at its own
// servings is printed as written.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { spoonedCup, withCupLadder } from "../prepQuantity";
import { buildPrepWeekPlan } from "../prepWeekBuild";
import { componentTotals, formatMeasure } from "../prepWeekAssembly";

describe("SERVER-12 C — a scaled amount under ¼ cup is said in spoons", () => {
  it("Sesame Chicken's flour at 3 of 4: ¼ cup × ¾ is 3 tbsp, not ¼ cup", () => {
    assert.equal(formatMeasure(0.25 * 0.75, "cup", "all-purpose flour"), "3 tbsp");
  });

  it("the household-2 half of ¼ cup is 2 tbsp; 1 tbsp and 1½ tsp below it", () => {
    assert.equal(formatMeasure(0.125, "cups", "soy sauce"), "2 tbsp");
    assert.equal(formatMeasure(1 / 16, "cup", "soy sauce"), "1 tbsp");
    assert.equal(formatMeasure(1 / 32, "cup", "soy sauce"), "1½ tsp");
  });

  it("the cup ladder starts at ¼ cup, and is unchanged above it", () => {
    assert.equal(formatMeasure(0.25, "cup", "all-purpose flour"), "¼ cup");
    assert.equal(formatMeasure(0.5 * 0.75, "cup", "cornstarch"), "⅓ cup");
    assert.equal(formatMeasure(1.5, "cup", "all-purpose flour"), "1½ cup");
  });

  it("an amount at its own servings is printed as written: ⅛ cup stays", () => {
    assert.equal(formatMeasure(0.125, "cup", "soy sauce", { asWritten: true }), "⅛ cup");
    assert.equal(spoonedCup(0.125, "cup", { asWritten: true }), null);
  });

  it("spoons were never cups: a scaled 3 tbsp stays 3 tbsp", () => {
    assert.equal(formatMeasure(4 * 0.75, "tablespoon", "all-purpose flour"), "3 tbsp");
    assert.equal(spoonedCup(3, "tbsp"), null);
  });

  it("a step's total follows its lines: scaled shares sum in spoons, written ones keep their cup", () => {
    const scaled = componentTotals([{ ingredientName: "soy sauce", preparationNote: null, measures: [
      { amount: "2 tbsp", forDish: "A", dishRole: "main", qty: 0.125, unit: "cup" },
      { amount: "1 tbsp", forDish: "B", dishRole: "main", qty: 1, unit: "tablespoon" },
    ] }] as never);
    assert.deepEqual(scaled.get("soy sauce"), ["3 tbsp"]);
    const written = componentTotals([{ ingredientName: "soy sauce", preparationNote: null, measures: [
      { amount: "⅛ cup", forDish: "A", dishRole: "main", qty: 0.125, unit: "cup", asWritten: true },
    ] }] as never);
    assert.deepEqual(written.get("soy sauce"), ["⅛ cup"]);
  });
});

describe("SERVER-12 C — Thanksgiving is frozen: the feast keeps the cup ladder", () => {
  const M = "11111111-1111-4111-8111-111111111111";
  const D = "d1111111-1111-4111-8111-111111111111";
  const ing = (ingredientId: string, ingredientName: string, quantity: number, unit: string) => ({ ingredientId, ingredientName, category: "Pantry", quantity, unit, preparationNote: null, sourceYield: null });
  const load = {
    input: {
      planId: "p", planName: "C",
      meals: [{
        mealId: M, mealName: "Crispy Sesame Chicken", cuisine: null, servingsOverride: 3,
        dishes: [{
          dishId: D, dishName: "Crispy Sesame Chicken", dishRole: "main", baseServings: 4, authoredBaseServings: 4,
          ingredients: [ing("a0000000-0000-4000-8000-000000000001", "all-purpose flour", 0.25, "cup"), ing("a0000000-0000-4000-8000-000000000002", "cornstarch", 0.5, "cup"), ing("a0000000-0000-4000-8000-000000000003", "garlic powder", 1, "teaspoon"), ing("a0000000-0000-4000-8000-000000000004", "kosher salt", 1, "teaspoon")],
          stepTexts: [], componentSteps: [{ stepIndex: 0, phaseType: "prep", componentKey: "dredge", text: "In a shallow dish, whisk together ¼ cup all-purpose flour, ½ cup cornstarch, 1 teaspoon garlic powder and 1 teaspoon kosher salt.", ingredientIds: ["a0000000-0000-4000-8000-000000000001", "a0000000-0000-4000-8000-000000000002", "a0000000-0000-4000-8000-000000000003", "a0000000-0000-4000-8000-000000000004"] }],
        }],
      }],
    },
    planRevisionId: 1,
    cookDays: { prepDay: null, lagByMealId: new Map(), dayNameByMealId: new Map() },
    identity: { foldedIdByIngredientId: new Map() },
  };
  const flour = (b: ReturnType<typeof buildPrepWeekPlan>) => b.stepPlan.steps.flatMap((s) => s.components).filter((c) => c.ingredientName === "all-purpose flour").flatMap((c) => c.measures.map((m) => m.amount));

  it("the week's dredge says 3 tbsp; the feast session's still says ¼ cup", () => {
    assert.deepEqual(flour(buildPrepWeekPlan(load as never)), ["3 tbsp"]);
    assert.deepEqual(flour(buildPrepWeekPlan(load as never, { feast: true })), ["¼ cup"]);
  });

  it("withCupLadder holds only while it runs", () => {
    assert.equal(withCupLadder(() => formatMeasure(0.1875, "cup", "all-purpose flour")), "¼ cup");
    assert.equal(formatMeasure(0.1875, "cup", "all-purpose flour"), "3 tbsp");
  });
});

describe("SERVER-12 C — just under ¼ cup is ¼ cup", () => {
  it("an amount the spoons would say as 4 tbsp stays ¼ cup; 3¾ tbsp is said", () => {
    assert.equal(formatMeasure(0.245, "cup", "all-purpose flour"), "¼ cup");
    assert.equal(formatMeasure(0.234, "cup", "all-purpose flour"), "3¾ tbsp");
  });
});

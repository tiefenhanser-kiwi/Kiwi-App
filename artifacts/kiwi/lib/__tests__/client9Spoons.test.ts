// CLIENT-9 A (BUG-632) — Cook Mode and Meal Detail say a small scaled amount in
// spoons, as SERVER-12 C (f6d5102a, BUG-623) made the prep text say it. Classic
// Crispy Sesame Chicken at 3 of 4: the ¼ cup flour row is 3 tbsp, and Cook Mode
// said "¼ cup" (the cup ladder's tie, ⅛ vs ¼, goes up). The cases are the
// server's (api-server src/lib/__tests__/server12Amounts.test.ts), read through
// the client's own paths: a step's amount (buildAmountRefSegments, Cook Mode and
// Meal Detail), an ingredient line, and the Ingredients sheet. A feast keeps the
// cup ladder, as the server's withCupLadder does (D-WS9-371).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildAmountRefSegments } from "../cooking/amountSegments";
import { formatIngredientLine } from "../format/ingredientLine";
import { isFeastMeal, mealScaleFactors, spokenMeasure } from "../format/quantity";
import { consolidateMealIngredients } from "../meals/consolidateMealIngredients";
import { FEAST_MEAL_TAG } from "../cooking/hubModel";

// Sesame Chicken's dredge step as the server's test states it.
const DREDGE =
  "In a shallow dish, whisk together ¼ cup all-purpose flour, ½ cup cornstarch, 1 teaspoon garlic powder and 1 teaspoon kosher salt.";
const span = (text: string, s: string, quantity: number, unit: string) => {
  const charStart = text.indexOf(s);
  return { ingredientId: "i", quantity, unit, charStart, charEnd: charStart + s.length };
};
const DREDGE_REFS = [
  span(DREDGE, "¼ cup", 0.25, "cup"),
  span(DREDGE, "½ cup", 0.5, "cup"),
  span(DREDGE, "1 teaspoon", 1, "teaspoon"),
];

const DISH = {
  dishId: "sesame",
  title: "Classic Crispy Sesame Chicken",
  ingredients: [
    { name: "all-purpose flour", quantity: 0.25, unit: "cup" },
    { name: "cornstarch", quantity: 0.5, unit: "cup" },
    { name: "garlic powder", quantity: 1, unit: "teaspoon" },
  ],
  steps: [],
};

/** The step's amounts on the screen's path: the meal's factors and its BirdLine. */
function stepAmounts(servings: number, tags: string[] = []): string[] {
  const scale = mealScaleFactors([DISH], servings / 4, isFeastMeal(tags));
  return buildAmountRefSegments(DREDGE, DREDGE_REFS, scale.byDish[DISH.dishId], scale.birds[DISH.dishId])
    .filter((s) => s.isRef)
    .map((s) => s.text);
}

/** One ingredient line, meal detail's path. */
function line(name: string, servings: number, tags: string[] = []): string {
  const scale = mealScaleFactors([DISH], servings / 4, isFeastMeal(tags));
  const ing = DISH.ingredients.find((i) => i.name === name)!;
  return formatIngredientLine(ing, { multiplier: scale.byDish[DISH.dishId], birds: scale.birds[DISH.dishId] });
}

const one = (qty: number, unit: string, name: string, multiplier: number) =>
  formatIngredientLine({ name, quantity: qty, unit }, { multiplier });

describe("CLIENT-9 A — a scaled amount under ¼ cup is said in spoons", () => {
  it("Sesame Chicken at 3 of 4: Cook Mode's step says 3 tbsp flour, and the line agrees", () => {
    assert.deepEqual(stepAmounts(3), ["3 tbsp", "⅓ cup", "¾ teaspoon"]);
    assert.equal(line("all-purpose flour", 3), "3 tbsp all-purpose flour");
  });

  it("the household-2 half of ¼ cup is 2 tbsp; 1 tbsp and 1½ tsp below it", () => {
    assert.equal(one(0.25, "cups", "soy sauce", 0.5), "2 tbsp soy sauce");
    assert.equal(one(0.25, "cup", "soy sauce", 0.25), "1 tbsp soy sauce");
    assert.equal(one(0.25, "cup", "soy sauce", 0.125), "1½ tsp soy sauce");
  });

  it("the cup ladder starts at ¼ cup, and is unchanged above it", () => {
    assert.equal(one(0.25, "cup", "all-purpose flour", 1.0001), "¼ cup all-purpose flour");
    assert.equal(one(0.5, "cup", "cornstarch", 0.75), "⅓ cup cornstarch");
    assert.equal(one(1, "cup", "all-purpose flour", 1.5), "1½ cups all-purpose flour");
  });

  it("an amount at its own servings is printed as written: ⅛ cup stays", () => {
    assert.equal(one(0.125, "cup", "soy sauce", 1), "⅛ cup soy sauce");
    assert.deepEqual(stepAmounts(4), ["¼ cup", "½ cup", "1 teaspoon"]);
    assert.equal(spokenMeasure(0.125, "cup", { scaled: false }), null);
  });

  it("spoons were never cups: a scaled 3 tbsp stays 3 tbsp", () => {
    assert.equal(one(4, "tablespoon", "all-purpose flour", 0.75), "3 tablespoons all-purpose flour");
    assert.equal(spokenMeasure(3, "tbsp"), null);
  });

  it("just under ¼ cup: one the spoons would say as 4 tbsp is ¼ cup; 3¾ tbsp is said", () => {
    assert.equal(one(0.245, "cup", "all-purpose flour", 1.0001), "¼ cup all-purpose flour");
    assert.equal(one(0.234, "cup", "all-purpose flour", 1.0001), "3¾ tbsp all-purpose flour");
  });

  it("the Ingredients sheet sums the scaled shares, then says them in spoons", () => {
    const meal = { tags: [], dishes: [DISH] };
    const lines = consolidateMealIngredients(meal as never, 0.75, 3).map((c) => c.line);
    assert.ok(lines.includes("3 tbsp all-purpose flour"), lines.join(" | "));
    const asWritten = consolidateMealIngredients(meal as never, 1, 4).map((c) => c.line);
    assert.ok(asWritten.includes("¼ cup all-purpose flour"), asWritten.join(" | "));
  });
});

describe("CLIENT-9 A — Thanksgiving is frozen: a feast keeps the cup ladder (D-WS9-371)", () => {
  const FEAST = [FEAST_MEAL_TAG];

  it("the step, the line and the sheet still say ¼ cup at 3 of 4", () => {
    assert.deepEqual(stepAmounts(3, FEAST), ["¼ cup", "⅓ cup", "¾ teaspoon"]);
    assert.equal(line("all-purpose flour", 3, FEAST), "¼ cup all-purpose flour");
    const lines = consolidateMealIngredients({ tags: FEAST, dishes: [DISH] } as never, 0.75, 3).map((c) => c.line);
    assert.ok(lines.includes("¼ cup all-purpose flour"), lines.join(" | "));
  });

  it("every BirdLine of a feast carries it, and only a feast's", () => {
    const feast = mealScaleFactors([DISH, { ...DISH, dishId: "b" }], 0.75, true);
    assert.equal(feast.birds[DISH.dishId].feast, true);
    assert.equal(feast.mealOwnedBirds.feast, true);
    const week = mealScaleFactors([DISH, { ...DISH, dishId: "b" }], 0.75, false);
    assert.equal("feast" in week.birds[DISH.dishId], false);
    assert.equal("feast" in week.mealOwnedBirds, false);
    assert.equal(spokenMeasure(0.1875, "cup", { cupLadder: true }), null);
  });
});

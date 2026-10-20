// WEB-4b (BUG-454) — one bird rule on both sides.
//
// A whole bird by weight floors at the smallest one sold (WEB-4, BUG-453), and
// every other line of ITS dish scales by the bird's factor — the floored weight
// ÷ the recipe's bird weight — not by servings: the brine, the butter, the herbs
// and the aromatics are for the bird. The bird's own parts (neck, giblets) are
// always as written: one bird, one neck.
//
// 🔴 THE PINNED TABLE. THX-3b pins the same inputs on the server (prep text);
// chat-Claude compares the two outputs. Inputs: Classic's "Herb-Roasted Whole
// Turkey" (14 lb, written for 10) and its "Pan Gravy" (the neck and giblets), as
// stored on dev (api-server scripts/_scratch/thx-3/recipes.out.txt). Every
// expected value is a LITERAL written from the rule, not read back from the code.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatIngredientLine } from "../format/ingredientLine";
import { dishScaleFactor, isBirdPart, mealScaleFactors } from "../format/quantity";
import { buildAmountRefSegments } from "../cooking/amountSegments";
import { consolidateMealIngredients } from "../meals/consolidateMealIngredients";

const ing = (quantity: number, unit: string, name: string) => ({ name, quantity, unit });

// Classic's turkey dish, every ingredient, in stored order.
const TURKEY = {
  dishId: "b2889ed4",
  title: "Herb-Roasted Whole Turkey",
  ingredients: [
    ing(14, "pound", "whole turkey"),
    ing(0.5, "cup", "kosher salt"),
    ing(1, "gallon", "cold water"),
    ing(0.25, "cup", "light brown sugar"),
    ing(1, "tablespoon", "black peppercorns"),
    ing(6, "sprig", "fresh thyme"),
    ing(4, "sprig", "fresh rosemary"),
    ing(3, "each", "bay leaves"),
    ing(6, "clove", "garlic"),
    ing(6, "tablespoon", "unsalted butter"),
    ing(4, "sprig", "fresh sage"),
    ing(1, "each", "lemon"),
    ing(1, "teaspoon", "black pepper"),
    ing(1, "each", "yellow onion"),
    ing(2, "stalk", "celery"),
    ing(2, "tablespoon", "olive oil"),
    ing(1, "each", "large brining bag"),
  ],
};
// Classic's Pan Gravy: the bird's parts, and a dish with no bird of its own.
const GRAVY = {
  dishId: "f90c8155",
  title: "Pan Gravy",
  ingredients: [
    ing(1, "each", "turkey neck"),
    ing(1, "set", "turkey giblets"),
    ing(0.5, "cup", "all-purpose flour"),
    ing(6, "cup", "cold water"),
  ],
};
const CLASSIC = { dishes: [TURKEY, GRAVY] };
const WRITTEN_FOR = 10;

/** One line on meal detail at `servings`: the screen's own path. */
function mealDetailLine(servings: number, dish: typeof TURKEY, name: string): string {
  const scale = mealScaleFactors(CLASSIC.dishes, servings / WRITTEN_FOR);
  const i = dish.ingredients.find((x) => x.name === name)!;
  return formatIngredientLine(i, { multiplier: scale.byDish[dish.dishId] });
}

// The brine step as stored: "½ cup" salt, "¼ cup" sugar, a unitless "1" gallon.
const BRINE =
  "Make ahead (Wednesday night): Dissolve ½ cup kosher salt and ¼ cup light brown sugar in 1 gallon cold water in a large brining bag set in a roasting pan or cooler.";
const span = (text: string, s: string, quantity: number, unit: string) => {
  const charStart = text.indexOf(s);
  return { ingredientId: "i", quantity, unit, charStart, charEnd: charStart + s.length };
};
const BRINE_REFS = [span(BRINE, "½ cup", 0.5, "cup"), span(BRINE, "¼ cup", 0.25, "cup"), span(BRINE, "1", 1, "")];
const stepRefs = (text: string, refs: ReturnType<typeof span>[], m: number) =>
  buildAmountRefSegments(text, refs, m).filter((x) => x.isRef).map((x) => x.text);

describe("BUG-454 — THE PINNED TABLE: Classic's turkey (14 lb, for 10) at 1 · 4 · 8 · 10 · 20 · 30", () => {
  const TABLE: [servings: number, bird: string, salt: string, water: string, neck: string][] = [
    [1, "10 pounds whole turkey", "⅓ cup kosher salt", "¾ gallon cold water", "1 turkey neck"],
    [4, "10 pounds whole turkey", "⅓ cup kosher salt", "¾ gallon cold water", "1 turkey neck"],
    [8, "11¼ pounds whole turkey", "⅓ cup kosher salt", "¾ gallon cold water", "1 turkey neck"],
    [10, "14 pounds whole turkey", "½ cup kosher salt", "1 gallon cold water", "1 turkey neck"],
    [20, "28 pounds whole turkey", "1 cup kosher salt", "2 gallons cold water", "1 turkey neck"],
    [30, "42 pounds whole turkey", "1½ cups kosher salt", "3 gallons cold water", "1 turkey neck"],
  ];

  it("the bird's weight, the brine's salt and water, and the neck — meal detail", () => {
    for (const [n, bird, salt, water, neck] of TABLE) {
      assert.equal(mealDetailLine(n, TURKEY, "whole turkey"), bird, `${n}: bird`);
      assert.equal(mealDetailLine(n, TURKEY, "kosher salt"), salt, `${n}: salt`);
      assert.equal(mealDetailLine(n, TURKEY, "cold water"), water, `${n}: water`);
      assert.equal(mealDetailLine(n, GRAVY, "turkey neck"), neck, `${n}: neck`);
    }
  });

  it("the bird's factor: floored weight ÷ 14, and the servings multiplier wherever the floor does not bind", () => {
    const f = (n: number) => dishScaleFactor(TURKEY.ingredients, n / WRITTEN_FOR);
    assert.equal(f(1), 10 / 14);
    assert.equal(f(4), 10 / 14);
    assert.equal(f(8), 0.8);
    assert.equal(f(10), 1);
    assert.equal(f(20), 2);
    assert.equal(f(30), 3);
  });

  it("the Ingredients sheet prints the same lines", () => {
    for (const [n, bird, salt, , neck] of TABLE) {
      const lines = consolidateMealIngredients(CLASSIC as never, n / WRITTEN_FOR, n).map((c) => c.line);
      assert.ok(lines.includes(bird), `${n}: ${lines.join(" | ")}`);
      assert.ok(lines.includes(salt), `${n}: ${lines.join(" | ")}`);
      assert.ok(lines.includes(neck), `${n}: ${lines.join(" | ")}`);
    }
  });

  it("the brine step (meal detail and Cook Mode take the dish's factor) agrees with the lines", () => {
    const at = (n: number) => stepRefs(BRINE, BRINE_REFS, mealScaleFactors(CLASSIC.dishes, n / WRITTEN_FOR).byDish[TURKEY.dishId]);
    assert.deepEqual(at(1), ["⅓ cup", "⅛ cup", "¾"]);
    assert.deepEqual(at(4), ["⅓ cup", "⅛ cup", "¾"]);
    assert.deepEqual(at(8), ["⅓ cup", "¼ cup", "¾"]);
    assert.deepEqual(at(10), ["½ cup", "¼ cup", "1"]);
    assert.deepEqual(at(20), ["1 cup", "½ cup", "2"]);
    assert.deepEqual(at(30), ["1½ cups", "¾ cup", "3"]);
  });
});

describe("BUG-454 — the rest of the rule", () => {
  it("the floor reads as min(floor, recipe weight): an 8 lb turkey stays 8 lb, and so does its brine", () => {
    const small = [ing(8, "pound", "whole turkey"), ing(0.5, "cup", "kosher salt")];
    assert.equal(dishScaleFactor(small, 0.4), 1);
    assert.equal(formatIngredientLine(small[0], { multiplier: dishScaleFactor(small, 0.4) }), "8 pounds whole turkey");
    assert.equal(formatIngredientLine(small[1], { multiplier: dishScaleFactor(small, 0.4) }), "½ cup kosher salt");
  });

  it("scaling up stays linear, with no cap", () => {
    for (const m of [1, 1.3, 2, 3, 5]) assert.equal(dishScaleFactor(TURKEY.ingredients, m), m);
    assert.equal(mealDetailLine(50, TURKEY, "whole turkey"), "70 pounds whole turkey");
  });

  it("the bird's parts are always 1 — on the line and in a step", () => {
    for (const m of [0.1, 0.4, 2, 3]) {
      assert.equal(formatIngredientLine(GRAVY.ingredients[0], { multiplier: m }), "1 turkey neck");
      assert.equal(formatIngredientLine(GRAVY.ingredients[1], { multiplier: m }), "1 set turkey giblets");
    }
    const text = "Simmer 1 turkey neck with the onion.";
    assert.deepEqual(stepRefs(text, [span(text, "1", 1, "")], 3), ["1"]);
    assert.ok(isBirdPart("chicken necks") && isBirdPart("giblets"));
    assert.ok(!isBirdPart("littleneck clams"), "a clam is not a bird part");
  });

  it("a dish with no bird by weight scales by servings — the gravy beside the turkey, a bird by count", () => {
    const scale = mealScaleFactors(CLASSIC.dishes, 0.4);
    assert.equal(scale.byDish[GRAVY.dishId], 0.4);
    assert.equal(mealDetailLine(4, GRAVY, "all-purpose flour"), "¼ cup all-purpose flour"); // 0.2 cup
    const byCount = [ing(1, "each", "whole turkey"), ing(0.5, "cup", "kosher salt")];
    assert.equal(dishScaleFactor(byCount, 0.4), 0.4);
  });

  it("steps that name no dish take the one dish's factor, or servings in a multi-dish meal", () => {
    assert.equal(mealScaleFactors([TURKEY], 0.4).mealOwned, 10 / 14);
    assert.equal(mealScaleFactors(CLASSIC.dishes, 0.4).mealOwned, 0.4);
  });
});

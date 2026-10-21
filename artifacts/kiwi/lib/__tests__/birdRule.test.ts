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
import { dishBirdLine, dishScaleFactor, isBirdPart, mealScaleFactors, type BirdLine } from "../format/quantity";
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

  it("a dish with no bird scales by servings — the gravy beside the turkey", () => {
    const scale = mealScaleFactors(CLASSIC.dishes, 0.4);
    assert.equal(scale.byDish[GRAVY.dishId], 0.4);
    assert.equal(mealDetailLine(4, GRAVY, "all-purpose flour"), "¼ cup all-purpose flour"); // 0.2 cup
    // WEB-4c (BUG-462) replaced WEB-4b's "a bird by count keeps servings": see below.
  });

  it("steps that name no dish take the one dish's factor, or servings in a multi-dish meal", () => {
    assert.equal(mealScaleFactors([TURKEY], 0.4).mealOwned, 10 / 14);
    assert.equal(mealScaleFactors(CLASSIC.dishes, 0.4).mealOwned, 0.4);
  });
});

// ── WEB-4c (BUG-462) — A BIRD WRITTEN BY COUNT ──────────────────────────────
//
// "1 whole turkey" shows max(1, nearest whole) birds, halves up. The rest of its
// dish scales by birds shown ÷ birds written; its parts and its equipment are
// one per bird; the bird's own size in a step ("a frozen 14-lb turkey") is per
// bird. Inputs: the dev catalog's "Buttermilk-Brined Roast Turkey" (b8fcb9f9,
// written for 10), the lines and steps the pins read. THX-3c pins the same
// inputs on the server. Every expected value is a LITERAL.
const BUTTERMILK = {
  dishId: "b8fcb9f9",
  title: "Buttermilk-Brined Roast Turkey",
  ingredients: [
    ing(1, "each", "whole turkey"),
    ing(2, "quart", "buttermilk"),
    ing(0.5, "cup", "Kosher salt"),
    ing(1, "each", "large brining bag"),
    ing(2, "stalk", "celery"),
  ],
};
const BM = { dishes: [BUTTERMILK] };
const bmLine = (servings: number, name: string) => {
  const scale = mealScaleFactors(BM.dishes, servings / WRITTEN_FOR);
  const i = BUTTERMILK.ingredients.find((x) => x.name === name)!;
  return formatIngredientLine(i, { multiplier: scale.byDish[BUTTERMILK.dishId], birds: scale.birds[BUTTERMILK.dishId] });
};
const BM_BRINE =
  "In a large pot, whisk together 2 quarts cold water, ½ cup kosher salt, and 2 tablespoons cracked black pepper until the salt dissolves.";
const BM_BRINE_REFS = [span(BM_BRINE, "2", 2, ""), span(BM_BRINE, "½ cup", 0.5, "cup")];
const BM_THAW =
  "Pour the brine over the turkey, seal the bag tightly, and refrigerate — brine 12 to 24 hours, turning the bag halfway through. A frozen 14-lb turkey thaws 3–4 days in the fridge, so plan accordingly.";
const BM_THAW_REFS = [span(BM_THAW, "14", 14, "")];
const stepRefsWith = (text: string, refs: ReturnType<typeof span>[], m: number, birds: BirdLine) =>
  buildAmountRefSegments(text, refs, m, birds).filter((x) => x.isRef).map((x) => x.text);

describe("BUG-462 — THE PINNED TABLE: Buttermilk-Brined Roast Turkey (1 bird, for 10) at 1 · 4 · 10 · 15 · 20", () => {
  const TABLE: [servings: number, bird: string, buttermilk: string, salt: string, bag: string, celery: string][] = [
    [1, "1 whole turkey", "2 quarts buttermilk", "½ cup Kosher salt", "1 large brining bag", "2 stalks celery"],
    [4, "1 whole turkey", "2 quarts buttermilk", "½ cup Kosher salt", "1 large brining bag", "2 stalks celery"],
    [10, "1 whole turkey", "2 quarts buttermilk", "½ cup Kosher salt", "1 large brining bag", "2 stalks celery"],
    [15, "2 whole turkeys", "4 quarts buttermilk", "1 cup Kosher salt", "2 large brining bags", "4 stalks celery"],
    [20, "2 whole turkeys", "4 quarts buttermilk", "1 cup Kosher salt", "2 large brining bags", "4 stalks celery"],
  ];

  it("the birds, the brine, the bag and the celery — meal detail", () => {
    for (const [n, bird, bm, salt, bag, celery] of TABLE) {
      assert.equal(bmLine(n, "whole turkey"), bird, `${n}: bird`);
      assert.equal(bmLine(n, "buttermilk"), bm, `${n}: buttermilk`);
      assert.equal(bmLine(n, "Kosher salt"), salt, `${n}: salt`);
      assert.equal(bmLine(n, "large brining bag"), bag, `${n}: bag`);
      assert.equal(bmLine(n, "celery"), celery, `${n}: celery`);
    }
  });

  it("the factor is birds shown ÷ birds written: 1 · 1 · 1 · 2 · 2", () => {
    const f = (n: number) => dishScaleFactor(BUTTERMILK.ingredients, n / WRITTEN_FOR);
    assert.deepEqual([1, 4, 10, 15, 20].map(f), [1, 1, 1, 2, 2]);
  });

  it("the Ingredients sheet prints the same lines", () => {
    for (const [n, bird, bm, , bag] of TABLE) {
      const lines = consolidateMealIngredients(BM as never, n / WRITTEN_FOR, n).map((c) => c.line);
      for (const want of [bird, bm, bag]) assert.ok(lines.includes(want), `${n}: ${want} — ${lines.join(" | ")}`);
    }
  });

  it("the brine step follows the birds; the thaw step's 14-lb turkey is per bird", () => {
    const scale = (n: number) => mealScaleFactors(BM.dishes, n / WRITTEN_FOR);
    const at = (text: string, refs: ReturnType<typeof span>[], n: number) =>
      stepRefsWith(text, refs, scale(n).byDish[BUTTERMILK.dishId], scale(n).birds[BUTTERMILK.dishId]);
    assert.deepEqual(at(BM_BRINE, BM_BRINE_REFS, 4), ["2", "½ cup"]); // was ["¾", "⅛ cup"]
    assert.deepEqual(at(BM_BRINE, BM_BRINE_REFS, 15), ["4", "1 cup"]); // was ["3", "¾ cup"]
    for (const n of [1, 4, 10, 15, 20]) assert.deepEqual(at(BM_THAW, BM_THAW_REFS, n), ["14"], `${n}: thaw`); // was 10 at 4, 21 at 15
  });
});

describe("BUG-462 — the rest of the rule", () => {
  it("nearest, halves up, never below 1: a chicken for 4 at 5 is one chicken, at 6 two", () => {
    const spatchcock = [ing(1, "each", "whole chicken"), ing(2, "tablespoon", "olive oil")];
    const line = (m: number, i: number) =>
      formatIngredientLine(spatchcock[i], { multiplier: dishScaleFactor(spatchcock, m), birds: dishBirdLine(spatchcock, m) });
    assert.equal(line(1.25, 0), "1 whole chicken"); // was 2 (ceil) with 2½ tablespoons oil
    assert.equal(line(1.25, 1), "2 tablespoons olive oil");
    assert.equal(line(1.5, 0), "2 whole chickens");
    assert.equal(line(1.5, 1), "4 tablespoons olive oil");
    assert.equal(line(0.25, 0), "1 whole chicken");
  });

  it("the parts are one per bird of the meal's bird, even in another dish", () => {
    const roast = { dishId: "r", title: "Roast", ingredients: [ing(1, "each", "whole chicken"), ing(1, "tablespoon", "butter")] };
    const gravy = { dishId: "g", title: "Gravy", ingredients: [ing(1, "each", "chicken neck"), ing(2, "cup", "chicken stock")] };
    const at = (m: number, name: string) => {
      const scale = mealScaleFactors([roast, gravy], m);
      const i = gravy.ingredients.find((x) => x.name === name)!;
      return formatIngredientLine(i, { multiplier: scale.byDish.g, birds: scale.birds.g });
    };
    assert.equal(at(0.5, "chicken neck"), "1 chicken neck");
    assert.equal(at(2, "chicken neck"), "2 chicken necks");
    assert.equal(at(2, "chicken stock"), "4 cups chicken stock"); // the gravy itself is by servings
    const sheet = consolidateMealIngredients({ dishes: [roast, gravy] } as never, 2, 8).map((c) => c.line);
    assert.ok(sheet.includes("2 chicken necks"), sheet.join(" | "));
    // A bird by weight is one bird at any size: Classic's neck stays 1 at 30.
    assert.equal(mealScaleFactors(CLASSIC.dishes, 3).birds[GRAVY.dishId].parts, 1);
  });

  it("a rotisserie chicken is cooked meat, not the dish's bird: the wraps keep servings", () => {
    const wraps = [ing(1, "each", "rotisserie chicken"), ing(8, "each", "flour tortillas")];
    assert.equal(dishScaleFactor(wraps, 0.5), 0.5);
    assert.equal(formatIngredientLine(wraps[0], { multiplier: 1.25 }), "2 rotisserie chickens"); // rule 1's ceiling
    assert.equal(formatIngredientLine(wraps[1], { multiplier: 0.5 }), "4 flour tortillas");
  });

  it("a bird written as a fraction keeps servings: ½ chicken never doubles its dish", () => {
    const half = [ing(0.5, "each", "whole chicken"), ing(1, "cup", "rice")];
    assert.equal(dishScaleFactor(half, 1), 1);
    assert.equal(formatIngredientLine(half[0], { multiplier: 1 }), "1 whole chicken");
  });

  it("a bird by weight decides first in a dish holding both", () => {
    const both = [ing(14, "pound", "whole turkey"), ing(1, "each", "whole chicken")];
    assert.equal(dishScaleFactor(both, 0.4), 10 / 14);
  });
});

// THX-4 (D-WS9-324) — the turkey's weight, chosen by the cook, on the client.
//
// 🔴 THE PINNED TABLE. api-server lib/__tests__/thx4BirdWeight.test.ts pins the
// same inputs on the server (prepQuantity dishRowMultipliers with `birdLb`, the
// rule grocery and Prep the feast read). The rows below are its rows, printed by
// this client's meal screen path; the server's strings are in each row's comment
// where the two formatters word them differently ("lb" / "pounds"). Every
// expected value is a LITERAL written from the rule, not read back from the code.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { formatIngredientLine } from "../format/ingredientLine";
import { chosenBird, chosenBirdName, defaultBirdLb, mealScaleFactors, weighedTurkeyOf } from "../format/quantity";
import { buildAmountRefSegments } from "../cooking/amountSegments";
import { consolidateMealIngredients } from "../meals/consolidateMealIngredients";
import { planDishView } from "../dishes/planDish";
import type { MealDetail } from "../api/meals";

type Row = { name: string; quantity: number; unit: string; preparationNote?: string | null };
const ing = (quantity: number, unit: string, name: string, preparationNote: string | null = null): Row => ({
  name,
  quantity,
  unit,
  preparationNote,
});

// The server table's rows: Classic's "Herb-Roasted Whole Turkey" (10 servings).
const TURKEY = {
  dishId: "turkey",
  ingredients: [
    ing(14, "pound", "whole turkey"),
    ing(0.5, "cup", "kosher salt"),
    ing(1, "gallon", "cold water"),
    ing(1, "each", "large brining bag"),
    ing(1, "each", "turkey neck"),
  ],
};
// The Buttermilk-Brined alternate: one bird by count, its weight in the NOTE.
const BUTTERMILK = {
  dishId: "buttermilk",
  ingredients: [
    ing(1, "each", "whole turkey", "12–14 lb, neck and giblets removed and reserved"),
    ing(2, "quart", "buttermilk"),
    ing(0.5, "cup", "Kosher salt"),
    ing(1, "each", "large brining bag"),
    ing(1, "each", "turkey neck"),
  ],
};
// Classic's Pan Gravy: the bird's parts, in a dish with no bird of its own.
const GRAVY = {
  dishId: "gravy",
  ingredients: [ing(1, "each", "turkey neck"), ing(1, "set", "turkey giblets"), ing(6, "cup", "cold water")],
};
// New Twist's spatchcock bird: by count, the weight in its NAME.
const NEW_TWIST = { dishId: "nt", ingredients: [ing(1, "each", "whole turkey (12–14 lb)"), ing(6, "tablespoon", "unsalted butter")] };

const WRITTEN_FOR = 10;

/** Every line of one dish on the meal screen, at `servings`, with `lb` chosen. */
function lines(dish: typeof TURKEY, servings: number, lb: number | null, dishes = [dish]): string[] {
  const scale = mealScaleFactors(dishes, servings / WRITTEN_FOR, true, lb);
  return dish.ingredients.map((i) =>
    formatIngredientLine(i, { multiplier: scale.byDish[dish.dishId], birds: scale.birds[dish.dishId] }),
  );
}

describe("THX-4 — THE PINNED TABLE: Classic's turkey at a chosen 8 · 10 · 12 · 14 · 16 · 20 lb", () => {
  // chosen lb → bird · salt · water · bag · neck, at servings 4, 10 and 20 alike
  const TABLE: Array<[number, string[]]> = [
    // server: 8 lb · ¼ cup · ⅝ gallon · 1 · 1
    [8, ["8 pounds whole turkey", "¼ cup kosher salt", "⅝ gallon cold water", "1 large brining bag", "1 turkey neck"]],
    // server: 10 lb · ⅓ cup · ¾ gallon · 1 · 1
    [10, ["10 pounds whole turkey", "⅓ cup kosher salt", "¾ gallon cold water", "1 large brining bag", "1 turkey neck"]],
    // server: 12 lb · ½ cup · ⅞ gallon · 1 · 1
    [12, ["12 pounds whole turkey", "½ cup kosher salt", "⅞ gallon cold water", "1 large brining bag", "1 turkey neck"]],
    // server: 14 lb · ½ cup · 1 gallon · 1 · 1
    [14, ["14 pounds whole turkey", "½ cup kosher salt", "1 gallon cold water", "1 large brining bag", "1 turkey neck"]],
    // server: 16 lb · ½ cup · 1⅛ gallon · 1 · 1
    [16, ["16 pounds whole turkey", "½ cup kosher salt", "1⅛ gallons cold water", "1 large brining bag", "1 turkey neck"]],
    // server: 20 lb · ¾ cup · 1⅜ gallon · 1 · 1
    [20, ["20 pounds whole turkey", "¾ cup kosher salt", "1⅜ gallons cold water", "1 large brining bag", "1 turkey neck"]],
  ];
  for (const [lb, want] of TABLE) {
    it(`${lb} lb → ${want.join(" · ")}`, () => {
      for (const servings of [4, 10, 20]) assert.deepEqual(lines(TURKEY, servings, lb), want, `${servings} servings`);
    });
  }

  it("no floor under a chosen weight: 8 lb is 8 lb (the servings rule floors a turkey at 10)", () => {
    assert.equal(lines(TURKEY, 4, null)[0], "10 pounds whole turkey");
    assert.equal(lines(TURKEY, 4, 8)[0], "8 pounds whole turkey");
  });

  it("the factor is chosen ÷ the recipe's weight, whatever the servings", () => {
    for (const servings of [1, 4, 10, 30]) {
      assert.equal(mealScaleFactors([TURKEY], servings / WRITTEN_FOR, true, 8).byDish.turkey, 8 / 14);
      assert.equal(mealScaleFactors([TURKEY], servings / WRITTEN_FOR, true, 20).byDish.turkey, 20 / 14);
    }
  });

  it("nothing changes with no weight chosen (null, undefined), byte for byte", () => {
    for (const servings of [1, 4, 8, 10, 20, 30]) {
      const m = servings / WRITTEN_FOR;
      const base = mealScaleFactors([TURKEY, GRAVY], m, true);
      assert.deepEqual(mealScaleFactors([TURKEY, GRAVY], m, true, null), base);
      assert.deepEqual(mealScaleFactors([TURKEY, GRAVY], m, true, undefined), base);
    }
  });
});

describe("THX-4 — a turkey written by count stays ONE bird", () => {
  // chosen lb → birds · buttermilk · salt · bag · neck (server: 1 · 1⅜ quart · ⅓ cup · 1 · 1 …)
  const WANT: Array<[number, string[]]> = [
    [10, ["1 whole turkey", "1⅜ quarts buttermilk", "⅓ cup Kosher salt", "1 large brining bag", "1 turkey neck"]],
    [14, ["1 whole turkey", "2 quarts buttermilk", "½ cup Kosher salt", "1 large brining bag", "1 turkey neck"]],
    [20, ["1 whole turkey", "2⅞ quarts buttermilk", "¾ cup Kosher salt", "1 large brining bag", "1 turkey neck"]],
  ];
  for (const [lb, want] of WANT) {
    it(`${lb} lb → ${want.join(" · ")}`, () => {
      for (const servings of [4, 10, 20]) assert.deepEqual(lines(BUTTERMILK, servings, lb), want, `${servings} servings`);
    });
  }

  it("at 20 servings the servings rule says two birds; a chosen weight says one", () => {
    assert.equal(lines(BUTTERMILK, 20, null)[0], "2 whole turkeys");
    assert.equal(lines(BUTTERMILK, 20, 16)[0], "1 whole turkey");
  });

  it("one bird even where chosen ÷ the recipe's weight passes 1½ (an 8–10 lb bird at 20 lb)", () => {
    const small = { dishId: "s", ingredients: [ing(1, "each", "whole turkey (8–10 lb)"), ing(1, "cup", "kosher salt")] };
    const scale = mealScaleFactors([small], 1, true, 20);
    assert.equal(scale.byDish.s, 2);
    const at = (i: number) => formatIngredientLine(small.ingredients[i], { multiplier: scale.byDish.s, birds: scale.birds.s });
    assert.equal(at(0), "1 whole turkey (8–10 lb)");
    assert.equal(at(1), "2 cups kosher salt");
  });

  it("the weight in the name counts too (New Twist): one bird, its butter at chosen ÷ 14", () => {
    const scale = mealScaleFactors([NEW_TWIST], 2, true, 16);
    assert.equal(scale.byDish.nt, 16 / 14);
    assert.equal(
      formatIngredientLine(NEW_TWIST.ingredients[0], { multiplier: scale.byDish.nt, birds: scale.birds.nt }),
      "1 whole turkey (12–14 lb)",
    );
  });
});

describe("THX-4 — which turkey, and the rest of the meal", () => {
  it("weighs turkeys only: a breast, a chicken, a count turkey with no weight anywhere", () => {
    assert.deepEqual(weighedTurkeyOf(TURKEY.ingredients), { index: 0, recipeLb: 14, byCount: false });
    assert.deepEqual(weighedTurkeyOf(BUTTERMILK.ingredients), { index: 0, recipeLb: 14, byCount: true });
    assert.deepEqual(weighedTurkeyOf(NEW_TWIST.ingredients), { index: 0, recipeLb: 14, byCount: true });
    assert.equal(weighedTurkeyOf([ing(5, "pound", "bone-in turkey breast")]), null);
    assert.equal(weighedTurkeyOf([ing(4, "pound", "whole chicken")]), null);
    assert.equal(weighedTurkeyOf([ing(1, "each", "whole turkey")]), null);
    assert.equal(chosenBird([GRAVY], 16), null);
  });

  it("the gravy keeps the servings; its neck and giblets are the one bird's", () => {
    const scale = mealScaleFactors([TURKEY, GRAVY], 0.4, true, 16);
    assert.equal(scale.byDish.gravy, 0.4);
    assert.equal(formatIngredientLine(GRAVY.ingredients[0], { multiplier: scale.byDish.gravy, birds: scale.birds.gravy }), "1 turkey neck");
    // Two birds by count at 20 servings had two necks; the chosen one bird has one.
    const bm = (lb: number | null) => mealScaleFactors([BUTTERMILK, GRAVY], 2, true, lb).birds.gravy.parts;
    assert.equal(bm(null), 2);
    assert.equal(bm(16), 1);
  });

  it("the steps: the brine follows the weight, and a bird's size in a step has no floor", () => {
    const BRINE = "Dissolve ½ cup kosher salt in 1 gallon cold water, then add the 14-lb turkey.";
    const span = (s: string, quantity: number, unit: string) => {
      const charStart = BRINE.indexOf(s);
      return { ingredientId: "i", quantity, unit, charStart, charEnd: charStart + s.length };
    };
    const refs = [span("½ cup", 0.5, "cup"), span("1", 1, ""), span("14", 14, "")];
    const at = (lb: number | null) => {
      const scale = mealScaleFactors([TURKEY], 0.4, true, lb);
      return buildAmountRefSegments(BRINE, refs, scale.byDish.turkey, scale.birds.turkey).filter((x) => x.isRef).map((x) => x.text);
    };
    assert.deepEqual(at(null), ["⅓ cup", "¾", "10"]);
    assert.deepEqual(at(8), ["¼ cup", "⅝", "8"]);
    assert.deepEqual(at(20), ["¾ cup", "1⅜", "20"]);
  });

  it("the ingredients sheet reads the same rule (consolidateMealIngredients)", () => {
    const meal = { tags: ["thanksgiving-feast"], dishes: [{ ...TURKEY, title: "Turkey" }] } as unknown as MealDetail;
    const turkey = (lb: number | null) => consolidateMealIngredients(meal, 0.4, 4, lb).find((c) => /turkey/.test(c.name))!.line;
    assert.match(turkey(null), /^10 pounds/);
    assert.match(turkey(8), /^8 pounds/);
  });

  it("the dish screen (a Hub row's dish): the turkey's dish only, from meal.birdWeightLb", () => {
    const meal = {
      tags: ["thanksgiving-feast"],
      effectiveServings: 4,
      authoredServingsDefault: 10,
      birdWeightLb: 16,
      dishes: [TURKEY, GRAVY],
    } as unknown as MealDetail;
    assert.deepEqual(planDishView(meal, "turkey")!.chosenBird, { factor: 16 / 14, birds: { parts: 1, birds: 1, chosen: true } });
    assert.equal(planDishView(meal, "gravy")!.chosenBird, undefined);
    assert.equal(planDishView({ ...meal, birdWeightLb: null }, "turkey")!.chosenBird, undefined);
  });
});

// CLIENT-4 B (BUG-537, the meal screen's half) — a turkey written by count says the
// chosen weight. The server's birdLineAtWeight words the grocery line the same way
// ("whole turkey (16 lb)"); its pins are api-server thx4BirdWeight.test.ts.
describe("CLIENT-4 B — a turkey by count says the chosen weight on the meal screen", () => {
  /** The meal screen's lines (app/meal/[id].tsx): the factors, then the bird's name. */
  function screenLines(dish: typeof TURKEY, servings: number, lb: number | null, dishes = [dish]): string[] {
    const scale = mealScaleFactors(dishes, servings / WRITTEN_FOR, true, lb);
    const bird = chosenBirdName(dishes, lb);
    return dish.ingredients.map((row, i) =>
      formatIngredientLine(bird && bird.dishId === dish.dishId && bird.index === i ? { ...row, name: bird.name } : row, {
        multiplier: scale.byDish[dish.dishId],
        birds: scale.birds[dish.dishId],
      }),
    );
  }

  it("the Buttermilk alternate (weight in the note) at 12, 16 and its authored 14 lb", () => {
    for (const servings of [4, 10, 20]) {
      assert.equal(screenLines(BUTTERMILK, servings, 12)[0], "1 whole turkey (12 lb)");
      assert.equal(screenLines(BUTTERMILK, servings, 16)[0], "1 whole turkey (16 lb)");
      assert.equal(screenLines(BUTTERMILK, servings, 14)[0], "1 whole turkey (14 lb)");
    }
    // The THX-4 pinned rows at the authored weight, the bird's name aside.
    assert.deepEqual(screenLines(BUTTERMILK, 4, 14).slice(1), ["2 quarts buttermilk", "½ cup Kosher salt", "1 large brining bag", "1 turkey neck"]);
  });

  it("New Twist (weight in the name): the name's weight is the chosen one, not a second one", () => {
    assert.equal(screenLines(NEW_TWIST, 4, 12)[0], "1 whole turkey (12 lb)");
    assert.equal(screenLines(NEW_TWIST, 4, 16)[0], "1 whole turkey (16 lb)");
    assert.equal(screenLines(NEW_TWIST, 4, 14)[0], "1 whole turkey (14 lb)");
    assert.equal(screenLines(NEW_TWIST, 4, 16.5)[0], "1 whole turkey (16½ lb)");
  });

  it("the other rows still scale by chosen ÷ the RECIPE's weight (read from the original text)", () => {
    for (const lb of [12, 14, 16]) {
      assert.equal(mealScaleFactors([BUTTERMILK], 0.4, true, lb).byDish.buttermilk, lb / 14);
      assert.equal(mealScaleFactors([NEW_TWIST], 0.4, true, lb).byDish.nt, lb / 14);
      // Only the bird's line moves; every other line is the THX-4 line, byte for byte.
      assert.deepEqual(screenLines(BUTTERMILK, 4, lb).slice(1), lines(BUTTERMILK, 4, lb).slice(1));
      assert.deepEqual(screenLines(NEW_TWIST, 4, lb).slice(1), lines(NEW_TWIST, 4, lb).slice(1));
    }
    // Had the renamed text been read, 16 lb would have scaled by 16 ÷ 16.
    assert.notEqual(screenLines(NEW_TWIST, 4, 16)[1], screenLines(NEW_TWIST, 4, 14)[1]);
  });

  it("no weight chosen: every line reads exactly as today", () => {
    for (const dish of [BUTTERMILK, NEW_TWIST, TURKEY]) {
      for (const servings of [4, 10, 20]) assert.deepEqual(screenLines(dish, servings, null), lines(dish, servings, null));
    }
    assert.equal(screenLines(BUTTERMILK, 4, null)[0], "1 whole turkey");
    assert.equal(screenLines(NEW_TWIST, 4, null)[0], "1 whole turkey (12–14 lb)");
    assert.equal(chosenBirdName([BUTTERMILK], null), null);
  });

  it("a turkey by weight already says it; a gravy dish has no bird line to rename", () => {
    assert.equal(chosenBirdName([TURKEY], 16), null);
    assert.equal(screenLines(TURKEY, 4, 16)[0], "16 pounds whole turkey");
    assert.deepEqual(chosenBirdName([GRAVY, BUTTERMILK], 16), { dishId: "buttermilk", index: 0, name: "whole turkey (16 lb)" });
  });

  it("the Ingredients sheet says the same weight", () => {
    const meal = { tags: ["thanksgiving-feast"], dishes: [{ ...BUTTERMILK, title: "Turkey" }] } as unknown as MealDetail;
    const turkey = (lb: number | null) => consolidateMealIngredients(meal, 0.4, 4, lb).find((c) => /whole turkey/.test(c.name))!.line;
    assert.equal(turkey(null), "1 whole turkey");
    assert.equal(turkey(12), "1 whole turkey (12 lb)");
    assert.equal(turkey(16), "1 whole turkey (16 lb)");
  });

  it("the meal screen renders through it", () => {
    const screen = readFileSync(new URL("../../app/meal/[id].tsx", import.meta.url), "utf8");
    assert.match(screen, /const birdName = chosenBirdName\(meal\.dishes, birdLb\);/);
    assert.match(screen, /birdName && birdName\.dishId === dish\.dishId && birdName\.index === i \? \{ \.\.\.ing, name: birdName\.name \} : ing/);
  });
});

describe("THX-4 — the default bird's weight (the server's birdShownLb)", () => {
  it("Classic: the floor at 4, ¼ lb steps at 8, the recipe at 10, linear above", () => {
    assert.equal(defaultBirdLb([TURKEY], 0.4, true), 10);
    assert.equal(defaultBirdLb([TURKEY], 0.8, true), 11.25);
    assert.equal(defaultBirdLb([TURKEY], 1, true), 14);
    assert.equal(defaultBirdLb([TURKEY], 2, true), 28);
  });

  it("New Twist (weight in the name): the weight rule's floor, 10 at 4 (the THX copies' birdShownLb)", () => {
    assert.equal(defaultBirdLb([NEW_TWIST], 0.4, true), 10);
  });

  it("by count: the birds shown × each bird's pounds", () => {
    assert.equal(defaultBirdLb([BUTTERMILK], 0.4, true), 14);
    assert.equal(defaultBirdLb([BUTTERMILK], 2, true), 28);
    assert.equal(defaultBirdLb([BUTTERMILK], 2, false), 28);
  });

  it("the first dish with a weighable turkey decides; none, null", () => {
    assert.equal(defaultBirdLb([GRAVY, TURKEY], 1, true), 14);
    assert.equal(defaultBirdLb([GRAVY], 1, true), null);
  });
});

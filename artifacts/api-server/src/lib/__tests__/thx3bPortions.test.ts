// THX-3b (BUG-456) — ONE INGREDIENT LISTED TWICE: EACH PORTION GOES WITH THE STEP
// THAT USES IT. The Sweet Potato Casserole (dev 1aee8a1b, rows and refs verbatim)
// lists brown sugar ¼ cup for the filling (step 1) and ½ cup for the topping (step 3),
// and butter 4 tbsp + 3 tbsp the same way. Before, both sugars sat in the filling's
// dry mix and the topping mix's closing line named the filling's butter.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildCoreWeek, buildFeastSession } from "../prepWeekBuild";
import { buildPrepCombineInput, portionView } from "../prepCombineAdapter";
import type { LoadPrepWeekInputResult, PrepLoadedDish } from "../prepWeekAggregation";

type Load = Pick<LoadPrepWeekInputResult, "input" | "cookDays" | "identity">;
const M = "f0000000-0000-4000-8000-0000000000b1";
const D = "fd000000-0000-4000-8000-0000000000b1";
const I = (n: number) => `f1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SUGAR = I(3);
const BUTTER = I(2);

const ing = (n: number, ingredientName: string, category: string, quantity: number, unit: string, preparationNote: string | null = null) => ({
  ingredientId: I(n), ingredientName, category, quantity, unit, preparationNote, sourceYield: null,
});
const step = (stepIndex: number, phaseType: string, text: string, refs: Array<[number, number]>) => ({
  stepIndex, phaseType, text, componentKey: null,
  ingredientIds: [...new Set(refs.map(([n]) => I(n)))],
  refs: refs.map(([n, quantity]) => ({ ingredientId: I(n), quantity })),
});

function casserole(): PrepLoadedDish {
  const componentSteps = [
    step(0, "cook", "Make ahead (Wednesday): Place 4 lb peeled sweet potato chunks in a large pot, cover with cold water, and boil 15–18 minutes until very tender; drain well.", [[1, 4]]),
    step(1, "assemble", "Make ahead (Wednesday): Mash the sweet potatoes until smooth, then stir in 4 tablespoons melted butter, ¼ cup light brown sugar, ¼ cup whole milk, 2 beaten eggs, 1 teaspoon vanilla, ½ teaspoon cinnamon, ¼ teaspoon nutmeg, and ½ teaspoon kosher salt.", [[2, 4], [3, 0.25], [4, 0.25], [5, 2], [6, 1], [7, 0.5], [8, 0.25], [9, 0.5]]),
    step(2, "assemble", "Make ahead (Wednesday): Spread the sweet potato filling evenly into a buttered 9×13-inch baking dish; cover tightly with foil and refrigerate overnight.", []),
    step(3, "prep", "Make ahead (Wednesday): In a medium bowl, combine 1 cup roughly chopped pecans, ½ cup light brown sugar, and ¼ cup flour; cut in 3 tablespoons cold butter with your fingers until the mixture resembles coarse crumbs; cover and refrigerate.", [[10, 1], [3, 0.5], [11, 0.25], [2, 3]]),
    step(4, "prep", "On Thursday: Preheat the oven to 350°F; remove the casserole from the fridge and scatter the pecan topping evenly over the surface.", []),
    step(5, "cook", "Bake uncovered in the 9×13-inch baking dish for 35–40 minutes until the topping is golden and the filling is heated through.", []),
  ];
  return {
    dishId: D, dishName: "Sweet Potato Casserole", dishRole: "side", baseServings: 10, authoredBaseServings: 10,
    ingredients: [
      ing(1, "sweet potatoes", "Produce", 4, "pound", "peeled and cut into 2-inch chunks"),
      ing(2, "unsalted butter", "Dairy", 4, "tablespoon", "melted, for filling"),
      ing(3, "light brown sugar", "Pantry", 0.25, "cup", "for filling"),
      ing(4, "whole milk", "Dairy", 0.25, "cup"),
      ing(5, "large eggs", "Dairy", 2, "each", "beaten"),
      ing(6, "vanilla extract", "Pantry", 1, "teaspoon"),
      ing(7, "ground cinnamon", "Pantry", 0.5, "teaspoon"),
      ing(8, "ground nutmeg", "Pantry", 0.25, "teaspoon"),
      ing(9, "kosher salt", "Pantry", 0.5, "teaspoon"),
      ing(10, "pecan halves", "Pantry", 1, "cup", "roughly chopped, for topping"),
      ing(3, "light brown sugar", "Pantry", 0.5, "cup", "for topping"),
      ing(11, "all-purpose flour", "Pantry", 0.25, "cup", "for topping"),
      ing(2, "unsalted butter", "Dairy", 3, "tablespoon", "cold, cut into small pieces, for topping"),
    ],
    stepTexts: componentSteps.map((s) => s.text),
    componentSteps,
    makeAheadDays: ["wed"],
  } as unknown as PrepLoadedDish;
}

function load(dish: PrepLoadedDish, servings: number | null, feast: boolean): Load {
  return {
    input: {
      planId: "f2000000-0000-4000-8000-0000000000b1", planName: "THX-3b",
      meals: [{ mealId: M, mealName: "THX-3b Thanksgiving", cuisine: null, servingsOverride: servings, ...(feast ? { feast: true as const } : {}), dishes: [dish] }],
    },
    cookDays: { prepDay: null, lagByMealId: new Map([[M, 4]]), dayNameByMealId: new Map([[M, "Thursday"]]) },
    identity: undefined,
  } as unknown as Load;
}

describe("THX-3b BUG-456 — the portion view", () => {
  it("matches each listing to the step whose amountRef carries its quantity", () => {
    const v = portionView(casserole())!;
    assert.deepEqual([...v.rowOf.values()].filter((r) => r.real === SUGAR), [
      { real: SUGAR, portion: "1", step: 1 },
      { real: SUGAR, portion: "2", step: 3 },
    ]);
    assert.ok(v.dish.componentSteps.find((s) => s.stepIndex === 3)!.ingredientIds.includes(`${SUGAR}#2`));
    assert.ok(!v.dish.componentSteps.find((s) => s.stepIndex === 3)!.ingredientIds.includes(SUGAR));
  });

  it("a dish that lists each ingredient once has no view, and maps exactly as before", () => {
    const once = casserole();
    once.ingredients = once.ingredients.slice(0, 10);
    assert.equal(portionView(once), null);
    const rows = buildPrepCombineInput(load(once, null, false).input).meals[0].dishes[0].ingredients;
    assert.ok(rows.every((r) => r.portion === undefined && !r.ingredientId.includes("#")));
  });

  it("the engine rows go out under the real id, each listing with its step", () => {
    const rows = buildPrepCombineInput(load(casserole(), null, true).input, { feast: true }).meals[0].dishes[0].ingredients;
    const sugar = rows.filter((r) => r.ingredientId === SUGAR);
    assert.deepEqual(sugar.map((r) => [r.quantity, r.portion, r.portionStep]), [[0.25, "1", 1], [0.5, "2", 3]]);
    assert.notEqual(sugar[0].momentKey, sugar[1].momentKey);
  });
});

describe("THX-3b BUG-456 — Prep the feast: the casserole's containers", () => {
  const b = buildFeastSession(load(casserole(), 8, true))!;
  const mixes = b.stepPlan.steps.filter((s) => !s.demoted && s.bowlName);
  const of = (name: string) => mixes.find((s) => s.bowlName === name)!;
  const contents = (name: string) => of(name).components.flatMap((c) => c.measures.map((m) => `${c.ingredientName} ${m.amount}`));

  it("the filling's sugar is in the filling's mix and the topping's in the topping's", () => {
    assert.deepEqual(contents("Sweet Potato Casserole dry mix").sort(), ["ground cinnamon ½ tsp", "ground nutmeg ¼ tsp", "kosher salt ½ tsp", "light brown sugar ¼ cup"].sort());
    assert.deepEqual(contents("Sweet Potato Casserole dry mix 2").sort(), ["all-purpose flour ¼ cup", "light brown sugar ⅓ cup", "pecan halves ¾ cup"].sort());
  });

  it("the topping mix's closing line names the topping's butter (3 tbsp × 0.8), not the filling's", () => {
    const line = b.closingLines?.get(of("Sweet Potato Casserole dry mix 2").stepKey);
    assert.ok(line, "no closing line for dry mix 2");
    assert.match(line!, /2½ tbsp unsalted butter/);
    assert.doesNotMatch(line!, /3¼ tbsp/);
  });
});

describe("THX-3b BUG-456 — the everyday week keys each listing's portion", () => {
  it("the topping's sugar is not in the filling's container", () => {
    const b = buildCoreWeek(load(casserole(), null, false));
    for (const s of b.stepPlan.steps.filter((x) => !x.demoted && x.bowlName)) {
      const sugar = s.components.filter((c) => c.ingredientName === "light brown sugar").flatMap((c) => c.measures);
      assert.ok(sugar.length <= 1, `${s.bowlName} holds ${sugar.length} sugar portions`);
    }
  });
});

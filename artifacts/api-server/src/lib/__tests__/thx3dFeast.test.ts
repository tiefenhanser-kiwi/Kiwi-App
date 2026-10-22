// THX-3d — Prep the feast: R1 (three or more, another vessel is another mix, a jar's
// one dry member goes in with its liquids). The cheesecake (one vessel) and the jar
// fold are asserted on the five real feasts by thx3dFeastWalk.test.ts (dev DB, opt-in).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildFeastSession } from "../prepWeekBuild";
import { NEW_VESSEL } from "../prepMoments";
import type { LoadPrepWeekInputResult } from "../prepWeekAggregation";

type Load = Pick<LoadPrepWeekInputResult, "input" | "cookDays" | "identity">;
const M = "f0000000-0000-4000-8000-0000000000d1";
const I = (n: number) => `f1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ing = (n: number, ingredientName: string, category: string, quantity: number, unit: string, preparationNote: string | null = null) => ({
  ingredientId: I(n), ingredientName, category, quantity, unit, preparationNote, sourceYield: null,
});
const step = (stepIndex: number, phaseType: string, text: string, ids: number[], refs: [number, number][] = []) => ({
  stepIndex, phaseType, componentKey: null, text, ingredientIds: ids.map(I), refs: refs.map(([n, quantity]) => ({ ingredientId: I(n), quantity })),
});

function feast(dishName: string, rows: ReturnType<typeof ing>[], steps: ReturnType<typeof step>[], makeAheadDays?: string[]): Load {
  return {
    input: {
      planId: "f2000000-0000-4000-8000-0000000000d1",
      planName: "THX-3d",
      meals: [{
        mealId: M, mealName: "THX-3d Thanksgiving", servingsOverride: null, feast: true,
        dishes: [{
          dishId: "fd000000-0000-4000-8000-0000000000d1", dishName, dishRole: "side", baseServings: 4, authoredBaseServings: 4,
          ingredients: rows, stepTexts: steps.map((s) => s.text), componentSteps: steps, ...(makeAheadDays ? { makeAheadDays } : {}),
        }],
      }],
    },
    cookDays: { prepDay: null, lagByMealId: new Map([[M, 1]]), dayNameByMealId: new Map([[M, "Thursday"]]) },
    identity: undefined,
  } as unknown as Load;
}
const containers = (l: Load, phase: string) =>
  buildFeastSession(l)!.stepPlan.steps.filter((s) => !s.demoted && s.phase === phase && s.bowlName).map((s) => s.components.map((c) => c.ingredientName).sort().join(", "));

const CRISP_ROWS = [
  ing(1, "granny smith apple", "Produce", 3, "each", "peeled, cored, and sliced"),
  ing(2, "granulated sugar", "Pantry", 3, "tablespoon"),
  ing(3, "ground nutmeg", "Pantry", 0.25, "teaspoon"),
  ing(4, "cornstarch", "Pantry", 1, "tablespoon"),
  // Listed twice under one id, as Small lists it: the filling's and the topping's.
  ing(10, "ground cinnamon", "Pantry", 0.75, "teaspoon"),
  ing(5, "old-fashioned rolled oats", "Pantry", 0.75, "cup"),
  ing(6, "all-purpose flour", "Pantry", 0.5, "cup"),
  ing(7, "packed light brown sugar", "Pantry", 0.5, "cup"),
  ing(10, "ground cinnamon", "Pantry", 0.25, "teaspoon", "for topping"),
  ing(8, "kosher salt", "Pantry", 0.25, "teaspoon"),
  ing(9, "cold unsalted butter", "Dairy", 6, "tablespoon", "cubed"),
];

describe("THX-3d R1 — another vessel is another mix; the same vessel is one", () => {
  it("NEW_VESSEL reads a separate bowl, not the first bowl", () => {
    assert.ok(NEW_VESSEL.test("In a separate bowl, combine ¾ cup rolled oats"));
    assert.ok(NEW_VESSEL.test("Whisk the dressing in another small bowl"));
    assert.ok(!NEW_VESSEL.test("In a large bowl, toss the apples with the sugar"));
    assert.ok(!NEW_VESSEL.test("Measure the spices; whisk them into the filling"));
  });

  it("the crisp's filling and topping are two mixes (Small's apple crisp)", () => {
    const l = feast("Apple Crisp", CRISP_ROWS, [
      step(0, "prep", "Make ahead (Wednesday): Peel, core, and slice 3 Granny Smith apples ¼-inch thick; toss in a large bowl with 3 tablespoons granulated sugar, ¾ teaspoon cinnamon, ¼ teaspoon nutmeg, 1 tablespoon cornstarch, and the juice of 1 lemon.", [1, 2, 10, 3, 4], [[10, 0.75]]),
      step(1, "prep", "Make ahead (Wednesday): In a separate bowl, combine ¾ cup rolled oats, ½ cup all-purpose flour, ½ cup packed light brown sugar, ¼ teaspoon cinnamon, and ¼ teaspoon kosher salt; work in 6 tablespoons cold cubed butter with your fingers until the mixture forms coarse, pea-sized clumps.", [5, 6, 7, 10, 8, 9], [[10, 0.25]]),
      step(2, "assemble", "Make ahead (Wednesday): Spread the apple filling in a 9×13-inch baking dish; scatter the oat topping evenly over the apples; cover and refrigerate overnight.", []),
      step(3, "cook", "On Thursday: Bake the apple crisp uncovered at 350°F for 45–50 minutes.", []),
    ], ["wed"]);
    assert.deepEqual(containers(l, "seasonings_dry").sort(), [
      "all-purpose flour, ground cinnamon, kosher salt, old-fashioned rolled oats, packed light brown sugar",
      "cornstarch, granulated sugar, ground cinnamon, ground nutmeg",
    ]);
  });
});

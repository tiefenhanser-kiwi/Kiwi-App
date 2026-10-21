// THX-3c — Prep the feast: G (no tub of whole spices alone).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildFeastSession } from "../prepWeekBuild";
import type { LoadPrepWeekInputResult } from "../prepWeekAggregation";

type Load = Pick<LoadPrepWeekInputResult, "input" | "cookDays" | "identity">;
const M = "f0000000-0000-4000-8000-0000000000c1";
const I = (n: number) => `f1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ing = (n: number, ingredientName: string, category: string, quantity: number, unit: string, preparationNote: string | null = null) => ({
  ingredientId: I(n), ingredientName, category, quantity, unit, preparationNote, sourceYield: null,
});

/** One make-ahead gravy whose stock step adds `spices` beside the neck and onion. */
function gravy(spices: ReturnType<typeof ing>[], words: string): Load {
  const rows = [ing(1, "turkey neck", "Protein", 1, "each"), ing(2, "yellow onion", "Produce", 1, "each", "chopped"), ...spices];
  return {
    input: {
      planId: "f2000000-0000-4000-8000-0000000000c1",
      planName: "THX-3c gravy",
      meals: [{
        mealId: M, mealName: "THX-3c Thanksgiving", servingsOverride: null, feast: true,
        dishes: [{
          dishId: "fd000000-0000-4000-8000-0000000000c1", dishName: "Pan Gravy", dishRole: "sauce", baseServings: 10, authoredBaseServings: 10,
          ingredients: rows, makeAheadDays: ["tue"],
          stepTexts: [`Make ahead (Tuesday): Simmer the turkey neck, the chopped onion, ${words} in 6 cups water for 1 hour.`],
          componentSteps: [{ stepIndex: 0, phaseType: "cook", componentKey: null, text: `Make ahead (Tuesday): Simmer the turkey neck, the chopped onion, ${words} in 6 cups water for 1 hour.`, ingredientIds: rows.map((r) => r.ingredientId) }],
        }],
      }],
    },
    cookDays: { prepDay: null, lagByMealId: new Map([[M, 4]]), dayNameByMealId: new Map([[M, "Thursday"]]) },
    identity: undefined,
  } as unknown as Load;
}
const dryContainers = (l: Load) =>
  buildFeastSession(l)!.stepPlan.steps.filter((s) => !s.demoted && s.phase === "seasonings_dry" && s.bowlName).map((s) => s.components.map((c) => c.ingredientName).sort().join(", "));

describe("THX-3c G — a feast dry container of whole spices alone keeps the floor of three", () => {
  it("bay leaves and peppercorns are no container: their amounts stay in the recipe step", () => {
    assert.deepEqual(dryContainers(gravy([ing(3, "bay leaves", "Pantry", 2, "each"), ing(4, "black peppercorns", "Pantry", 1, "teaspoon")], "2 bay leaves and 1 teaspoon black peppercorns")), []);
  });

  it("three whole spices are a container", () => {
    assert.deepEqual(
      dryContainers(gravy([ing(3, "bay leaves", "Pantry", 2, "each"), ing(4, "black peppercorns", "Pantry", 1, "teaspoon"), ing(5, "whole cloves", "Pantry", 3, "each")], "2 bay leaves, 1 teaspoon black peppercorns and 3 whole cloves")),
      ["bay leaves, black peppercorns, whole cloves"],
    );
  });

  it("a whole spice beside a measure that is not one still makes the feast's mix of two", () => {
    assert.deepEqual(
      dryContainers(gravy([ing(3, "bay leaves", "Pantry", 2, "each"), ing(6, "granulated sugar", "Pantry", 1, "tablespoon")], "2 bay leaves and 1 tablespoon granulated sugar")),
      ["bay leaves, granulated sugar"],
    );
  });
});

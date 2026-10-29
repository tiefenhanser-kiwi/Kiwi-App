// SERVER-8 C (BUG-568) — the isPrepped rollup counts ticks the way Cook Mode does: against
// the cached screen the cook ticked (SERVER-7's rule, prepTickCarry), so a plan whose Prep
// the Week was re-keyed by an engine change reads prepped without regenerating.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import { derivePrepCompletion } from "../prepCompletion";
import { loadPrepStepSet } from "../prepStepSet";
import type { loadPrepWeekInput as productionLoadPrepWeekInput } from "../prepWeekAggregation";

const PLAN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "u-server8";
const MEAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DISH_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ONION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SPICE_IDS = ["f1111111-1111-4111-8111-111111111111", "f2222222-2222-4222-8222-222222222222", "f3333333-3333-4333-8333-333333333333"];
const ONION_KEY = `produce#${ONION_ID}`;
// Today's key for the dish's spices (prepStepSet.test.ts's fixture), and the week's old one.
const BLEND_KEY = `seasonings_dry#dish#${DISH_ID}`;
const OLD_BLEND_KEY = "seasonings_dry#blend";

const loader = (async () => ({
  input: {
    planId: PLAN_ID,
    planName: "Carry Test",
    meals: [{
      mealId: MEAL_ID, mealName: "Meal", cuisine: null, servingsOverride: null,
      dishes: [{
        dishId: DISH_ID, dishName: "Dish", baseServings: 4, authoredBaseServings: 4, stepTexts: [], componentSteps: [],
        ingredients: [
          { ingredientId: ONION_ID, ingredientName: "yellow onion", category: "Produce", quantity: 1, unit: "each", preparationNote: "diced" },
          ...["cumin", "paprika", "coriander"].map((name, i) => ({ ingredientId: SPICE_IDS[i], ingredientName: name, category: "Pantry", quantity: 1, unit: "tsp", preparationNote: null })),
        ],
      }],
    }],
  },
  planRevisionId: 1,
})) as unknown as typeof productionLoadPrepWeekInput;

let reads = 0;
const prismaWith = (structureJson: unknown | null) => ({
  prepWeekStructure: { findUnique: async () => { reads += 1; return structureJson === null ? null : { structureJson }; } },
}) as unknown as PrismaClient;
// The screen the cook ticked: an older engine's one blend for the week.
const OLD_SCREEN = {
  phases: [
    { phase: "produce", steps: [{ stepKey: ONION_KEY, contributesToMealIds: [MEAL_ID] }] },
    { phase: "seasonings_dry", steps: [{ stepKey: OLD_BLEND_KEY, contributesToMealIds: [MEAL_ID] }] },
  ],
};
const stepSet = (ticks: string[] | undefined, structure: unknown | null = OLD_SCREEN) =>
  loadPrepStepSet({ planId: PLAN_ID, userId: USER_ID, prisma: prismaWith(structure), loadPrepWeekInput: loader, ...(ticks ? { ticks } : {}) });

describe("SERVER-8 C — the rollup carries a stale screen's ticks", () => {
  it("the old blend's tick carries today's dish blend: the meal reads prepped (it read not)", async () => {
    const ticks = [ONION_KEY, OLD_BLEND_KEY];
    const refs = await stepSet(ticks);
    const blend = refs.find((r) => r.stepKey === BLEND_KEY)!;
    assert.equal(blend.carried, true);
    assert.equal(refs.find((r) => r.stepKey === ONION_KEY)!.carried, undefined);
    const after = derivePrepCompletion([MEAL_ID], refs, new Set(ticks));
    assert.equal(after.perMeal[MEAL_ID], true);
    assert.equal(after.perMealState[MEAL_ID], "fully");
    assert.equal(after.derivedPrepStatus, "prepped");
    // HEAD's rollup over the same rows: the blend's own key was never ticked.
    const before = derivePrepCompletion([MEAL_ID], refs.map(({ carried: _c, ...r }) => r), new Set(ticks));
    assert.equal(before.derivedPrepStatus, "not_prepped");
    assert.equal(before.perMealState[MEAL_ID], "partly");
  });

  it("an old step the cook left unticked carries nothing", async () => {
    const refs = await stepSet([ONION_KEY, "produce#gone-from-the-plan"]);
    assert.ok(refs.every((r) => !r.carried));
    assert.equal(derivePrepCompletion([MEAL_ID], refs, new Set([ONION_KEY])).derivedPrepStatus, "not_prepped");
  });

  it("no ticks given, or every tick a live key: the step set as before, and the cache is not read", async () => {
    reads = 0;
    const plain = await stepSet(undefined);
    const live = await stepSet([ONION_KEY, BLEND_KEY]);
    assert.deepEqual(live, plain);
    assert.ok(plain.every((r) => !r.carried));
    assert.equal(reads, 0);
  });

  it("with no cache, an orphan tick still carries only when it holds every portion (SERVER-7's no-cache rule)", async () => {
    const refs = await stepSet([ONION_KEY, OLD_BLEND_KEY], null);
    assert.equal(refs.find((r) => r.stepKey === BLEND_KEY)!.carried, true);
  });
});

describe("SERVER-8 C — derivePrepCompletion reads `carried`", () => {
  it("a carried step is checked for every meal it contributes to; an uncarried one is not", () => {
    const steps = [
      { stepKey: "a", contributesToMealIds: ["m1", "m2"], carried: true },
      { stepKey: "b", contributesToMealIds: ["m2"] },
    ];
    const r = derivePrepCompletion(["m1", "m2"], steps, new Set());
    assert.deepEqual(r.perMeal, { m1: true, m2: false });
    assert.deepEqual(r.perMealState, { m1: "fully", m2: "partly" });
    assert.equal(r.derivedPrepStatus, "partial");
  });
});

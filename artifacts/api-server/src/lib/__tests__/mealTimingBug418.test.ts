// PREP-1 G (BUG-418) — a feast's derived times are Thursday's: the make-ahead runs
// are left out before the scheduler; every other meal is stamped exactly as before.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deriveMealTiming, onTheDaySteps, stampMealTiming } from "../mealTiming";
import type { SchedulerPhase } from "../cookingScheduler";

type Step = { stepIndex: number; text: string; estimatedMinutes: number; phaseType: SchedulerPhase; isTimingSensitive: boolean };
const st = (stepIndex: number, text: string, estimatedMinutes: number, phaseType: SchedulerPhase, isTimingSensitive = false): Step => ({
  stepIndex, text, estimatedMinutes, phaseType, isTimingSensitive,
});

// THX-2G-F's shapes: a Tuesday stock whose 2-hour simmer is UNPREFIXED inside its run,
// and a pie made Wednesday and warmed Thursday.
const GRAVY: Step[] = [
  st(0, "Make ahead (Tuesday): Put the turkey neck, 1 carrot and 2 bay leaves in a pot with 8 cups water.", 8, "prep"),
  st(1, "Simmer 2 hours, strain and chill.", 120, "cook"),
  st(2, "On Thursday: Whisk the drippings into the stock and season with the salt.", 8, "cook", true),
];
const PIE: Step[] = [
  st(0, "Make ahead (Wednesday): Preheat the oven to 425°F.", 15, "preheat"),
  st(1, "Roll the crust and fill it.", 20, "prep"),
  st(2, "Bake 55 minutes.", 55, "cook"),
  st(3, "On Thursday: Warm the pie 10 minutes at 300°F.", 20, "cook"),
];
const TURKEY: Step[] = [
  st(0, "Preheat the oven to 325°F.", 15, "preheat"),
  st(1, "Rub the turkey with the herb butter.", 15, "prep"),
  st(2, "Roast 3 hours.", 180, "cook"),
];

/** A stub transaction: the persisted steps and links, the meal's tags on the link read. */
function tx(dishes: Record<string, Step[]>, tags: string[]) {
  const mealUpdates: Record<string, unknown>[] = [];
  return {
    mealUpdates,
    tx: {
      meal: { update: async ({ data }: { data: Record<string, unknown> }) => (mealUpdates.push(data), {}) },
      dish: { update: async () => ({}) },
      mealDishLink: {
        findMany: async () => Object.keys(dishes).map((dishId, positionIndex) => ({ dishId, positionIndex, meal: { tags } })),
      },
      recipeInstructionStep: {
        findMany: async () =>
          Object.entries(dishes).flatMap(([ownerId, steps]) =>
            steps.map((s) => ({ ownerId, stepIndex: s.stepIndex, estimatedMinutes: s.estimatedMinutes, phaseType: s.phaseType, isTimingSensitive: s.isTimingSensitive, parallelGroup: null, componentKey: null, pathKey: null, stepTextTranslated: s.text })),
          ),
      },
    } as never,
  };
}

const sched = (dishes: Record<string, Step[]>) =>
  Object.entries(dishes).map(([dishId, steps], positionIndex) => ({ dishId, title: dishId, positionIndex, steps }));

describe("PREP-1 G (BUG-418) — a feast's clock is Thursday's", () => {
  it("the run: from 'Make ahead (' up to 'On Thursday:', unprefixed steps inside it included", () => {
    assert.deepEqual(onTheDaySteps(GRAVY).map((s) => s.stepIndex), [2]);
    assert.deepEqual(onTheDaySteps(PIE).map((s) => s.stepIndex), [3]);
    assert.deepEqual(onTheDaySteps(TURKEY).map((s) => s.stepIndex), [0, 1, 2]);
  });

  it("a feast is stamped with Thursday's steps only", async () => {
    const dishes = { turkey: TURKEY, gravy: GRAVY, pie: PIE };
    const { tx: t, mealUpdates } = tx(dishes, ["american", "thanksgiving", "thanksgiving-feast"]);
    const timing = await stampMealTiming(t, "feast", Object.keys(dishes));
    const thursday = deriveMealTiming(sched({ turkey: TURKEY, gravy: [GRAVY[2]], pie: [PIE[3]] }));
    const everything = deriveMealTiming(sched(dishes));
    assert.equal(timing.totalMinutes, thursday.totalMinutes);
    assert.equal(timing.activeMinutes, thursday.activeMinutes);
    assert.deepEqual(mealUpdates, [{ estimatedTimeMinutes: thursday.totalMinutes, activeTimeMinutes: thursday.activeMinutes }]);
    assert.ok(everything.activeMinutes! > thursday.activeMinutes!, "fixture: the make-ahead work was on the clock before");
  });

  it("a meal NOT tagged thanksgiving-feast is stamped exactly as before, make-ahead text and all", async () => {
    const dishes = { turkey: TURKEY, gravy: GRAVY, pie: PIE };
    const { tx: t, mealUpdates } = tx(dishes, ["american", "thanksgiving"]);
    const timing = await stampMealTiming(t, "pizza-night", Object.keys(dishes));
    const before = deriveMealTiming(sched(dishes));
    assert.equal(JSON.stringify({ ...timing, dishTotals: [...timing.dishTotals] }), JSON.stringify({ ...before, dishTotals: [...before.dishTotals] }));
    assert.deepEqual(mealUpdates, [{ estimatedTimeMinutes: before.totalMinutes, activeTimeMinutes: before.activeMinutes }]);
  });
});

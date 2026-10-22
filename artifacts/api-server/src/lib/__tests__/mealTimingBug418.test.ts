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

  it("PREP-2 item 3 — the bird's 'Thaw (start Friday):' step is a run too (the client's literal vectors)", () => {
    // Verbatim up to the first clause: the same vectors as artifacts/kiwi
    // lib/cooking/__tests__/feastDay.test.ts, so the two readings agree step for step.
    const turkey = [
      "Thaw (start Friday): If the turkey is frozen, transfer it to the fridge on Friday.",
      "Make ahead (Wednesday night): Dissolve ½ cup kosher salt and ¼ cup light brown sugar in 1 gallon cold water.",
      "Make ahead (Wednesday night): Add 1 tablespoon black peppercorns, 3 thyme sprigs, 2 rosemary sprigs.",
      "Make ahead (Wednesday night): Pat the turkey dry with paper towels and submerge the bird in the brine.",
      "Make ahead (Wednesday night): Mash 6 tablespoons softened butter with 3 minced garlic cloves.",
      "On Thursday: Remove the turkey from the brine, discard the brine, and pat the bird very dry.",
      "Preheat the oven to 325°F.",
      "Loosen the skin over the breast and thighs and rub all of the herb butter directly onto the meat.",
      "Stuff the cavity with the quartered onion; tie the legs together with kitchen twine.",
      "Place the turkey breast side up on a rack and roast at 325°F for 3 to 3½ hours.",
      "Transfer the turkey to a cutting board and let it rest.",
      "Carve the turkey and arrange on a large platter.",
    ];
    const stuffing = [
      "Make ahead (Tuesday): Cut 1½ lb rustic white bread into ¾-inch cubes and leave uncovered.",
      "Make ahead (Wednesday): Melt 8 tablespoons butter in a 12-inch skillet over medium heat.",
      "Make ahead (Wednesday): Stir in the minced garlic, ¼ cup chopped sage.",
      "Make ahead (Wednesday): Toss the dried bread cubes with the cooked vegetable mixture.",
      "Make ahead (Wednesday): Whisk 3 beaten eggs into 3 cups low-sodium stock.",
      "Make ahead (Wednesday): Butter a 9×13-inch baking dish, cover tightly with foil, and refrigerate overnight.",
      "On Thursday: Preheat the oven to 375°F.",
      "Bake the stuffing, still covered in foil, for 30 minutes; uncover and bake 20–25 minutes more.",
      "Serve the stuffing directly from the baking dish.",
    ];
    const idx = (texts: string[]) => onTheDaySteps(texts.map((text) => ({ text }))).map((s) => texts.indexOf(s.text));
    assert.deepEqual(idx(turkey), [5, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual(idx(stuffing), [6, 7, 8]);
    // A thaw that is NOT the opening clause is an ordinary step.
    assert.deepEqual(idx(["Let the butter thaw (about 10 minutes) on the counter."]), [0]);
  });

  it("a feast is stamped with Thursday's steps only", async () => {
    const dishes = { turkey: TURKEY, gravy: GRAVY, pie: PIE };
    const { tx: t, mealUpdates } = tx(dishes, ["american", "thanksgiving", "thanksgiving-feast"]);
    const timing = await stampMealTiming(t, "feast", Object.keys(dishes));
    // THX-3d (R4) — scheduled as the feast it is: the gravy's "whisk the drippings" now
    // waits for the bird to come out, which a non-feast schedule does not know.
    const thursday = deriveMealTiming(sched({ turkey: TURKEY, gravy: [GRAVY[2]], pie: [PIE[3]] }), { feastOven: true });
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

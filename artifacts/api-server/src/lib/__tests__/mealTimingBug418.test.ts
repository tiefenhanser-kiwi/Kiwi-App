// PREP-1 G (BUG-418) — a feast's derived times are Thursday's: the make-ahead runs
// are left out before the scheduler; every other meal is stamped exactly as before.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deriveMealTiming, onTheDaySteps, stampMealTiming } from "../mealTiming";
import type { SchedulerPhase } from "../cookingScheduler";

// SERVER-8 (D-WS9-351) — the one list, CLIENT-6's: data only, loaded from the client's tree.
import { FEAST_DAY_VECTORS } from "../../../../kiwi/lib/cooking/__tests__/feastDayVectors.mjs";

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
      // THX-3d round 4 (BUG-497 item 8) — the link carries the dish's title, as the stamp reads it.
      mealDishLink: {
        findMany: async () => Object.keys(dishes).map((dishId, positionIndex) => ({ dishId, positionIndex, roleLabel: null, meal: { tags }, dish: { title: TITLE[dishId] ?? dishId, servingsDefault: 10, authoredServingsDefault: 10, dishIngredients: [] } })),
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

/** THX-3d round 4 — each fixture dish's title (production's ids are UUIDs, never "turkey"). */
const TITLE: Record<string, string> = {
  turkey: "Herb-Roasted Whole Turkey", gravy: "Pan Gravy", pie: "Pumpkin Pie",
  "3f1c2e7a-0b6d-4c1e-9a2f-6d8e1b7c5a40": "Herb-Roasted Whole Turkey", "8b2d4f60-1c3e-4a5b-8d7f-2e9c0a6b3d11": "Pan Gravy", "c5e7a9b1-2d4f-4e6a-9c8b-0f1e3d5a7b22": "Pumpkin Pie",
};
// THX-3d round 4 (BUG-497 item 8) — scheduled by title, as Cook Mode and now the stamp do
// (it pinned `title: dishId`, which found the bird only because the fixture's id is "turkey").
const sched = (dishes: Record<string, Step[]>) =>
  Object.entries(dishes).map(([dishId, steps], positionIndex) => ({ dishId, title: TITLE[dishId] ?? dishId, positionIndex, steps }));

describe("PREP-1 G (BUG-418) — a feast's clock is Thursday's", () => {
  it("the run: from 'Make ahead (' up to 'On Thursday:', unprefixed steps inside it included", () => {
    assert.deepEqual(onTheDaySteps(GRAVY).map((s) => s.stepIndex), [2]);
    assert.deepEqual(onTheDaySteps(PIE).map((s) => s.stepIndex), [3]);
    assert.deepEqual(onTheDaySteps(TURKEY).map((s) => s.stepIndex), [0, 1, 2]);
  });

  // SERVER-8 (D-WS9-351) — THE ONE LIST (artifacts/kiwi lib/cooking/__tests__/
  // feastDayVectors.mts), read here and by the client's feastDay.test.ts, so the two readings
  // agree step for step: the bird's thaw is a run, a step without a prefix continues the run
  // before it, and the feast day opens at "On Thursday:" or (after the flip) "On feast day:".
  for (const v of FEAST_DAY_VECTORS) {
    it(`shared vector: ${v.name}`, () => {
      assert.deepEqual(onTheDaySteps(v.steps.map((text, i) => ({ text, i }))).map((s) => s.i), v.onTheDay);
    });
  }

  // SEQ-1 (BUG-612) — CLIENT-7's five steps (scripts/_scratch/client-7/diverge.ts): a run
  // starts at a day prefix only, "Make ahead (Monday):" or "Thaw (start Friday):", as the
  // client's feastDay.ts reads it. "Thaw (about 10 minutes) the peas" and "Make ahead (up to
  // 3 days) the gravy:" are ordinary steps on the day. (To join the shared vectors in
  // feastDayVectors.mts, CLIENT-8's lane, once it is free.)
  it("BUG-612: only a day prefix starts a run", () => {
    const steps = ["Make ahead (Monday): Zest 2 oranges.", "On Thursday: Remove the turkey.", "Thaw (about 10 minutes) the frozen peas in warm water.", "Make ahead (up to 3 days) the gravy: whisk the roux.", "Serve."];
    assert.deepEqual(onTheDaySteps(steps.map((text, i) => ({ text, i }))).map((s) => s.i), [1, 2, 3, 4]);
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

  it("THX-3d round 4 (BUG-497 item 8) — a feast keyed by UUIDs is stamped by its titles: the bird is found, the stamp is Cook Mode's", async () => {
    const ids = ["3f1c2e7a-0b6d-4c1e-9a2f-6d8e1b7c5a40", "8b2d4f60-1c3e-4a5b-8d7f-2e9c0a6b3d11", "c5e7a9b1-2d4f-4e6a-9c8b-0f1e3d5a7b22"];
    const dishes = { [ids[0]]: TURKEY, [ids[1]]: GRAVY, [ids[2]]: PIE };
    const { tx: t } = tx(dishes, ["american", "thanksgiving", "thanksgiving-feast"]);
    const timing = await stampMealTiming(t, "feast", ids);
    const day = { [ids[0]]: TURKEY, [ids[1]]: [GRAVY[2]], [ids[2]]: [PIE[3]] };
    const byTitle = deriveMealTiming(sched(day), { feastOven: true });
    const byId = deriveMealTiming(Object.entries(day).map(([dishId, steps], positionIndex) => ({ dishId, title: dishId, positionIndex, steps })), { feastOven: true });
    assert.equal(timing.totalMinutes, byTitle.totalMinutes);
    assert.notEqual(byId.totalMinutes, byTitle.totalMinutes, "fixture: read by id, the stamp would differ (no bird)");
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

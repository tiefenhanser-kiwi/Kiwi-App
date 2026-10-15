// PREP-1 (BUG-413) — Prep the Week 502'd when a phase passed 30 steps, and paid
// for the narration first. Two causes, two fixes:
//   1. engine-demoted steps rode the wire as `skipSuggested` (the client never
//      renders them) and counted toward the 30 — they are off the wire now;
//   2. a week with more than 30 steps that DO render had no answer at all — the
//      overflow now goes to the cook-day list before the narration.
// Over the real engine with a hand-built loader result.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { LoadPrepWeekInputResult } from "../prepWeekAggregation";
import { buildPrepWeekPlan, finishPrepWeek, type PrepWeekBuild } from "../prepWeekBuild";
import {
  assemblePrepWeekResult,
  OVER_CAP_REASON,
  overCapPhases,
  PHASE_STEP_MAX,
  summarizePrepWeek,
} from "../prepWeekAssembly";
import { PrepWeekResultSchema } from "../ai/schemas/prepWeek";

const MEALS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

// Knife work that holds a week, none of it a garnish or a citrus wedge (rule 7's
// drop pass) and none of it a food that browns once cut.
const VEG = [
  "carrot", "celery", "zucchini", "yellow squash", "eggplant", "cucumber", "red bell pepper",
  "green bell pepper", "yellow onion", "red onion", "shallot", "leek", "fennel bulb", "radish",
  "turnip", "parsnip", "beet", "broccoli", "cauliflower", "green cabbage", "red cabbage", "kale",
  "bok choy", "snow peas", "green beans", "asparagus", "jalapeño", "poblano pepper", "celery root",
  "kohlrabi", "rutabaga", "butternut squash", "okra", "tomatillo",
];
// Whole cherry tomatoes and the like: nothing to cut, so the engine demotes them.
const WHOLE = ["cherry tomatoes", "grape tomatoes", "baby spinach"];

const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dishId = (m: number) => `d${m}000000-0000-4000-8000-000000000000`;

/**
 * `knife` vegetables spread over five meals (the first two shared by meals 1 and 2,
 * so the week has multi-meal steps too) plus `whole` foods the engine demotes.
 */
function week(knife: number, whole: number): LoadPrepWeekInputResult {
  const perMeal = MEALS.map(() => [] as { ingredientId: string; ingredientName: string; preparationNote: string | null }[]);
  VEG.slice(0, knife).forEach((name, i) => {
    const row = { ingredientId: id(i + 1), ingredientName: name, preparationNote: "diced" };
    if (i < 2) {
      perMeal[0].push(row);
      perMeal[1].push(row);
    } else {
      perMeal[i % MEALS.length].push(row);
    }
  });
  WHOLE.slice(0, whole).forEach((name, i) => {
    perMeal[i % MEALS.length].push({ ingredientId: id(100 + i), ingredientName: name, preparationNote: null });
  });
  return {
    input: {
      planId: "pppppppp-pppp-4ppp-8ppp-pppppppppppp",
      planName: "BUG-413 fixture",
      meals: MEALS.map((mealId, m) => ({
        mealId,
        mealName: `Meal ${m + 1}`,
        cuisine: null,
        servingsOverride: null,
        dishes: [{
          dishId: dishId(m + 1),
          dishName: `Dish ${m + 1}`,
          dishRole: "main" as const,
          baseServings: 4,
          authoredBaseServings: 4,
          ingredients: perMeal[m].map((r) => ({ ...r, category: "Produce", quantity: 1, unit: "each", sourceYield: null })),
          stepTexts: [],
          componentSteps: [],
        }],
      })),
    },
    planRevisionId: 1,
    cookDays: {
      prepDay: "2026-11-22",
      lagByMealId: new Map(MEALS.map((m, i) => [m, i + 1])),
      dayNameByMealId: new Map(MEALS.map((m, i) => [m, DAYS[i]])),
    },
    identity: { foldedIdByIngredientId: new Map() },
  } as unknown as LoadPrepWeekInputResult;
}

/** The route's order: the cap guard, then (stand-in) narration, assembly, the schema check. */
function wire(build: PrepWeekBuild) {
  const narration = {
    steps: build.stepPlan.narrationInput.steps.map((s) => ({ stepId: s.stepId, title: "Do the thing", instructions: "Do the thing." })),
  };
  const assembled = assemblePrepWeekResult(build.stepPlan, narration);
  return { assembled, parsed: PrepWeekResultSchema.safeParse(assembled), result: summarizePrepWeek(finishPrepWeek(assembled, build)) };
}
const produce = (r: ReturnType<typeof wire>["assembled"]) => r.phases.find((p) => p.phase === "produce")!.steps;

describe("PREP-1 (BUG-413) — engine-muted steps are off the wire", () => {
  // 29 knife steps + the wash = 30 that render, and 3 the engine demotes: 33 planned.
  const build = buildPrepWeekPlan(week(29, 3));

  it("fixture: the produce phase plans 33 steps, 3 of them engine-demoted", () => {
    const planned = build.stepPlan.steps.filter((s) => s.phase === "produce");
    assert.equal(planned.length, 33);
    assert.equal(planned.filter((s) => s.demoted).length, 3);
    assert.ok(planned.every((s) => s.demoted?.reason !== OVER_CAP_REASON), "nothing was over the cap");
  });

  it("the wire carries the 30 that render, and passes the schema", () => {
    const { assembled, parsed } = wire(build);
    assert.equal(produce(assembled).length, PHASE_STEP_MAX);
    assert.ok(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.flatten()));
    assert.ok(produce(assembled).every((s) => !s.skipSuggested));
    assert.deepEqual(overCapPhases(build.stepPlan), []);
  });

  it("a demoted step's dish recipe is not sent to the narrator", () => {
    // A sixth meal whose only food is whole cherry tomatoes: its one step is
    // demoted, so its recipe is prose nobody reads.
    const load = week(2, 0);
    const meals = load.input.meals as unknown as { dishes: { dishName: string; ingredients: unknown[]; stepTexts: string[] }[] }[];
    meals[0].dishes[0].stepTexts = ["Dice the carrot and the celery."];
    meals.push({
      mealId: "66666666-6666-4666-8666-666666666666",
      mealName: "Meal 6",
      dishes: [{
        dishId: dishId(6), dishName: "Tomato Plate", dishRole: "main", baseServings: 4, authoredBaseServings: 4,
        ingredients: [{ ingredientId: id(100), ingredientName: "cherry tomatoes", category: "Produce", quantity: 1, unit: "cup", preparationNote: null, sourceYield: null }],
        stepTexts: ["Pile the cherry tomatoes on a plate."],
        componentSteps: [],
      }],
    } as never);
    const b = buildPrepWeekPlan(load);
    const tomato = b.stepPlan.steps.find((s) => s.components.some((c) => c.ingredientName === "cherry tomatoes"))!;
    assert.ok(tomato.demoted, "fixture: the tomatoes are not prep");
    assert.ok(!b.stepPlan.narrationInput.steps.some((n) => n.stepId === tomato.stepId));
    assert.deepEqual(Object.keys(b.stepPlan.narrationInput.dishSteps), ["Dish 1"]);
  });
});

describe("PREP-1 (BUG-413) — the 30-step backstop", () => {
  // 33 knife steps + the wash = 34 that render.
  const build = buildPrepWeekPlan(week(33, 0));
  const moved = build.stepPlan.steps.filter((s) => s.demoted?.reason === OVER_CAP_REASON);

  it("moves exactly the overflow, before the narration", () => {
    assert.equal(moved.length, 4);
    assert.deepEqual(overCapPhases(build.stepPlan), []);
    for (const st of moved) {
      assert.ok(!build.stepPlan.narrationInput.steps.some((n) => n.stepId === st.stepId), "an overflow step was narrated");
    }
  });

  it("a week over 30 visible steps passes the schema, 30 on the wire", () => {
    const { assembled, parsed } = wire(build);
    assert.ok(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.flatten()));
    assert.equal(produce(assembled).length, PHASE_STEP_MAX);
  });

  it("the overflow is the latest meal's single-meal steps, on its cook-day line", () => {
    const last = MEALS[MEALS.length - 1];
    assert.equal(moved.length, 4);
    assert.ok(moved.every((s) => s.contributesToMealIds.length === 1 && s.contributesToMealIds[0] === last));
    const { result } = wire(build);
    const held = result.phases.find((p) => p.phase === "proteins")!.heldForCookDay ?? [];
    const line = held.find((l) => l.startsWith("Meal 5"));
    assert.ok(line, `no cook-day line for meal 5: ${JSON.stringify(held)}`);
    for (const st of moved) {
      assert.ok(line!.includes(st.components[0].ingredientName), `${st.components[0].ingredientName} missing from "${line}"`);
    }
  });

  it("the route's pre-narration guard names a phase over the cap", () => {
    const steps = Array.from({ length: PHASE_STEP_MAX + 1 }, () => ({ phase: "produce" }));
    assert.deepEqual(overCapPhases({ steps } as never), ["produce"]);
    assert.deepEqual(overCapPhases({ steps: steps.map((s, i) => (i === 0 ? { ...s, demoted: { reason: "x" } } : s)) } as never), []);
  });

  it("the choice is a function of the composition alone: a day edit does not move it", () => {
    const again = week(33, 0);
    // Reverse every cook day. The narration is cached on the composition (D-WS9-298),
    // so what it narrates may not depend on the day.
    again.cookDays.lagByMealId = new Map(MEALS.map((m, i) => [m, MEALS.length - i]));
    const keys = (b: PrepWeekBuild) => b.stepPlan.steps.filter((s) => s.demoted?.reason === OVER_CAP_REASON).map((s) => s.stepKey).sort();
    assert.deepEqual(keys(buildPrepWeekPlan(again)), keys(build));
    assert.deepEqual(keys(buildPrepWeekPlan(week(33, 0))), keys(build));
  });
});

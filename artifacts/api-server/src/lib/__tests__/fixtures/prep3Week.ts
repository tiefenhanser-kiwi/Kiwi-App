// PREP-3 — a week for the engine, built the route's way (J.1's loader): meals of dishes
// of ingredients and steps, each meal on its day with its lag.
import assert from "node:assert/strict";

import type { LoadPrepWeekInputResult, PrepLoadedPlan } from "../../prepWeekAggregation";
import { finishPrepWeek, type PrepWeekBuild } from "../../prepWeekBuild";
import { assemblePrepWeekResult, summarizePrepWeek } from "../../prepWeekAssembly";
import { PrepWeekResultSchema, type PrepWeekResult } from "../../ai/schemas/prepWeek";

export type Ing = { id: string; name: string; category: string; quantity: number; unit: string; note?: string; pack?: string };
export type St = { i: number; phase: string; text: string; ids?: string[]; key?: string };
export type Dish = { id: string; name: string; ings: Ing[]; steps: St[] };
export type Meal = { id: string; name: string; day: string; lag: number; dishes: Dish[] };

export const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000003e00`;

export function load(meals: Meal[], opts: { prepDay?: string } = {}): LoadPrepWeekInputResult {
  const input: PrepLoadedPlan = {
    planId: uuid(999),
    planName: "PREP-3",
    meals: meals.map((m) => ({
      mealId: m.id,
      mealName: m.name,
      cuisine: null,
      servingsOverride: null,
      dishes: m.dishes.map((d) => ({
        dishId: d.id,
        dishName: d.name,
        dishRole: "main" as const,
        baseServings: 4,
        authoredBaseServings: 4,
        ingredients: d.ings.map((x) => ({
          ingredientId: x.id, ingredientName: x.name, category: x.category, quantity: x.quantity, unit: x.unit,
          preparationNote: x.note ?? null, sourceYield: null, purchaseUnit: x.pack ?? null,
        })),
        stepTexts: d.steps.map((s) => s.text),
        componentSteps: d.steps.map((s) => ({ stepIndex: s.i, text: s.text, componentKey: s.key ?? null, ingredientIds: s.ids ?? [], phaseType: s.phase })),
      })),
    })),
  };
  return {
    input,
    planRevisionId: 1,
    cookDays: {
      prepDay: opts.prepDay ?? "2026-10-25",
      lagByMealId: new Map(meals.map((m) => [m.id, m.lag])),
      dayNameByMealId: new Map(meals.map((m) => [m.id, m.day])),
    },
    identity: { foldedIdByIngredientId: new Map() },
  };
}

/** The route's sequence with the narration stubbed. */
export function wire(build: PrepWeekBuild): PrepWeekResult {
  const narration = { steps: build.stepPlan.narrationInput.steps.map((s) => ({ stepId: s.stepId, title: "Do it", instructions: "Do it." })) };
  const res = summarizePrepWeek(finishPrepWeek(assemblePrepWeekResult(build.stepPlan, narration), build));
  const v = PrepWeekResultSchema.safeParse(res);
  assert.ok(v.success, v.success ? "" : JSON.stringify(v.error.flatten()));
  return res;
}

/** Every container and what it holds, from the build (demoted steps out). */
export function containers(build: PrepWeekBuild): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const st of build.stepPlan.steps) {
    if (st.demoted) continue;
    for (const c of st.components) {
      for (const m of c.measures) {
        const n = m.destination ?? st.bowlName;
        if (!n) continue;
        out.set(n, [...(out.get(n) ?? []), `${c.ingredientName}${m.preparationNote ? ` (${m.preparationNote})` : ""}`]);
      }
    }
  }
  return out;
}

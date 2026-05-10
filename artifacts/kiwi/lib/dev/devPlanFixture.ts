// DEV-ONLY scaffolding. Delete at WS7-CLOSE when real plan persistence lands.
//
// Injected via Profile → Developer → "Inject dev test plan" so Hans can reach
// a Plan Review with meals (for Find Similar AI testing) without going through
// the wizard or manual create-plan flows (both stubbed).
//
// id: "demo" intentionally reuses the existing rich Plan Review branch in
// stubs.ts → getReviewPlan("demo"), which returns 3 meals across 3 cuisines
// (Salmon Teriyaki / Chicken Stir Fry / Pasta Primavera). Plan Review reads
// from getReviewPlan, NOT from this MealPlan.meals array — so the meals[]
// here is benign-default content (mirrors defaultPlan()), included only to
// satisfy the MealPlan type. The id linkage is what makes the demo surface.

import { DAYS, getMondayISO } from "../domain";
import type { MealPlan } from "../types";

export const DEV_TEST_PLAN_ID = "demo";

export function buildDevTestPlan(): MealPlan {
  return {
    id: DEV_TEST_PLAN_ID,
    name: "Dev Test Plan",
    createdAt: Date.now(),
    weekStart: getMondayISO(),
    meals: DAYS.map((d) => ({
      day: d,
      slot: "Dinner",
      recipeId: "",
    })),
  };
}

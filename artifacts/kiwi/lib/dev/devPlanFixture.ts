// DEV-ONLY scaffolding. Delete at WS7-CLOSE when real plan persistence lands.
//
// Injected via Profile → Developer → "Inject dev test plan" so Hans can reach
// a Plan Review with meals (for Find Similar AI testing) without going through
// the wizard or manual create-plan flows (both stubbed).
//
// id: "demo" intentionally reuses the existing rich Plan Review branch in
// stubs.ts → getReviewPlan("demo"), which returns 3 meals
// (Beef Tacos / Spaghetti Carbonara / Salmon with Rice Pilaf). Plan Review
// reads from getReviewPlan, NOT from this MealPlan.meals array — so the meals[]
// here is benign-default content (mirrors defaultPlan()), included only to
// satisfy the MealPlan type. The id linkage is what makes the demo surface.
//
// The recipeIds below match the real seeded meal IDs from devData.ts so a
// tap-through reaches a meal that GET /meals/:id can resolve (post Block B).

import { getMondayISO } from "../domain";
import type { MealPlan } from "../types";

export const DEV_TEST_PLAN_ID = "demo";

// Three MealSlots with non-empty recipeIds matching the 3 meals returned
// by getReviewPlan("demo"). Non-empty recipeIds are required to satisfy
// the `hasAnyRealMeal` gate on the Plans tab "This Week" card
// (plans.tsx:31-38) and the Home hero's isEmptyState gate (index.tsx:83-90).
// The gates only check `recipeId !== ""` — they don't try to resolve.
export function buildDevTestPlan(): MealPlan {
  return {
    id: DEV_TEST_PLAN_ID,
    name: "Dev Test Plan",
    createdAt: Date.now(),
    weekStart: getMondayISO(),
    meals: [
      { day: "Mon", slot: "Dinner", recipeId: "dev-meal-beef-tacos" },
      { day: "Tue", slot: "Dinner", recipeId: "dev-meal-spaghetti-carbonara" },
      { day: "Wed", slot: "Dinner", recipeId: "dev-meal-salmon-rice-pilaf" },
    ],
  };
}

// WS7-3 Block C3 Commit 1 — pure default-filter resolution for the Meals
// sub-tab. Extracted so it unit-tests under the bare node:test harness (no
// JSX runner — see C2 Phase 1 §10 / C3 Phase 1 §1.10).

import type { MealFilterKey } from "@/lib/api/meals";

/**
 * Meals sub-tab default filter (PRD §9.3.2 / Phase 1 R1): a persisted
 * `lastMealsFilters` wins (first key — single-select per D-WS7-049
 * carryover); otherwise My Meals.
 */
export function mealsFilterDefault(
  savedFilters: readonly MealFilterKey[],
): MealFilterKey[] {
  if (savedFilters.length > 0) return [savedFilters[0]];
  return ["my_meals"];
}

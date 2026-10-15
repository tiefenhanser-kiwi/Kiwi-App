// WS7-3 Block C3 Commit 1 — pure default-filter resolution for the Meals
// sub-tab. Extracted so it unit-tests under the bare node:test harness (no
// JSX runner — see C2 Phase 1 §10 / C3 Phase 1 §1.10).

import type { MealFilterKey } from "@/lib/api/meals";

/**
 * BOOK-1C1 — the chips the Recipes → Meals sub-tab shows. Featured, Top Rated
 * and Hosting are gone from it (always empty: Meal has no featuring flag,
 * D-WS7-039); Saved is new. The other keys stay in MEAL_FILTER_KEYS for the
 * sheets that still read them.
 */
export const RECIPES_MEAL_CHIPS: readonly MealFilterKey[] = ["my_meals", "saved"];

/**
 * Meals sub-tab default filter (PRD §9.3.2 / Phase 1 R1): a persisted
 * `lastMealsFilters` wins (first key — single-select per D-WS7-049
 * carryover) when it is still a chip on the tab; otherwise My Meals. A user
 * who last sat on Featured (BOOK-1C1 removed it) lands on My Meals rather
 * than on a chip that no longer exists.
 */
export function mealsFilterDefault(
  savedFilters: readonly MealFilterKey[],
): MealFilterKey[] {
  const first = savedFilters[0];
  if (first !== undefined && RECIPES_MEAL_CHIPS.includes(first)) return [first];
  return ["my_meals"];
}

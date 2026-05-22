// WS7-3 Block C3 Commit 2 — pure default-filter resolution for the Dishes
// sub-tab. Extracted so it unit-tests under the bare node:test harness (no
// JSX runner — see C2 Phase 1 §10 / C3 Phase 1 §1.10).

import type { DishFilterKey } from "@/lib/api/dishes";

/**
 * Dishes sub-tab default filter. Mirrors mealsFilterDefault: a persisted
 * filter would win (first key — single-select per D-WS7-049 carryover), but
 * the Dishes tab has no User.lastDishesFilters schema field yet (D-WS7-051),
 * so the persistence channel is unused for now. The signature stays
 * compatible so c2's call site doesn't change when WS9 lands the field.
 */
export function dishesFilterDefault(
  savedFilters: readonly DishFilterKey[],
): DishFilterKey[] {
  if (savedFilters.length > 0) return [savedFilters[0]];
  return ["my_dishes"];
}

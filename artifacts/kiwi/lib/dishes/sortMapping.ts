// WS7-6 C-fix Block 4 — shared SortDropdown→server-sort mapping for dish
// contexts. Previously copied inline in app/(tabs)/meals.tsx and
// app/meal-builder.tsx; the Meal→Add-Dish sheet now also drives a server sort,
// so the three consumers share ONE source rather than a third copy.
//
// `last_cooked` has no Dish.lastUsedAt write path (D-WS7-111), so it stays
// greyed/disabled in dish dropdowns and is mapped defensively to `alpha` if it
// ever reaches the server param.

import type { SortKey } from "@/components/SortDropdown";
import type { DishSortKey } from "@/lib/api/dishes";

// `times_cooked` ranks by mealUseCount (saved meals containing the dish), not a
// literal cook count — relabel it "Most used" in dish contexts.
export const DISH_SORT_LABEL_OVERRIDES: Partial<Record<SortKey, string>> = {
  times_cooked: "Most used",
};

// Sort keys greyed/disabled in dish contexts.
export const DISH_DISABLED_SORT_KEYS: readonly SortKey[] = ["last_cooked"];

export function toDishSortKey(key: SortKey): DishSortKey {
  return key === "last_cooked" ? "alpha" : key;
}

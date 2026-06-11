// WS7-6 G2 — shared SortDropdown→server-sort mapping for meal contexts.
// Meals support alpha / date_created / cook_time — the dish keys minus the
// dish-only `times_cooked` + `last_cooked`. Those two stay greyed/disabled in
// meal dropdowns and map defensively to `alpha` if one ever reaches the param.
// Parallel to lib/dishes/sortMapping (the dish twin).

import type { SortKey } from "@/components/SortDropdown";
import type { MealSortKey } from "@/lib/api/meals";

// Sort keys greyed/disabled in meal contexts (no backing meal field).
export const MEAL_DISABLED_SORT_KEYS: readonly SortKey[] = [
  "last_cooked",
  "times_cooked",
];

export function toMealSortKey(key: SortKey): MealSortKey {
  return key === "date_created" || key === "cook_time" ? key : "alpha";
}

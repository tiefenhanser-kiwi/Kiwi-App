// WS9-2 BUG-075 — Plans-tab sort context. Parallel to lib/meals/sortMapping and
// lib/dishes/sortMapping, but the Plans surface is DIFFERENT from the meal/dish
// ones (Hans-ruled):
//   - `cook_time` is HIDDEN (removed from the option set entirely). A plan has
//     no cook time, and an average would need a server aggregate the GET /plans
//     list payload doesn't carry. It stays live for MEAL contexts — this hides
//     it only for plans.
//   - `last_cooked` + `times_cooked` are GREYED (disabled) — the cook-stat sort
//     keys need server metadata GET /plans doesn't carry yet (D-WS7-048).
// `date_created` + `alpha` stay live. No PLAN_* equivalent existed before this
// (§1.2), so this is the first — reuse it, don't create a second.

import type { SortKey } from "@/components/SortDropdown";

export const PLAN_HIDDEN_SORT_KEYS: readonly SortKey[] = ["cook_time"];

export const PLAN_DISABLED_SORT_KEYS: readonly SortKey[] = [
  "last_cooked",
  "times_cooked",
];

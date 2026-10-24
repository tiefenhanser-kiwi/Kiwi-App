// React Query hook for GET /meals/:id — the meal-detail screen's read side.
// WS7-3 Block B: replaces app/meal/[id].tsx's synchronous getMealById stub.
//
// Query key follows the documented convention (lib/api/README.md):
// ["meals", "detail", id]. staleTime is the personal-mutable tier (60_000) —
// the global QueryClient default — so no per-query override is needed.
//
// WS7-7-A B5 (D-WS7-090 read-side): an optional `planItemId` threads the plan
// context to the server so the per-instance recipeOverrideJson is applied. It
// is part of the query key so the plan-scoped (override-applied) read is cached
// separately from the canonical library read of the same meal.
//
// CLIENT-1 item 2: `prepped` (Cook Mode's "yes, I prepped") is a fifth key part,
// present only when true, so every ["meals","detail"] prefix invalidation still
// reaches it. Its first read keeps the unprepped meal on screen (placeholder)
// rather than dropping Cook Mode back to a spinner under the gate's toast.

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { getMeal, type MealDetail } from "@/lib/api/meals";

export function mealDetailKey(id: string, planItemId?: string, prepped = false) {
  const key: (string | null)[] = ["meals", "detail", id, planItemId ?? null];
  if (prepped && planItemId) key.push("prepped");
  return key;
}

export function useMeal(id: string, planItemId?: string, opts: { prepped?: boolean } = {}) {
  const prepped = !!opts.prepped && !!planItemId;
  return useQuery<MealDetail>({
    queryKey: mealDetailKey(id, planItemId, prepped),
    queryFn: () => getMeal(id, planItemId, prepped ? { prepped } : {}),
    // An empty id (missing route param) never hits the network; the screen
    // renders its not-found state instead.
    enabled: id.length > 0,
    ...(prepped ? { placeholderData: keepPreviousData } : {}),
  });
}

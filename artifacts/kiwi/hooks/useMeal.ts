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

import { useQuery } from "@tanstack/react-query";

import { getMeal, type MealDetail } from "@/lib/api/meals";

export function useMeal(id: string, planItemId?: string) {
  return useQuery<MealDetail>({
    queryKey: ["meals", "detail", id, planItemId ?? null],
    queryFn: () => getMeal(id, planItemId),
    // An empty id (missing route param) never hits the network; the screen
    // renders its not-found state instead.
    enabled: id.length > 0,
  });
}

// React Query hook for GET /meals/:id — the meal-detail screen's read side.
// WS7-3 Block B: replaces app/meal/[id].tsx's synchronous getMealById stub.
//
// Query key follows the documented convention (lib/api/README.md):
// ["meals", "detail", id]. staleTime is the personal-mutable tier (60_000) —
// the global QueryClient default — so no per-query override is needed.

import { useQuery } from "@tanstack/react-query";

import { getMeal, type MealDetail } from "@/lib/api/meals";

export function useMeal(id: string) {
  return useQuery<MealDetail>({
    queryKey: ["meals", "detail", id],
    queryFn: () => getMeal(id),
    // An empty id (missing route param) never hits the network; the screen
    // renders its not-found state instead.
    enabled: id.length > 0,
  });
}

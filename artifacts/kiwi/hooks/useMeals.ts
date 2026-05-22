// React Query hook for GET /me/meals — the Meals tab list.
// WS7-3 Block C1: API + hook foundation; the Meals screen migrates in a later
// C-block. The meal-detail read stays on the existing useMeal hook.
//
// Query key ["meals", "list", <filter>] — distinct from useMeal's
// ["meals", "detail", id]. staleTime uses the global personal-mutable default.

import { useQuery } from "@tanstack/react-query";

import {
  getMeals,
  type MealFilterKey,
  type MealListResponse,
} from "@/lib/api/meals";

export function useMeals(filter?: readonly MealFilterKey[]) {
  return useQuery<MealListResponse>({
    queryKey: ["meals", "list", filter ?? null],
    queryFn: () => getMeals(filter),
  });
}

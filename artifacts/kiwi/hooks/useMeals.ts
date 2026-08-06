// React Query hook for GET /me/meals — the Meals tab list.
// WS7-3 Block C1: API + hook foundation; the Meals screen migrates in a later
// C-block. The meal-detail read stays on the existing useMeal hook.
//
// Query key ["meals", "list", <filter>] — distinct from useMeal's
// ["meals", "detail", id]. staleTime uses the global personal-mutable default.

import { useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import {
  getMeals,
  type MealFilterKey,
  type MealListItem,
  type MealListResponse,
  type MealSortKey,
} from "@/lib/api/meals";

// WS9 3f-4 (Thread E, §5.2) — optional `limit` raises the first-page candidate
// pool (Find Similar's ~20-row alphabetical truncation is the corpus half of
// BUG-058). The key stays byte-identical to the pre-3f-4 shape when `limit` is
// omitted, so every existing caller/primed-cache/AppContext list-update key is
// untouched; only a limited call gets the extra key element. The server clamps
// the value to [1,100] (listQuery.ts clampLimit), so a bounded raise is a pure
// client change — no server contract change (that stays 3f-5's).
export function useMeals(filter?: readonly MealFilterKey[], limit?: number) {
  return useQuery<MealListResponse>({
    queryKey:
      limit === undefined
        ? ["meals", "list", filter ?? null]
        : ["meals", "list", filter ?? null, limit],
    queryFn: () => getMeals(filter, limit === undefined ? {} : { limit }),
  });
}

// WS7-6 G2 scope (iii) — infinite (keyset-paginated) + server-sorted Meals
// list for the Recipes→Meals sub-tab. A SEPARATE hook from useMeals because
// the FindSimilar / ChangeMeal / AddMeals sheets still consume useMeals'
// non-infinite first-page shape; converting useMeals itself would break them.
// The query key shares the ["meals","list"] prefix so saveMeal's
// invalidateQueries({ queryKey: ["meals","list"] }) still kicks this chain —
// the new-save-appears fix scope (iii) is built around. Mirrors useDishes.
export function useInfiniteMeals(
  filter?: readonly MealFilterKey[],
  sort?: MealSortKey,
) {
  const query = useInfiniteQuery<MealListResponse>({
    queryKey: ["meals", "list", filter ?? null, sort ?? null],
    queryFn: ({ pageParam }) =>
      getMeals(filter, {
        sort,
        cursor: (pageParam as string | undefined) ?? undefined,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  // Flattened across all loaded pages — the shape every list surface wants.
  const meals = useMemo<MealListItem[]>(
    () => query.data?.pages.flatMap((p) => p.meals) ?? [],
    [query.data],
  );

  return { ...query, meals };
}

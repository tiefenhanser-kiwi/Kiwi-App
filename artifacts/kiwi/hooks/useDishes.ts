// React Query hook for GET /me/dishes — the Dishes tab list.
// WS7-3 Block C1: API + hook foundation.
// WS7-6 B-fix Block 3: converted to useInfiniteQuery — the list is now
// cursor-paginated server-side and sortable. The query key includes the
// filter AND the sort so each (filter, sort) combination caches its own
// page chain. `getNextPageParam` reads the opaque `nextCursor`.
//
// Consumers get a flattened `dishes` array alongside the raw infinite-query
// result, so no surface has to reimplement page-flattening.

import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";

import {
  getDishes,
  type DishFilterKey,
  type DishListItem,
  type DishListResponse,
  type DishSortKey,
} from "@/lib/api/dishes";

export function useDishes(
  filter?: readonly DishFilterKey[],
  sort?: DishSortKey,
) {
  const query = useInfiniteQuery<DishListResponse>({
    queryKey: ["dishes", "list", filter ?? null, sort ?? null],
    queryFn: ({ pageParam }) =>
      getDishes(filter, {
        sort,
        cursor: (pageParam as string | undefined) ?? undefined,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  // Flattened across all loaded pages — the shape every list surface wants.
  const dishes = useMemo<DishListItem[]>(
    () => query.data?.pages.flatMap((p) => p.dishes) ?? [],
    [query.data],
  );

  return { ...query, dishes };
}

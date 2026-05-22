// React Query hook for GET /me/dishes — the Dishes tab list.
// WS7-3 Block C1: API + hook foundation; the Dishes screen migrates in a later
// C-block.
//
// Query key ["dishes", "list", <filter>] — the filter selection is part of
// the key so each chip combination caches independently. staleTime uses the
// global personal-mutable default (60_000).

import { useQuery } from "@tanstack/react-query";

import {
  getDishes,
  type DishFilterKey,
  type DishListResponse,
} from "@/lib/api/dishes";

export function useDishes(filter?: readonly DishFilterKey[]) {
  return useQuery<DishListResponse>({
    queryKey: ["dishes", "list", filter ?? null],
    queryFn: () => getDishes(filter),
  });
}

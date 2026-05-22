// React Query hook for GET /dishes/:id — dish detail.
// WS7-3 Block C1: API + hook foundation; the Dish detail screen migrates in a
// later C-block.
//
// Query key ["dishes", "detail", id]. An empty id (missing route param) never
// hits the network. staleTime uses the global personal-mutable default.

import { useQuery } from "@tanstack/react-query";

import { getDish, type DishDetail } from "@/lib/api/dishes";

export function useDish(id: string) {
  return useQuery<DishDetail>({
    queryKey: ["dishes", "detail", id],
    queryFn: () => getDish(id),
    enabled: id.length > 0,
  });
}

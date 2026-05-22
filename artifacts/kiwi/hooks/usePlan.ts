// React Query hook for GET /plans/:id — the Plan Review detail.
// WS7-3 Block C1: API + hook foundation; the Plan Review screen migrates in a
// later C-block.
//
// Query key ["plans", "detail", id]. An empty id (missing route param) never
// hits the network. staleTime uses the global personal-mutable default.

import { useQuery } from "@tanstack/react-query";

import { getPlan, type PlanDetail } from "@/lib/api/plans";

export function usePlan(id: string) {
  return useQuery<PlanDetail>({
    queryKey: ["plans", "detail", id],
    queryFn: () => getPlan(id),
    enabled: id.length > 0,
  });
}

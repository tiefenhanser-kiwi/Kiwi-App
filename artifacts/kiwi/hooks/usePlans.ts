// React Query hook for GET /plans — the Plan Discovery list.
// WS7-3 Block C1: API + hook foundation; the Plans screen migrates in a later
// C-block.
//
// Query key ["plans", "list", <filter>] — the filter selection is part of the
// key so each chip combination caches independently. staleTime uses the
// global personal-mutable default (60_000).

import { useQuery } from "@tanstack/react-query";

import {
  getPlans,
  type PlanFilterKey,
  type PlanListResponse,
} from "@/lib/api/plans";

// CLIENT-3 F — `enabled` (default true) lets Cook Mode read this week's plan only
// once it needs it.
export function usePlans(
  filter?: readonly PlanFilterKey[],
  opts: { enabled?: boolean } = {},
) {
  return useQuery<PlanListResponse>({
    queryKey: ["plans", "list", filter ?? null],
    queryFn: () => getPlans(filter),
    enabled: opts.enabled ?? true,
  });
}

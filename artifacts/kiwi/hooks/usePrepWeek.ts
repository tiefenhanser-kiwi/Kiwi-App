// React Query hook for POST /plans/:planId/prep-week — the Prep the Week
// GENERATE call (WS7-8b Block 4, Screen 3). Mirrors useCookingSequence: a
// POST-via-query launch read.
//
// Query key follows the documented convention (lib/api/README.md):
// ["cooking", "prep-week", planId]. The server caches the assembled structure by
// plan revisionId (a re-call on an unchanged plan is a cheap cacheHit, no AI), so
// staleTime is Infinity — a prep session never needs to refetch mid-flow. Block 3
// invalidates this key on plan edit / after a completion write if it needs fresh
// state.
//
// `getPrepWeek` returns a PrepWeekOutcome union, NOT a raw envelope: a 402
// entitlement gate resolves as `{ kind: "upgrade_required" }` (a SUCCESSFUL
// query — the screen shows a gentle upgrade affordance, never a hard paywall).
// Every other failure (404/502/401/schema) throws → React Query `isError`.

import { useQuery } from "@tanstack/react-query";

import { getPrepWeek, type PrepWeekOutcome } from "@/lib/api/cooking";

export function usePrepWeek(planId: string, enabled = true) {
  return useQuery<PrepWeekOutcome>({
    queryKey: ["cooking", "prep-week", planId],
    queryFn: () => getPrepWeek(planId),
    enabled: enabled && planId.length > 0,
    staleTime: Infinity,
  });
}

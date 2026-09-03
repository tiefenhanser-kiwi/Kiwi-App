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

// WS9 — Prep Selected Meals. 🔴 A subset result MUST NOT land under the
// full-week key. That key has staleTime: Infinity and is the cache every other
// prep surface reads/invalidates (prepCompletionToggle.ts, usePrepWeekComple-
// tions.ts); a two-meal envelope stored there would be served as the canonical
// week for the rest of the session — the client-side twin of the server's
// planId-keyed structure row, and just as silent.
//
// The subset key EXTENDS the full-week key rather than replacing it, so the two
// can never alias. ⚠️ Because React Query matches by key PREFIX, that also means
// any future `invalidateQueries(["cooking","prep-week",planId])` would refetch
// every mounted subset — and each of those refetches is a live AI call at
// ~$0.12. No such invalidation exists today: `prepCompletionInvalidationKeys`
// deliberately omits the generate key (prepCompletionToggle.ts), which is why a
// checkbox write does not re-run generation. Keep it that way.
//
// Ids are sorted so selection ORDER doesn't fragment the cache — the same two
// meals picked in either order is one entry, and therefore one AI call.
function prepWeekQueryKey(planId: string, mealIds?: string[]) {
  if (!mealIds || mealIds.length === 0) return ["cooking", "prep-week", planId];
  return ["cooking", "prep-week", planId, "subset", [...mealIds].sort().join(",")];
}

export function usePrepWeek(
  planId: string,
  enabled = true,
  mealIds?: string[],
) {
  const isSubset = !!mealIds && mealIds.length > 0;
  return useQuery<PrepWeekOutcome>({
    queryKey: prepWeekQueryKey(planId, mealIds),
    queryFn: () => getPrepWeek(planId, isSubset ? mealIds : undefined),
    enabled: enabled && planId.length > 0,
    staleTime: Infinity,
  });
}

export { prepWeekQueryKey };

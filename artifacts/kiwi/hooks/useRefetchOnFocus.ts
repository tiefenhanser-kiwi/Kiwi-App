// WS7-6 (E) Block 2 §6 — focus-driven refetch backstop.
//
// React Query's native refetchOnWindowFocus is a no-op on RN with the
// current QueryClient defaults (refetchOnWindowFocus: false, staleTime:
// 60_000 — see app/_layout.tsx). After a server-side mutation routed
// through some screen *other than this one* (e.g. activating a plan from
// Plan Review while Home is mounted in the background), the precise
// ["home"] / ["plans"] invalidations land first, but a user who returns
// to a tab whose query has gone stale benefits from a focus-driven kick.
//
// We call query.refetch() inside useFocusEffect — refetch() honors React
// Query's staleness gate when no params force it, so fresh data (within
// the 60_000 default) is not refetched. Tabs that re-focus inside the
// stale window pay nothing.

import { useCallback } from "react";
import { useFocusEffect } from "expo-router";

interface RefetchableQuery {
  /** Whether the query's cached data is past its staleTime. */
  isStale: boolean;
  /** React Query's bound refetch. */
  refetch: () => unknown;
}

export function useRefetchOnFocus(query: RefetchableQuery): void {
  useFocusEffect(
    useCallback(() => {
      if (query.isStale) {
        query.refetch();
      }
      // No cleanup — useFocusEffect re-runs the callback on each focus.
      return undefined;
    }, [query.isStale, query.refetch]),
  );
}

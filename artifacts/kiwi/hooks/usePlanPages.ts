// CLIENT-9 E (BUG-467) — GET /plans, page after page, for the Plans tab.
//
// Query key ["plans", "pages", <filter>, <q>]: under the ["plans"] prefix, so a
// plan mutation's invalidateQueries({ queryKey: ["plans"] }) refetches it and
// compost's optimistic removal (useCompostWithUndo) reaches its pages. The first
// page of a new search keeps the previous rows on screen until it lands.

import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";

import { getPlans, type PlanFilterKey } from "@/lib/api/plans";
import { PLAN_PAGE_SIZE } from "@/lib/plans/planPages";

export function usePlanPages(filter: readonly PlanFilterKey[], q: string) {
  return useInfiniteQuery({
    queryKey: ["plans", "pages", filter, q],
    queryFn: ({ pageParam }) => getPlans(filter, { cursor: pageParam, q, limit: PLAN_PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

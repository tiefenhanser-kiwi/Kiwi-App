// CLIENT-6 C (BUG-583) — React Query hook for GET /plans/:planId/prep-week/structure,
// the plan's prep step set with no AI call (Part J.1b). Cook Mode reads it after
// "Yes, I prepped" to fold the steps the prep covered. Its own key, beside the
// generate key, so nothing here can be served as Prep the Week's payload.

import { useQuery } from "@tanstack/react-query";

import { getPrepWeekStructure, type PrepWeekStructure } from "@/lib/api/cooking";

export function usePrepWeekStructure(planId: string) {
  return useQuery<PrepWeekStructure>({
    queryKey: ["cooking", "prep-week-structure", planId],
    queryFn: () => getPrepWeekStructure(planId),
    enabled: planId.length > 0,
  });
}

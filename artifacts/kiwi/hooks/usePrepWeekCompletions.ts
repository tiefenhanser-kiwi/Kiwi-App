// React Query hook for GET /plans/:planId/prep-week/completions — the Week Prep
// RESUME read (WS7-8b Block 4, Build Block 3). Provides the persisted checked
// stepKeys so a returning user sees their progress (PRD §13.4.5).
//
// Key: ["cooking","prep-week-completions",planId] — DISTINCT from the generate
// key ["cooking","prep-week",planId] (usePrepWeek). The separation is load-
// bearing: a completion write invalidates THIS key (cheap GET) and never the
// expensive AI generate call. staleTime is the personal-mutable default so a
// post-write invalidation refetches; the write path also setQueryData's this
// cache optimistically for instant feedback.

import { useQuery } from "@tanstack/react-query";

import {
  getPrepWeekCompletions,
  type PrepWeekCompletions,
} from "@/lib/api/cooking";
import { prepWeekCompletionsKey } from "@/lib/cooking/prepCompletionToggle";

export function usePrepWeekCompletions(planId: string, enabled = true) {
  return useQuery<PrepWeekCompletions>({
    queryKey: prepWeekCompletionsKey(planId),
    queryFn: () => getPrepWeekCompletions(planId),
    enabled: enabled && planId.length > 0,
  });
}

// WS7-8b Block 4 (Build Block 3) — the prep-completion write hook.
//
// A thin React Query wrapper over the pure runners in lib/cooking/
// prepCompletionToggle.ts: it supplies live deps (the resume cache + the check/
// uncheck verbs + the sibling-cache invalidation) so the runners do the
// optimistic update, the revert, and the propagation. Returns:
//   - `toggle(stepKey, nextChecked)` — the per-step checkbox write.
//   - `completePhase(stepKeys)` — R1: batch-check a whole phase in one optimistic
//     write + one invalidation (Done with phase / Finish prep).
// Both share ONE deps builder so they operate on the same resume cache.

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  checkPrepStep,
  uncheckPrepStep,
  type PrepWeekCompletions,
} from "@/lib/api/cooking";
import {
  prepCompletionInvalidationKeys,
  prepWeekCompletionsKey,
  runPrepPhaseComplete,
  runPrepStepToggle,
  type PrepToggleDeps,
} from "@/lib/cooking/prepCompletionToggle";

export function usePrepStepToggle(planId: string) {
  const queryClient = useQueryClient();

  const buildDeps = useCallback((): PrepToggleDeps => {
    const key = prepWeekCompletionsKey(planId);
    return {
      cancel: () => queryClient.cancelQueries({ queryKey: key }),
      getCompletions: () => queryClient.getQueryData<PrepWeekCompletions>(key),
      setCompletions: (next) => queryClient.setQueryData(key, next),
      check: (k) => checkPrepStep(planId, k),
      uncheck: (k) => uncheckPrepStep(planId, k),
      invalidate: () => {
        for (const k of prepCompletionInvalidationKeys(planId)) {
          void queryClient.invalidateQueries({ queryKey: k });
        }
      },
      nowIso: () => new Date().toISOString(),
    };
  }, [planId, queryClient]);

  const toggle = useCallback(
    (stepKey: string, nextChecked: boolean) =>
      runPrepStepToggle(buildDeps(), stepKey, nextChecked),
    [buildDeps],
  );

  const completePhase = useCallback(
    (stepKeys: readonly string[]) =>
      runPrepPhaseComplete(buildDeps(), stepKeys),
    [buildDeps],
  );

  return { toggle, completePhase };
}

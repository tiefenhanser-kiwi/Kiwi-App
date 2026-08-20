// BUG-104 — React wiring for the optimistic plan-write runner.
//
// A thin wrapper over the pure runner in lib/plans/planWriteRunner.ts,
// deliberately shaped like hooks/usePrepStepToggle.ts (the in-repo pattern this
// follows): the hook supplies live deps — cancelQueries, get/setQueryData on
// ["plans","detail",planId], the shared invalidation set, and the write-depth
// counter from AppContext — and the runner owns the ordering.
//
// The write-depth counter lives on AppContext rather than here because it must
// be SHARED across every plan write on the screen; a per-hook-instance counter
// would let two different mutations each think they were the only one in
// flight, which is the exact race being fixed.

import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useApp } from "@/contexts/AppContext";
import type { PlanDetail } from "@/lib/api/plans";
import {
  applyToDetail,
  runPlanWrite,
  type PlanWriteDeps,
} from "@/lib/plans/planWriteRunner";

export function usePlanWrite(planId: string) {
  const queryClient = useQueryClient();
  const { beginPlanWrite, endPlanWrite, invalidatePlanCaches } = useApp();

  const deps: PlanWriteDeps = useMemo(() => {
    const key = ["plans", "detail", planId];
    return {
      cancel: () => queryClient.cancelQueries({ queryKey: key }),
      getDetail: () => queryClient.getQueryData<PlanDetail>(key),
      setDetail: (next) => queryClient.setQueryData(key, next),
      invalidate: invalidatePlanCaches,
      beginWrite: beginPlanWrite,
      endWrite: endPlanWrite,
    };
  }, [
    planId,
    queryClient,
    invalidatePlanCaches,
    beginPlanWrite,
    endPlanWrite,
  ]);

  /** Optimistically apply `apply` to the cached plan, then run `write`. */
  const write = useCallback(
    <T,>(
      apply: (prev: PlanDetail) => PlanDetail,
      run: () => Promise<T>,
    ): Promise<T> => runPlanWrite(deps, apply, run),
    [deps],
  );

  /** Post-response cache touch-up outside the optimistic/rollback window. */
  const patchCache = useCallback(
    (apply: (prev: PlanDetail) => PlanDetail): void => {
      applyToDetail(deps, apply);
    },
    [deps],
  );

  return { write, patchCache };
}

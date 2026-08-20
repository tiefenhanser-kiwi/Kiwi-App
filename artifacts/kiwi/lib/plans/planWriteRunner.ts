// BUG-104 — the optimistic runner behind every Plan Review write.
//
// Modelled directly on lib/cooking/prepCompletionToggle.ts's runPrepStepToggle
// (the in-repo pattern: cancel → snapshot → optimistic setQueryData → write →
// revert on failure → invalidate). Two things differ, and both are forced by
// the defect this fixes:
//
//  1. It carries a WRITE-DEPTH counter. cancelQueries alone does NOT close the
//     race, and that is the subtle half of BUG-104. Cancelling at write-start
//     kills the GET that is in flight WHEN THE WRITE STARTS, but each write's
//     own success invalidation starts a FRESH refetch:
//
//       tap A: cancel, optimistic A, PATCH A
//       tap B: cancel (kills nothing yet), optimistic B, PATCH B
//       PATCH A resolves → invalidate → GET starts → resolves post-A/pre-B
//                       → cache reverts to pre-B → B is wiped        ← still broken
//       PATCH B resolves → invalidate → converges
//
//     So the invalidation must be DEFERRED until the last concurrent write
//     settles. The depth counter does that: every write increments on entry,
//     decrements in `finally`, and only the write that returns the depth to 0
//     invalidates. One burst of taps costs exactly one refetch.
//
//  2. It rolls the CACHE back rather than a component's state, so the screen's
//     `reviewPlan` mirror — which is re-seeded wholesale from the cache — is a
//     pure derivation of something already correct.
//
// PURE: deps are injected, so a unit test drives it with fakes and no
// QueryClient. React wiring lives in hooks/usePlanWrite.ts.

import type { PlanDetail } from "@/lib/api/plans";

export interface PlanWriteDeps {
  /**
   * Cancel in-flight fetches for THIS plan's detail query before the optimistic
   * write lands. Without it, a GET that started before the tap resolves after
   * the optimistic setQueryData and overwrites it.
   */
  cancel: () => Promise<void> | void;
  getDetail: () => PlanDetail | undefined;
  setDetail: (next: PlanDetail | undefined) => void;
  /** Invalidate the plans/home/groceries caches. Called ONCE per burst. */
  invalidate: () => void;
  /** Increment the write depth; returns the depth AFTER incrementing (≥1). */
  beginWrite: () => number;
  /** Decrement the write depth; returns the depth AFTER decrementing (≥0). */
  endWrite: () => number;
}

/**
 * Run one optimistic plan write.
 *
 * `apply` is a pure PlanDetail → PlanDetail transform (see
 * planDetailOptimistic.ts). `write` performs the server call and resolves with
 * whatever the caller needs back (e.g. Change Meal's new item id).
 *
 * On failure the cache is restored to the pre-write snapshot and the error is
 * RETHROWN, so the caller can surface a message. Callers must not swallow it
 * silently — that is BUG-112.
 *
 * The invalidation runs in `finally` on the last concurrent write, whether that
 * write succeeded or was rolled back, so the client always reconciles to server
 * truth exactly once per burst.
 */
export async function runPlanWrite<T>(
  deps: PlanWriteDeps,
  apply: (prev: PlanDetail) => PlanDetail,
  write: () => Promise<T>,
): Promise<T> {
  deps.beginWrite();
  await deps.cancel();
  const snapshot = deps.getDetail();
  if (snapshot) {
    deps.setDetail(apply(snapshot));
  }
  try {
    return await write();
  } catch (err) {
    // Restore the exact pre-write payload. Only this write's optimism is
    // undone in the single-write case; in a burst the snapshot may also carry a
    // sibling's optimism, and the deferred invalidation below reconciles the
    // whole burst to server truth regardless.
    deps.setDetail(snapshot);
    throw err;
  } finally {
    if (deps.endWrite() === 0) {
      deps.invalidate();
    }
  }
}

/**
 * Apply a follow-up transform to the cache OUTSIDE the optimistic/rollback
 * window — used by Change Meal to repoint the row's id to the server's freshly
 * created item as soon as the response lands, ahead of the refetch.
 */
export function applyToDetail(
  deps: Pick<PlanWriteDeps, "getDetail" | "setDetail">,
  apply: (prev: PlanDetail) => PlanDetail,
): void {
  const current = deps.getDetail();
  if (current) deps.setDetail(apply(current));
}

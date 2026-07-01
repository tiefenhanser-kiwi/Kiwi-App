// WS7-8b Block 4 (Build Block 3) — pure logic behind the per-step completion
// write (D-WS7-157). Kept React-free so the optimistic update, the revert, and
// the cache-invalidation key set are all unit-testable without mounting a
// QueryClient. The hook (hooks/usePrepStepToggle.ts) is a thin wrapper that
// supplies live deps from React Query.

import type { PrepCompletionRow, PrepWeekCompletions } from "@/lib/api/cooking";

// ── Query keys ──────────────────────────────────────────────────────────────

/**
 * The RESUME read key — DISTINCT from the generate key
 * `["cooking","prep-week",planId]` (usePrepWeek, staleTime: Infinity). Keeping
 * them separate means a completion write invalidating the resume read NEVER
 * refetches the expensive AI generate call. (Confirmed in the Phase 1 plan.)
 */
export function prepWeekCompletionsKey(planId: string): string[] {
  return ["cooking", "prep-week-completions", planId];
}

/**
 * The caches a completion write must invalidate so the rollup propagates across
 * screens (the D-WS7-157 skip-loop):
 *   - ["plans"]              → GET /plans/:id re-derives per-meal isPrepped, which
 *                              the single-meal Cook prep gate reads.
 *   - ["meals","detail"]     → the cook screen's meal read isn't left stale
 *                              (BUG-001 stale-sibling class).
 *   - ["home"]               → the Hub's prep indicator/pills read server prep
 *                              status; the Hub is reachable right after a session.
 *   - prepWeekCompletionsKey → reconcile the optimistic resume state with server.
 * Deliberately EXCLUDES the generate key (see prepWeekCompletionsKey).
 */
export function prepCompletionInvalidationKeys(planId: string): string[][] {
  return [
    ["plans"],
    ["meals", "detail"],
    ["home"],
    prepWeekCompletionsKey(planId),
  ];
}

// ── Optimistic row update ───────────────────────────────────────────────────

/**
 * Apply a check/uncheck to the resume rows, idempotently:
 *   - check (nextChecked=true): add a row if absent; no-op if already present
 *     (keeps the existing checkedAt, mirroring the server's upsert).
 *   - uncheck (nextChecked=false): drop the row if present; no-op if absent.
 * Pure — returns a new array (or the same ref when it's a no-op).
 */
export function toggleCompletionRows(
  rows: readonly PrepCompletionRow[],
  stepKey: string,
  nextChecked: boolean,
  nowIso: string,
): PrepCompletionRow[] {
  const exists = rows.some((r) => r.stepKey === stepKey);
  if (nextChecked) {
    return exists ? [...rows] : [...rows, { stepKey, checkedAt: nowIso }];
  }
  return exists ? rows.filter((r) => r.stepKey !== stepKey) : [...rows];
}

// ── Optimistic toggle runner (snapshot → optimistic → write → revert) ─────────

/**
 * The deps the runner needs — a minimal cache+network surface so it can be
 * driven by fakes in a unit test. Mirrors the codebase's AppContext optimistic
 * convention (snapshot the query data, setQueryData optimistically, revert on
 * failure, invalidate to reconcile).
 */
export interface PrepToggleDeps {
  cancel: () => Promise<void> | void;
  getCompletions: () => PrepWeekCompletions | undefined;
  setCompletions: (next: PrepWeekCompletions | undefined) => void;
  check: (stepKey: string) => Promise<unknown>;
  uncheck: (stepKey: string) => Promise<unknown>;
  invalidate: () => void;
  nowIso: () => string;
}

/**
 * Run one optimistic check/uncheck. Snapshots the resume cache, applies the
 * optimistic row update, fires the server write, REVERTS to the snapshot on
 * failure (then rethrows so the caller can surface a non-blocking message), and
 * ALWAYS invalidates the sibling caches in `finally` so the rollup propagates
 * whether the write succeeded or was reverted.
 */
export async function runPrepStepToggle(
  deps: PrepToggleDeps,
  stepKey: string,
  nextChecked: boolean,
): Promise<void> {
  await deps.cancel();
  const snapshot = deps.getCompletions();
  if (snapshot) {
    deps.setCompletions({
      ...snapshot,
      completions: toggleCompletionRows(
        snapshot.completions,
        stepKey,
        nextChecked,
        deps.nowIso(),
      ),
    });
  }
  try {
    if (nextChecked) await deps.check(stepKey);
    else await deps.uncheck(stepKey);
  } catch (err) {
    deps.setCompletions(snapshot); // revert to the pre-toggle snapshot
    throw err;
  } finally {
    deps.invalidate();
  }
}

/**
 * Batch-complete a whole phase (WS7-8b Block 3 R1): "Done with phase ✓" /
 * "Finish prep ✓" assert the entire phase is done, so this checks EVERY not-yet-
 * checked step in one pass. Reuses the same optimistic machinery as
 * {@link runPrepStepToggle}, but batched so N steps cost ONE optimistic cache
 * write and ONE invalidation (not N re-renders / N `["plans"]` refetches):
 *   - filters to the steps that aren't already checked (idempotent — never
 *     re-writes an already-checked step);
 *   - if none remain, it's a no-op (no write, no invalidation — the phase's
 *     rollup is already correct), so the caller can advance freely;
 *   - otherwise applies all adds to the resume cache in a SINGLE setCompletions,
 *     fires the checks concurrently, reverts the whole batch on any failure
 *     (then rethrows so the caller stays on the phase + shows the banner), and
 *     invalidates ONCE in `finally`.
 *
 * The caller passes the phase's full stepKey list; this owns the not-yet-checked
 * filtering so idempotency has a single home. Never advances the pointer — that
 * is the caller's job, gated on this resolving (do-not-advance-on-failure).
 */
export async function runPrepPhaseComplete(
  deps: PrepToggleDeps,
  stepKeys: readonly string[],
): Promise<void> {
  await deps.cancel();
  const snapshot = deps.getCompletions();
  const already = new Set(snapshot?.completions.map((r) => r.stepKey) ?? []);
  const toCheck = stepKeys.filter((k) => !already.has(k));
  if (toCheck.length === 0) return; // whole phase already checked — nothing to do

  // One optimistic cache write for the whole batch (fold every add, set once).
  if (snapshot) {
    const now = deps.nowIso();
    let rows = snapshot.completions;
    for (const k of toCheck) rows = toggleCompletionRows(rows, k, true, now);
    deps.setCompletions({ ...snapshot, completions: rows });
  }
  try {
    await Promise.all(toCheck.map((k) => deps.check(k)));
  } catch (err) {
    deps.setCompletions(snapshot); // revert the whole batch on any failure
    throw err;
  } finally {
    deps.invalidate(); // once, after the batch settles (not per step)
  }
}

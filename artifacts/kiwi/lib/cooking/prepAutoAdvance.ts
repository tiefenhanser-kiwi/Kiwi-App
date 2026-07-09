// WS7-8b Block A (BUG-024) — pure auto-advance guard for Week Prep (Screen 3).
//
// When the user hand-checks the LAST unchecked step of a phase, the phase flips
// to all-done and Prep the Week auto-advances to the next phase (+ a toast), or
// finishes on the last phase. The container (PrepWeekScreen) owns the React
// state (the phase pointer, the toast, the completion write); this module is the
// pure, unit-testable decision logic that keeps that advance EXACTLY ONCE per
// all-done episode — the one subtle correctness point.
//
// Two concerns, two helpers, deliberately separated so each is verifiable:
//
//  • EDGE (isPrepAllDoneEdge): only a genuine false→true flip of the CURRENT
//    phase's all-done is an advance trigger. Mount, vacuously-empty phases, a
//    resumed-already-complete phase, and pointer moves are NOT edges, so they
//    never auto-advance (BUG-024 is specifically "advance on per-step CHECKING").
//
//  • LATCH (requestPrepAdvance / releasePrepAdvance): the same all-done state can
//    be reached by BOTH the per-step effect AND the "Mark all complete" button in
//    the same tick. The latch (the phase index already acted on) makes the second
//    caller a no-op, so the phase advances once, not twice — the double-advance
//    guard. The absolute `to` (from + 1) makes the pointer move itself idempotent
//    too, so even a bypassed latch can never SKIP a phase.

export type PrepAdvanceEffect =
  | { kind: "advance"; from: number; to: number }
  | { kind: "finish"; from: number }
  | { kind: "none" };

/** What the edge test remembers between renders: the last observed all-done of a
 *  given phase index. `null` before the first observation (i.e. on mount). */
export interface PrepAllDoneObservation {
  index: number;
  allDone: boolean;
}

/**
 * Idempotent advance/finish decision for a COMPLETED phase, guarded by `latch`
 * (the phase index whose current all-done episode has already been acted on).
 * Both the per-step all-done effect and the "Mark all complete" button call this
 * with the completed phase index; whichever arrives first advances, the other
 * gets `{ kind: "none" }`. Non-last → advance to `from + 1` (absolute, so the
 * pointer move is idempotent); last phase → finish.
 */
export function requestPrepAdvance(
  latch: number | null,
  completedIndex: number,
  phaseCount: number,
): { latch: number | null; effect: PrepAdvanceEffect } {
  if (latch === completedIndex) return { latch, effect: { kind: "none" } };
  const isLast = completedIndex >= phaseCount - 1;
  return {
    latch: completedIndex,
    effect: isLast
      ? { kind: "finish", from: completedIndex }
      : { kind: "advance", from: completedIndex, to: completedIndex + 1 },
  };
}

/**
 * Release the latch when a phase leaves all-done (a step gets un-checked), so a
 * later re-completion of the SAME phase advances again. No-op unless the latch is
 * held by exactly this phase.
 */
export function releasePrepAdvance(
  latch: number | null,
  phaseIndex: number,
): number | null {
  return latch === phaseIndex ? null : latch;
}

/**
 * True only on a genuine false→true flip of the CURRENT phase's all-done from the
 * last observation. Guards against auto-advancing on mount (`last === null`), on
 * a vacuously-empty or resumed-complete phase (already-true, no flip), on leaving
 * all-done (true→false), and on a pointer move to a different phase index.
 */
export function isPrepAllDoneEdge(
  last: PrepAllDoneObservation | null,
  phaseIndex: number,
  currentAllDone: boolean,
): boolean {
  return (
    last != null &&
    last.index === phaseIndex &&
    last.allDone === false &&
    currentAllDone === true
  );
}

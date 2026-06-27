// WS7-8b Block 4 (Block 1) — shared per-step wall-clock timer math.
//
// Lifted VERBATIM from cookSession.ts (single-meal Cook Mode) so the Week Prep
// screen can reuse the same timer chips. Wall-clock model: a started timer
// stores `endsAt` (epoch ms). A single ticking "now" drives every chip's
// remaining time, so concurrency (many timers at once) and continuation across
// navigation / brief app-background come for free — remaining is always
// `endsAt - now`, independent of which step is the anchor. The live state + the
// interval live in the hook (useStepTimers); these are the pure math. No logic
// change from the original — cookSession.ts re-exports for back-compat.

export interface ActiveTimer {
  /** Epoch ms at which the countdown reaches zero. */
  endsAt: number;
  /** The full duration it was started with (for progress/restart). */
  durationMs: number;
}

/** Remaining milliseconds, clamped at 0. */
export function timerRemainingMs(timer: ActiveTimer, nowMs: number): number {
  return Math.max(0, timer.endsAt - nowMs);
}

/** True once the wall clock has reached/passed the timer's end. */
export function isTimerDone(timer: ActiveTimer, nowMs: number): boolean {
  return nowMs >= timer.endsAt;
}

/**
 * Format remaining ms as "M:SS" (minutes uncapped). Rounds UP to the next whole
 * second so a freshly-started 5-minute timer reads "5:00", not "4:59".
 */
export function formatClock(ms: number): string {
  const totalSeconds = Math.ceil(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

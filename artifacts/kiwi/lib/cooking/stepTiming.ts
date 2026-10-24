// WS7-8b Block 4 (Block 1) — shared step-duration math for the cook/prep footer.
//
// Lifted from cookSession.ts (single-meal Cook Mode). Generalized only in its
// PARAMETER TYPE — it now accepts any `{ estimatedMinutes }`-bearing list (a
// widening that CookStep already satisfies) so the Week Prep screen can sum its
// own step shape without importing the meal-shaped CookStep. The arithmetic is
// byte-for-byte the original; cookSession.ts re-exports for back-compat.

/**
 * Sum of estimated minutes for the steps from `fromIndex` to the end.
 *
 * 🔴 THIS IS NOT THE WALL CLOCK, AND IT MUST NOT BE SHOWN AS ONE. It ignores
 * every overlap rule `cookingScheduler` applies, so on a multi-dish meal it reads
 * far longer than the same steps actually take. Measured on the 13-plan census
 * (BUG-337): 48 of 54 meals overstated, median 43% over, worst 167% — the Carne
 * Asada Tacos footer said 116 minutes where the card and the schedule said 88.
 *
 * Use it ONLY where no serve-anchored offset exists: the unsequenced single-dish
 * flatten paths, and §27's defensive append. Everywhere else call
 * {@link remainingMinutesToServe}.
 */
export function remainingMinutes(
  steps: readonly { estimatedMinutes: number }[],
  fromIndex: number,
): number {
  return steps
    .slice(Math.max(0, fromIndex))
    .reduce((sum, s) => sum + (s.estimatedMinutes || 0), 0);
}

/**
 * WS9 BUG-337 / D-WS9-297 ruling 5 — minutes from the CURRENT step to serve,
 * read off the scheduler's own serve-anchored offset.
 *
 * ⚠️ TWO CLOCKS, NEVER THREE. `cookingScheduler` owns the wall clock;
 * `mealTiming` adapts it for the stamp the card reads; this reads the same
 * number for the footer. Anything that sums step minutes and calls the result
 * elapsed time is a THIRD clock, and a third clock is how the footer came to
 * contradict the card on 48 of 54 meals.
 *
 * Returns null when the step carries no offset (the flatten paths, §27's
 * append), so the caller falls back to {@link remainingMinutes} rather than
 * showing a confident zero.
 *
 * Skipping EARLIER steps (the prep gate) does not affect this: the offset is
 * measured forward from this step, so whatever was skipped before it is already
 * excluded. A later step being filtered out would make the true remainder
 * smaller — the number is then conservative, never short.
 */
export function remainingMinutesToServe(
  steps: readonly { startOffsetMinutes?: number | null }[],
  fromIndex: number,
): number | null {
  const step = steps[Math.max(0, fromIndex)];
  const off = step?.startOffsetMinutes;
  if (off == null) return null;
  return Math.max(0, -off);
}

/**
 * WEB-4d (R4) — a sequenced step whose window starts at serve or later: the
 * feast's dessert after the serve step ("Slice the pie and serve"). Its
 * remainder is 0, which hid the footer line, so the footer says "After serving"
 * instead. A 0-minute step at 0 is the serve moment itself, not after it; a step
 * with no offset (flatten paths, §27's append) is never after serving.
 */
export function startsAfterServe(
  step: { estimatedMinutes: number; startOffsetMinutes?: number | null } | undefined,
): boolean {
  const off = step?.startOffsetMinutes;
  if (off == null) return false;
  return off > 0 || (off === 0 && (step?.estimatedMinutes ?? 0) > 0);
}

/**
 * FIX-3 / BUG-344 — the number Cook Mode's footer shows, or null to show none.
 *
 * An unsequenced meal (a single-dish meal, or any flatten path) carries no
 * serve-anchored offset on ANY step, and its only number is the serial sum
 * {@link remainingMinutes} warns about. TRIAGE-0 measured that on all 242
 * single-dish catalog meals: 126 overstated, worst +46 min. Hans: hide it until
 * Part K gives those meals a real clock. So: no offset anywhere → null.
 *
 * A sequenced meal keeps its serve-anchored reading, and §27's appended tail
 * (no offset on those steps only) keeps the fallback it always had.
 */
export function cookFooterMinutes(
  steps: readonly { estimatedMinutes: number; startOffsetMinutes?: number | null }[],
  fromIndex: number,
): number | null {
  if (!steps.some((s) => s.startOffsetMinutes != null)) return null;
  return remainingMinutesToServe(steps, fromIndex) ?? remainingMinutes(steps, fromIndex);
}

// ── CLIENT-1 (BUG-507) — "Next step in N minutes" under a long step ─────────
//
// A step of 20 minutes or more (a roast, a simmer, a rise) leaves the cook free,
// and the question is when the next thing needs them. The answer is the next
// step's start minus this one's, off the same serve-anchored offsets the footer
// reads (so it is the scheduler's clock, never a sum of step minutes) — whatever
// dish that next step belongs to. Relative only (Hans, Oct 23): no clock time,
// no serving-time target.
//
// "Next" is the next step the cook will be on: a step Prep the Week already did
// is drawn collapsed and stepped over by Next, so it is stepped over here too.
// With no offset on either step (an unsequenced meal, §27's append) there is no
// answer, and no line.

/** A step this long or longer gets the line. */
export const NEXT_STEP_LINE_MIN_MINUTES = 20;

export function nextStepLine(
  steps: readonly { key: string; estimatedMinutes: number; startOffsetMinutes?: number | null }[],
  index: number,
  doneInPrepKeys: ReadonlySet<string> = new Set(),
): string | null {
  const step = steps[index];
  if (!step || step.estimatedMinutes < NEXT_STEP_LINE_MIN_MINUTES) return null;
  if (step.startOffsetMinutes == null) return null;
  const next = steps.slice(index + 1).find((s) => !doneInPrepKeys.has(s.key));
  if (!next || next.startOffsetMinutes == null) return null;
  const raw = next.startOffsetMinutes - step.startOffsetMinutes;
  if (raw < 1) return "Next step now";
  const gap = Math.round(raw);
  return `Next step in ${gap} ${gap === 1 ? "minute" : "minutes"}`;
}

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

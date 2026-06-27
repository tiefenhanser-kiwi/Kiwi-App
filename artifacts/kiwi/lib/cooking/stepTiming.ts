// WS7-8b Block 4 (Block 1) — shared step-duration math for the cook/prep footer.
//
// Lifted from cookSession.ts (single-meal Cook Mode). Generalized only in its
// PARAMETER TYPE — it now accepts any `{ estimatedMinutes }`-bearing list (a
// widening that CookStep already satisfies) so the Week Prep screen can sum its
// own step shape without importing the meal-shaped CookStep. The arithmetic is
// byte-for-byte the original; cookSession.ts re-exports for back-compat.

/** Sum of estimated minutes for the steps from `fromIndex` to the end. */
export function remainingMinutes(
  steps: readonly { estimatedMinutes: number }[],
  fromIndex: number,
): number {
  return steps
    .slice(Math.max(0, fromIndex))
    .reduce((sum, s) => sum + (s.estimatedMinutes || 0), 0);
}

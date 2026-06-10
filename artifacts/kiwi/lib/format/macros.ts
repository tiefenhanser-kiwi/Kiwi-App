// WS7-6 (E) Block 2 §1 — shared macro/calorie display formatter.
//
// Kills the "51.60000000000001g" float artifact at RAW render sites by
// rounding to whole numbers. Null/undefined/NaN render as the caller's
// fallback (default "—" to match Plan Review's daily-averages convention).

export function formatMacro(
  value: number | null | undefined,
  fallback: string = "—",
): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return String(Math.round(value));
}

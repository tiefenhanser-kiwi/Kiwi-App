// WS9 BUG-245 (D-WS9-235) — the ONE place a meal's minutes are formatted for
// the plan review row and the Meal Detail header.
//
// Two rules live here so they cannot drift between surfaces:
//   1. A wizard DRAFT's time is an estimate: since f6e6571 it is derived from
//      the step outline the AI writes at expand; the saved recipe's real steps
//      re-derive it at save and a single-digit gap is expected to remain. The
//      draft renders with a leading tilde ("~38 min") so the change at save
//      reads as expected, not as a bug. Saved plans and Meal Detail never tilde.
//   2. Hands-on time renders only where the server sends `activeTimeMinutes`
//      (nullable, beside `minutes`). Null or absent → the line is byte-identical
//      to the pre-BUG-245 render. Never computed on the client.
export function formatMealTime(
  minutes: number,
  activeTimeMinutes?: number | null,
  opts: { estimate?: boolean } = {},
): string {
  const mark = opts.estimate ? "~" : "";
  const total = `${mark}${minutes} min`;
  if (activeTimeMinutes === null || activeTimeMinutes === undefined) {
    return total;
  }
  return `${total} · ${mark}${activeTimeMinutes} min hands-on`;
}

// Prep the Week footer copy — Hans's device-pass wording (Oct 3):
//
//   "Next: {next step title} · This step: ~{n} min"
//   "Last step · This step: ~{n} min"            (on the last one)
//
// A "step" here is one page of the flow, which in Prep the Week is a PHASE
// (PrepWeekView renders one phase at a time). So the title is the next phase's
// server title, and n is the current phase's minutes summed over the steps
// that render (skipSuggested-demoted steps are already gone from the VM —
// D-WS7-184 — and count 0 under BUG-011, so nothing skipped is in either).
//
// The old pair read "~N min left", but N never went down as steps were
// ticked: it was always the phase's size. "This step: ~N min" says what the
// number is.
//
// A phase with nothing to prep has no minutes; the clause drops rather than
// promising "~0 min".

export function prepWeekFooterLine(
  nextTitle: string | null,
  minutes: number,
): string {
  const lead = nextTitle ? `Next: ${nextTitle}` : "Last step";
  return minutes > 0 ? `${lead} · This step: ~${minutes} min` : lead;
}

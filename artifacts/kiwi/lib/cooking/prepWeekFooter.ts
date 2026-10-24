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

// CLIENT-1 item 3 — "Skip this Prep" and the label step.
//
// PREP-3 3b puts "Label N containers" first, on the first phase with steps,
// and the labels are never to be skipped with the phase they open. The server
// says so with `skippable: false` on that phase, but the flag cannot be read
// alone: PRD 13.4.1 has always sent `skippable: false` on Produce and Proteins,
// and BUG-020 (Hans-ruled footer) shows Skip on every phase but the last
// regardless of it. Honouring the flag would take Skip off Produce again. And
// Prep the feast's label step keeps its phase's own flag (prepFeastLabels.ts
// splices the step in before the phases are built). So the rule keys on the
// step itself: Skip hides while the phase holds a label step not yet ticked.
// Once the labels are written, skipping the rest of the phase skips nothing of
// them, and Skip comes back.

/** The server's label step keys (prepWeekLabels.ts WEEK_LABEL_STEP_KEY,
 *  prepFeastLabels.ts FEAST_LABEL_STEP_KEY). */
export const LABEL_STEP_KEYS: readonly string[] = ["week-labels", "feast-labels"];

export function prepShowsSkip(
  phase: { steps: readonly { stepKey: string; done: boolean }[] } | undefined,
  onLastPhase: boolean,
): boolean {
  if (onLastPhase) return false;
  return !(phase?.steps.some((s) => LABEL_STEP_KEYS.includes(s.stepKey) && !s.done) ?? false);
}

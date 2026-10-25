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

// CLIENT-2 B1 (BUG-509) — "Skip this Prep" at any time.
//
// CLIENT-1 item 3 hid Skip while the phase held an unticked "Label N
// containers" step; Hans ruled Skip must be there at any time (the gate
// blocked previewing the session). So Skip shows on every phase but the last
// (BUG-020), whatever the phase's `skippable` flag says: PRD 13.4.1 sends
// `false` on Produce and Proteins, PREP-3 3b on the label step's phase, and
// the footer reads neither.

/** The server's label step keys (prepWeekLabels.ts WEEK_LABEL_STEP_KEY,
 *  prepFeastLabels.ts FEAST_LABEL_STEP_KEY). */
export const LABEL_STEP_KEYS: readonly string[] = ["week-labels", "feast-labels"];

export function prepShowsSkip(onLastPhase: boolean): boolean {
  return !onLastPhase;
}

/** CLIENT-2 B2 (BUG-509) — Hans's line above the label step's instructions. */
export const LABEL_STEP_REASSURANCE =
  "Don't worry, some of these containers combine at the end of the prep session. We'll take you step by step through the fastest and easiest way to prep your week.";

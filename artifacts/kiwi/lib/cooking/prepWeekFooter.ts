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

// CLIENT-3 E (BUG-534, client half) — the label step is the prep-area card:
//
//   Set up your prep area
//   As you chop and measure in this session, you'll fill {n} containers. Set
//   them out however works for you (tape and a pen work well for labels):
//   <one line per container>
//
// It replaces the server's "Label N containers" title, its "Write these on
// tape, one per container: A · B." instructions, and CLIENT-2 B2's "Don't worry,
// some of these containers combine…" line above them. The server still writes
// the step (prepWeekLabels.ts / prepFeastLabels.ts); the card reads its count
// and its list from it, so no server change is needed for this half.

export const PREP_AREA_TITLE = "Set up your prep area";

export function prepAreaBody(n: number): string {
  return `As you chop and measure in this session, you'll fill ${n} ${n === 1 ? "container" : "containers"}. Set them out however works for you (tape and a pen work well for labels):`;
}

const LABEL_LIST_LEAD = "one per container:";

/** The containers the server's instructions list, in order; null when the
 *  instructions are not in the form the server writes. */
export function prepAreaLabels(instructions: string): string[] | null {
  const at = instructions.indexOf(LABEL_LIST_LEAD);
  if (at < 0) return null;
  const list = instructions
    .slice(at + LABEL_LIST_LEAD.length)
    .trim()
    .replace(/\.$/, "")
    .split(" · ")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : null;
}

/**
 * {n} — the session's own count: the N of the server's "Label N containers"
 * (the week's list is cut at 800 characters, the count is not), else the
 * list's length; null when neither is there.
 */
export function prepAreaCount(title: string, labels: readonly string[] | null): number | null {
  const m = /^Label (\d+) containers?$/.exec(title.trim());
  if (m) return Number(m[1]);
  return labels ? labels.length : null;
}

export interface PrepAreaCard {
  title: string;
  body: string;
  /** One line per container; null → show the server's instructions as sent. */
  labels: string[] | null;
}

/** The card for a label step; null when the step does not carry a count. */
export function prepAreaCard(step: { stepKey: string; title: string; instructions: string }): PrepAreaCard | null {
  if (!LABEL_STEP_KEYS.includes(step.stepKey)) return null;
  const labels = prepAreaLabels(step.instructions);
  const n = prepAreaCount(step.title, labels);
  if (n === null) return null;
  return { title: PREP_AREA_TITLE, body: prepAreaBody(n), labels };
}

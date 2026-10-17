// PREP-2 item 5 — which shape Prep the Week (and Prep the feast) takes.
//
// Hans, on his Pixel at the largest text: "the footer that shows what steps the
// user are on goes pretty high on the screen and the header … goes down to the
// footer, so there's no way to get at the steps in the middle." The screen pins a
// header block (plan name, "— N meals combined —", the tally, the notice, "Phase n
// of 4", the progress bar) above the step list and a footer (a status line, the
// Skip / Save & Exit row, the back + Mark all complete row) below it. Each of those
// lines grows with the text; the window does not. At the largest sizes the two
// pinned blocks met and the list between them had no height at all. The layout
// predates PREP-1 (978e6dd pins the same blocks; PREP-1 added the notice line).
//
// So in the large-text shape: the header block scrolls away with the steps, and
// the footer is ONE row — back, Mark all complete, and "More" for the two quiet
// actions. Below it the screen is exactly as before.
//
// The same family of rule as lib/welcomeLayout.ts (BUG-347). app/** is outside the
// test glob (D-WS9-164), so the decision lives here.

/** At or above this system text scale (iOS AX sizes, Android 14+ / Samsung large). */
export const PREP_LARGE_TEXT_MIN_SCALE = 1.5;

/**
 * Below this many text-scale-1 dp of window height the pinned blocks crowd out the
 * list at ANY scale: what fits is the window's height over the text scale. 600
 * keeps a 667 pt iPhone SE at default text in today's shape, and reads a Pixel's
 * ~850 dp at 1.3× (stock Android's largest before 14: 654) as roomy enough.
 */
export const PREP_MIN_TEXT_HEIGHT = 600;

/** True → the header scrolls with the steps and the footer is one row. */
export function prepUsesLargeTextLayout(window: { fontScale: number; height: number }): boolean {
  const scale = window.fontScale > 0 ? window.fontScale : 1;
  return scale >= PREP_LARGE_TEXT_MIN_SCALE || window.height / scale < PREP_MIN_TEXT_HEIGHT;
}

/**
 * The large-text footer's most a label may grow. One row has to hold "←", "Mark all
 * complete" and "More" side by side; 1.3 is stock Android's own largest step, so a
 * label never reads smaller than an ordinary large-text phone shows it.
 */
export const PREP_FOOTER_MAX_FONT_SCALE = 1.3;

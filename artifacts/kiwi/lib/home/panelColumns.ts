// PREP-2 item 7 — how many cells a row of the Home "this week" card's action
// panel holds. Two, except at the largest text sizes: at 2x, "Grocery" alone is
// wider than half the card, and no wrap can fit a word wider than its cell (the
// web check at 2x showed it running past the cell's edge). At 1.5x every label
// still wraps cleanly inside a half-width cell.
//
// The same threshold as Welcome (lib/welcomeLayout.ts) and Prep the Week
// (lib/cooking/prepWeekLayout.ts): iOS's accessibility sizes, Android 14+'s
// largest. app/** and components/** logic that wants a test lives in lib/.

export const PANEL_ONE_COLUMN_MIN_SCALE = 1.5;

export function panelCellsPerRow(fontScale: number): 1 | 2 {
  return fontScale >= PANEL_ONE_COLUMN_MIN_SCALE ? 1 : 2;
}

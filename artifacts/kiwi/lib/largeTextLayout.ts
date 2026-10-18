// FIX-7 (BUG-439) — the bottom tab bar and the Featured chip at the largest
// Font + Display size. Hans, Session 2 (Android, both at maximum, app
// force-stopped first): "footer buttons are a little cut off, featured plans in
// the rail have a 'featured' chip that's displaying as 'feat'".
//
// Both are BUG-347's failures on new surfaces, and both reuse its fixes
// (lib/welcomeLayout.ts, app/(auth)/welcome.tsx):
//
//   - THE TAB BAR is a fixed 56 dp + the bottom inset. Its icon block (a 3 dp
//     indicator, a 4 dp gap, a 22 dp icon) plus an 11 sp label fills that at
//     fontScale 1; at 2.0 the label alone doubles, and five tabs in a ~320 dp
//     window (Android's largest Display size) leave ~64 dp a tab — "Groceries"
//     wraps, and the second line falls below the bar's fixed bottom edge. So,
//     as BUG-347 did for the Welcome footer: the label's growth is CAPPED
//     (Resub C1's maxFontSizeMultiplier), it is ONE line that shrinks to fit
//     (the wordmark's adjustsFontSizeToFit), and the bar grows by exactly the
//     capped label's extra height, so nothing is cut.
//   - THE CHIP is one unbreakable word in a pill with no width bound. Android
//     breaks a too-wide word mid-word — the wordmark's "Kiw", the chip's
//     "feat". Same answer as the wordmark: one line, shrink to fit, capped, and
//     a maxWidth so the shrink has an edge to measure against.
//
// app/** is outside the test glob (D-WS9-164), so the numbers live here.

/** The tab bar's height at fontScale 1, above the bottom inset (unchanged). */
export const TAB_BAR_BASE_HEIGHT = 56;

/** The most a tab label grows with the system text size. 11 × 1.5 = 16.5 sp:
 *  past this the five labels cannot share a 320 dp bar at any honest size. */
export const TAB_LABEL_MAX_SCALE = 1.5;

/** The label may shrink to this fraction of its (capped) size to stay on one
 *  line — "Groceries" in a 64 dp tab. 0.6 × 16.5 ≈ 10 sp, still legible. */
export const TAB_LABEL_MIN_FIT = 0.6;

/** The tab label's type size (Typography.fontSize.xs) and Android's default
 *  line height for it (~1.3 em — RN sets no lineHeight on these labels). */
const TAB_LABEL_SIZE = 11;
const TAB_LABEL_LINE = 1.3;

/**
 * The bar's height for a system text scale: the base, plus the label's extra
 * line height once it grows, capped where the label stops growing. At 1.0 (or
 * below — a user who shrank their text) it is exactly the base: nobody at
 * ordinary sizes sees a different bar.
 */
export function tabBarHeight(fontScale: number, bottomInset: number): number {
  const scale = Math.min(Math.max(fontScale, 1), TAB_LABEL_MAX_SCALE);
  const extra = Math.ceil(TAB_LABEL_SIZE * TAB_LABEL_LINE * (scale - 1));
  return TAB_BAR_BASE_HEIGHT + extra + bottomInset;
}

/** The Featured chip's growth cap — BUG-347's wordmark cap, same reasoning:
 *  it is a label over a photo, not body text, and it has a fixed card to fit. */
export const RAIL_CHIP_MAX_SCALE = 1.5;

/** The chip may shrink this far to keep its word whole. */
export const RAIL_CHIP_MIN_FIT = 0.5;

/** The pill's own left offset inside the card, mirrored on the right as its
 *  bound: the chip may span the card but never run past it. */
export const RAIL_CHIP_INSET = 7;

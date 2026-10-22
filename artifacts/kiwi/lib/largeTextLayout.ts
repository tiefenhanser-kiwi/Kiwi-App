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

// ── BUG-451 — the Prep & Cook hub's meal rows at large text ─────────────────
//
// Hans, Session 1 items 34–35: at the largest Font + Display sizes the meal
// names vanish; one step below, they wrap to a thin strip. The row is
// [tick cell · thumbnail · name + meta · status tag], and every cell but the
// name is fixed or grows with the text: the 52 dp tick cell, the thumbnail, and
// the tag, whose label scales. At fontScale 2 in a 320 dp window the name is
// left ~0 dp. The answer is BUG-347's: measure, and change the SHAPE when the
// measure says so, rather than shrinking text.
//
//   1. The name takes its own line (the full card width) when its inline width
//      falls below HUB_ROW_TITLE_MIN_EMS of its own type size. The tag then sits
//      under the meta line, not beside it.
//   2. If, stacked, the meta column is still narrower than the tag, the
//      thumbnail is dropped.
//
// Ordinary text (fontScale 1) in a 375 dp window keeps today's row with every
// label the hub shows (the longest, "Nothing to prep", leaves the name 4.1 em).
//
// WEB-4b — 4 ems at DEFAULT text stacked a 360 dp phone: with "Nothing to prep"
// the name is left 47 dp (3.15 em) there, and the row stacked up to 372 dp. At
// fontScale 1 the bar is 3 ems, so nothing stacks at 360 dp or wider (the
// widest that stacks is 357, the longest tag). Large text keeps BUG-451's 4 ems
// from Android's first step up (1.15), with a straight ramp between, so every
// size Hans tested stacks exactly as built.

/** The narrowest an inline name may get, in ems of its own (scaled) size, at
 *  large text (fontScale ≥ HUB_ROW_LARGE_SCALE). */
export const HUB_ROW_TITLE_MIN_EMS = 4;
/** …and at default text (fontScale ≤ 1). */
export const HUB_ROW_TITLE_MIN_EMS_DEFAULT = 3;
/** Android's first text size above default ("Large"). */
const HUB_ROW_LARGE_SCALE = 1.15;

/** The bar for this text scale: 3 ems at or below default, 4 from 1.15 up. */
export function hubRowTitleMinEms(fontScale: number): number {
  const t = Math.min(1, Math.max(0, (fontScale - 1) / (HUB_ROW_LARGE_SCALE - 1)));
  return HUB_ROW_TITLE_MIN_EMS_DEFAULT + t * (HUB_ROW_TITLE_MIN_EMS - HUB_ROW_TITLE_MIN_EMS_DEFAULT);
}

// The row's fixed chrome, from components/PrepCookHubView.tsx's styles.
const HUB_SCREEN_PAD = 16 * 2; // Screen's paddingHorizontal (Spacing[4])
const HUB_ROW_CHROME = 12 * 2 + 2; // mealRow padding (Spacing[3]) + 1 dp border each side
const HUB_GAP = 12; // mealRow gap (Spacing[3])
const HUB_TICK_CELL = 52; // selectCell width
const HUB_TITLE_SIZE = 15; // mealTitle, Typography.fontSize.md
const HUB_TAG_SIZE = 11; // pillText, Typography.fontSize.xs
const HUB_TAG_PAD = 8 * 2; // pill paddingHorizontal (Spacing[2])
/** A sans label's average advance, in ems — DM Sans semibold, measured loosely. */
const SANS_EM_ADVANCE = 0.55;

export interface HubRowLayout {
  /** The meal name on its own full-width line, the tag under the meta. */
  titleOwnLine: boolean;
  showThumb: boolean;
}

/** The status tag's width at a text scale. */
export function hubTagWidth(label: string, fontScale: number): number {
  return label.length * SANS_EM_ADVANCE * HUB_TAG_SIZE * fontScale + HUB_TAG_PAD;
}

export function hubRowLayout(input: {
  /** The window width — or, on the web, the column's (lib/webLayout.ts). */
  contentWidth: number;
  fontScale: number;
  /** The row shows a prep tick (a feast row does not). */
  selectable: boolean;
  thumb: number;
  tagLabel: string;
}): HubRowLayout {
  const { contentWidth, fontScale, selectable, thumb, tagLabel } = input;
  const card = contentWidth - HUB_SCREEN_PAD - HUB_ROW_CHROME;
  const tick = selectable ? HUB_TICK_CELL + HUB_GAP : 0;
  const thumbCell = thumb + HUB_GAP;
  const tag = hubTagWidth(tagLabel, fontScale);
  const inlineTitle = card - tick - thumbCell - HUB_GAP - tag;
  if (inlineTitle >= hubRowTitleMinEms(fontScale) * HUB_TITLE_SIZE * fontScale) {
    return { titleOwnLine: false, showThumb: true };
  }
  const metaColumn = card - tick - thumbCell;
  return { titleOwnLine: true, showThumb: metaColumn >= tag };
}

// ── SEC-3 C (BUG-466, the rotating half) — Tell Kiwi's pill at large text ───
//
// Hans, on the Pixel: the rotating phrase did not wrap — cut at normal text,
// about one word at max text. The phrase wraps now; this is the pill's WIDTH.
// The Tell Kiwi row is [label · pill], and at fontScale 2 the label alone is
// half the row, so a pill that merely shrinks is a sliver that breaks
// "something" in half. BUG-451's answer again: change the SHAPE. The row wraps
// (flexWrap), and the pill's flex basis is a floor measured in the phrase's
// own type: when the label and that floor no longer fit side by side, the
// pill takes its own full-width line under the label.
//
// At fontScale 1 the floor is 7 ems of 14 sp + the pill's chrome = 161: beside
// the ~68 label (measured on the web at 320), that fits a 320 dp window's 256 dp
// card — one row, as before. At fontScale 2 it is 259, beside a ~136 label: no
// phone's card (430 dp window → 366) fits both, so the pill stacks — and 7 ems
// at 28 sp still hold the longest word of the five phrases.

/** The pill's text floor, in ems of the phrase's type size. */
export const TELL_KIWI_PILL_MIN_EMS = 7;

/** The pill's horizontal chrome: 17 left padding + the 34 arrow and its 12 inset. */
export const TELL_KIWI_PILL_CHROME = 17 + 34 + 12;

/** The pill's flex basis for a system text scale (never below the fontScale-1 floor). */
export function tellKiwiPillBasis(fontScale: number, textSize: number): number {
  const scale = Math.max(fontScale, 1);
  return Math.round(TELL_KIWI_PILL_CHROME + TELL_KIWI_PILL_MIN_EMS * textSize * scale);
}

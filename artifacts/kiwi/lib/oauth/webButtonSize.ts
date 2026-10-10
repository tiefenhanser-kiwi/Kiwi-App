// WEB-1 Part G (BUG-364, the web half) — ONE size for the two web sign-in
// buttons, so Apple's and Google's read as a pair.
//
// Both are drawn by the provider's own script, each inside its own limits:
//   Google (GIS, size "large")  height 40 px fixed; width clamped to 200–400.
//   Apple  (appleid.auth.js)    width 130–375; height 30–64; it fills the
//                               element it is given.
// Before this, Apple filled the whole form column at 48 px and Google drew at
// the column width (clamped to 400) at 40 px, left-aligned in a 48 px host —
// two different widths and heights stacked on top of each other.
//
// So: one centred box, never wider than 375 (the narrower of the two ceilings,
// and inside Google's 200–400), and both buttons 40 px (Google's fixed height,
// inside Apple's range). Native buttons are untouched — Hans ruled native
// post-launch.

export const WEB_SOCIAL_BUTTON = {
  /** Apple's ceiling; inside Google's [200, 400] clamp. */
  maxWidth: 375,
  /** GIS "large" is 40 px tall and cannot be told otherwise. */
  height: 40,
} as const;

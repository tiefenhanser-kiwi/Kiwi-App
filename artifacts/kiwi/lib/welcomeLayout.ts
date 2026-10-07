// Resub C3 (BUG-347) — which shape the Welcome screen takes.
//
// Resub C1 PINNED the three actions in a footer above the bottom safe area:
// Apple's reviewer, in a 375 × 667 window, saw the actions cut off by the
// bottom edge. That fix holds for ordinary text. It cannot hold at the largest
// text sizes: at fontScale 2.0 in a ~320 dp window (Android's largest Display
// size) each button label wraps to three lines and the pinned footer alone is
// taller than the window, which leaves the ScrollView above it nothing — the
// screen "does not scroll down".
//
// So above a threshold nothing is pinned: hero, cards, actions and the legal
// line are ONE ScrollView and every piece is reachable. Below it the C1 layout
// is untouched — the 375 × 667 window at fontScale 1.0 is the one Apple
// reviewed in and it must keep its pinned footer.
//
// app/** is outside the test glob (D-WS9-164), so the decision lives here.

/**
 * At or above this system text scale the screen scrolls as one piece. iOS
 * reports 1.0 at its default size and ≥ 1.65 only at the accessibility sizes
 * (AX1+); stock Android tops out at 1.3, Samsung and Android 14+ at 2.0. So
 * 1.5 takes in every accessibility size and leaves the ordinary range pinned.
 */
export const WELCOME_LARGE_TEXT_MIN_SCALE = 1.5;

/**
 * Below this window width the screen scrolls as one piece, at any text scale.
 * Android's "Display size" shrinks the dp width — the largest setting on a
 * 411 dp phone lands near 320. 360 dp itself is the commonest Android width at
 * DEFAULT settings, so it stays pinned; Apple's 375 pt window is above it.
 */
export const WELCOME_NARROW_MAX_WIDTH_EXCLUSIVE = 360;

/** True → hero, cards and actions share one ScrollView; nothing is pinned. */
export function welcomeUsesLargeTextLayout(window: {
  fontScale: number;
  width: number;
}): boolean {
  return (
    window.fontScale >= WELCOME_LARGE_TEXT_MIN_SCALE ||
    window.width < WELCOME_NARROW_MAX_WIDTH_EXCLUSIVE
  );
}

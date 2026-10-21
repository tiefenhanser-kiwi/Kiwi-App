// WEB-4 — the web app at desktop width (working agreements §3.2 rule 5).
//
// The web app is the Expo client exported for the browser, so at 1280 px every
// phone layout stretched edge to edge: 1248 px buttons, 72 px thumbnails in
// 1250 px rows, a 1248 × 780 hero, bottom sheets the width of the window. Until
// a design session sets real rules, four interim principles hold:
//
//   1. content sits in a centred column with a maximum width;
//   2. rails and lists are centred in that column;
//   3. images are sized to the column, not to a phone;
//   4. nothing that only makes sense on a phone shows on the web.
//
// ⚠️ EVERY WEB-ONLY LAYOUT BRANCH GOES THROUGH THIS FILE, so it is the one place
// to test on one surface and the one place to grep for. Each helper takes the
// platform as an argument (defaulting to Platform.OS) and, off the web, RETURNS
// ITS INPUT ITSELF — the same object, not a copy or a merged array — so a
// native render is byte-identical to the one before WEB-4. The tests pin that
// identity for "ios" and "android".
//
// app/** is outside the test glob (D-WS9-164), so the rules live here.
import { createElement, type ReactElement } from "react";
import { Platform, View, type StyleProp, type ViewStyle } from "react-native";

/** The column every screen sits in on the web. The Cookbook keeps its own
 *  640 column (CookbookResults' COOKBOOK_MAX_WIDTH) inside it. */
export const WEB_COLUMN_MAX_WIDTH = 720;

/** Below this window width a web visitor has a phone-sized window: the column
 *  IS the phone, so images keep their phone sizes there (principle 3). */
export const WEB_WIDE_MIN_WIDTH = 600;

/** Web thumbnail sizes (principle 3): the native role size → the web one, in a
 *  window at least WEB_WIDE_MIN_WIDTH wide. */
export const WEB_THUMB = {
  /** Plan Review's meal row — ImageTreatment.thumb.row (72) on native. */
  planRow: 112,
  /** The Prep & Cook hub's meal row — ImageTreatment.thumb.compact (60). */
  hubRow: 88,
} as const;

type OS = typeof Platform.OS;

const isWeb = (os: OS) => os === "web";

const COLUMN: ViewStyle = {
  width: "100%",
  maxWidth: WEB_COLUMN_MAX_WIDTH,
  alignSelf: "center",
};

// Most sheet panels are absolutely positioned (left: 0, right: 0, bottom: 0),
// where alignSelf does nothing: auto side margins centre a width-capped
// absolute box, and an in-flow one too.
const SHEET: ViewStyle = { ...COLUMN, marginHorizontal: "auto" };

/**
 * A screen container's style, centred in the column on the web. Native gets
 * `base` back unchanged. Used once, on the Tabs' `sceneStyle` (the root Stack
 * uses webScreenLayout) — never screen by screen.
 */
export function webColumn<T extends StyleProp<ViewStyle>>(
  base: T,
  os: OS = Platform.OS,
): T | StyleProp<ViewStyle> {
  return isWeb(os) ? [base, COLUMN] : base;
}

/** Root-stack routes that carry their own column: the tab navigator, whose
 *  bar's background spans the window (its sceneStyle is webColumn). */
export const WEB_FULL_WIDTH_ROUTES: readonly string[] = ["(tabs)"];

type ScreenLayout = (args: { route: { name: string }; children: ReactElement }) => ReactElement;

/**
 * The root Stack's `screenLayout`: each screen inside a full-width view of the
 * app background, holding the column. Not `contentStyle` — outside a capped
 * content box the navigator paints its own default grey (#F2F2F2), and the
 * theme that owns it is not reachable from this app. Native: undefined.
 */
export function webScreenLayout(background: string, os: OS = Platform.OS): ScreenLayout | undefined {
  if (!isWeb(os)) return undefined;
  return ({ route, children }) =>
    WEB_FULL_WIDTH_ROUTES.includes(route.name)
      ? children
      : createElement(
          View,
          { style: { flex: 1, backgroundColor: background } },
          createElement(View, { style: [{ flex: 1 }, COLUMN] }, children),
        );
}

/**
 * A bottom sheet's panel. RN's Modal portals to the document root on the web,
 * outside every navigator, so the column has to be applied to the panel
 * itself. Native gets `base` back unchanged.
 */
export function webSheet<T extends StyleProp<ViewStyle>>(
  base: T,
  os: OS = Platform.OS,
): T | StyleProp<ViewStyle> {
  return isWeb(os) ? [base, SHEET] : base;
}

/** The grab handle is a drag affordance; the web has no drag-to-dismiss
 *  (✕, the backdrop and Escape close a sheet there). Principle 4. */
export function sheetHandleShown(os: OS = Platform.OS): boolean {
  return !isWeb(os);
}

/**
 * The bottom tab bar: its background stays the window's width, its items sit
 * in the column — the same left and right inset the column leaves. Native
 * gets `base` back unchanged.
 */
export function webTabBar<T extends ViewStyle>(
  base: T,
  windowWidth: number,
  os: OS = Platform.OS,
): T {
  if (!isWeb(os)) return base;
  const inset = Math.max(0, (windowWidth - WEB_COLUMN_MAX_WIDTH) / 2);
  return { ...base, paddingLeft: inset, paddingRight: inset };
}

/** The width a screen's content has: the window on native, the column (or a
 *  narrower window) on the web. For layout rules that measure. */
export function webContentWidth(windowWidth: number, os: OS = Platform.OS): number {
  return isWeb(os) ? Math.min(windowWidth, WEB_COLUMN_MAX_WIDTH) : windowWidth;
}

/** A thumbnail's edge: the native role size, or its web size in a wide window. */
export function webThumb(
  nativeSize: number,
  webSize: number,
  windowWidth: number,
  os: OS = Platform.OS,
): number {
  return isWeb(os) && windowWidth >= WEB_WIDE_MIN_WIDTH ? webSize : nativeSize;
}

// ── WEB-4c (BUG-470) — THE WHOLE WINDOW SCROLLS ─────────────────────────────
//
// Hans, October 20, on production: "the scroll only works in the frame of the
// app." Every scroll container sits inside the 720 column, so a wheel or a
// trackpad over the cream margins reached no scroller and did nothing.
//
// The rule: on the web a wheel ANYWHERE in the window scrolls the screen's
// content; the column stays 720 wide. Moving each screen's scroller out to the
// window (the column into its contentContainerStyle) would touch every one of
// the 56 files that hold a ScrollView, FlatList or SectionList, and every bar
// beside them. Instead ONE listener on the window, installed by the root
// layout, forwards a wheel that no scroller would take — over the margins, a
// header, a footer bar or a sheet's backdrop — to the scroller the column shows
// at that height. A wheel over a scroller is left to the browser, untouched.
//
// The scrollbar stays at the column's edge; keyboard scrolling is unchanged.

/** The heights the column is probed at for a scroller, as fractions of the
 *  window, after the pointer's own height: the middle first (a header or a
 *  sheet's backdrop sits above it), then the lower half (sheets rise from the
 *  bottom), then the top. */
const PROBE_FRACTIONS = [0.5, 0.75, 0.9, 0.25] as const;

/** What the forwarder reads from the DOM, injectable so the rule is testable
 *  without a browser. */
export interface WheelDom<E> {
  width: number;
  height: number;
  parentOf: (el: E) => E | null;
  /** The element the browser would hit at (x, y), or null. */
  elementAt: (x: number, y: number) => E | null;
  /** True when `el` scrolls vertically: overflow-y auto|scroll and taller content. */
  scrollsVertically: (el: E) => boolean;
}

function verticalScroller<E>(el: E | null, dom: WheelDom<E>): E | null {
  for (let n = el; n; n = dom.parentOf(n)) if (dom.scrollsVertically(n)) return n;
  return null;
}

/**
 * The scroller a wheel at height `clientY` should move, or null to leave the
 * event to the browser: null when the pointer is already over a vertical
 * scroller (the browser scrolls it), or when the column shows none.
 */
export function wheelForwardTarget<E>(target: E | null, clientY: number, dom: WheelDom<E>): E | null {
  if (verticalScroller(target, dom)) return null;
  const x = dom.width / 2;
  for (const y of [clientY, ...PROBE_FRACTIONS.map((f) => f * dom.height)]) {
    const s = verticalScroller(dom.elementAt(x, y), dom);
    if (s) return s;
  }
  return null;
}

/** A wheel's vertical distance in pixels (deltaMode 1 = lines, 2 = pages). */
export function wheelPixels(deltaY: number, deltaMode: number, pageHeight: number): number {
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * pageHeight;
  return deltaY;
}

/**
 * Install the forwarder on the window. Web only; native gets a no-op and
 * touches nothing. Returns the uninstaller. Ctrl+wheel (zoom) and a mostly
 * sideways wheel are the browser's.
 */
export function installWebWheelScroll(os: OS = Platform.OS): () => void {
  if (!isWeb(os) || typeof window === "undefined") return () => {};
  const dom: WheelDom<Element> = {
    get width() {
      return window.innerWidth;
    },
    get height() {
      return window.innerHeight;
    },
    parentOf: (el) => el.parentElement,
    elementAt: (x, y) => document.elementFromPoint(x, y),
    scrollsVertically: (el) => {
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      const oy = window.getComputedStyle(el).overflowY;
      return oy === "auto" || oy === "scroll";
    },
  };
  const onWheel = (e: WheelEvent) => {
    if (e.defaultPrevented || e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const scroller = wheelForwardTarget(e.target instanceof Element ? e.target : null, e.clientY, dom);
    if (!scroller) return;
    scroller.scrollTop += wheelPixels(e.deltaY, e.deltaMode, scroller.clientHeight);
    e.preventDefault();
  };
  window.addEventListener("wheel", onWheel, { passive: false });
  return () => window.removeEventListener("wheel", onWheel);
}

// ── WEB-4c (BUG-471) — A BAR SPANS THE WINDOW ───────────────────────────────
//
// Home's header ("Good evening, Hans") was a darker cream box only as wide as
// the column, and the content slid under its bottom edge in the column alone.
// On the web a bar's BACKGROUND spans the window, like the tab bar, and its
// content stays in the column: the bar reaches past the column by the column's
// inset on each side (negative margins) and pads its content back in by the
// same amount. Native gets `base` back unchanged.

/** The inset the column leaves on each side of a window this wide. */
function columnInset(windowWidth: number): number {
  return Math.max(0, (windowWidth - WEB_COLUMN_MAX_WIDTH) / 2);
}

export function webFullBleed<T extends ViewStyle>(base: T, windowWidth: number, os: OS = Platform.OS): T {
  if (!isWeb(os)) return base;
  const inset = columnInset(windowWidth);
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const pad = (side: unknown) => num(side) + inset;
  return {
    ...base,
    marginLeft: num(base.marginLeft ?? base.marginHorizontal ?? base.margin) - inset,
    marginRight: num(base.marginRight ?? base.marginHorizontal ?? base.margin) - inset,
    paddingLeft: pad(base.paddingLeft ?? base.paddingHorizontal ?? base.padding),
    paddingRight: pad(base.paddingRight ?? base.paddingHorizontal ?? base.padding),
  };
}

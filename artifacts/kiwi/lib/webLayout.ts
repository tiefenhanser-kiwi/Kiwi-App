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

/** Web thumbnail sizes (principle 3): the native role size → the web one. */
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

/** A thumbnail's edge: the native role size, or its web size. */
export function webThumb(nativeSize: number, webSize: number, os: OS = Platform.OS): number {
  return isWeb(os) ? webSize : nativeSize;
}

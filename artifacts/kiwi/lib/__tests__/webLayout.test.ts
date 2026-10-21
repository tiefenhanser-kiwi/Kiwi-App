// WEB-4 — the web column (lib/webLayout.ts). The native half is the point:
// every helper must hand native its input BACK — the same object — so the
// iOS and Android trees are byte-identical to the ones before WEB-4.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  WEB_COLUMN_MAX_WIDTH,
  WEB_THUMB,
  installWebWheelScroll,
  sheetHandleShown,
  webColumn,
  webScreenLayout,
  webSheet,
  webTabBar,
  webFullBleed,
  webThumb,
  wheelForwardTarget,
  wheelPixels,
  type WheelDom,
} from "../webLayout.ts";

const NATIVE = ["ios", "android"] as const;

test("🔴 native: every helper returns its input itself", () => {
  const bg = { backgroundColor: "#FBF6EE" };
  const sheet = [{ padding: 16 }, { paddingBottom: 30 }];
  const bar = { backgroundColor: "#F1EADC", height: 56 };
  for (const os of NATIVE) {
    assert.equal(webColumn(bg, os), bg, `${os} column`);
    assert.equal(webColumn(undefined, os), undefined, `${os} scene`);
    assert.equal(webSheet(sheet, os), sheet, `${os} sheet`);
    assert.equal(webTabBar(bar, 1280, os), bar, `${os} tab bar`);
    assert.equal(sheetHandleShown(os), true, `${os} handle`);
    assert.equal(webThumb(72, WEB_THUMB.planRow, 1280, os), 72, `${os} row thumb`);
    assert.equal(webThumb(60, WEB_THUMB.hubRow, 1280, os), 60, `${os} hub thumb`);
  }
});

test("web: a centred column of the ruled width", () => {
  assert.equal(WEB_COLUMN_MAX_WIDTH, 720);
  const bg = { backgroundColor: "#FBF6EE" };
  assert.deepEqual(webColumn(bg, "web"), [
    bg,
    { width: "100%", maxWidth: 720, alignSelf: "center" },
  ]);
  // A sheet panel is usually absolute (left/right 0): auto margins centre it.
  assert.deepEqual(webSheet(bg, "web"), [
    bg,
    { width: "100%", maxWidth: 720, alignSelf: "center", marginHorizontal: "auto" },
  ]);
});

test("web: the tab bar keeps its background, its items take the column's inset", () => {
  const bar = { backgroundColor: "#F1EADC", height: 84 };
  assert.deepEqual(webTabBar(bar, 1280, "web"), { ...bar, paddingLeft: 280, paddingRight: 280 });
  // Narrower than the column: no inset, never negative.
  assert.deepEqual(webTabBar(bar, 375, "web"), { ...bar, paddingLeft: 0, paddingRight: 0 });
  assert.notEqual(webTabBar(bar, 1280, "web"), bar, "a copy — the input is never mutated");
  assert.equal(bar.height, 84);
});

test("web: no drag handle; thumbnails at their web sizes in a wide window, phone sizes in a phone-sized one", () => {
  assert.equal(sheetHandleShown("web"), false);
  assert.equal(webThumb(72, WEB_THUMB.planRow, 1280, "web"), 112);
  assert.equal(webThumb(60, WEB_THUMB.hubRow, 1280, "web"), 88);
  assert.equal(webThumb(72, WEB_THUMB.planRow, 600, "web"), 112);
  assert.equal(webThumb(72, WEB_THUMB.planRow, 599, "web"), 72);
  assert.equal(webThumb(60, WEB_THUMB.hubRow, 375, "web"), 60);
});

test("🔴 native: the root Stack gets no screenLayout at all", () => {
  for (const os of NATIVE) assert.equal(webScreenLayout("#FBF6EE", os), undefined, os);
});

test("web: screenLayout puts a screen in the column on the app background; (tabs) passes through", () => {
  const layout = webScreenLayout("#FBF6EE", "web");
  assert.ok(layout);
  const child = { type: "screen", props: {}, key: null } as never;
  assert.equal(layout({ route: { name: "(tabs)" }, children: child }), child);
  const wrapped = layout({ route: { name: "plan/[id]" }, children: child }) as any;
  assert.deepEqual(wrapped.props.style, { flex: 1, backgroundColor: "#FBF6EE" });
  const column = wrapped.props.children;
  assert.deepEqual(column.props.style, [{ flex: 1 }, { width: "100%", maxWidth: 720, alignSelf: "center" }]);
  assert.equal(column.props.children, child);
});

// ── WEB-4c (BUG-470, BUG-471) ───────────────────────────────────────────────

test("🔴 native: the bar bleed returns its input itself, and the wheel forwarder installs nothing", () => {
  const bar = { backgroundColor: "#E4DCCB", paddingHorizontal: 16 };
  for (const os of NATIVE) {
    assert.equal(webFullBleed(bar, 1280, os), bar, `${os} bleed`);
    const uninstall = installWebWheelScroll(os);
    assert.equal(typeof uninstall, "function", `${os} uninstaller`);
    uninstall();
  }
});

test("web: a bar reaches past the column by its inset and pads its content back in", () => {
  const bar = { backgroundColor: "#E4DCCB", paddingHorizontal: 16 };
  assert.deepEqual(webFullBleed(bar, 1280, "web"), {
    ...bar,
    marginLeft: -280,
    marginRight: -280,
    paddingLeft: 296,
    paddingRight: 296,
  });
  // A phone-sized window has no inset: the bar is unchanged in effect.
  assert.deepEqual(webFullBleed(bar, 375, "web"), { ...bar, marginLeft: 0, marginRight: 0, paddingLeft: 16, paddingRight: 16 });
  // Its own side margins and paddings are kept and extended.
  assert.deepEqual(webFullBleed({ padding: 12, marginHorizontal: 4 }, 1000, "web"), {
    padding: 12,
    marginHorizontal: 4,
    marginLeft: -136,
    marginRight: -136,
    paddingLeft: 152,
    paddingRight: 152,
  });
});

// A fake DOM: a window 1280 × 800, the column's scroller from y 120 down, a
// header above it, the margins beside it, and a sheet (with its own scroller)
// that can open over the lower half.
type El = { id: string; parent: El | null; scrolls: boolean };
const el = (id: string, parent: El | null, scrolls = false): El => ({ id, parent, scrolls });
const root = el("root", null);
const margin = el("margin", root);
const column = el("column", root);
const header = el("header", column);
const scroller = el("scroller", column, true);
const row = el("row", scroller);
const backdrop = el("backdrop", root);
const sheetScroller = el("sheet-scroller", backdrop, true);
const sheetRow = el("sheet-row", sheetScroller);
function dom(sheetOpen = false): WheelDom<El> {
  return {
    width: 1280,
    height: 800,
    parentOf: (e) => e.parent,
    scrollsVertically: (e) => e.scrolls,
    elementAt: (x, y) => {
      if (sheetOpen) return y >= 500 ? sheetRow : backdrop;
      if (x < 280 || x > 1000) return margin;
      return y < 120 ? header : row;
    },
  };
}

test("web: a wheel over the margins scrolls the column's scroller; one over a scroller is the browser's", () => {
  assert.equal(wheelForwardTarget(margin, 400, dom()), scroller, "left margin, beside the content");
  assert.equal(wheelForwardTarget(margin, 60, dom()), scroller, "left margin, beside the header");
  assert.equal(wheelForwardTarget(header, 60, dom()), scroller, "over the header itself");
  assert.equal(wheelForwardTarget(row, 400, dom()), null, "over the scroller: left to the browser");
  assert.equal(wheelForwardTarget(null, 400, dom()), scroller, "no target element");
});

test("web: with a sheet open, a wheel over its backdrop scrolls the sheet", () => {
  assert.equal(wheelForwardTarget(backdrop, 100, dom(true)), sheetScroller);
  assert.equal(wheelForwardTarget(sheetRow, 600, dom(true)), null, "over the sheet's scroller: the browser's");
});

test("web: nothing to forward to when the column shows no scroller", () => {
  const flat: WheelDom<El> = { ...dom(), elementAt: () => header };
  assert.equal(wheelForwardTarget(margin, 400, flat), null);
});

test("web: a wheel's lines and pages are pixels", () => {
  assert.equal(wheelPixels(100, 0, 700), 100);
  assert.equal(wheelPixels(3, 1, 700), 48);
  assert.equal(wheelPixels(1, 2, 700), 700);
});

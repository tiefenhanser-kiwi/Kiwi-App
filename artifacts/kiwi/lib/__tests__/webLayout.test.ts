// WEB-4 — the web column (lib/webLayout.ts). The native half is the point:
// every helper must hand native its input BACK — the same object — so the
// iOS and Android trees are byte-identical to the ones before WEB-4.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  WEB_COLUMN_MAX_WIDTH,
  WEB_THUMB,
  sheetHandleShown,
  webColumn,
  webScreenLayout,
  webSheet,
  webTabBar,
  webThumb,
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

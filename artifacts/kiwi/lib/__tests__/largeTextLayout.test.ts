// FIX-7 (BUG-439) — the tab bar and the Featured chip at the largest Font +
// Display size. Tests prove structure and the sizing arithmetic, not layout:
// React Native does not re-measure after a live font change, and only a device
// at the maximum sizes shows whether anything clips (the device pass is the
// gate, as it was for BUG-347).
//
// app/** is outside the test glob, so the tab bar's wiring is pinned at source
// level (the authFieldCopy / orderOnlineWiring precedent).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  RAIL_CHIP_INSET,
  RAIL_CHIP_MAX_SCALE,
  RAIL_CHIP_MIN_FIT,
  TAB_LABEL_MAX_SCALE,
  TAB_LABEL_MIN_FIT,
  hubRowLayout,
  hubTagWidth,
  tabBarHeight,
} from "../largeTextLayout";

// ── BUG-451 — the Prep & Cook hub's meal rows ───────────────────────────────

const hubRow = (
  contentWidth: number,
  fontScale: number,
  extra: { thumb?: number; selectable?: boolean; tag?: string } = {},
) =>
  hubRowLayout({
    contentWidth,
    fontScale,
    selectable: extra.selectable ?? true,
    thumb: extra.thumb ?? 60,
    tagLabel: extra.tag ?? "Not prepped",
  });

test("BUG-451: ordinary text on a 375 or 411 dp phone keeps today's row, whatever the tag says", () => {
  for (const tag of ["Not prepped", "Mostly prepped", "Prepped ✓", "Nothing to prep", "Partly prepped"]) {
    assert.deepEqual(hubRow(375, 1, { tag }), { titleOwnLine: false, showThumb: true }, tag);
    assert.deepEqual(hubRow(411, 1, { tag }), { titleOwnLine: false, showThumb: true }, tag);
  }
});

const HUB_TAGS = ["Prepped ✓", "Not prepped", "Mostly prepped", "Partly prepped", "Nothing to prep"];

/** The widest window (dp) that still stacks, for this text scale and tag. */
const widestStacked = (fontScale: number, tag: string, selectable = true) => {
  let w = 0;
  for (let x = 240; x <= 1280; x++) if (hubRow(x, fontScale, { tag, selectable }).titleOwnLine) w = x;
  return w;
};

test("WEB-4b: at DEFAULT text nothing stacks at 360 dp or wider — any tag, tick or not", () => {
  for (const tag of HUB_TAGS) {
    for (const selectable of [true, false]) {
      for (let w = 360; w <= 1280; w += 1) {
        assert.equal(hubRow(w, 1, { tag, selectable }).titleOwnLine, false, `${w} dp, ${tag}, tick ${selectable}`);
      }
    }
  }
  // Below it, the longest tag still stacks: 357 is the widest (it was 372 at 4 ems).
  assert.equal(widestStacked(1, "Nothing to prep"), 357);
  assert.equal(widestStacked(1, "Prepped ✓"), 321);
});

test("WEB-4b: large text stacks exactly as built — 4 ems from Android's 1.15 up", () => {
  // The widths BUG-451 shipped (f5fe502), by text scale: [shortest tag, longest tag].
  const BUILT: [number, number, number][] = [
    [1.15, 353, 395],
    [1.3, 370, 417],
    [1.5, 393, 448],
    [1.8, 428, 493],
    [2, 450, 523],
  ];
  for (const [f, shortest, longest] of BUILT) {
    assert.equal(widestStacked(f, "Prepped ✓"), shortest, `${f}: Prepped ✓`);
    assert.equal(widestStacked(f, "Nothing to prep"), longest, `${f}: Nothing to prep`);
  }
});

test("BUG-451: Hans's two sizes (max, and one step below) give the name its own line", () => {
  for (const w of [320, 360, 375, 411]) {
    assert.equal(hubRow(w, 2).titleOwnLine, true, `${w} @ 2.0`);
    assert.equal(hubRow(w, 1.8).titleOwnLine, true, `${w} @ 1.8`);
  }
});

test("BUG-451: at max Font + Display size (320 dp) the thumbnail goes, so the tag fits beside the tick", () => {
  assert.deepEqual(hubRow(320, 2), { titleOwnLine: true, showThumb: false });
  assert.deepEqual(hubRow(320, 1.5), { titleOwnLine: true, showThumb: true });
});

test("BUG-451: the web column (720, 88 px thumbs) never needs the stacked row", () => {
  for (const f of [1, 1.5, 2]) {
    assert.deepEqual(hubRow(720, f, { thumb: 88 }), { titleOwnLine: false, showThumb: true });
  }
});

test("BUG-451: a feast row (no tick) and a longer tag are measured, not assumed", () => {
  // No tick cell: 64 dp more for the name.
  assert.equal(hubRow(360, 1.15, { selectable: false }).titleOwnLine, false);
  assert.equal(hubRow(360, 1.15).titleOwnLine, true);
  assert.ok(hubTagWidth("Nothing to prep", 1) > hubTagWidth("Not prepped", 1));
});

const here = dirname(fileURLToPath(import.meta.url));
const tabs = readFileSync(resolve(here, "../../app/(tabs)/_layout.tsx"), "utf8");

test("the bar is exactly 56 + inset at ordinary text sizes", () => {
  assert.equal(tabBarHeight(1, 0), 56);
  assert.equal(tabBarHeight(1, 34), 90);
  assert.equal(tabBarHeight(0.85, 24), 80); // a user who shrank their text
});

test("it grows by the label's extra line height, and stops where the label stops", () => {
  // 11 sp × 1.3 line = 14.3 dp of label at 1.0.
  assert.equal(tabBarHeight(1.3, 0), 61); // stock Android's largest: +4.29 → 5
  assert.equal(tabBarHeight(1.5, 0), 64); // the cap: +7.15 → 8
  assert.equal(tabBarHeight(2, 0), 64); // Samsung / Android 14 maximum: capped
  assert.equal(tabBarHeight(3.1, 48), 112); // iOS AX5, with a home indicator
});

test("the caps are BUG-347's: labels 1.5×, the chip 1.5× like the wordmark", () => {
  assert.equal(TAB_LABEL_MAX_SCALE, 1.5);
  assert.equal(TAB_LABEL_MIN_FIT, 0.6);
  assert.equal(RAIL_CHIP_MAX_SCALE, 1.5);
  assert.equal(RAIL_CHIP_MIN_FIT, 0.5);
  assert.equal(RAIL_CHIP_INSET, 7);
});

test("the tab bar reads its height from the font scale, and every label is one capped line that shrinks to fit", () => {
  // WEB-4 — the same read also takes the width (the web tab bar's inset).
  assert.match(tabs, /const \{ fontScale, width \} = useWindowDimensions\(\);/);
  assert.match(tabs, /Platform\.OS === "web" \? 84 : tabBarHeight\(fontScale, insets\.bottom\)/);
  assert.doesNotMatch(tabs, /baseHeight \+ insets\.bottom/);
  const label = /function tabLabel[\s\S]*?\n\}/.exec(tabs)?.[0] ?? "";
  assert.match(label, /numberOfLines=\{1\}/);
  assert.match(label, /adjustsFontSizeToFit/);
  assert.match(label, /minimumFontScale=\{TAB_LABEL_MIN_FIT\}/);
  assert.match(label, /maxFontSizeMultiplier=\{TAB_LABEL_MAX_SCALE\}/);
  // Every visible tab goes through tabLabel (Profile is hidden: href null).
  for (const t of ["Home", "Plans", "Recipes", "Playlist", "Groceries"]) {
    assert.match(tabs, new RegExp(`tabBarLabel: tabLabel\\("${t}"\\)`), t);
  }
});

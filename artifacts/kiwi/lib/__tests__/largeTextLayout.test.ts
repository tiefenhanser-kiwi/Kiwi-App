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
  tabBarHeight,
} from "../largeTextLayout";

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
  assert.match(tabs, /const \{ fontScale \} = useWindowDimensions\(\);/);
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

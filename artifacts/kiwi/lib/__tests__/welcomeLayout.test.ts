// Resub C3 (BUG-347) — the threshold that takes Welcome out of its pinned-footer
// layout. The boundaries are pinned as LITERALS, not read back from the
// constants: a test that derives its expectation from the value under test
// cannot notice that value moving.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  WELCOME_LARGE_TEXT_MIN_SCALE,
  WELCOME_NARROW_MAX_WIDTH_EXCLUSIVE,
  welcomeUsesLargeTextLayout,
} from "../welcomeLayout";

test("the constants are the ruled values", () => {
  assert.equal(WELCOME_LARGE_TEXT_MIN_SCALE, 1.5);
  assert.equal(WELCOME_NARROW_MAX_WIDTH_EXCLUSIVE, 360);
});

test("🔴 Apple's 375 × 667 window at fontScale 1.0 keeps the pinned footer (C1)", () => {
  assert.equal(welcomeUsesLargeTextLayout({ fontScale: 1, width: 375 }), false);
});

test("Hans's phone at the largest Font AND Display size scrolls as one piece", () => {
  assert.equal(welcomeUsesLargeTextLayout({ fontScale: 2, width: 320 }), true);
});

test("font-scale boundary: 1.49 pinned, 1.5 not", () => {
  assert.equal(welcomeUsesLargeTextLayout({ fontScale: 1.49, width: 411 }), false);
  assert.equal(welcomeUsesLargeTextLayout({ fontScale: 1.5, width: 411 }), true);
});

test("stock Android's largest Font size (1.3) on a default-width phone stays pinned", () => {
  assert.equal(welcomeUsesLargeTextLayout({ fontScale: 1.3, width: 411 }), false);
});

test("width boundary: 360 pinned (the commonest Android width), 359 not", () => {
  assert.equal(welcomeUsesLargeTextLayout({ fontScale: 1, width: 360 }), false);
  assert.equal(welcomeUsesLargeTextLayout({ fontScale: 1, width: 359 }), true);
});

test("iOS accessibility sizes (AX1 ≈ 1.65 and up) scroll as one piece at any width", () => {
  assert.equal(welcomeUsesLargeTextLayout({ fontScale: 1.65, width: 430 }), true);
  assert.equal(welcomeUsesLargeTextLayout({ fontScale: 3.12, width: 375 }), true);
});

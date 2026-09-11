// WS9 BUG-245 (D-WS9-235) — formatMealTime is the single read of a meal's
// minutes + hands-on minutes for the plan review row and Meal Detail header.
// Pins: (1) the draft estimate mark is a leading tilde on BOTH segments and
// nothing else; (2) hands-on renders only when the server sends a non-null
// activeTimeMinutes — null/absent is byte-identical to the pre-BUG-245 line.

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatMealTime } from "../mealTimeLine";

test("saved, no hands-on: total only (byte-identical to the legacy line)", () => {
  assert.equal(formatMealTime(38), "38 min");
  assert.equal(formatMealTime(38, null), "38 min");
  assert.equal(formatMealTime(38, undefined), "38 min");
});

test("saved, hands-on sent: total · hands-on", () => {
  assert.equal(formatMealTime(38, 10), "38 min · 10 min hands-on");
});

test("draft: tilde on the total, and on hands-on when sent", () => {
  assert.equal(formatMealTime(38, null, { estimate: true }), "~38 min");
  assert.equal(
    formatMealTime(38, 10, { estimate: true }),
    "~38 min · ~10 min hands-on",
  );
});

test("hands-on of 0 is still a sent value and renders", () => {
  assert.equal(formatMealTime(38, 0), "38 min · 0 min hands-on");
});

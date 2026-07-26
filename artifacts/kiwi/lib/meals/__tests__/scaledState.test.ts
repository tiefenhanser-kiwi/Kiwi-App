// Plan-Gen Arc · Block 4a piece 2 — scaled-from-authored predicate tests.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isScaledFromAuthored,
  SCALED_BAKEWARE_ADVISORY,
} from "../scaledState";

test("scaled true when effective diverges from the authored anchor (household-scaled fork)", () => {
  // 4-authored catalog meal bound to a 2-person household.
  assert.equal(isScaledFromAuthored(2, 4), true);
});

test("scaled true when scaled UP as well as down", () => {
  assert.equal(isScaledFromAuthored(6, 4), true);
});

test("scaled false when effective equals the authored anchor (unscaled)", () => {
  assert.equal(isScaledFromAuthored(4, 4), false);
});

test("scaled false when the anchor is null/undefined (no trustworthy claim to make)", () => {
  assert.equal(isScaledFromAuthored(2, null), false);
  assert.equal(isScaledFromAuthored(2, undefined), false);
});

test("scaled false when the anchor is non-positive (degenerate)", () => {
  assert.equal(isScaledFromAuthored(2, 0), false);
  assert.equal(isScaledFromAuthored(2, -1), false);
});

test("advisory copy is an honest note, not a computed pan size", () => {
  assert.match(SCALED_BAKEWARE_ADVISORY, /scaled/i);
  assert.equal(/\d+\s*(×|x|inch|"|qt|quart)/i.test(SCALED_BAKEWARE_ADVISORY), false);
});

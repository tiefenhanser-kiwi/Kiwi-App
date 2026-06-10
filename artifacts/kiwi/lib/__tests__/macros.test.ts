// WS7-6 (E) Block 2 §1 — formatMacro: whole-number rounding + float artifact
// elimination + null/NaN graceful fallback.

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatMacro } from "../format/macros";

test("formatMacro rounds whole numbers to themselves", () => {
  assert.equal(formatMacro(42), "42");
  assert.equal(formatMacro(0), "0");
});

test("formatMacro rounds .5 up and .4 down (banker-free)", () => {
  assert.equal(formatMacro(12.4), "12");
  assert.equal(formatMacro(12.5), "13");
});

test("formatMacro kills the 51.60000000000001 float artifact", () => {
  assert.equal(formatMacro(51.60000000000001), "52");
  assert.equal(formatMacro(0.1 + 0.2), "0");
});

test("formatMacro renders fallback for null/undefined/NaN", () => {
  assert.equal(formatMacro(null), "—");
  assert.equal(formatMacro(undefined), "—");
  assert.equal(formatMacro(NaN), "—");
});

test("formatMacro accepts a custom fallback (matches site convention)", () => {
  assert.equal(formatMacro(null, "0"), "0");
  assert.equal(formatMacro(undefined, ""), "");
});

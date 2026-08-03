// WS9 3f-2 follow-up (①) — parseQuantity is the shared "what counts as a valid
// quantity" rule used by both builders' save paths and grocery inline editing.
// It was previously untested; these lock the decimal / fraction / comma-locale
// contract. The test glob covers lib/__tests__/*.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseQuantity } from "../quantity";

test("parseQuantity: plain decimals and integers", () => {
  assert.equal(parseQuantity("1"), 1);
  assert.equal(parseQuantity("2"), 2);
  assert.equal(parseQuantity("1.5"), 1.5);
  assert.equal(parseQuantity("1.75"), 1.75);
  assert.equal(parseQuantity("0.25"), 0.25);
  assert.equal(parseQuantity("  1.5  "), 1.5); // trims
});

test("parseQuantity: fractions and mixed fractions", () => {
  assert.equal(parseQuantity("1/2"), 0.5);
  assert.equal(parseQuantity("3/4"), 0.75);
  assert.equal(parseQuantity("1 1/2"), 1.5);
  assert.equal(parseQuantity("2 3/4"), 2.75);
});

test("parseQuantity: comma-decimal locale input is normalized to a dot", () => {
  assert.equal(parseQuantity("1,5"), 1.5);
  assert.equal(parseQuantity("1,75"), 1.75);
  assert.equal(parseQuantity("0,25"), 0.25);
});

test("parseQuantity: invalid / empty returns null", () => {
  assert.equal(parseQuantity(""), null);
  assert.equal(parseQuantity("   "), null);
  assert.equal(parseQuantity("abc"), null);
  assert.equal(parseQuantity("1/0"), null); // zero denominator
  assert.equal(parseQuantity("1,,5"), null); // malformed
});

test("parseQuantity: mid-typing partials do not throw (validation, not a gate)", () => {
  // "1." is not a committed value; parseQuantity may accept it (Number("1.")=1)
  // — the builder stores the raw string and only parses at save, so the input
  // is never blocked mid-typing regardless.
  assert.equal(parseQuantity("1."), 1);
});

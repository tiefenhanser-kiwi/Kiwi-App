// WS7-3 C4 c1 — narrowing tests for toDayOfWeek. Pure function, no React.

import assert from "node:assert/strict";
import { test } from "node:test";

import { toDayOfWeek } from "../dayOfWeek";

test("toDayOfWeek: null → null", () => {
  assert.equal(toDayOfWeek(null), null);
});

test("toDayOfWeek: undefined → null", () => {
  assert.equal(toDayOfWeek(undefined), null);
});

test("toDayOfWeek: empty string → null", () => {
  assert.equal(toDayOfWeek(""), null);
});

test("toDayOfWeek: canonical Monday → Monday", () => {
  assert.equal(toDayOfWeek("Monday"), "Monday");
});

test("toDayOfWeek: all seven canonical values round-trip", () => {
  for (const day of [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ]) {
    assert.equal(toDayOfWeek(day), day);
  }
});

test("toDayOfWeek: lowercase variant narrows to null (case-sensitive)", () => {
  assert.equal(toDayOfWeek("monday"), null);
});

test("toDayOfWeek: unknown string narrows to null", () => {
  assert.equal(toDayOfWeek("Funday"), null);
});

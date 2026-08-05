// WS7-6 (E) Block 2 §1 — formatMacro: whole-number rounding + float artifact
// elimination + null/NaN graceful fallback.

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatMacro, formatMacroLine } from "../format/macros";

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

// WS7-6 C-fix Block 4 — formatMacroLine: the shared per-serving macro line.

test("formatMacroLine builds the cal · P · C · F line, rounding each field", () => {
  assert.equal(
    formatMacroLine(320, 30, 40, 20),
    "320 cal · 30g P · 40g C · 20g F",
  );
  assert.equal(
    formatMacroLine(539.6, 38.4, 31.5, 23.5),
    "540 cal · 38g P · 32g C · 24g F",
  );
});

// WS9 3f-3 cleanup (BUG-060) — the Add-Meals picker (AddMealsSheet MealRow)
// was the one surface rendering meal.*PerServing raw, leaking the float sum
// artifact ("49.000000001g F"). It now routes through formatMacroLine; this
// pins the exact reported case to the formatter the fix relies on.
test("formatMacroLine kills the raw float-sum artifact (BUG-060)", () => {
  assert.equal(
    formatMacroLine(542, 30, 40, 49.000000001),
    "542 cal · 30g P · 40g C · 49g F",
  );
});

test("formatMacroLine renders real zeros as-is (e.g. Garlic Green Beans 0 cal)", () => {
  assert.equal(formatMacroLine(0, 0, 0, 0), "0 cal · 0g P · 0g C · 0g F");
});

test("formatMacroLine renders missing fields as 0 (consistent line shape)", () => {
  assert.equal(
    formatMacroLine(200, null, undefined, 5),
    "200 cal · 0g P · 0g C · 5g F",
  );
});

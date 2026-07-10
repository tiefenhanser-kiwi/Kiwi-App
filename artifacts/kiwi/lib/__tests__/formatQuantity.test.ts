// WS7-8b fraction-glyph block — formatNeedGlyph (grocery) + formatQuantity
// thirds extension (meal-detail / cook-mode). Pure-function tests; the test
// glob covers lib/__tests__/*.test.ts (not lib/format/__tests__), so the file
// lives here.

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatNeedGlyph, formatQuantity } from "../format/quantity";

// ── formatNeedGlyph — grocery need-quantity glyphs (ε-exact + decimal fallback)

test("formatNeedGlyph maps the ⅛-ladder set to glyphs (with integer part)", () => {
  assert.equal(formatNeedGlyph(1 + 1 / 3), "1⅓"); // 1.333…
  assert.equal(formatNeedGlyph(1.125), "1⅛");
  assert.equal(formatNeedGlyph(1.5), "1½");
  assert.equal(formatNeedGlyph(1 + 2 / 3), "1⅔"); // 1.667
  assert.equal(formatNeedGlyph(1.25), "1¼");
  assert.equal(formatNeedGlyph(1.375), "1⅜");
  assert.equal(formatNeedGlyph(1.625), "1⅝");
  assert.equal(formatNeedGlyph(1.75), "1¾");
  assert.equal(formatNeedGlyph(1.875), "1⅞");
});

test("formatNeedGlyph renders a bare fraction when there is no whole part", () => {
  assert.equal(formatNeedGlyph(0.5), "½"); // NOT "0½"
  assert.equal(formatNeedGlyph(1 / 3), "⅓");
  assert.equal(formatNeedGlyph(0.125), "⅛");
});

test("formatNeedGlyph leaves whole numbers unchanged (no stray fraction)", () => {
  assert.equal(formatNeedGlyph(2), "2"); // NOT "2 0" or "2⅛"
  assert.equal(formatNeedGlyph(0), "0");
  assert.equal(formatNeedGlyph(6), "6");
});

test("formatNeedGlyph falls back to the decimal string for off-glyph values", () => {
  // 0.9 is > ε from ⅞ (0.875) → must NOT be glyphed; passes through verbatim.
  assert.equal(formatNeedGlyph(1.9), "1.9");
  assert.equal(formatNeedGlyph(0.1), "0.1");
  // A lightly-rounded third still matches within ε.
  assert.equal(formatNeedGlyph(1.667), "1⅔");
});

// ── formatQuantity — meal-detail / cook-mode: thirds now render correctly ────

test("formatQuantity renders ⅓/⅔ where it previously rounded to ⅜/⅝", () => {
  // Pre-fix: 1/8-rounding sent 1.333→1⅜ and 1.667→1⅝. Now they read as thirds.
  assert.equal(formatQuantity(1 + 1 / 3, "cup"), "1⅓");
  assert.equal(formatQuantity(1 + 2 / 3, "cup"), "1⅔");
  assert.equal(formatQuantity(1 / 3, "cup"), "⅓"); // bare
  assert.equal(formatQuantity(2 / 3, "tbsp"), "⅔");
});

test("formatQuantity keeps its existing eighth + whole behavior (no regression)", () => {
  assert.equal(formatQuantity(1.5, "cup"), "1½");
  assert.equal(formatQuantity(1.125, "cup"), "1⅛");
  assert.equal(formatQuantity(2, "cup"), "2");
  assert.equal(formatQuantity(0.75, "cup"), "¾");
  // whole/clove units still ceil to a whole count.
  assert.equal(formatQuantity(3.2, "clove"), "4");
  // Approximate rounding survives for non-third arbitrary decimals (1.9 → 1⅞).
  assert.equal(formatQuantity(1.9, "cup"), "1⅞");
});

// WS7-8b BUG-003 Block 1 — render-time segment builder tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildAmountRefSegments } from "../amountSegments";
import type { AmountRef } from "../../api/meals";

const ref = (quantity: number, unit: string, charStart: number, charEnd: number): AmountRef => ({
  ingredientId: "x",
  quantity,
  unit,
  charStart,
  charEnd,
});

describe("buildAmountRefSegments", () => {
  it("null/[] amountRefs → single plain segment (legacy/no-ref → plain render)", () => {
    const text = "Add the salt and stir.";
    assert.deepEqual(buildAmountRefSegments(text, null, 1), [{ text, isRef: false }]);
    assert.deepEqual(buildAmountRefSegments(text, [], 1.5), [{ text, isRef: false }]);
  });

  it("scales the ref amount by the multiplier and styles only the ref segment", () => {
    // "Spread ¾ cup of the mild salsa…" — span "¾ cup" at [7,12]
    const text = "Spread ¾ cup of the mild salsa over the base.";
    const segs = buildAmountRefSegments(text, [ref(0.75, "cup", 7, 12)], 1.5);
    // 0.75 × 1.5 = 1.125 → rounds to 1⅛
    assert.deepEqual(segs, [
      { text: "Spread ", isRef: false },
      { text: "1⅛ cup", isRef: true },
      { text: " of the mild salsa over the base.", isRef: false },
    ]);
    // reconstructs the prose around the replaced amount
    assert.equal(segs.map((s) => s.text).join("").includes("of the mild salsa"), true);
  });

  it("multiplier 1 (Cook Mode) renders the structured base amount", () => {
    const text = "Add 2 tablespoons taco seasoning.";
    const segs = buildAmountRefSegments(text, [ref(2, "tablespoons", 4, 17)], 1);
    assert.deepEqual(segs, [
      { text: "Add ", isRef: false },
      { text: "2 tablespoons", isRef: true },
      { text: " taco seasoning.", isRef: false },
    ]);
  });

  it("unitless ref renders just the number (no trailing unit)", () => {
    const text = "Mince 3 garlic cloves.";
    const segs = buildAmountRefSegments(text, [ref(3, "", 6, 7)], 2);
    // 3 × 2 = 6, no unit appended
    assert.deepEqual(segs, [
      { text: "Mince ", isRef: false },
      { text: "6", isRef: true },
      { text: " garlic cloves.", isRef: false },
    ]);
  });

  it("handles multiple in-order refs", () => {
    const text = "1 tsp cumin, 1 tsp chili.";
    const segs = buildAmountRefSegments(text, [ref(1, "tsp", 0, 5), ref(1, "tsp", 13, 18)], 3);
    assert.deepEqual(
      segs.filter((s) => s.isRef).map((s) => s.text),
      ["3 tsp", "3 tsp"],
    );
  });

  it("defensively ignores out-of-range refs without mangling prose", () => {
    const text = "Add salt.";
    const segs = buildAmountRefSegments(text, [ref(2, "cup", 50, 60)], 1);
    assert.deepEqual(segs, [{ text, isRef: false }]);
  });
});

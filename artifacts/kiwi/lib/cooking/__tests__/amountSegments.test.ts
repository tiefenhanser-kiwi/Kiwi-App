// WS7-8b BUG-003 Block 1 — render-time segment builder tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildAmountRefSegments, spanHoldsRange } from "../amountSegments";
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
    // 0.75 × 1.5 = 1.125 → rounds to 1⅛, and BUG-321 pluralizes the unit WORD
    // beside it: the step is prose a cook reads, so "1⅛ cups" and not "1⅛ cup".
    assert.deepEqual(segs, [
      { text: "Spread ", isRef: false },
      { text: "1⅛ cups", isRef: true },
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

// ═════════════════════════════════════════════════════════════════════════════
// [grocery] Block C — BUG-326: a range must not render as its midpoint.
//
// The catalog resolves an authored range to a single number and picks the
// MIDDLE: "3–4 shallow cuts" carries 3.5, "2–3 tablespoons" carries 2.5. This
// builder replaced the authored span with that number, so the cook read
// "3½ shallow cuts" and "2.5 tablespoons".
//
// The two literals below are the live spans measured on the stored catalog
// snapshot (api-server/scripts/output/ws9-30min/preimage_km30_*.json); both are
// exact midpoints.
// ═════════════════════════════════════════════════════════════════════════════

describe("🔴 BUG-326 — an authored range keeps its authored text", () => {
  it("the two live spans", () => {
    const t1 = "Off the heat, add the pesto and 2–3 tablespoons of the reserved pasta water.";
    const s1 = t1.indexOf("2–3 tablespoons");
    assert.deepEqual(
      buildAmountRefSegments(t1, [ref(2.5, "tablespoons", s1, s1 + "2–3 tablespoons".length)], 1),
      [
        { text: "Off the heat, add the pesto and ", isRef: false },
        { text: "2–3 tablespoons", isRef: true },
        { text: " of the reserved pasta water.", isRef: false },
      ],
    );

    const t2 = "Layer 3 bacon slices, 2–3 tomato slices, and a generous handful of lettuce.";
    const s2 = t2.indexOf("2–3");
    assert.deepEqual(
      buildAmountRefSegments(t2, [ref(2.5, "", s2, s2 + 3)], 1),
      [
        { text: "Layer 3 bacon slices, ", isRef: false },
        { text: "2–3", isRef: true },
        { text: " tomato slices, and a generous handful of lettuce.", isRef: false },
      ],
    );
  });

  it("🔴 SCALING LEAVES A RANGE AS WRITTEN — a range is a tolerance, not a quantity", () => {
    const text = "Add 2–3 tablespoons of water.";
    const start = text.indexOf("2–3 tablespoons");
    for (const mult of [0.5, 1, 1.5, 2, 3]) {
      const segs = buildAmountRefSegments(
        text,
        [ref(2.5, "tablespoons", start, start + "2–3 tablespoons".length)],
        mult,
      );
      assert.deepEqual(
        segs[1],
        { text: "2–3 tablespoons", isRef: true },
        `multiplier ${mult}`,
      );
    }
  });

  it("isRef stays TRUE — the span is still an amount and still earns the tint", () => {
    const text = "Make 3–4 shallow cuts.";
    const start = text.indexOf("3–4");
    const segs = buildAmountRefSegments(text, [ref(3.5, "", start, start + 3)], 1);
    assert.equal(segs[1].isRef, true);
    assert.equal(segs[1].text, "3–4");
  });

  it("every dash spelling, plus `to`", () => {
    for (const dash of ["-", "–", "—", " to "]) {
      const text = `Make 3${dash}4 cuts.`;
      const start = text.indexOf("3");
      const span = `3${dash}4`;
      const segs = buildAmountRefSegments(text, [ref(3.5, "", start, start + span.length)], 2);
      assert.equal(segs[1].text, span, dash);
    }
  });

  it("the join-back guarantee survives a kept range", () => {
    const text = "Off the heat, add 2–3 tablespoons of water and 1 cup of stock.";
    const a = text.indexOf("2–3 tablespoons");
    const b = text.indexOf("1 cup");
    const segs = buildAmountRefSegments(
      text,
      [ref(2.5, "tablespoons", a, a + "2–3 tablespoons".length), ref(1, "cup", b, b + 5)],
      1,
    );
    // The ranged span is byte-identical to the source; the structured one is
    // rebuilt. Both are refs.
    assert.equal(segs.filter((s) => s.isRef).length, 2);
    assert.equal(segs.find((s) => s.text.includes("2–3"))?.isRef, true);
  });

  it("a NON-range span still scales, exactly as before", () => {
    const text = "Add 2 tablespoons of water.";
    const start = text.indexOf("2 tablespoons");
    const segs = buildAmountRefSegments(
      text,
      [ref(2, "tablespoon", start, start + "2 tablespoons".length)],
      2,
    );
    assert.equal(segs[1].text, "4 tablespoons");
  });

  it("a hyphenated WORD is not a range — only digits on both sides", () => {
    // "low-sodium", "5-spice", "half-and-half": the guard must not fire.
    const text = "Add 2 cups low-sodium broth.";
    const start = text.indexOf("2 cups");
    const segs = buildAmountRefSegments(text, [ref(2, "cup", start, start + 6)], 2);
    assert.equal(segs[1].text, "4 cups");
  });

  it("spanHoldsRange is the whole predicate, and it is exported for the audit", () => {
    assert.equal(spanHoldsRange("2–3 tablespoons"), true);
    assert.equal(spanHoldsRange("60-70"), true);
    assert.equal(spanHoldsRange("3 to 4"), true);
    assert.equal(spanHoldsRange("2 tablespoons"), false);
    assert.equal(spanHoldsRange("¾ cup"), false);
    assert.equal(spanHoldsRange("low-sodium"), false);
  });
});

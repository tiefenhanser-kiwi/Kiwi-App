// WS7-8b BUG-003 Block 1 — render-time segment builder tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildAmountRefSegments, spanHoldsRange, unitIsCorrupt } from "../amountSegments";
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

// ── 🔴 WS9 BUG-334 — the fraction printed twice ─────────────────────────────
//
// Hans's device pass, item 16. Two literals from the report, and they are the
// two shapes: a fraction glyph the extractor left in BOTH fields, and the
// slash spelling of the same split.
describe("BUG-334 — a unit that opens with a number is not a unit", () => {
  it("🔴 the literal from the report: '1½ cups' renders ONCE", () => {
    // Meal b52fd852, step 6. The ref is {quantity: 1.5, unit: "½ cups"} and the
    // authored span is the seven characters "1½ cups". Before the guard this
    // printed "1½ ½ cups".
    const text = "Whisk together 1½ cups all-purpose flour with the baking powder.";
    const start = text.indexOf("1½ cups");
    assert.equal(start, 15); // the charStart the report quoted
    const segs = buildAmountRefSegments(text, [ref(1.5, "½ cups", start, start + 7)], 1);
    assert.equal(segs[1].text, "1½ cups");
    assert.equal(segs[1].isRef, true); // still an amount, still terracotta
    assert.equal(segs.map((s) => s.text).join(""), text); // prose is intact
  });

  it("🔴 the second literal: Cook Mode's '1 3/4 3/4 lbs'", () => {
    // The DIGIT class — here the quantity is 1 and the fraction was LOST into
    // the unit, so printing the structured value would be wrong twice over.
    // Rendering the authored text is right either way, which is why one guard
    // serves both classes.
    const text = "Place the trimmed 1 3/4 lbs chicken thighs in the slow cooker.";
    const start = text.indexOf("1 3/4 lbs");
    const segs = buildAmountRefSegments(text, [ref(1, "3/4 lbs", start, start + 9)], 1);
    assert.equal(segs[1].text, "1 3/4 lbs");
    assert.equal(segs.map((s) => s.text).join(""), text);
  });

  it("🔴 the range case is NOT the range guard — the span is just '5½'", () => {
    // The report read this as BUG-326 letting "½–6 hours" through. It is not:
    // the ref's span is the four characters "5½" and "–6 hours" is ordinary
    // prose this builder never touched. Measured across all 3,266 corrupt refs,
    // ZERO authored spans contain a range, so spanHoldsRange fires on none.
    const text = "Cover and cook on low for 5½–6 hours (or high for 3–3½ hours).";
    const start = text.indexOf("5½");
    assert.equal(spanHoldsRange("5½"), false); // the range guard is not involved
    const segs = buildAmountRefSegments(text, [ref(5.5, "½", start, start + 2)], 1);
    assert.equal(segs.map((s) => s.text).join(""), text);
    assert.ok(!segs.some((s) => s.text.includes("½ ½")));
  });

  it("the guard is a SHAPE test — every way a number can lead", () => {
    const text = "Add 2 cups broth.";
    const start = text.indexOf("2 cups");
    for (const unit of ["½ cups", "¼ pounds", "⅜ oz", "3/4 lbs", "/4 cups", "12 count", "½"]) {
      const segs = buildAmountRefSegments(text, [ref(9, unit, start, start + 6)], 3);
      assert.equal(segs[1].text, "2 cups", `unit "${unit}" must be refused`);
    }
  });

  it("a REAL unit is untouched, and still scales", () => {
    const text = "Add 2 cups broth.";
    const start = text.indexOf("2 cups");
    for (const unit of ["cup", "cups", "tablespoon", "lb", "oz", "g", "clove", "fl oz", ""]) {
      const segs = buildAmountRefSegments(text, [ref(2, unit, start, start + 6)], 3);
      assert.notEqual(segs[1].text, "2 cups", `unit "${unit}" must still scale`);
    }
  });

  it("unitIsCorrupt is the whole predicate, exported for the repair script", () => {
    assert.equal(unitIsCorrupt("½ cups"), true);
    assert.equal(unitIsCorrupt("3/4 lbs"), true);
    assert.equal(unitIsCorrupt("2 hours"), true);
    assert.equal(unitIsCorrupt(" ¾"), true); // leading space tolerated
    assert.equal(unitIsCorrupt("cups"), false);
    assert.equal(unitIsCorrupt("fl oz"), false);
    assert.equal(unitIsCorrupt(""), false);
    assert.equal(unitIsCorrupt(null), false);
    assert.equal(unitIsCorrupt(undefined), false);
  });
});

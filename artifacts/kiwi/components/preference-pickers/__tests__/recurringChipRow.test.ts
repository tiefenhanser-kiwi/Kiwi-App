// WS9 BUG-152 — the recurring-items chip row.
//
// MECHANISM, VERIFIED (not a render bug, not a stale query): the picker's
// `value` is a local useState buffer in preferences.tsx, updated synchronously
// by `update()`, so an added item DID render immediately — as a row in the list
// at the TOP of the section, while the user was looking at the input at the
// BOTTOM. The only other confirmation was an 800ms-debounced toast. Nothing was
// broken; the feedback was simply nowhere near the action.
//
// So there is no invalidation to test here — and that matters, because a React
// Query invalidation test in this repo has been vacuous before (seeded via
// queryCache.build() with no subscribed observer, so invalidateQueries marked
// the query stale without refetching and every assertion passed for the wrong
// reason). Asserting a refetch that this code path never performs would be that
// same shape of nothing.
//
// What IS testable is the composition: a custom item must appear in the chip
// row that sits directly above the input.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COMMON_RECURRING_ITEMS, recurringChipRow } from "@/lib/domain";

const COMMON = COMMON_RECURRING_ITEMS as readonly string[];

describe("BUG-152: a custom recurring item appears in the chip row", () => {
  it("guard C1 — the defect: a custom item is IN the row after add", () => {
    const row = recurringChipRow(["lime"]);
    assert.ok(row.includes("lime"), `"lime" missing from chip row: ${row.join(", ")}`);
    // ...and it is the user's own entry that appears, not a near-match.
    assert.equal(row.filter((i) => i === "lime").length, 1);
  });

  it("guard C2 — with no custom items the row is EXACTLY the commons", () => {
    assert.deepEqual(recurringChipRow([]), [...COMMON]);
    // Selecting commons must not append anything — they are already there.
    assert.deepEqual(recurringChipRow(["Milk", "Eggs"]), [...COMMON]);
  });

  it("guard C3 — a common item never renders twice", () => {
    const row = recurringChipRow(["Bananas", "lime", "Coffee"]);
    for (const item of COMMON) {
      assert.equal(
        row.filter((i) => i === item).length,
        1,
        `"${item}" duplicated in the chip row`,
      );
    }
    assert.equal(new Set(row).size, row.length, "chip row contains duplicates");
  });

  it("guard C4 — order is stable: commons first, customs in insertion order", () => {
    // The chips are keyed by label, so an unstable order would reshuffle the
    // row on every keystroke that changes `value`.
    const row = recurringChipRow(["zucchini", "lime", "Milk", "apple"]);
    assert.deepEqual(row.slice(0, COMMON.length), [...COMMON]);
    assert.deepEqual(row.slice(COMMON.length), ["zucchini", "lime", "apple"]);
  });

  it("guard C5 — removing a custom item takes its chip away", () => {
    const after = recurringChipRow(["lime", "zucchini"]).length;
    const removed = recurringChipRow(["zucchini"]);
    assert.ok(!removed.includes("lime"));
    assert.equal(removed.length, after - 1);
  });

  it("guard C6 — the input is untouched (pure, no mutation of `value`)", () => {
    // The picker passes its prop straight in; mutating it would corrupt the
    // preferences form buffer that auto-save PATCHes.
    const value = ["lime"];
    const snapshot = [...value];
    recurringChipRow(value);
    assert.deepEqual(value, snapshot);
  });
});

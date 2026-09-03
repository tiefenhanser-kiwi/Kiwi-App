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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { RecurringItemsPicker } from "../RecurringItemsPicker";
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

// ── WS9 (Sept 3) — the duplicate list is gone; chips are the only indicator ──
// Hans, on device: "we're duplicating the list of items and the chips… I think
// we can remove the list and stick with the chips as the only visual
// indicators." The section used to render every selected item TWICE — a
// removable list at the top and the chip row below — and he never saw the list.
//
// These are RENDER tests, deliberately: the helper tests above prove the chip
// row COMPOSES correctly, but they could not have caught a second copy of the
// same items rendered somewhere else in the component.
describe("RecurringItemsPicker renders each item exactly once", () => {
  function renderPicker(value: string[]) {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(RecurringItemsPicker, { value, onChange: () => {} }),
      );
    });
    return renderer;
  }

  /** Every literal string rendered anywhere in the tree. */
  function allText(renderer: TestRenderer.ReactTestRenderer): string[] {
    const out: string[] = [];
    const walk = (n: unknown): void => {
      if (n == null) return;
      if (typeof n === "string") { out.push(n); return; }
      if (Array.isArray(n)) { n.forEach(walk); return; }
      const node = n as { children?: unknown };
      if (Array.isArray(node.children)) node.children.forEach(walk);
    };
    walk(renderer.toJSON());
    return out;
  }

  it("🔴 a selected item appears ONCE, not twice — the defect Hans reported", () => {
    const renderer = renderPicker(["Milk", "lime"]);
    const texts = allText(renderer);
    for (const item of ["Milk", "lime"]) {
      assert.equal(
        texts.filter((t) => t === item).length,
        1,
        `"${item}" rendered ${texts.filter((t) => t === item).length}× — the ` +
          "duplicate list is back",
      );
    }
    renderer.unmount();
  });

  it("a CUSTOM item still renders — deleting the list stranded nothing", () => {
    // The list was the only place a custom item appeared before BUG-152, and
    // the only thing with an explicit remove control before this change. If the
    // chip row ever stops carrying customs, an item could be selected and
    // unreachable — which is the one outcome that would have made the deletion
    // wrong.
    const renderer = renderPicker(["lime"]);
    assert.ok(allText(renderer).includes("lime"), "custom item has no chip");
    renderer.unmount();
  });

  it("every common item renders whether selected or not", () => {
    const renderer = renderPicker([]);
    const texts = allText(renderer);
    for (const item of COMMON_RECURRING_ITEMS) {
      assert.ok(texts.includes(item), `common item "${item}" missing`);
    }
    renderer.unmount();
  });
});

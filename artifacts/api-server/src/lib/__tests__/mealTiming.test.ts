// WS9 D-WS9-235 — deriveMealTiming unit tests.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deriveMealTiming } from "../mealTiming";
import type { SchedulerDish } from "../cookingScheduler";

function dish(
  dishId: string,
  steps: { min: number; phase?: "prep" | "cook" | "rest" | "assemble" | "preheat" | "hold"; sensitive?: boolean }[],
  positionIndex = 0,
): SchedulerDish {
  return {
    dishId,
    title: dishId,
    positionIndex,
    steps: steps.map((s, i) => ({
      stepIndex: i,
      estimatedMinutes: s.min,
      phaseType: s.phase ?? "cook",
      isTimingSensitive: s.sensitive ?? false,
    })),
  };
}

describe("deriveMealTiming (D-WS9-235)", () => {
  it("Hans's acceptance example: 20-min bake beside a 10-min sauté", () => {
    const t = deriveMealTiming([
      dish("bake", [{ min: 20, phase: "cook", sensitive: false }], 0),
      dish("saute", [{ min: 10, phase: "cook", sensitive: true }], 1),
    ]);
    assert.equal(t.totalMinutes, 20, "the sauté overlaps the unattended bake");
    assert.equal(t.activeMinutes, 10, "only the watched sauté costs hands");
    assert.deepEqual([...t.dishTotals.entries()].sort(), [["bake", 20], ["saute", 10]]);
  });

  it("a single-dish meal's total is its serial sum", () => {
    // One dish, nothing to overlap with: every step runs back to back.
    const t = deriveMealTiming([
      dish("solo", [
        { min: 5, phase: "prep" },
        { min: 58, phase: "cook", sensitive: false },
        { min: 10, phase: "rest" },
      ]),
    ]);
    assert.equal(t.totalMinutes, 73, "5 + 58 + 10");
    // prep is hands-on; the bake and the rest are not.
    assert.equal(t.activeMinutes, 5);
    assert.equal(t.dishTotals.get("solo"), 73);
  });

  it("returns NULLS, never zeros, when nothing is derivable", () => {
    // THE DISTINCTION IS LOAD-BEARING: 0 is a claim that the meal takes no
    // time, and a caller writing that into estimatedTimeMinutes would replace
    // an unverified number with a definitely-wrong one. Null means "I cannot
    // say" and the caller keeps what it had.
    for (const input of [[], [dish("empty", [])]]) {
      const t = deriveMealTiming(input);
      assert.equal(t.totalMinutes, null);
      assert.equal(t.activeMinutes, null);
      assert.equal(t.dishTotals.size, 0);
    }
  });

  it("a dish with no steps does not drag the meal's total to zero", () => {
    // A real shape: one dish fully specified, a sibling that never got steps.
    const t = deriveMealTiming([
      dish("real", [{ min: 30, phase: "cook", sensitive: true }], 0),
      dish("stepless", [], 1),
    ]);
    assert.equal(t.totalMinutes, 30);
    assert.equal(t.activeMinutes, 30);
    assert.equal(t.dishTotals.has("stepless"), false, "no total for a dish with no steps");
  });
});

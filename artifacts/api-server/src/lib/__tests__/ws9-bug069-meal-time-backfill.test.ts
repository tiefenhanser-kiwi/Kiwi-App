// BUG-069 / D-WS9-128 — unit tests for the meal-time recompute formula.
// Pure arithmetic; no DB. Verifies: never lowers a value · respects the 240 gate ·
// handles a meal with no steps.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isEligible,
  recomputeEt,
  MAX_STEP_GATE,
} from "../../../scripts/ws9-bug069-meal-time-backfill";

describe("BUG-069 meal-time recompute", () => {
  describe("recomputeEt — never lowers a value", () => {
    it("raises et to the step sum when the sum is larger (the defect case)", () => {
      // Slow Cooker Beef Stew: stored 30, honest step sum 527.
      assert.equal(recomputeEt({ currentEt: 30, stepSum: 527 }), 527);
    });

    it("keeps the current value when it already exceeds the step sum", () => {
      // An already-correct long-cook meal must not be dragged DOWN to a
      // parallelism-deflated sum.
      assert.equal(recomputeEt({ currentEt: 600, stepSum: 480 }), 600);
    });

    it("is a no-op when current equals the step sum", () => {
      assert.equal(recomputeEt({ currentEt: 480, stepSum: 480 }), 480);
    });

    it("returns the current value unchanged for a meal with no steps (sum 0)", () => {
      assert.equal(recomputeEt({ currentEt: 45, stepSum: 0 }), 45);
    });
  });

  describe("isEligible — respects the 240 gate", () => {
    it("flags a meal with a 4h+ step whose et is below its max step", () => {
      assert.equal(isEligible({ maxStep: 480, currentEt: 30 }), true);
    });

    it("does NOT flag a meal whose max step is under the gate, even if et < maxStep", () => {
      // The 120–239 band the ruling excludes (parallelism-heavy braises/proofs).
      assert.equal(isEligible({ maxStep: 210, currentEt: 55 }), false);
      assert.equal(isEligible({ maxStep: MAX_STEP_GATE - 1, currentEt: 10 }), false);
    });

    it("does NOT flag a long-cook meal whose et already meets/exceeds its max step", () => {
      // Provably-correct: a meal cannot take less than its longest step, and this
      // one doesn't — so there is nothing to fix.
      assert.equal(isEligible({ maxStep: 480, currentEt: 480 }), false);
      assert.equal(isEligible({ maxStep: 480, currentEt: 510 }), false);
    });

    it("does NOT flag a meal with no steps (max step 0)", () => {
      assert.equal(isEligible({ maxStep: 0, currentEt: 30 }), false);
    });

    it("gate boundary: exactly 240 is eligible when et is below it", () => {
      assert.equal(isEligible({ maxStep: 240, currentEt: 50 }), true);
    });
  });

  describe("eligibility + recompute compose to a strict raise", () => {
    it("every eligible row strictly increases (et < maxStep <= sum after fix)", () => {
      const rows = [
        { currentEt: 25, maxStep: 360, stepSum: 429 },
        { currentEt: 55, maxStep: 240, stepSum: 341 },
        { currentEt: 210, maxStep: 480, stepSum: 675 },
      ];
      for (const r of rows) {
        assert.equal(isEligible(r), true);
        const next = recomputeEt(r);
        assert.ok(next > r.currentEt, `expected raise for ${JSON.stringify(r)}`);
        // Idempotency: after the fix, et >= maxStep, so it is no longer eligible.
        assert.equal(isEligible({ maxStep: r.maxStep, currentEt: next }), false);
      }
    });
  });
});

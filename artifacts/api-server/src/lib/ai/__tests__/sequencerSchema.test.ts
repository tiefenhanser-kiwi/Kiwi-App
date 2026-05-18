// WS6 6-CLOSE / D-WS6-093 — SequencerDishStepSchema unit tests.
// Pure Zod parsing — no DB, no AI, no HTTP.
//
// Covers the mutual-exclusion invariant added in D-WS6-093:
// isTimingSensitive=true MUST NOT combine with parallelGroup="passive-*",
// because passive-* groups are hands-free by definition.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SequencerDishStepSchema } from "../schemas/sequencer";

function step(opts: Partial<{
  dishId: string;
  stepIndex: number;
  stepText: string;
  phaseType: "prep" | "cook" | "rest" | "preheat" | "assemble" | "hold";
  parallelGroup: string | null;
  estimatedMinutes: number;
  isTimingSensitive: boolean;
}> = {}) {
  return {
    dishId: "dish-1",
    stepIndex: 0,
    stepText: "Sear the chicken until golden.",
    phaseType: "cook" as const,
    parallelGroup: null as string | null,
    estimatedMinutes: 5,
    isTimingSensitive: false,
    ...opts,
  };
}

describe("SequencerDishStepSchema", () => {
  describe("D-WS6-093 isTimingSensitive vs parallelGroup mutual exclusion", () => {
    it("rejects isTimingSensitive=true with parallelGroup='passive-simmer'", () => {
      const result = SequencerDishStepSchema.safeParse(
        step({ isTimingSensitive: true, parallelGroup: "passive-simmer" }),
      );
      assert.equal(result.success, false);
      if (!result.success) {
        const issue = result.error.issues.find((i) =>
          i.message.includes("isTimingSensitive cannot be true"),
        );
        assert.ok(issue, "expected mutual-exclusion issue on isTimingSensitive");
        assert.deepEqual(issue?.path, ["isTimingSensitive"]);
      }
    });

    it("rejects isTimingSensitive=true with parallelGroup='passive-roast'", () => {
      const result = SequencerDishStepSchema.safeParse(
        step({ isTimingSensitive: true, parallelGroup: "passive-roast" }),
      );
      assert.equal(result.success, false);
    });

    it("accepts isTimingSensitive=true with parallelGroup='active-sear'", () => {
      const result = SequencerDishStepSchema.safeParse(
        step({ isTimingSensitive: true, parallelGroup: "active-sear" }),
      );
      assert.equal(result.success, true);
    });

    it("accepts isTimingSensitive=false with parallelGroup='passive-simmer'", () => {
      const result = SequencerDishStepSchema.safeParse(
        step({ isTimingSensitive: false, parallelGroup: "passive-simmer" }),
      );
      assert.equal(result.success, true);
    });

    it("accepts isTimingSensitive=true with parallelGroup=null", () => {
      const result = SequencerDishStepSchema.safeParse(
        step({ isTimingSensitive: true, parallelGroup: null }),
      );
      assert.equal(result.success, true);
    });
  });
});

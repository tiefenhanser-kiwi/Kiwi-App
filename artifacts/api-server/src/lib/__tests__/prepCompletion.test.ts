// WS7-8a Block 3 (D-WS7-153) — prep-completion derivation unit tests.
// Pure (no DB, no AI, no HTTP).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  stepKeysOfResult,
  derivePrepCompletion,
  effectivePrepStatus,
} from "../prepCompletion";
import type { PrepWeekResult } from "../ai/schemas/prepWeek";

// Minimal step set the derivation consumes (matches prepStepSet.PrepStepRef).
type StepRef = { stepKey: string; contributesToMealIds: string[] };

const MEAL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEAL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// A structure: onion produce step → both meals; beef protein step → meal A only.
function structure(): PrepWeekResult {
  return {
    totalEstimatedMinutes: 10,
    phases: [
      { phase: "seasonings_dry", title: "S", skippable: true, steps: [] },
      { phase: "sauces_marinades", title: "M", skippable: true, steps: [] },
      {
        phase: "produce",
        title: "Produce",
        skippable: false,
        steps: [
          {
            number: 1,
            stepKey: "produce#onion",
            title: "Dice onion",
            instructions: "Dice.",
            estimatedMinutes: 5,
            contributesToMealIds: [MEAL_A, MEAL_B],
          },
        ],
      },
      {
        phase: "proteins",
        title: "Proteins",
        skippable: false,
        steps: [
          {
            number: 1,
            stepKey: "proteins#beef",
            title: "Portion beef",
            instructions: "Portion.",
            estimatedMinutes: 5,
            contributesToMealIds: [MEAL_A],
          },
        ],
      },
    ],
  };
}

// The two prep steps as the derivation sees them.
const STEPS: StepRef[] = [
  { stepKey: "produce#onion", contributesToMealIds: [MEAL_A, MEAL_B] },
  { stepKey: "proteins#beef", contributesToMealIds: [MEAL_A] },
];

describe("stepKeysOfResult — prune keep-set", () => {
  it("collects every stepKey from an assembled result", () => {
    assert.deepEqual(stepKeysOfResult(structure()), new Set(["produce#onion", "proteins#beef"]));
  });
});

describe("derivePrepCompletion — per-meal + rollup (D-WS7-153)", () => {
  const steps = STEPS;

  it("none checked → not_prepped, both meals not prepped", () => {
    const r = derivePrepCompletion([MEAL_A, MEAL_B], steps, new Set());
    assert.deepEqual(r.perMeal, { [MEAL_A]: false, [MEAL_B]: false });
    assert.equal(r.derivedPrepStatus, "not_prepped");
  });

  it("all contributing steps checked → prepped, both meals prepped", () => {
    const r = derivePrepCompletion(
      [MEAL_A, MEAL_B],
      steps,
      new Set(["produce#onion", "proteins#beef"]),
    );
    assert.deepEqual(r.perMeal, { [MEAL_A]: true, [MEAL_B]: true });
    assert.equal(r.derivedPrepStatus, "prepped");
  });

  it("mixed → partial (meal B done via onion, meal A still needs beef)", () => {
    // Only the onion step is checked. Meal B's only contributing step is onion
    // → B prepped. Meal A also needs beef → A not prepped.
    const r = derivePrepCompletion([MEAL_A, MEAL_B], steps, new Set(["produce#onion"]));
    assert.deepEqual(r.perMeal, { [MEAL_A]: false, [MEAL_B]: true });
    assert.equal(r.derivedPrepStatus, "partial");
  });

  it("zero-prep meal is vacuously prepped (no contributing steps)", () => {
    // MEAL_C has no steps in the structure → ready to cook. With nothing
    // checked, A+B are not prepped but C is → partial (some prepped).
    const MEAL_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const r = derivePrepCompletion([MEAL_A, MEAL_B, MEAL_C], steps, new Set());
    assert.equal(r.perMeal[MEAL_C], true);
    assert.equal(r.derivedPrepStatus, "partial");
  });

  it("a plan of ALL zero-prep (all-easy) meals rolls up to prepped", () => {
    const MEAL_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    // No steps at all (empty structure) → every meal vacuously prepped.
    const r = derivePrepCompletion([MEAL_A, MEAL_C], [], new Set());
    assert.deepEqual(r.perMeal, { [MEAL_A]: true, [MEAL_C]: true });
    assert.equal(r.derivedPrepStatus, "prepped");
  });

  it("orphan checked keys (not in the step set) don't affect the rollup", () => {
    // A stale completion for a since-removed step must not mark anything prepped.
    const r = derivePrepCompletion([MEAL_A, MEAL_B], steps, new Set(["produce#ghost"]));
    assert.deepEqual(r.perMeal, { [MEAL_A]: false, [MEAL_B]: false });
    assert.equal(r.derivedPrepStatus, "not_prepped");
  });

  it("a step pointing at a meal outside the universe is ignored", () => {
    const r = derivePrepCompletion([MEAL_A], steps, new Set(["produce#onion", "proteins#beef"]));
    // Only MEAL_A in the universe; both its steps checked → prepped.
    assert.deepEqual(r.perMeal, { [MEAL_A]: true });
    assert.equal(r.derivedPrepStatus, "prepped");
  });

  it("empty plan (no meals) → not_prepped", () => {
    const r = derivePrepCompletion([], steps, new Set());
    assert.deepEqual(r.perMeal, {});
    assert.equal(r.derivedPrepStatus, "not_prepped");
  });
});

describe("effectivePrepStatus — manual override precedence", () => {
  it("manual pin wins over derived", () => {
    assert.equal(effectivePrepStatus(true, "prepped", "not_prepped"), "prepped");
    assert.equal(effectivePrepStatus(true, "not_prepped", "prepped"), "not_prepped");
  });

  it("non-manual returns the derived rollup", () => {
    assert.equal(effectivePrepStatus(false, "prepped", "partial"), "partial");
    assert.equal(effectivePrepStatus(false, "not_prepped", "prepped"), "prepped");
  });
});

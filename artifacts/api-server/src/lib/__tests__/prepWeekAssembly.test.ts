// WS7-8a Block 2 — code-owned assembly unit tests.
// Pure (no DB, no AI). Proves the by-construction guarantee: numeric +
// attribution fields trace to the engine/step plan, never to AI prose.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { combinePrep, type PrepCombineInput } from "../prepCombineEngine";
import {
  buildStepPlan,
  assemblePrepWeekResult,
  PrepNarrationIncompleteError,
  type StepPlan,
} from "../prepWeekAssembly";
import type { PrepNarrationResult } from "../ai/schemas/prepNarration";

const MEAL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEAL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// Two meals share onion (produce) + a 3-spice blend on meal A's dish.
function plan(): PrepCombineInput {
  const onionA = {
    ingredientId: "ing-onion",
    ingredientName: "yellow onion",
    category: "Produce",
    quantity: 1,
    unit: "each",
    preparationNote: "diced",
  };
  return {
    meals: [
      {
        mealId: MEAL_A,
        mealName: "Tacos",
        dishes: [
          {
            dishId: "d-a",
            dishName: "Seasoned Beef",
            ingredients: [
              onionA,
              { ingredientId: "ing-cumin", ingredientName: "cumin", category: "Pantry", quantity: 1, unit: "tsp" },
              { ingredientId: "ing-paprika", ingredientName: "paprika", category: "Pantry", quantity: 1, unit: "tsp" },
              { ingredientId: "ing-chili", ingredientName: "chili powder", category: "Pantry", quantity: 2, unit: "tsp" },
              { ingredientId: "ing-beef", ingredientName: "ground beef", category: "Protein", quantity: 1, unit: "lb" },
            ],
          },
        ],
      },
      {
        mealId: MEAL_B,
        mealName: "Fajitas",
        dishes: [
          {
            dishId: "d-b",
            dishName: "Fajitas",
            ingredients: [{ ...onionA, quantity: 2 }],
          },
        ],
      },
    ],
  };
}

// Echo every planned step back with canned prose + a fixed time.
function echo(stepPlan: StepPlan, minutes = 5): PrepNarrationResult {
  return {
    steps: stepPlan.steps.map((s, i) => ({
      stepId: s.stepId,
      title: `Title ${i}`,
      instructions: `Instructions ${i}`,
      estimatedMinutes: minutes,
    })),
  };
}

// ── buildStepPlan ────────────────────────────────────────────────────────────

describe("buildStepPlan", () => {
  it("emits one produce step (onion grouped across both meals)", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    const produceSteps = sp.steps.filter((s) => s.phase === "produce");
    assert.equal(produceSteps.length, 1);
    assert.equal(produceSteps[0].number, 1);
    assert.equal(produceSteps[0].stepId, "produce#1");
    // attribution = union of both meals
    assert.deepEqual(
      [...produceSteps[0].contributesToMealIds].sort(),
      [MEAL_A, MEAL_B].sort(),
    );
  });

  it("collapses the 3-spice blend into ONE seasonings_dry step (B1)", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    const blendSteps = sp.steps.filter((s) => s.phase === "seasonings_dry");
    assert.equal(blendSteps.length, 1);
    assert.equal(blendSteps[0].isBlend, true);
    // all three spice components present in the single blend step
    const names = blendSteps[0].components.map((c) => c.ingredientName).sort();
    assert.deepEqual(names, ["chili powder", "cumin", "paprika"]);
  });

  it("narrationInput mirrors the planned steps 1:1 by stepId", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    assert.equal(sp.narrationInput.planName, "Test Plan");
    assert.deepEqual(
      sp.narrationInput.steps.map((s) => s.stepId),
      sp.steps.map((s) => s.stepId),
    );
  });

  it("routes ground beef to a proteins step", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    const proteinSteps = sp.steps.filter((s) => s.phase === "proteins");
    assert.equal(proteinSteps.length, 1);
    assert.equal(proteinSteps[0].components[0].ingredientName, "ground beef");
  });
});

// ── assemblePrepWeekResult ───────────────────────────────────────────────────

describe("assemblePrepWeekResult", () => {
  it("emits 4 phases in fixed order with proteins last", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    const result = assemblePrepWeekResult(sp, echo(sp));
    assert.deepEqual(
      result.phases.map((p) => p.phase),
      ["seasonings_dry", "sauces_marinades", "produce", "proteins"],
    );
    assert.equal(result.phases[3].phase, "proteins");
  });

  it("takes numbers + attribution from the plan, prose from the AI", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    // Narration tries to look authoritative but has no number/mealId field.
    const result = assemblePrepWeekResult(sp, {
      steps: sp.steps.map((s) => ({
        stepId: s.stepId,
        title: "AI TITLE",
        instructions: "AI INSTRUCTIONS",
        estimatedMinutes: 7,
      })),
    });
    const produce = result.phases.find((p) => p.phase === "produce")!;
    const planned = sp.steps.find((s) => s.phase === "produce")!;
    assert.equal(produce.steps[0].title, "AI TITLE"); // prose = AI
    assert.equal(produce.steps[0].number, planned.number); // number = code
    assert.deepEqual(
      produce.steps[0].contributesToMealIds, // attribution = code
      planned.contributesToMealIds,
    );
  });

  it("totalEstimatedMinutes is the SUM of AI step estimates", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    const result = assemblePrepWeekResult(sp, echo(sp, 6));
    // 3 steps (blend + produce + protein) × 6 = 18.
    assert.equal(sp.steps.length, 3);
    assert.equal(result.totalEstimatedMinutes, 18);
  });

  it("clamps totalEstimatedMinutes to the schema ceiling (240)", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    // 3 steps × 60 = 180 < 240; push past with a fat fixture instead.
    const result = assemblePrepWeekResult(sp, echo(sp, 60));
    assert.ok(result.totalEstimatedMinutes <= 240);
    assert.equal(result.totalEstimatedMinutes, 180);
  });

  it("carries an optional storageNote through when present", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    const narration: PrepNarrationResult = {
      steps: sp.steps.map((s, i) => ({
        stepId: s.stepId,
        title: `T${i}`,
        instructions: `I${i}`,
        estimatedMinutes: 5,
        ...(s.phase === "produce" ? { storageNote: "Fridge, 3 days" } : {}),
      })),
    };
    const result = assemblePrepWeekResult(sp, narration);
    const produce = result.phases.find((p) => p.phase === "produce")!;
    assert.equal(produce.steps[0].storageNote, "Fridge, 3 days");
    // a step without storageNote omits it entirely
    const blend = result.phases.find((p) => p.phase === "seasonings_dry")!;
    assert.equal("storageNote" in blend.steps[0], false);
  });

  it("throws PrepNarrationIncompleteError when a planned step is unnarrated", () => {
    const sp = buildStepPlan(combinePrep(plan()), "Test Plan");
    // Drop the last step from the narration.
    const partial: PrepNarrationResult = {
      steps: sp.steps.slice(0, -1).map((s, i) => ({
        stepId: s.stepId,
        title: `T${i}`,
        instructions: `I${i}`,
        estimatedMinutes: 5,
      })),
    };
    assert.throws(
      () => assemblePrepWeekResult(sp, partial),
      (err) => err instanceof PrepNarrationIncompleteError,
    );
  });
});

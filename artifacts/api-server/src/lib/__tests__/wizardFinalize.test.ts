// WS7-5c Block A — wizardFinalize unit tests.
//
// Pins:
//   1. Details-stage Zod schemas accept the stepless shape, reject
//      malformed ingredients/macros.
//   2. mergeFinalizeStepsIntoDetails — positional merge invariants
//      (missing / extra / duplicate keys all error).
//   3. §27 round-trip: a stepless details draft + a finalize-AI output
//      merge into a payload that parses against WizardExpandedPlanSchema
//      (the materializer's read-side schema).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  WizardExpandDishDetailsSchema,
  WizardExpandedPlanDetailsSchema,
  WizardExpandedPlanSchema,
  WizardFinalizeStepsResultSchema,
  type WizardExpandedPlanDetails,
  type WizardFinalizeStepsResult,
} from "../ai/schemas/wizard";
import { mergeFinalizeStepsIntoDetails } from "../wizardFinalize";

// ── builders ──────────────────────────────────────────────────────────────

function detailsPlan(): WizardExpandedPlanDetails {
  return {
    candidateId: "c-roundtrip",
    title: "Cozy Comfort Week",
    tags: ["Comfort", "Easy"],
    whyBullets: [
      "Sheet-pan and one-pot meals minimize cleanup",
      "Garlic shared across 3 meals",
    ],
    meals: [
      {
        title: "Sheet-pan harissa chicken",
        cuisineType: "Mediterranean",
        estimatedTimeMinutes: 35,
        difficulty: "easy",
        servings: 4,
        dishes: [
          {
            title: "Sheet-pan harissa chicken",
            role: "main",
            positionIndex: 0,
            ingredients: [
              { name: "chicken thighs", quantity: 1.5, unit: "pound" },
              { name: "harissa", quantity: 3, unit: "tablespoon" },
              { name: "olive oil", quantity: 2, unit: "tablespoon" },
            ],
            macros: {
              caloriesPerServing: 540,
              proteinGPerServing: 38,
              carbsGPerServing: 12,
              fatGPerServing: 28,
            },
          },
          {
            title: "Roasted vegetables",
            role: "side",
            positionIndex: 1,
            ingredients: [{ name: "broccoli", quantity: 1, unit: "pound" }],
            macros: {
              caloriesPerServing: 80,
              proteinGPerServing: 4,
              carbsGPerServing: 14,
              fatGPerServing: 1,
            },
          },
        ],
      },
      {
        title: "Tomato soup + grilled cheese",
        cuisineType: "American",
        estimatedTimeMinutes: 25,
        difficulty: "easy",
        servings: 4,
        dishes: [
          {
            title: "Tomato soup",
            role: "main",
            positionIndex: 0,
            ingredients: [
              { name: "canned tomatoes", quantity: 28, unit: "ounce" },
              { name: "yellow onion", quantity: 1, unit: "each" },
            ],
            macros: {
              caloriesPerServing: 220,
              proteinGPerServing: 6,
              carbsGPerServing: 30,
              fatGPerServing: 8,
            },
          },
        ],
      },
    ],
  };
}

function fullStepsResult(): WizardFinalizeStepsResult {
  return {
    dishSteps: [
      {
        mealIndex: 0,
        dishIndex: 0,
        steps: [
          "Preheat the oven to 425F.",
          "Toss 1.5 lb chicken thighs with 3 tablespoons harissa and 2 tablespoons olive oil.",
          "Roast for 25 minutes until 165F internal.",
        ],
      },
      {
        mealIndex: 0,
        dishIndex: 1,
        steps: ["Steam 1 lb broccoli for 5 minutes."],
      },
      {
        mealIndex: 1,
        dishIndex: 0,
        steps: [
          "Sweat 1 diced yellow onion in olive oil over medium heat for 5 minutes.",
          "Add 28 oz canned tomatoes; simmer 15 minutes.",
          "Blend until smooth and serve.",
        ],
      },
    ],
  };
}

// ── 1. Details-stage schema acceptance / rejection ────────────────────────

describe("WizardExpandDishDetailsSchema — accepts stepless dish, rejects malformed", () => {
  it("accepts a dish with ingredients and NO steps field", () => {
    const parsed = WizardExpandDishDetailsSchema.safeParse({
      title: "Sheet-pan harissa chicken",
      role: "main",
      positionIndex: 0,
      ingredients: [
        { name: "chicken thighs", quantity: 1.5, unit: "pound" },
      ],
    });
    assert.equal(parsed.success, true);
  });

  it("rejects a dish with 0 ingredients", () => {
    const parsed = WizardExpandDishDetailsSchema.safeParse({
      title: "Empty",
      role: "main",
      positionIndex: 0,
      ingredients: [],
    });
    assert.equal(parsed.success, false);
  });

  it("rejects a dish with a non-positive ingredient quantity", () => {
    const parsed = WizardExpandDishDetailsSchema.safeParse({
      title: "Bad ingredient",
      role: "main",
      positionIndex: 0,
      ingredients: [{ name: "salt", quantity: 0, unit: "teaspoon" }],
    });
    assert.equal(parsed.success, false);
  });

  it("silently strips an unexpected steps field (forward-compat with old drafts)", () => {
    // Pre-WS7-5c drafts MAY have stored a steps array. Stripping silently
    // keeps GET /wizard/drafts/:id working for legacy rows without forcing
    // a migration. The activate/save path will regenerate steps via
    // finalize_steps regardless of any stale steps the draft carried.
    const parsed = WizardExpandDishDetailsSchema.safeParse({
      title: "Legacy dish",
      role: "main",
      positionIndex: 0,
      ingredients: [{ name: "salt", quantity: 1, unit: "teaspoon" }],
      steps: ["this should be stripped"],
    });
    assert.equal(parsed.success, true);
    if (!parsed.success) return;
    // zod object defaults to "strip" unknown fields.
    assert.equal(
      (parsed.data as { steps?: unknown }).steps,
      undefined,
      "unknown steps field should be stripped",
    );
  });
});

describe("WizardExpandedPlanDetailsSchema — accepts stepless plan", () => {
  it("accepts a multi-meal multi-dish details-stage plan with macros and NO steps", () => {
    const parsed = WizardExpandedPlanDetailsSchema.safeParse(detailsPlan());
    assert.equal(
      parsed.success,
      true,
      parsed.success ? "" : JSON.stringify(parsed.error.flatten()),
    );
  });

  it("rejects a plan with malformed dish macros (non-numeric)", () => {
    const bad = detailsPlan();
    // Force the macros payload off-schema.
    (bad.meals[0].dishes[0].macros as unknown as Record<string, unknown>)
      .caloriesPerServing = "lots" as unknown as number;
    const parsed = WizardExpandedPlanDetailsSchema.safeParse(bad);
    assert.equal(parsed.success, false);
  });
});

describe("WizardFinalizeStepsResultSchema — finalize AI output shape", () => {
  it("accepts a valid dishSteps array", () => {
    const parsed = WizardFinalizeStepsResultSchema.safeParse(fullStepsResult());
    assert.equal(parsed.success, true);
  });

  it("rejects an empty dishSteps array (.min(1))", () => {
    const parsed = WizardFinalizeStepsResultSchema.safeParse({ dishSteps: [] });
    assert.equal(parsed.success, false);
  });

  it("rejects a dish with 0 steps", () => {
    const parsed = WizardFinalizeStepsResultSchema.safeParse({
      dishSteps: [{ mealIndex: 0, dishIndex: 0, steps: [] }],
    });
    assert.equal(parsed.success, false);
  });
});

// ── 2. mergeFinalizeStepsIntoDetails — positional invariants ──────────────

describe("mergeFinalizeStepsIntoDetails — positional merge invariants", () => {
  it("merges per-dish steps positionally into every dish", () => {
    const merged = mergeFinalizeStepsIntoDetails(
      detailsPlan(),
      fullStepsResult(),
    );
    assert.equal(merged.status, "ok");
    if (merged.status !== "ok") return;
    // Every dish has steps; counts mirror the input.
    assert.equal(merged.payload.meals[0].dishes[0].steps.length, 3);
    assert.equal(merged.payload.meals[0].dishes[1].steps.length, 1);
    assert.equal(merged.payload.meals[1].dishes[0].steps.length, 3);
    // Ingredients + macros pass through unchanged.
    assert.equal(
      merged.payload.meals[0].dishes[0].ingredients.length,
      3,
    );
    assert.equal(
      merged.payload.meals[1].dishes[0].macros?.caloriesPerServing,
      220,
    );
  });

  it("errors when a (mealIndex, dishIndex) entry is missing", () => {
    const partial = fullStepsResult();
    // Drop the entry for (0, 1).
    partial.dishSteps = partial.dishSteps.filter(
      (e) => !(e.mealIndex === 0 && e.dishIndex === 1),
    );
    const merged = mergeFinalizeStepsIntoDetails(detailsPlan(), partial);
    assert.equal(merged.status, "error");
    if (merged.status !== "error") return;
    assert.ok(
      merged.reason.startsWith("missing_dish_steps:0:1"),
      `unexpected reason: ${merged.reason}`,
    );
  });

  it("errors when an extra (mealIndex, dishIndex) entry references a nonexistent dish", () => {
    const extra = fullStepsResult();
    extra.dishSteps.push({
      mealIndex: 5,
      dishIndex: 0,
      steps: ["this dish doesn't exist"],
    });
    const merged = mergeFinalizeStepsIntoDetails(detailsPlan(), extra);
    assert.equal(merged.status, "error");
    if (merged.status !== "error") return;
    assert.ok(
      merged.reason.startsWith("extra_dish_steps:5:0"),
      `unexpected reason: ${merged.reason}`,
    );
  });

  it("errors when (mealIndex, dishIndex) is duplicated", () => {
    const dup = fullStepsResult();
    dup.dishSteps.push({
      mealIndex: 0,
      dishIndex: 0,
      steps: ["duplicate entry"],
    });
    const merged = mergeFinalizeStepsIntoDetails(detailsPlan(), dup);
    assert.equal(merged.status, "error");
    if (merged.status !== "error") return;
    assert.ok(
      merged.reason.startsWith("duplicate_dish_steps:0:0"),
      `unexpected reason: ${merged.reason}`,
    );
  });
});

// ── 3. §27 round-trip: stepless + finalize → with-steps → schema ─────────

describe("§27 round-trip — details-stage + finalize merge satisfies WizardExpandedPlanSchema", () => {
  it("the merged payload parses against the materializer-side schema (real merged shape, not a mock)", () => {
    const details = detailsPlan();
    const finalize = fullStepsResult();
    const merged = mergeFinalizeStepsIntoDetails(details, finalize);
    assert.equal(
      merged.status,
      "ok",
      merged.status === "error" ? merged.reason : "",
    );
    if (merged.status !== "ok") return;

    // This is the contract from the §27 callout — the finalize output shape
    // (write-side) must satisfy the materializer's read-side schema. The
    // merged payload IS the value passed to materializeWizardDraft({ payload });
    // pinning it here is the durable invariant test.
    const parsed = WizardExpandedPlanSchema.safeParse(merged.payload);
    assert.equal(
      parsed.success,
      true,
      parsed.success ? "" : JSON.stringify(parsed.error.flatten()),
    );

    // Sanity: schema-stripped output has the same per-dish step counts.
    if (!parsed.success) return;
    let stepCount = 0;
    for (const m of parsed.data.meals) {
      for (const d of m.dishes) {
        stepCount += d.steps.length;
      }
    }
    // 3 + 1 + 3 = 7 steps across all 3 dishes.
    assert.equal(stepCount, 7);
  });
});

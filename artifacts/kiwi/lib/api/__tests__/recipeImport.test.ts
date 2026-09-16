// WS9 BUG-273 — the URL / image / text import adapter (canonicalToDraftMeal)
// shares the fix with parsedMealToDraft: each canonical dish keeps ITS steps
// (with phaseType) instead of flattening everything onto the meal level, which
// the builder then hydrated onto dish[0].

import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalToDraftMeal, type CanonicalRecipeContentWire } from "../recipeImport";

function step(
  stepIndex: number,
  text: string,
  minutes: number,
  phaseType: string,
  extra: Partial<CanonicalRecipeContentWire["dishes"][number]["steps"]> = {},
) {
  return {
    stepIndex,
    stepTextRaw: text,
    stepTextTranslated: text,
    estimatedMinutes: minutes,
    phaseType,
    requiresPreheat: false,
    requiresRest: false,
    requiresMarination: false,
    isTimingSensitive: false,
    ...extra,
  };
}

function makeCanonical(): CanonicalRecipeContentWire {
  return {
    meal: {
      title: "Roast chicken with potatoes",
      cuisineType: "French",
      mealType: "dinner",
      estimatedTimeMinutes: 90,
      difficulty: "fancy",
      servingsDefault: 4,
    },
    dishes: [
      {
        title: "Roast chicken",
        role: "main",
        positionIndex: 0,
        ingredients: [{ name: "whole chicken", quantity: 1, unit: "unit" }],
        steps: [
          step(0, "Preheat oven to 425F.", 15, "preheat"),
          step(1, "Roast 60 minutes.", 60, "cook"),
          step(2, "Rest 10 minutes.", 10, "rest"),
        ],
      },
      {
        title: "Crispy potatoes",
        role: "side",
        positionIndex: 1,
        ingredients: [{ name: "potato", quantity: 2, unit: "lb" }],
        steps: [
          step(0, "Parboil the potatoes.", 10, "cook"),
          // A phase the server enum doesn't know: dropped, not passed through.
          step(1, "Roast alongside the chicken.", 40, "bake-ish"),
        ],
      },
    ],
  };
}

test("BUG-273: canonical dishes keep their own steps; phaseType narrowed to the enum", () => {
  const draft = canonicalToDraftMeal(makeCanonical(), "https://example.com/r");
  assert.equal(draft.dishes.length, 2);
  assert.deepEqual(draft.dishes.map((d) => d.steps?.length), [3, 2]);
  assert.deepEqual(
    draft.dishes[0].steps?.map((s) => s.phaseType),
    ["preheat", "cook", "rest"],
  );
  assert.equal(draft.dishes[1].steps?.[0].phaseType, "cook");
  assert.ok(!("phaseType" in draft.dishes[1].steps![1]), "unknown phase is dropped");
  assert.equal(draft.dishes[1].steps?.[1].text, "Roast alongside the chicken.");
  // Legacy flat view still present and renumbered across dishes.
  assert.deepEqual(draft.steps.map((s) => s.stepNumber), [1, 2, 3, 4, 5]);
  assert.equal(draft.difficulty, "hard");
  assert.equal(draft.sourceUrl, "https://example.com/r");
});

test("BUG-273: a dish with no steps on the wire gets an empty per-dish list", () => {
  const canonical = makeCanonical();
  delete canonical.dishes[1].steps;
  const draft = canonicalToDraftMeal(canonical, null);
  assert.deepEqual(draft.dishes[1].steps, []);
  assert.equal(draft.steps.length, 3);
  assert.equal(draft.sourceUrl, undefined);
});

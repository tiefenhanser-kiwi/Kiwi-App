// WS7-6 G1 — ParsedMeal → DraftMeal adapter (Mode A round-trip into the
// Meal Builder's draftJson hydration).

import assert from "node:assert/strict";
import { test } from "node:test";

import { parsedMealToDraft } from "../parsedMealToDraft";
import type { ParsedMeal } from "../../api/builder";

function makeParsedMeal(overrides: Partial<ParsedMeal> = {}): ParsedMeal {
  return {
    title: "Chicken Piccata Dinner",
    cuisine: "Italian",
    estimatedPrepMinutes: 15,
    estimatedCookMinutes: 25,
    servingsDefault: 4,
    difficulty: "medium",
    tags: ["weeknight"],
    subDishes: [
      {
        title: "Chicken Piccata",
        role: "main",
        positionIndex: 0,
        ingredients: [
          { name: "chicken breast", quantity: 2, unit: "pieces" },
          { name: "capers", quantity: 2, unit: "tbsp", isOptional: true },
        ],
        steps: [
          {
            content: "Pound and season the chicken.",
            estimatedMinutes: 5,
            phaseType: "prep",
          },
          {
            content: "Sear, then build the pan sauce.",
            estimatedMinutes: 12,
            phaseType: "cook",
            isTimingSensitive: true,
          },
        ],
      },
      {
        title: "Arugula Salad",
        role: "side",
        positionIndex: 1,
        ingredients: [{ name: "arugula", quantity: 4, unit: "cups" }],
        steps: [
          {
            content: "Whisk vinaigrette and toss.",
            estimatedMinutes: 4,
            phaseType: "assemble",
          },
        ],
      },
    ],
    ...overrides,
  };
}

test("maps scalar fields; estimatedTimeMinutes = prep + cook; macros zeroed", () => {
  const draft = parsedMealToDraft(makeParsedMeal());
  assert.equal(draft.title, "Chicken Piccata Dinner");
  assert.equal(draft.cuisineType, "Italian");
  assert.equal(draft.difficulty, "medium");
  assert.equal(draft.estimatedTimeMinutes, 40); // 15 + 25
  assert.equal(draft.servingsDefault, 4);
  assert.deepEqual(draft.tags, ["weeknight"]);
  assert.equal(draft.caloriesPerServing, 0);
  assert.equal(draft.proteinGPerServing, 0);
  assert.equal(draft.carbsGPerServing, 0);
  assert.equal(draft.fatGPerServing, 0);
});

test("sub-dishes → dishes; ingredients carry name/quantity/unit", () => {
  const draft = parsedMealToDraft(makeParsedMeal());
  assert.equal(draft.dishes.length, 2);
  assert.equal(draft.dishes[0].name, "Chicken Piccata");
  assert.deepEqual(draft.dishes[0].ingredients[0], {
    name: "chicken breast",
    quantity: 2,
    unit: "pieces",
  });
  assert.equal(draft.dishes[1].name, "Arugula Salad");
});

test("steps flatten across sub-dishes and renumber 1..N", () => {
  const draft = parsedMealToDraft(makeParsedMeal());
  assert.equal(draft.steps.length, 3);
  assert.deepEqual(
    draft.steps.map((st) => st.stepNumber),
    [1, 2, 3],
  );
  assert.equal(draft.steps[0].text, "Pound and season the chicken.");
  assert.equal(draft.steps[1].isTimingSensitive, true);
  assert.equal(draft.steps[2].text, "Whisk vinaigrette and toss.");
});

test("null cuisine collapses to an absent cuisineType (DraftMeal optional)", () => {
  const draft = parsedMealToDraft(makeParsedMeal({ cuisine: null }));
  assert.equal(draft.cuisineType, undefined);
  assert.ok(!("cuisineType" in draft) || draft.cuisineType === undefined);
});

test("a meal with no steps yields an empty steps array (not undefined)", () => {
  const draft = parsedMealToDraft(
    makeParsedMeal({
      subDishes: [
        {
          title: "Cheese Plate",
          role: "main",
          positionIndex: 0,
          ingredients: [{ name: "brie", quantity: 1, unit: "wheel" }],
          steps: [],
        },
      ],
    }),
  );
  assert.deepEqual(draft.steps, []);
  assert.equal(draft.dishes.length, 1);
});

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

// ── WS9 BUG-273 — steps stay with their sub-dish; phaseType survives ────────
//
// Hans's device case: "Grilled chicken breast with rice pilaf and steamed
// green beans" → mode_a_parse rule 1 splits on "with / and" → three sub-dishes,
// each with its own steps. The pre-fix adapter flattened all of them into the
// meal-level list (dropping phaseType) and the builder hydrated that list onto
// dish[0], so the meal saved as ONE dish carrying every step — serial time,
// one-dish Cook Mode.

function makeThreeDishParse(): ParsedMeal {
  return {
    title: "Grilled chicken with rice pilaf and green beans",
    cuisine: "American",
    estimatedPrepMinutes: 15,
    estimatedCookMinutes: 30,
    servingsDefault: 4,
    difficulty: "easy",
    tags: ["weeknight"],
    subDishes: [
      {
        title: "Grilled Chicken Breast",
        role: "main",
        positionIndex: 0,
        ingredients: [{ name: "chicken breast", quantity: 4, unit: "pieces" }],
        steps: [
          { content: "Preheat the grill to high.", estimatedMinutes: 10, phaseType: "preheat" },
          { content: "Grill 6 minutes per side.", estimatedMinutes: 12, phaseType: "cook", isTimingSensitive: true },
          { content: "Rest 5 minutes.", estimatedMinutes: 5, phaseType: "rest" },
        ],
      },
      {
        title: "Rice Pilaf",
        role: "side",
        positionIndex: 1,
        ingredients: [{ name: "long-grain rice", quantity: 1.5, unit: "cups" }],
        steps: [
          { content: "Toast the rice in butter.", estimatedMinutes: 3, phaseType: "cook" },
          { content: "Add stock, cover, simmer.", estimatedMinutes: 18, phaseType: "cook", parallelGroup: null },
        ],
      },
      {
        title: "Steamed Green Beans",
        role: "side",
        positionIndex: 2,
        ingredients: [{ name: "green beans", quantity: 1, unit: "lb" }],
        steps: [
          { content: "Trim the beans.", estimatedMinutes: 4, phaseType: "prep" },
          { content: "Steam until crisp-tender.", estimatedMinutes: 6, phaseType: "cook", isTimingSensitive: true },
        ],
      },
    ],
  };
}

test("BUG-273: each sub-dish keeps ITS steps (nothing collapses onto dish[0])", () => {
  const draft = parsedMealToDraft(makeThreeDishParse());
  assert.equal(draft.dishes.length, 3);
  assert.deepEqual(
    draft.dishes.map((d) => d.steps?.length),
    [3, 2, 2],
    "3 / 2 / 2 steps stay on their own dish",
  );
  assert.equal(draft.dishes[0].steps?.[0].text, "Preheat the grill to high.");
  assert.equal(draft.dishes[1].steps?.[1].text, "Add stock, cover, simmer.");
  assert.equal(draft.dishes[2].steps?.[0].text, "Trim the beans.");
  // Per-dish numbering restarts at 1 for each dish (one list per dish in the
  // builder).
  assert.deepEqual(draft.dishes[2].steps?.map((s) => s.stepNumber), [1, 2]);
});

test("BUG-273: phaseType (and parallelGroup when sent) survive the adapter", () => {
  const draft = parsedMealToDraft(makeThreeDishParse());
  assert.deepEqual(
    draft.dishes[0].steps?.map((s) => s.phaseType),
    ["preheat", "cook", "rest"],
  );
  assert.deepEqual(draft.dishes[2].steps?.map((s) => s.phaseType), ["prep", "cook"]);
  assert.equal(draft.dishes[0].steps?.[1].isTimingSensitive, true);
  assert.equal(draft.dishes[0].steps?.[1].estimatedMinutes, 12);
  // parallelGroup: carried as-sent (null here), absent when the parse omits it.
  assert.equal(draft.dishes[1].steps?.[1].parallelGroup, null);
  assert.ok(!("parallelGroup" in draft.dishes[1].steps![0]));
});

test("BUG-273: the legacy meal-level steps[] is still the flattened, renumbered view", () => {
  const draft = parsedMealToDraft(makeThreeDishParse());
  assert.equal(draft.steps.length, 7);
  assert.deepEqual(draft.steps.map((s) => s.stepNumber), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(draft.steps[3].text, "Toast the rice in butter.");
  assert.equal(draft.steps[3].phaseType, "cook");
});

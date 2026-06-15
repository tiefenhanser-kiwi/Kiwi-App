// WS7-6 Fix-Block 1 (Fix B) — pure-function tests for the Meal Builder
// state helpers (hydration + save serialization).
//
// Regression pinned: device-test cluster surfaced that editing a meal,
// SWAPPING a sub-dish, then saving wiped the new dish's correct steps and
// re-attached the OLD dish's steps to dish[0]. The pre-fix code:
//   - Hydration FLATTENED every dish's steps into a single meal-level
//     state ⇒ per-dish provenance lost on first render.
//   - Save serialization RE-ATTACHED the whole flat array to dish[0]
//     (kind:"new") ⇒ wrong-dish steps wrote back to the server.
//
// The fix (see lib/meal-builder-state.ts) makes BuilderDish own its own
// steps[]. These tests pin:
//   1. Multi-dish hydration preserves per-dish steps (no flatten).
//   2. Sub-dish SWAP: replacing dish[1] leaves dish[0]'s steps untouched
//      and emits the new dish[1]'s steps as that dish's own.
//   3. Single-dish round-trip (the most common case) still works.
//   4. Legacy fallback: a single-dish meal with steps only on the meal-
//      level array (no per-dish steps) still hydrates onto dish[0].

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildManualSaveMealInput,
  buildRecipeOverride,
  hydrateBuilderDishesFromDraft,
  hydrateBuilderDishesFromMeal,
  newDish,
  newIngredient,
  newStep,
  pickSavedDishToBuilderDish,
  validateManualSave,
  type BuilderDish,
} from "../meal-builder-state";
import type { MealDetail } from "../api/meals";
import type { DraftMeal, SavedDish } from "../types";

// ── Tiny uid allocator + helpers ───────────────────────────────────────

function makeAlloc(): () => number {
  let i = 1;
  return () => i++;
}

// Build a server-side MealStep fixture row (mirrors lib/api/meals.ts).
function mealStep(stepIndex: number, text: string, timing = false) {
  return {
    stepIndex,
    text,
    estimatedMinutes: 5,
    phaseType: "cook",
    parallelGroup: null,
    requiresPreheat: false,
    requiresRest: false,
    requiresMarination: false,
    isTimingSensitive: timing,
  };
}

function mealIng(name: string, qty: number, unit: string) {
  return {
    name,
    quantity: qty,
    unit,
    preparationNote: null,
    category: "Pantry",
    isOptional: false,
  };
}

// A 2-dish MealDetail with DISTINCT per-dish steps — the scenario that
// surfaced the bug (dish[1] swap left dish[0]'s flattened-in steps stale).
function makeMultiDishMeal(): MealDetail {
  return {
    id: "meal-test",
    title: "Test multi-dish meal",
    cuisine: "American",
    minutes: 35,
    servings: 4,
    calories: 600,
    protein: 30,
    carbs: 40,
    fat: 20,
    tags: [],
    image: null,
    description: null,
    difficulty: "medium",
    mealType: "dinner",
    sourceType: "manual",
    isPublic: false,
    userId: "u1",
    notes: null,
    dishes: [
      {
        dishId: "dish-A",
        title: "Roast chicken",
        roleLabel: "main",
        positionIndex: 0,
        minutes: 30,
        difficulty: "medium",
        servings: 4,
        ingredients: [mealIng("Chicken", 1, "whole")],
        steps: [
          mealStep(0, "Pat chicken dry"),
          mealStep(1, "Roast at 425F"),
        ],
      },
      {
        dishId: "dish-B",
        title: "Bistro salad",
        roleLabel: "side",
        positionIndex: 1,
        minutes: 5,
        difficulty: "easy",
        servings: 4,
        ingredients: [mealIng("Arugula", 4, "cup")],
        steps: [
          mealStep(0, "Whisk vinaigrette"),
          mealStep(1, "Toss greens"),
          mealStep(2, "Plate"),
        ],
      },
    ],
    steps: [],
  };
}

// A single-dish MealDetail. The server populates BOTH dishes[0].steps AND
// the top-level meal-owned steps[] (composeMealDetail mirror).
function makeSingleDishMeal(): MealDetail {
  return {
    id: "meal-solo",
    title: "Salmon teriyaki",
    cuisine: "Japanese",
    minutes: 25,
    servings: 4,
    calories: 540,
    protein: 38,
    carbs: 32,
    fat: 24,
    tags: [],
    image: null,
    description: null,
    difficulty: "easy",
    mealType: "dinner",
    sourceType: "curated",
    isPublic: true,
    userId: null,
    notes: null,
    dishes: [
      {
        dishId: "dish-only",
        title: "Salmon",
        roleLabel: "main",
        positionIndex: 0,
        minutes: 25,
        difficulty: "easy",
        servings: 4,
        ingredients: [mealIng("Salmon", 1.5, "lb")],
        steps: [mealStep(0, "Sear salmon", true)],
      },
    ],
    steps: [mealStep(0, "Sear salmon", true)],
  };
}

// ── Hydration ──────────────────────────────────────────────────────────

test("hydrate(multi-dish): each dish keeps ONLY its own steps (no flatten)", () => {
  const alloc = makeAlloc();
  const dishes = hydrateBuilderDishesFromMeal(makeMultiDishMeal(), alloc);
  assert.equal(dishes.length, 2);
  // dish[0] (Roast chicken): 2 steps, exactly its own.
  assert.equal(dishes[0].name, "Roast chicken");
  assert.equal(dishes[0].steps.length, 2);
  assert.equal(dishes[0].steps[0].text, "Pat chicken dry");
  assert.equal(dishes[0].steps[1].text, "Roast at 425F");
  // dish[1] (Bistro salad): 3 steps, exactly its own — would have been
  // flattened onto dish[0] under the pre-fix code.
  assert.equal(dishes[1].name, "Bistro salad");
  assert.equal(dishes[1].steps.length, 3);
  assert.equal(dishes[1].steps[0].text, "Whisk vinaigrette");
  assert.equal(dishes[1].steps[2].text, "Plate");
});

test("hydrate(single-dish): steps land on dish[0] (server populates both surfaces)", () => {
  const alloc = makeAlloc();
  const dishes = hydrateBuilderDishesFromMeal(makeSingleDishMeal(), alloc);
  assert.equal(dishes.length, 1);
  assert.equal(dishes[0].steps.length, 1);
  assert.equal(dishes[0].steps[0].text, "Sear salmon");
  assert.equal(dishes[0].steps[0].isTimingSensitive, true);
});

test("hydrate(legacy single-dish with only meal-owned steps): falls back to dish[0]", () => {
  // Older / wizard-activated meals may have empty dishes[].steps but
  // non-empty top-level steps. The hydrator drops those onto dish[0] so
  // the steps still round-trip through the builder.
  const meal = makeSingleDishMeal();
  meal.dishes[0].steps = [];
  // meal-level steps stay populated.
  const alloc = makeAlloc();
  const dishes = hydrateBuilderDishesFromMeal(meal, alloc);
  assert.equal(dishes[0].steps.length, 1);
  assert.equal(dishes[0].steps[0].text, "Sear salmon");
});

test("hydrate(draft, multi-dish): all draft.steps land on dish[0]", () => {
  // Drafts carry a single meal-level steps[] (importer doesn't know per-
  // dish ownership), so multi-dish drafts collapse onto dish[0].
  const draft: DraftMeal = {
    title: "Imported recipe",
    difficulty: "easy",
    estimatedTimeMinutes: 30,
    servingsDefault: 4,
    tags: [],
    caloriesPerServing: 0,
    proteinGPerServing: 0,
    carbsGPerServing: 0,
    fatGPerServing: 0,
    dishes: [
      {
        name: "Main",
        ingredients: [{ name: "X", quantity: 1, unit: "cup" }],
      },
      {
        name: "Side",
        ingredients: [{ name: "Y", quantity: 1, unit: "cup" }],
      },
    ],
    steps: [
      { stepNumber: 1, text: "Step one" },
      { stepNumber: 2, text: "Step two" },
    ],
  };
  const alloc = makeAlloc();
  const dishes = hydrateBuilderDishesFromDraft(draft, alloc);
  assert.equal(dishes.length, 2);
  assert.equal(dishes[0].steps.length, 2);
  assert.equal(dishes[0].steps[0].text, "Step one");
  assert.equal(dishes[1].steps.length, 0);
});

// ── Sub-dish SWAP (the load-bearing regression) ────────────────────────

test("SUB-DISH SWAP: dish[0]'s steps are NEVER polluted by the swapped-out dish", () => {
  // Reproduces the device-test scenario: hydrate a 2-dish meal where
  // each dish has DISTINCT steps, simulate the user swapping dish[1]
  // (the salad) for a new "Garlic green beans", and assert the save
  // payload:
  //   - dish[0] (Roast chicken) carries ONLY its 2 original steps.
  //   - dish[1] (new Garlic green beans) carries ONLY its own steps.
  // Pre-fix behaviour: dish[0] would carry ALL 5 original steps
  // (chicken + salad), dish[1] would carry [] — the symptom Hans saw.
  const alloc = makeAlloc();
  const hydrated = hydrateBuilderDishesFromMeal(makeMultiDishMeal(), alloc);

  // Simulate the swap: drop dish[1] (Bistro salad), add a fresh dish
  // (Garlic green beans) with new steps. Same shape as
  // setDishes(prev => [...prev.filter(d => d.uid !== bistroSaladUid),
  //                     newDish({ name: 'Garlic green beans', ... })]).
  const newDishB = newDish(alloc, {
    name: "Garlic green beans",
    ingredients: [
      newIngredient(alloc, { quantity: "1", unit: "lb", name: "Green beans" }),
    ],
    steps: [
      newStep(alloc, { text: "Trim beans" }),
      newStep(alloc, { text: "Sauté with garlic" }),
    ],
  });
  const swapped: BuilderDish[] = [hydrated[0], newDishB];

  const input = buildManualSaveMealInput({
    mealName: "Roast chicken with green beans",
    cuisineType: "American",
    difficulty: "medium",
    estimatedTimeMinutes: "35",
    servingsDefault: 4,
    notes: "",
    dishes: swapped,
    sourceType: "manual",
  });

  assert.equal(input.dishes.length, 2);

  // dish[0] (Roast chicken) MUST keep its own 2 steps — no Bistro salad
  // leakage, no Garlic green beans leakage.
  const d0 = input.dishes[0];
  assert.equal(d0.kind, "new");
  if (d0.kind !== "new") return;
  assert.equal(d0.title, "Roast chicken");
  assert.equal(d0.steps.length, 2);
  assert.equal(d0.steps[0].text, "Pat chicken dry");
  assert.equal(d0.steps[1].text, "Roast at 425F");

  // dish[1] (Garlic green beans) carries ONLY its own steps. Pre-fix
  // shape would have set steps: [] on dish[1] (collapse-onto-dish[0]).
  const d1 = input.dishes[1];
  assert.equal(d1.kind, "new");
  if (d1.kind !== "new") return;
  assert.equal(d1.title, "Garlic green beans");
  assert.equal(d1.steps.length, 2);
  assert.equal(d1.steps[0].text, "Trim beans");
  assert.equal(d1.steps[1].text, "Sauté with garlic");
});

// ── Single-dish round-trip (don't regress the common case) ─────────────

test("single-dish round-trip: hydrate → edit one step → save preserves all steps on dish[0]", () => {
  const alloc = makeAlloc();
  const hydrated = hydrateBuilderDishesFromMeal(makeSingleDishMeal(), alloc);
  assert.equal(hydrated.length, 1);

  // User adds a second step to the single dish.
  const edited: BuilderDish[] = [
    {
      ...hydrated[0],
      steps: [
        ...hydrated[0].steps,
        newStep(alloc, { text: "Glaze with teriyaki", estimatedMinutes: "2" }),
      ],
    },
  ];

  const input = buildManualSaveMealInput({
    mealName: "Salmon teriyaki",
    cuisineType: "Japanese",
    difficulty: "easy",
    estimatedTimeMinutes: "25",
    servingsDefault: 4,
    notes: "",
    dishes: edited,
    sourceType: "manual",
  });

  assert.equal(input.dishes.length, 1);
  const d0 = input.dishes[0];
  assert.equal(d0.kind, "new");
  if (d0.kind !== "new") return;
  assert.equal(d0.steps.length, 2);
  assert.equal(d0.steps[0].text, "Sear salmon");
  assert.equal(d0.steps[0].isTimingSensitive, true);
  assert.equal(d0.steps[1].text, "Glaze with teriyaki");
  assert.equal(d0.steps[1].estimatedMinutes, 2);
});

test("single-dish round-trip: empty-text steps are filtered out", () => {
  // The builder pre-allocates a blank row when the user clicks "+ Add
  // step"; if the user never fills it in, it MUST NOT make it to the
  // server (the existing pre-fix .filter(st => st.text.trim().length > 0)
  // contract).
  const alloc = makeAlloc();
  const dishes: BuilderDish[] = [
    newDish(alloc, {
      name: "Toast",
      ingredients: [
        newIngredient(alloc, { quantity: "2", unit: "slice", name: "Bread" }),
      ],
      steps: [
        newStep(alloc, { text: "Toast bread" }),
        newStep(alloc, { text: "" }), // blank — should drop
        newStep(alloc, { text: "   " }), // whitespace-only — should drop
      ],
    }),
  ];
  const input = buildManualSaveMealInput({
    mealName: "Toast",
    cuisineType: "",
    difficulty: "easy",
    estimatedTimeMinutes: "5",
    servingsDefault: 1,
    notes: "",
    dishes,
    sourceType: "manual",
  });
  const d0 = input.dishes[0];
  assert.equal(d0.kind, "new");
  if (d0.kind !== "new") return;
  assert.equal(d0.steps.length, 1);
  assert.equal(d0.steps[0].text, "Toast bread");
});

// ── Saved-dish pick hydration (WS7-6 Fix-Block 2, B-2) ─────────────────
//
// The Block-1 sub-dish-SWAP test (above) hand-built the new BuilderDish
// with steps populated in the fixture — it never exercised the actual
// pick handler. So the device symptom (picking a saved dish from the
// chooser during meal-edit dropped the dish's steps + on save dropped
// the dish entirely) slipped past. These tests run the same mapper the
// handler runs, and assert the pick path carries the full dish through.

function makeSavedDish(overrides: Partial<SavedDish> = {}): SavedDish {
  return {
    id: "saved-dish-pick",
    name: "Garlic Green Beans",
    type: "side",
    ingredients: [
      { quantity: 1, unit: "lb", name: "green beans, trimmed" },
      { quantity: 2, unit: "tbsp", name: "olive oil" },
      { quantity: 3, unit: "clove", name: "garlic, minced" },
    ],
    caloriesPerServing: 95,
    proteinGPerServing: 3,
    carbsGPerServing: 12,
    fatGPerServing: 5,
    mealUseCount: 0,
    steps: [
      { stepNumber: 1, text: "Trim the green beans" },
      { stepNumber: 2, text: "Heat oil in skillet", estimatedMinutes: 2 },
      {
        stepNumber: 3,
        text: "Sauté with garlic until tender-crisp",
        estimatedMinutes: 7,
        isTimingSensitive: true,
      },
    ],
    ...overrides,
  };
}

test("pickSavedDishToBuilderDish: carries the picked dish's name + ingredients + steps onto the new BuilderDish", () => {
  const alloc = makeAlloc();
  const picked = makeSavedDish();

  const result = pickSavedDishToBuilderDish(picked, alloc);

  assert.equal(result.name, "Garlic Green Beans");

  assert.equal(result.ingredients.length, 3);
  assert.equal(result.ingredients[0].name, "green beans, trimmed");
  assert.equal(result.ingredients[0].quantity, "1");
  assert.equal(result.ingredients[0].unit, "lb");
  assert.equal(result.ingredients[2].name, "garlic, minced");
  assert.equal(result.ingredients[2].quantity, "3");
  assert.equal(result.ingredients[2].unit, "clove");

  // Steps — the bit the pre-fix mapper dropped. Each step's text +
  // metadata must round-trip through the helper.
  assert.equal(result.steps.length, 3);
  assert.equal(result.steps[0].text, "Trim the green beans");
  assert.equal(result.steps[0].estimatedMinutes, "");
  assert.equal(result.steps[1].text, "Heat oil in skillet");
  assert.equal(result.steps[1].estimatedMinutes, "2");
  assert.equal(result.steps[2].text, "Sauté with garlic until tender-crisp");
  assert.equal(result.steps[2].estimatedMinutes, "7");
  assert.equal(result.steps[2].isTimingSensitive, true);
});

test("pickSavedDishToBuilderDish: saved dish with no steps lands with empty steps[] (no synthetic blank row)", () => {
  const alloc = makeAlloc();
  const picked = makeSavedDish({ steps: undefined });

  const result = pickSavedDishToBuilderDish(picked, alloc);

  assert.equal(result.name, "Garlic Green Beans");
  assert.equal(result.ingredients.length, 3);
  assert.deepEqual(result.steps, []);
});

test("PICK-INTO-EDIT: picking a saved dish into a 1-dish meal during edit adds a 2nd dish that survives save with its OWN steps + ingredients", () => {
  // Reproduces the device scenario the swap-test missed: hydrate an
  // existing meal, simulate the user opening the DishChooserSheet and
  // picking a saved dish with its own steps + ingredients. Assert the
  // serialized save payload carries BOTH dishes' steps onto their own
  // dish (no flatten, no drop).
  const alloc = makeAlloc();
  const hydrated = hydrateBuilderDishesFromMeal(makeSingleDishMeal(), alloc);
  assert.equal(hydrated.length, 1);

  const picked = pickSavedDishToBuilderDish(makeSavedDish(), alloc);
  const withPick: BuilderDish[] = [...hydrated, picked];

  const input = buildManualSaveMealInput({
    mealName: "Salmon with green beans",
    cuisineType: "American",
    difficulty: "medium",
    estimatedTimeMinutes: "30",
    servingsDefault: 4,
    notes: "",
    dishes: withPick,
    sourceType: "manual",
  });

  // Both dishes survive the serializer's "has at least one ingredient"
  // filter — pre-fix the picked dish kept its ingredients (they were
  // mapped) but its title-only steps shape didn't break the filter, so
  // the regression Hans saw was specifically the steps loss. Pin both.
  assert.equal(input.dishes.length, 2);

  const d0 = input.dishes[0];
  assert.equal(d0.kind, "new");
  if (d0.kind !== "new") return;
  assert.equal(d0.title, "Salmon");
  assert.equal(d0.steps.length, 1);
  assert.equal(d0.steps[0].text, "Sear salmon");

  // The picked dish must arrive with its OWN title, ingredients, AND
  // steps populated on save. Pre-fix shape: title kept, ingredients
  // kept, steps: [] (empty).
  const d1 = input.dishes[1];
  assert.equal(d1.kind, "new");
  if (d1.kind !== "new") return;
  assert.equal(d1.title, "Garlic Green Beans");
  assert.equal(d1.ingredients.length, 3);
  assert.equal(d1.ingredients[0].name, "green beans, trimmed");
  assert.equal(d1.steps.length, 3);
  assert.equal(d1.steps[0].text, "Trim the green beans");
  assert.equal(d1.steps[2].text, "Sauté with garlic until tender-crisp");
  assert.equal(d1.steps[2].isTimingSensitive, true);
});

// ── Validation gates ────────────────────────────────────────────────────

test("buildManualSaveMealInput: no meal name throws a friendly error", () => {
  const alloc = makeAlloc();
  assert.throws(
    () =>
      buildManualSaveMealInput({
        mealName: "   ",
        cuisineType: "",
        difficulty: "easy",
        estimatedTimeMinutes: "30",
        servingsDefault: 4,
        notes: "",
        dishes: [newDish(alloc)],
        sourceType: "manual",
      }),
    /meal name/i,
  );
});

test("buildManualSaveMealInput: no surviving dish throws the no-ingredients error", () => {
  // All dishes have blank ingredient names → filtered to zero kind:"new"
  // dishes → the gate trips.
  const alloc = makeAlloc();
  const dishes: BuilderDish[] = [
    newDish(alloc, {
      name: "Empty",
      ingredients: [newIngredient(alloc, { name: "", quantity: "", unit: "" })],
      steps: [],
    }),
  ];
  assert.throws(
    () =>
      buildManualSaveMealInput({
        mealName: "Has a name",
        cuisineType: "",
        difficulty: "easy",
        estimatedTimeMinutes: "30",
        servingsDefault: 4,
        notes: "",
        dishes,
        sourceType: "manual",
      }),
    /at least one dish/i,
  );
});

// ── WS7-6 Block 1F — save-disabled clarity predicate ─────────────────────
//
// validateManualSave is the pure-function predicate behind manual-mode's
// Save button. PRD §10.5.6: a meal needs name + ≥1 named ingredient +
// ≥1 cooking step. Pre-F the screen-level predicate accepted ingredient
// rows with only a quantity (looser than the save serializer's NAME-
// filter at meal-builder-state.ts ~L239-244), and steps weren't required
// at all. These tests pin both tightenings.

test("validateManualSave: pristine empty form is invalid on all three fields", () => {
  const alloc = makeAlloc();
  const v = validateManualSave({
    mealName: "",
    dishes: [newDish(alloc)],
  });
  assert.equal(v.nameMissing, true);
  assert.equal(v.ingredientMissing, true);
  assert.equal(v.stepMissing, true);
});

test("validateManualSave: whitespace-only meal name counts as missing", () => {
  const alloc = makeAlloc();
  const v = validateManualSave({
    mealName: "   ",
    dishes: [
      newDish(alloc, {
        name: "Solo",
        ingredients: [
          newIngredient(alloc, { quantity: "1", unit: "cup", name: "Rice" }),
        ],
        steps: [newStep(alloc, { text: "Cook rice" })],
      }),
    ],
  });
  assert.equal(v.nameMissing, true);
  assert.equal(v.ingredientMissing, false);
  assert.equal(v.stepMissing, false);
});

test("validateManualSave: an ingredient with only a quantity does NOT satisfy ingredientMissing (F tightening)", () => {
  // Pre-F the screen predicate accepted name-OR-quantity. F tightens
  // to NAME so the predicate matches what serializeNewDishesForSave
  // actually keeps (name-trim filter).
  const alloc = makeAlloc();
  const v = validateManualSave({
    mealName: "Toast",
    dishes: [
      newDish(alloc, {
        ingredients: [
          newIngredient(alloc, { quantity: "2", unit: "slice", name: "" }),
        ],
        steps: [newStep(alloc, { text: "Toast bread" })],
      }),
    ],
  });
  assert.equal(v.ingredientMissing, true);
});

test("validateManualSave: a single named ingredient anywhere satisfies the ingredient gate", () => {
  const alloc = makeAlloc();
  const v = validateManualSave({
    mealName: "Toast",
    dishes: [
      newDish(alloc, {
        ingredients: [
          // Two blank rows + one named — the named one carries the gate.
          newIngredient(alloc, { name: "", quantity: "", unit: "" }),
          newIngredient(alloc, { name: "", quantity: "2", unit: "slice" }),
          newIngredient(alloc, { name: "Bread", quantity: "", unit: "" }),
        ],
        steps: [newStep(alloc, { text: "Toast bread" })],
      }),
    ],
  });
  assert.equal(v.ingredientMissing, false);
});

test("validateManualSave: stepMissing — single-dish meal with no step text is missing", () => {
  // ≥1 step required (F-tightening). A pre-allocated blank step row
  // doesn't count — same predicate as the save serializer's text-trim
  // filter at meal-builder-state.ts ~L249-250.
  const alloc = makeAlloc();
  const v = validateManualSave({
    mealName: "Solo meal",
    dishes: [
      newDish(alloc, {
        ingredients: [
          newIngredient(alloc, { quantity: "1", unit: "cup", name: "Rice" }),
        ],
        // Both step rows are whitespace-only → stepMissing.
        steps: [newStep(alloc, { text: "" }), newStep(alloc, { text: "   " })],
      }),
    ],
  });
  assert.equal(v.stepMissing, true);
});

test("validateManualSave: stepMissing — multi-dish meal with no step text is missing", () => {
  // Composite shape: two dishes, neither carries a non-empty step text.
  // The uniform walk covers both shapes (no simple/composite branching).
  const alloc = makeAlloc();
  const v = validateManualSave({
    mealName: "Composite meal",
    dishes: [
      newDish(alloc, {
        name: "Main",
        ingredients: [
          newIngredient(alloc, {
            quantity: "1",
            unit: "lb",
            name: "Chicken",
          }),
        ],
        steps: [],
      }),
      newDish(alloc, {
        name: "Side",
        ingredients: [
          newIngredient(alloc, {
            quantity: "1",
            unit: "cup",
            name: "Rice",
          }),
        ],
        steps: [newStep(alloc, { text: "" })],
      }),
    ],
  });
  assert.equal(v.stepMissing, true);
});

test("validateManualSave: stepMissing — multi-dish meal with a step on the SECOND dish only is satisfied", () => {
  // ≥1 step ANYWHERE satisfies the gate — the walk doesn't care which
  // dish owns the step.
  const alloc = makeAlloc();
  const v = validateManualSave({
    mealName: "Composite meal",
    dishes: [
      newDish(alloc, {
        name: "Main",
        ingredients: [
          newIngredient(alloc, {
            quantity: "1",
            unit: "lb",
            name: "Chicken",
          }),
        ],
        steps: [],
      }),
      newDish(alloc, {
        name: "Side",
        ingredients: [
          newIngredient(alloc, {
            quantity: "1",
            unit: "cup",
            name: "Rice",
          }),
        ],
        steps: [newStep(alloc, { text: "Boil rice for 18 minutes" })],
      }),
    ],
  });
  assert.equal(v.stepMissing, false);
  assert.equal(v.nameMissing, false);
  assert.equal(v.ingredientMissing, false);
});

test("validateManualSave: all three gates satisfied → all flags false", () => {
  const alloc = makeAlloc();
  const v = validateManualSave({
    mealName: "Salmon teriyaki",
    dishes: [
      newDish(alloc, {
        ingredients: [
          newIngredient(alloc, { quantity: "1.5", unit: "lb", name: "Salmon" }),
        ],
        steps: [newStep(alloc, { text: "Sear salmon" })],
      }),
    ],
  });
  assert.equal(v.nameMissing, false);
  assert.equal(v.ingredientMissing, false);
  assert.equal(v.stepMissing, false);
});

// ── WS7-6 Block 1H — DishChooserSheet "Create from scratch" factory ─────
//
// H replaces the prior route-away "Have something in mind?" option with
// an in-sheet "Create from scratch" that calls onAddEmptyDish in the
// meal-builder, which appends newDish() to dishes[]. The screen-level
// integration (sheet → callback → state update) isn't covered here (no
// React test harness for the sheet in this workspace), but the factory
// output that the append depends on IS — newDish() with no partial must
// produce an editable blank dish with exactly the shape H expects: one
// blank ingredient row (so the user lands somewhere they can type
// immediately) and zero steps.

test("newDish() with no partial: editable blank dish — empty name, ONE blank ingredient row, zero steps", () => {
  const alloc = makeAlloc();
  const empty = newDish(alloc);
  assert.equal(empty.name, "");
  assert.equal(empty.ingredients.length, 1);
  assert.equal(empty.ingredients[0].name, "");
  assert.equal(empty.ingredients[0].quantity, "");
  assert.equal(empty.ingredients[0].unit, "");
  assert.equal(empty.steps.length, 0);
});

test("Block 1H append shape: setDishes(prev => [...prev, newDish()]) yields a 2-dish array with the original dish unchanged and the new dish empty", () => {
  // Simulates the onAddEmptyDish wiring at meal-builder.tsx
  // (onAddEmptyDish={() => setDishes((prev) => [...prev, newDish()])}).
  // Pinning the array-shape here so future refactors of the wiring
  // can't silently drop an existing dish.
  const alloc = makeAlloc();
  const seed: BuilderDish[] = [
    newDish(alloc, {
      name: "Existing main",
      ingredients: [
        newIngredient(alloc, { quantity: "1", unit: "lb", name: "Chicken" }),
      ],
      steps: [newStep(alloc, { text: "Roast chicken" })],
    }),
  ];
  const next: BuilderDish[] = [...seed, newDish(alloc)];

  assert.equal(next.length, 2);
  // Original dish untouched.
  assert.equal(next[0].name, "Existing main");
  assert.equal(next[0].ingredients.length, 1);
  assert.equal(next[0].ingredients[0].name, "Chicken");
  assert.equal(next[0].steps.length, 1);
  assert.equal(next[0].steps[0].text, "Roast chicken");
  // New dish is the blank-slot shape H promises.
  assert.equal(next[1].name, "");
  assert.equal(next[1].ingredients.length, 1);
  assert.equal(next[1].ingredients[0].name, "");
  assert.equal(next[1].steps.length, 0);
});

// ── WS7-7-A B5 follow-on (D-WS7-141) — override seed + apply-always ──────
//
// The editor's seed read now threads planItemId (meal-builder.tsx Fix 1a), so
// when opened from a plan it hydrates the per-instance OVERRIDE-applied detail
// (GET /meals/:id?planItemId= → composeMealDetail applies recipeOverrideJson)
// instead of the canonical meal. These tests pin the consequences with the
// pure builders the screen shares:
//   (a) hydration seeds the reduced (override) ingredient set — a "just this
//       time" removal stays absent on re-open.
//   (b) apply-always writes BOTH the override and the template from the SAME
//       on-screen dishes (single `input` source).
//   (c) re-saving an unedited override-seeded form reproduces the same override
//       — the removed ingredient is NOT clobbered back in (the destructive
//       round-trip the pre-fix canonical seed caused).

// A MealDetail as returned by GET /meals/:id?planItemId= AFTER the server
// applied a "just this time" override that REMOVED "Parmesan" from the only
// dish (canonical had Pasta + Parmesan). composeMealDetail preserves canonical
// steps via the {...dish} spread, so the detail still carries steps even though
// the override JSON omits them (D-WS7-142).
function makeOverrideAppliedMeal(): MealDetail {
  return {
    id: "meal-ov",
    title: "Weeknight Pasta",
    cuisine: "Italian",
    minutes: 20,
    servings: 4,
    calories: 500,
    protein: 20,
    carbs: 70,
    fat: 15,
    tags: [],
    image: null,
    description: null,
    difficulty: "easy",
    mealType: "dinner",
    sourceType: "manual",
    isPublic: false,
    userId: "u1",
    notes: null,
    dishes: [
      {
        dishId: "dish-pasta",
        title: "Pasta",
        roleLabel: "main",
        positionIndex: 0,
        minutes: 20,
        difficulty: "easy",
        servings: 4,
        // Override removed "Parmesan" — only "Pasta" remains.
        ingredients: [mealIng("Pasta", 1, "lb")],
        steps: [mealStep(0, "Boil pasta"), mealStep(1, "Toss with sauce")],
      },
    ],
    steps: [],
  };
}

function pastaSourceState(dishes: BuilderDish[]) {
  return {
    mealName: "Weeknight Pasta",
    cuisineType: "Italian",
    difficulty: "easy" as const,
    estimatedTimeMinutes: "20",
    servingsDefault: 4,
    notes: "",
    dishes,
    sourceType: "manual" as const,
  };
}

test("(D-WS7-141 Fix 1a) editor seeds the OVERRIDE ingredient set — removed ingredient stays absent + steps round-trip", () => {
  const alloc = makeAlloc();
  const dishes = hydrateBuilderDishesFromMeal(makeOverrideAppliedMeal(), alloc);
  assert.equal(dishes.length, 1);
  const names = dishes[0].ingredients.map((i) => i.name);
  assert.deepEqual(names, ["Pasta"]);
  assert.ok(
    !names.includes("Parmesan"),
    "the override-removed ingredient must not reappear in the seed",
  );
  // Canonical steps survive the override read → present in the seeded form
  // (confirms the Phase-1 steps round-trip: no steps loss from threading
  // planItemId).
  assert.deepEqual(
    dishes[0].steps.map((s) => s.text),
    ["Boil pasta", "Toss with sauce"],
  );
});

test("(D-WS7-141 Fix 1b) apply-always: override + template writes derive from the SAME form state", () => {
  const alloc = makeAlloc();
  const dishes = hydrateBuilderDishesFromMeal(makeOverrideAppliedMeal(), alloc);
  const input = buildManualSaveMealInput(pastaSourceState(dishes));
  const override = buildRecipeOverride(input);

  // The template PATCH sends `input.dishes` verbatim (buildUpdateMealInput:
  // `dishes: input.dishes`), and the instance override is built from the SAME
  // `input` — so both writes carry the identical edited ingredient set.
  assert.equal(override.titleOverride, input.title);
  assert.equal(override.dishes.length, input.dishes.length);
  override.dishes.forEach((od, i) => {
    const formDish = input.dishes[i];
    assert.equal(formDish.kind, "new");
    if (formDish.kind !== "new") return;
    assert.deepEqual(
      od.ingredients.map((g) => ({
        name: g.name,
        quantity: g.quantity,
        unit: g.unit,
      })),
      formDish.ingredients.map((g) => ({
        name: g.name,
        quantity: g.quantity,
        unit: g.unit,
      })),
    );
  });
  // Both writes reflect the removal.
  assert.deepEqual(
    override.dishes[0].ingredients.map((g) => g.name),
    ["Pasta"],
  );
});

test("(D-WS7-141 Fix 1c) just-this-time idempotency: re-saving an unedited override-seeded form reproduces the same override — no clobber", () => {
  const alloc = makeAlloc();
  // Seed from the override-applied detail (Parmesan already removed), make NO
  // edits, then serialize + rebuild the override exactly as runSaveJustThisTime
  // does (buildManualSaveMealInput → buildRecipeOverride → changeRecipeForPlanItem).
  // The removed ingredient must NOT reappear — the pre-fix canonical seed would
  // have re-introduced it and silently clobbered the prior override.
  const dishes = hydrateBuilderDishesFromMeal(makeOverrideAppliedMeal(), alloc);
  const input = buildManualSaveMealInput(pastaSourceState(dishes));
  const override = buildRecipeOverride(input);

  assert.equal(override.dishes.length, 1);
  const names = override.dishes[0].ingredients.map((g) => g.name);
  assert.deepEqual(names, ["Pasta"]);
  assert.ok(
    !names.includes("Parmesan"),
    "an unedited re-save must not clobber the prior removal back in",
  );
  // Quantity/unit round-trip cleanly too (String→parseQuantity→number).
  assert.deepEqual(override.dishes[0].ingredients[0], {
    name: "Pasta",
    quantity: 1,
    unit: "lb",
  });
});

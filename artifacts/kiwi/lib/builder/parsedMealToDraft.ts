// WS7-6 G1 — Mode A "Ask Kiwi" adapter: ParsedMeal (POST /builder/parse-meal)
// → DraftMeal (the legacy review/edit shape the Meal Builder hydrates from
// `draftJson`).
//
// This MIRRORS canonicalToDraftMeal in lib/api/recipeImport.ts so Mode A lands
// the same way Import-from-Text does (PRD §10.4b is the shipped sibling): same
// flat DraftMeal envelope. Macros are 0 (parse-meal returns no nutrition; the
// import adapter zeroes them too).
//
// WS9 BUG-273 — steps stay WITH THEIR SUB-DISH. The pre-fix adapter flattened
// every sub-dish's steps into the one meal-level `steps[]` and dropped
// `phaseType`; hydrateBuilderDishesFromDraft then put the whole list on
// dish[0], so a three-dish parse ("chicken with rice pilaf and green beans")
// saved as one dish carrying every step: the scheduler only overlaps work
// ACROSS dishes, so the derived time was the serial sum, and Cook Mode ran it
// as one dish. Now each ReviewMealDish carries its own `steps` (phaseType +
// parallelGroup kept); the meal-level `steps[]` is still emitted, flattened
// and renumbered 1..N, for readers of the legacy envelope.
//
// Round-trip note (§27): parse-meal already maps the server `fancy → hard`
// difficulty at the lib/api/builder boundary, so ParsedMeal.difficulty is the
// UI enum DraftMeal expects — no second mapping here.

import type { ParsedMeal } from "@/lib/api/builder";
import type { DraftMeal, ReviewMealDish, ReviewMealStep } from "@/lib/types";

export function parsedMealToDraft(meal: ParsedMeal): DraftMeal {
  // Per-dish steps, numbered 1..N WITHIN the dish (the builder renders one
  // list per dish); the meal-level list below renumbers across dishes.
  const dishes: ReviewMealDish[] = meal.subDishes.map((sd) => ({
    name: sd.title,
    ingredients: sd.ingredients.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      unit: i.unit,
    })),
    steps: sd.steps.map(
      (st, idx): ReviewMealStep => ({
        stepNumber: idx + 1,
        text: st.content,
        estimatedMinutes: st.estimatedMinutes,
        isTimingSensitive: st.isTimingSensitive,
        phaseType: st.phaseType,
        ...(st.parallelGroup !== undefined
          ? { parallelGroup: st.parallelGroup }
          : {}),
      }),
    ),
  }));

  // Legacy meal-level view: the same steps flattened and renumbered 1..N.
  let stepCounter = 1;
  const steps: ReviewMealStep[] = [];
  for (const d of dishes) {
    for (const st of d.steps ?? []) {
      steps.push({ ...st, stepNumber: stepCounter++ });
    }
  }

  return {
    title: meal.title,
    // WS9 BUG-288 — the headnote rides the draft like the import path's does
    // (canonicalToDraftMeal); the save builder carries it when the user typed
    // no notes over it. Omitted (not "") when the parse had none.
    ...(meal.description && meal.description.trim() ? { description: meal.description.trim() } : {}),
    // DraftMeal.cuisineType is `string?`; collapse parse-meal's nullable.
    ...(meal.cuisine ? { cuisineType: meal.cuisine } : {}),
    difficulty: meal.difficulty,
    estimatedTimeMinutes: meal.estimatedPrepMinutes + meal.estimatedCookMinutes,
    servingsDefault: meal.servingsDefault,
    tags: meal.tags,
    caloriesPerServing: 0,
    proteinGPerServing: 0,
    carbsGPerServing: 0,
    fatGPerServing: 0,
    dishes,
    steps,
  };
}

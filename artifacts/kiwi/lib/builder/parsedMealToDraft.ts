// WS7-6 G1 — Mode A "Ask Kiwi" adapter: ParsedMeal (POST /builder/parse-meal)
// → DraftMeal (the legacy review/edit shape the Meal Builder hydrates from
// `draftJson`).
//
// This MIRRORS canonicalToDraftMeal in lib/api/recipeImport.ts so Mode A lands
// the same way Import-from-Text does (PRD §10.4b is the shipped sibling): same
// flat DraftMeal envelope, per-dish steps flattened into one meal-level steps[]
// (the builder's hydrateBuilderDishesFromDraft re-attaches the flattened list
// to dish[0] — the §10.5.4 "meal IS the dish" collapse). Macros are 0 (parse-
// meal returns no nutrition; the import adapter zeroes them too).
//
// Round-trip note (§27): parse-meal already maps the server `fancy → hard`
// difficulty at the lib/api/builder boundary, so ParsedMeal.difficulty is the
// UI enum DraftMeal expects — no second mapping here.

import type { ParsedMeal } from "@/lib/api/builder";
import type { DraftMeal, ReviewMealDish, ReviewMealStep } from "@/lib/types";

export function parsedMealToDraft(meal: ParsedMeal): DraftMeal {
  const dishes: ReviewMealDish[] = meal.subDishes.map((sd) => ({
    name: sd.title,
    ingredients: sd.ingredients.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      unit: i.unit,
    })),
  }));

  // Flatten per-sub-dish steps into a single meal-level list, renumbering
  // stepNumber 1..N (identical to the import adapter's flatten pass).
  let stepCounter = 1;
  const steps: ReviewMealStep[] = [];
  for (const sd of meal.subDishes) {
    for (const st of sd.steps) {
      steps.push({
        stepNumber: stepCounter++,
        text: st.content,
        estimatedMinutes: st.estimatedMinutes,
        isTimingSensitive: st.isTimingSensitive,
      });
    }
  }

  return {
    title: meal.title,
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

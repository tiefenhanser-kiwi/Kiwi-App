// WS7-3 C4 c2 — adapter that maps the GET /me/meals row shape (MealListItem)
// back to the legacy MealSummary that the picker sheets (AddMealsSheet,
// SwapMealSheet) and the screen's MealSummary-consuming helpers
// (applyMealReplacement, addExistingMealToPlan) consume.
//
// Field renames (server -> MealSummary):
//   cuisine        -> cuisineType (undefined when "")
//   minutes        -> estimatedTimeMinutes
//   servings       -> servingsDefault
//   calories/...   -> caloriesPerServing/... (1:1 numeric)
//   image          -> imageUrl (undefined when null)
//
// MealListItem lacks `difficulty`; MealSummary requires it. Ruling 8 locks
// "easy" as the default — cosmetic-only drift on the row meta-line ("Easy ·
// N min · serves M"), logged as PRD-alignment finding for the WS7-CLOSE
// redline batch. Fix lands once at server-shape widening, not piecemeal.
//
// timesCooked / lastCookedAt / createdAt stay undefined — these are
// MealSummary-only fields with no source field in MealListItem today
// (D-WS7-048 covers the cook-stat sort gap).

import type { MealFilterKey, MealListItem } from "@/lib/api/meals";
import type { MealSummary } from "@/lib/types";

type MealSource = MealSummary["source"];

const FILTER_TO_SOURCE: Record<MealFilterKey, MealSource> = {
  my_meals: "saved",
  featured: "featured",
  top_rated: "top_rated",
  hosting: "hosting",
};

export function mealListItemToSummary(
  m: MealListItem,
  source: MealFilterKey,
): MealSummary {
  return {
    id: m.id,
    title: m.title,
    cuisineType: m.cuisine.length > 0 ? m.cuisine : undefined,
    difficulty: "easy",
    estimatedTimeMinutes: m.minutes,
    servingsDefault: m.servings,
    imageUrl: m.image ?? undefined,
    caloriesPerServing: m.calories,
    proteinGPerServing: m.protein,
    carbsGPerServing: m.carbs,
    fatGPerServing: m.fat,
    source: FILTER_TO_SOURCE[source],
  };
}

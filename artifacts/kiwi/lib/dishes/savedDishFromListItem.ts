// WS7-6 C-fix Block 4 — shared wire→SavedDish adapter.
//
// Lifted from the Mode-C inline `savedDishes` useMemo in app/meal-builder.tsx
// so the Meal-Builder dish picker AND the Meal→Add-Dish sheet share ONE field
// map instead of two inline copies that can drift. The GET /me/dishes list
// shape (DishListItem) is renamed-flat; SavedDish is the builder/sheet domain
// shape. Field map (verified against both schemas):
//
//   id                ← id
//   name              ← title
//   imageUrl          ← image (null → undefined: SavedDish.imageUrl is
//                       string | undefined, never null)
//   ingredients       = []      (the list shape omits per-dish ingredients;
//                       CombineReview degrades to names-only — a detail fetch
//                       can hydrate later if review parity is required)
//   type              = "main"  (the wire carries no dish type — D-WS7-050;
//                       "main" preserves the pre-extraction inline default)
//   caloriesPerServing← calories
//   proteinGPerServing← protein
//   carbsGPerServing  ← carbs
//   fatGPerServing    ← fat
//   mealUseCount      ← mealUseCount (live-meals-only count, server-filtered)
//   estimatedTimeMinutes ← minutes
//
// createdAt / lastCookedAt are intentionally omitted: sort is server-side, so
// no surface needs the client-side sort fields anymore.

import type { DishListItem } from "@/lib/api/dishes";
import type { SavedDish } from "@/lib/types";

export function savedDishFromListItem(d: DishListItem): SavedDish {
  return {
    id: d.id,
    name: d.title,
    cuisineType: undefined,
    imageUrl: d.image ?? undefined,
    ingredients: [],
    type: "main",
    caloriesPerServing: d.calories,
    proteinGPerServing: d.protein,
    carbsGPerServing: d.carbs,
    fatGPerServing: d.fat,
    mealUseCount: d.mealUseCount,
    estimatedTimeMinutes: d.minutes,
  };
}

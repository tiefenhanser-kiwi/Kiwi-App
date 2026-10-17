// PREP-2 item 2 — one dish of a meal, read in plan context.
//
// The Thanksgiving make-ahead rows open a DISH, but the dish has to read at the
// FEAST's servings: GET /dishes/:id is the dish alone, at its own default, with no
// plan item and no per-plan recipe edit. So the dish screen reads it out of GET
// /meals/:id?planItemId — the same composed meal meal detail reads — and scales it
// the way meal detail does: effectiveServings ÷ the meal's authored anchor
// (app/meal/[id].tsx `servingsMultiplier`, WS7-8 BUG-003). One rule, two screens.

import type { MealDetail } from "@/lib/api/meals";
import { resolveAmountMultiplier } from "@/lib/cooking/cookSession";

type MealDish = MealDetail["dishes"][number];

export interface PlanDishView {
  dish: MealDish;
  /** "serves N" — the plan's servings for the meal (servingsOverride ?? default). */
  servings: number;
  /** Every amount × this, ingredient lines and step amounts alike. */
  multiplier: number;
}

/** Null when the meal does not hold the dish (a swapped-out dish, a stale link). */
export function planDishView(meal: MealDetail, dishId: string): PlanDishView | null {
  const dish = meal.dishes.find((d) => d.dishId === dishId);
  if (!dish) return null;
  return {
    dish,
    servings: meal.effectiveServings,
    multiplier: resolveAmountMultiplier(meal.effectiveServings, meal.authoredServingsDefault),
  };
}

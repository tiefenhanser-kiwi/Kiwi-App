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
import { chosenBird, chosenBirdName, isFeastMeal, type BirdLine } from "@/lib/format/quantity";

type MealDish = MealDetail["dishes"][number];

export interface PlanDishView {
  dish: MealDish;
  /** "serves N" — the plan's servings for the meal (servingsOverride ?? default). */
  servings: number;
  /** Every amount × this, ingredient lines and step amounts alike. */
  multiplier: number;
  /** WEB-4c — the meal is a feast: its dishes follow a bird written by count. */
  feast: boolean;
  /** THX-4 — the dish holds the meal's turkey and the cook chose its weight: every
   *  line follows `factor` (chosen ÷ the recipe's) and `birds` (one bird), not the
   *  servings. Absent otherwise. */
  chosenBird?: {
    factor: number;
    birds: BirdLine;
    /** CLIENT-5 C (D-WS9-339) — a turkey by count: its row (index into dish.ingredients)
     *  and the name it shows at the chosen weight, "whole turkey (16 lb)", as meal detail
     *  shows it (CLIENT-4 B chosenBirdName). DISPLAY ONLY: `factor` is read from the
     *  recipe's own name. Absent for a turkey by weight (its amount says the weight). */
    birdName?: { index: number; name: string };
  };
}

/** Null when the meal does not hold the dish (a swapped-out dish, a stale link). */
export function planDishView(meal: MealDetail, dishId: string): PlanDishView | null {
  const dish = meal.dishes.find((d) => d.dishId === dishId);
  if (!dish) return null;
  const bird = chosenBird(meal.dishes, meal.birdWeightLb, isFeastMeal(meal.tags));
  const named = chosenBirdName(meal.dishes, meal.birdWeightLb);
  const birdName = named && named.dishId === dishId ? { birdName: { index: named.index, name: named.name } } : {};
  return {
    dish,
    servings: meal.effectiveServings,
    multiplier: resolveAmountMultiplier(meal.effectiveServings, meal.authoredServingsDefault),
    feast: isFeastMeal(meal.tags),
    ...(bird && bird.dishId === dishId ? { chosenBird: { factor: bird.factor, birds: bird.birds, ...birdName } } : {}),
  };
}

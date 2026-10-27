// CLIENT-3 A (BUG-528) — "Add dish" → a saved dish, in the Meal Builder.
//
// The sheet's rows are GET /me/dishes list items: a title, an image and
// macros, no ingredients and no steps (savedDishFromListItem). The pick used to
// append that row as it was, an empty dish that the save serializer drops (no
// ingredient survives), so on a plan meal the add did nothing at all. A row
// without ingredients is read in full first (GET /dishes/:id) and only then
// appended; a read that fails says so and appends nothing. A dish that arrives
// with its ingredients (the sheet's own "Simple Dish") is appended as before.
//
// app/meal-builder.tsx is outside the test glob, so the sequence lives here
// with its effects injected.

import type { DishDetail } from "@/lib/api/dishes";
import {
  dishDetailToBuilderDish,
  pickSavedDishToBuilderDish,
  type BuilderDish,
  type UidAllocator,
} from "@/lib/meal-builder-state";
import type { SavedDish } from "@/lib/types";

export const PICK_DISH_ERROR_TITLE = "Couldn't add that dish";
export const PICK_DISH_ERROR_BODY = "We couldn't load it. Check your connection and try again.";

export interface PickSavedDishDeps {
  fetchDish: (id: string) => Promise<DishDetail>;
  allocUid: UidAllocator;
  /** What the meal's dishes are written for; see dishDetailToBuilderDish. */
  targetServings?: number;
  onAdd: (dish: BuilderDish) => void;
  onError: (title: string, message: string) => void;
}

/** Resolves true when the dish was appended. Never throws. */
export async function pickSavedDish(dish: SavedDish, deps: PickSavedDishDeps): Promise<boolean> {
  if (dish.ingredients.length > 0) {
    deps.onAdd(pickSavedDishToBuilderDish(dish, deps.allocUid));
    return true;
  }
  let detail: DishDetail;
  try {
    detail = await deps.fetchDish(dish.id);
  } catch {
    deps.onError(PICK_DISH_ERROR_TITLE, PICK_DISH_ERROR_BODY);
    return false;
  }
  deps.onAdd(dishDetailToBuilderDish(detail, deps.allocUid, deps.targetServings));
  return true;
}

// WS7-6 G3 Scope E / surface #3 — post-save navigation for the Dish Builder
// CREATE path. The dish twin of lib/builder/postSaveNav.
//
// LANDING CONTRACT: after an Ask-Kiwi / create save with no plan context, land
// on the item just created — here, the new dish's Dish Detail page. Dishes are
// never saved into a plan directly, so there is NO plan-back branch.
//
// Why this matters (the bug it fixes): the dish-side Ask-Kiwi flow stacks an
// input screen (ask-kiwi-dish) between the caller and the Dish Builder, so the
// pre-G3 `router.back()` returned the user to that INPUT screen rather than the
// saved dish. Replacing-to-Dish-Detail lands on the created item regardless.
//
// An EDIT save keeps its contextual `back` (the user returns to wherever they
// opened the editor) — G3 only normalizes the create/Ask-Kiwi landing.

export type DishPostSaveNav =
  | { kind: "dish-detail"; dishId: string }
  | { kind: "back" };

export function resolveDishPostSaveNav(args: {
  newDishId: string;
  isEdit: boolean;
}): DishPostSaveNav {
  return args.isEdit
    ? { kind: "back" }
    : { kind: "dish-detail", dishId: args.newDishId };
}

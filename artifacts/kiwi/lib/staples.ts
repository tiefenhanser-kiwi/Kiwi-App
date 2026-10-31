// CLIENT-9 D (BUG-472) — "I always have this": the pure half of marking a grocery
// row a staple, and the copy. The routes are lib/api/staples.ts; the row's action
// is app/grocery-list/[id].tsx, the list is app/staples.tsx (Profile → Staples).
//
// Pure and in lib/ because app/** is outside the test glob (D-WS9-164).

import type { GroceryListItem } from "./types";

/** The row action's label, and the confirm button's. */
export const MARK_STAPLE_LABEL = "I always have this";

/** Profile → Staples, and the confirm on a grocery row. Hans's copy, verbatim. */
export const STAPLES_COPY =
  "Staples are things you always have, like garlic powder or olive oil. Kiwi keeps them off your list.";

export const STAPLES_EMPTY = "No staples yet. On a grocery list, press and hold an item and choose “I always have this”.";

/**
 * A row can be marked when it is not a staple already and it is a catalog
 * ingredient: the server keys a staple by the row's ingredient and refuses a row
 * with none (422 — an item the cook typed in). An older wire with no
 * ingredientId offers nothing.
 */
export function canMarkStaple(item: Pick<GroceryListItem, "isUniversalStaple" | "ingredientId">): boolean {
  return !item.isUniversalStaple && typeof item.ingredientId === "string" && item.ingredientId.length > 0;
}

/**
 * The list as the server leaves it after POST /me/staples: every row of that
 * ingredient is a staple, not opted in for this trip, so it dims and leaves the
 * Instacart cart (lib/instacartOrder.ts orders a staple only when opted in). The
 * row the cook pressed always moves, whatever its ingredientId.
 */
export function withStapleMarked(items: readonly GroceryListItem[], marked: GroceryListItem): GroceryListItem[] {
  const ing = marked.ingredientId;
  return items.map((it) =>
    it.id === marked.id || (typeof ing === "string" && it.ingredientId === ing)
      ? { ...it, isUniversalStaple: true, stapleOptedIn: false }
      : it,
  );
}

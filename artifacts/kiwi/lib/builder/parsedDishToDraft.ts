// WS7-6 G2 — Dish Mode A "Ask Kiwi" adapter: ParsedDish (POST
// /builder/parse-dish) → DraftDish (the shape app/dish-builder.tsx hydrates
// its form from when handed a `draftJson` param).
//
// The dish twin of parsedMealToDraft.ts. A dish is the atomic recipe unit, so
// there is no sub-dish flatten pass — the parsed dish's ingredients + steps map
// straight across. `type` defaults to "main" (free-text Mode A can't reliably
// infer side-vs-main; the user re-picks it in the builder). difficulty + tags
// are intentionally dropped: the Dish Builder form doesn't capture them today
// (its save path omits both), so carrying them here would be dead data — the
// hydrated form stays consistent with a manually-built one.

import type { ParsedDish } from "@/lib/api/builder";

export interface DraftDish {
  name: string;
  /** Title-case cuisine (e.g. "Mediterranean") or undefined when cuisine-
   *  agnostic. The builder's chip row highlights it if it's a known cuisine. */
  cuisineType?: string;
  type: "side" | "main";
  estimatedTimeMinutes: number;
  servingsDefault: number;
  ingredients: { name: string; quantity: number; unit: string }[];
  steps: {
    text: string;
    estimatedMinutes?: number;
    isTimingSensitive?: boolean;
  }[];
}

export function parsedDishToDraft(dish: ParsedDish): DraftDish {
  return {
    name: dish.title,
    ...(dish.cuisine ? { cuisineType: dish.cuisine } : {}),
    type: "main",
    estimatedTimeMinutes:
      dish.estimatedPrepMinutes + dish.estimatedCookMinutes,
    servingsDefault: dish.servingsDefault,
    ingredients: dish.ingredients.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      unit: i.unit,
    })),
    steps: dish.steps.map((st) => ({
      text: st.content,
      estimatedMinutes: st.estimatedMinutes,
      isTimingSensitive: st.isTimingSensitive,
    })),
  };
}

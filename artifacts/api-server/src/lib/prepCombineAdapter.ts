// WS7-8a Block 2 — loader → engine adapter.
//
// Maps the enriched prep-week loader output (PrepLoadedPlan) into the pure
// engine's input (PrepCombineInput). Two responsibilities the engine cannot do
// itself (both require data the engine input deliberately omits):
//
//  1. SERVINGS-SCALING — the loader ships RAW dish-ingredient quantities. We
//     scale per-dish, mirroring groceryList.ts exactly: the base is
//     dish.servingsDefault and the override is the plan-item's servingsOverride
//     (carried at meal level), so multiplier = (override ?? base) / base. No
//     override → multiplier 1. The engine then sums effective quantities.
//
//  2. "6 oz" COMPOUND-UNIT SPLIT — the one real seed unit that doesn't
//     canonicalize. `salmon fillets` is stored as quantity=2, unit="6 oz"
//     (2 fillets of 6 oz = 12 oz). We split the leading number out of the unit
//     and fold it into the quantity (2 × 6 = 12 oz) so it joins the weight
//     family instead of bucketing alone as an unknown unit.
//
// category comes straight off the Ingredient row (the loader now carries it);
// inferCategory is a defensive pocket fallback only, for the theoretical
// empty-category row.

import { inferCategory } from "./ingredientResolve";
import type { PrepCombineInput } from "./prepCombineEngine";
import type { PrepLoadedPlan } from "./prepWeekAggregation";

// Leading "<number> <unit>" compound, e.g. "6 oz", "1.5 lb". The number is a
// per-unit pack size folded into the quantity; the remainder is the real unit.
const COMPOUND_UNIT_RE = /^\s*(\d+(?:\.\d+)?)\s+(\S.*?)\s*$/;

export function splitCompoundUnit(
  quantity: number,
  unit: string,
): { quantity: number; unit: string } {
  const m = unit.match(COMPOUND_UNIT_RE);
  if (!m) return { quantity, unit };
  const factor = Number.parseFloat(m[1]);
  if (!Number.isFinite(factor) || factor <= 0) return { quantity, unit };
  return { quantity: quantity * factor, unit: m[2] };
}

export function buildPrepCombineInput(loaded: PrepLoadedPlan): PrepCombineInput {
  return {
    meals: loaded.meals.map((meal) => ({
      mealId: meal.mealId,
      mealName: meal.mealName,
      dishes: meal.dishes.map((dish) => {
        // WS7-8 BUG-003 — DENOMINATOR is the immutable authored anchor
        // (authoredBaseServings ?? baseServings); the NUMERATOR keeps its
        // no-override fallback of the live baseServings (= servingsDefault).
        // Anchor == baseServings until a future canonical promote, so today the
        // multiplier is unchanged.
        const authoredBase = dish.authoredBaseServings ?? dish.baseServings;
        const base = authoredBase > 0 ? authoredBase : 1;
        const effective = meal.servingsOverride ?? dish.baseServings;
        const multiplier = effective / base;
        return {
          dishId: dish.dishId,
          dishName: dish.dishName,
          dishRole: dish.dishRole,
          ingredients: dish.ingredients.map((ing) => {
            const split = splitCompoundUnit(ing.quantity, ing.unit);
            const category =
              ing.category && ing.category.trim() !== ""
                ? ing.category
                : inferCategory(ing.ingredientName);
            return {
              ingredientId: ing.ingredientId,
              ingredientName: ing.ingredientName,
              category,
              quantity: split.quantity * multiplier,
              unit: split.unit,
              preparationNote: ing.preparationNote,
            };
          }),
        };
      }),
    })),
  };
}

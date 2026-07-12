// WS6 6b-3 — Override-resolution stub for plan macro recalc.
//
// D-WS6-003 lives at this seam: a MealPlanItem may carry per-instance
// `ingredientOverrides` (Json?) and/or `recipeOverrideJson` (Json?) that
// modify the canonical Dish recipe for THIS plan-instance only. Real
// override semantics — replacing ingredients, adjusting quantities,
// honoring full RecipeOverride.dishes — are wired in WS7 alongside real
// plan persistence.
//
// For MVP: pass-through. Returns `dish.dishIngredients` mapped to the
// shape the macro estimator expects. Override fields on the item are
// captured by `hasOverrides()` so the caller (planMacros) can decide
// whether to bypass the macro cache (overrides always recompute), but
// the resolved ingredient list itself is unchanged.
//
// When WS7 wires real overrides here, the helper signature stays stable;
// only the body changes. planMacros.ts and the recalc endpoint do not
// need to know whether resolution is real or stubbed.

import type { DishIngredient, Ingredient, MealPlanItem } from "@prisma/client";

import type { Per100gMacros } from "./usda/fdcClient";
import { isMatchedRef } from "./usda/ingredientEnrichment";

export interface EffectiveIngredient {
  name: string;
  quantity: number;
  unit: string;
  isOptional: boolean;
  // WS7-8b USDA Block 1 — per-100g USDA reference macros, present ONLY when
  // the ingredient row carries a MATCHED usda record (miss-markers and nulls
  // omit this). Threads through to estimateDishMacros as grounding. Absent =
  // ungrounded, exactly as before.
  nutritionRefPer100g?: Per100gMacros;
  // WS7-8b B2 — Ingredient identity for the quantity→grams table lookup +
  // stamped AI-fallback write-back inside estimateDishMacros.
  ingredientId?: string | null;
  canonicalName?: string;
  conversionRef?: unknown;
}

export type DishWithIngredients = {
  dishIngredients: Array<DishIngredient & { ingredient: Ingredient }>;
};

/**
 * Returns true when the item carries any per-instance override that should
 * cause the macro cache to be bypassed for this dish (overrides always
 * recompute via the AI helper). MVP-safe: even though the resolver itself
 * is a pass-through, surfacing an override here documents the contract
 * planMacros relies on, so when WS7 turns the resolver into a real merger
 * the cache-bypass path is already correct.
 */
export function hasOverrides(item: Pick<MealPlanItem, "ingredientOverrides" | "recipeOverrideJson">): boolean {
  return item.ingredientOverrides !== null || item.recipeOverrideJson !== null;
}

/**
 * D-WS6-003 stub. Pass-through for MVP — returns the dish's canonical
 * `dishIngredients` mapped to the shape the macro estimator expects.
 *
 * WS7 will replace the body with a real merger that reads
 * `item.ingredientOverrides` (IngredientOverride[]) and
 * `item.recipeOverrideJson` (RecipeOverride) and produces the effective
 * per-instance ingredient list.
 */
export function resolveEffectiveIngredients(
  _item: Pick<MealPlanItem, "ingredientOverrides" | "recipeOverrideJson">,
  dish: DishWithIngredients,
): EffectiveIngredient[] {
  return dish.dishIngredients.map((di) => {
    const ref = di.ingredient.nutritionRefPerUnit;
    return {
      name: di.ingredient.displayName,
      quantity: di.quantity,
      unit: di.unit,
      isOptional: di.isOptional,
      // Only a MATCHED usda record grounds the estimate; miss-markers / null
      // leave the field absent so the ingredient reads as ungrounded.
      ...(isMatchedRef(ref) ? { nutritionRefPer100g: ref.per100g } : {}),
      // WS7-8b B2 — identity for the quantity→grams table lookup + fallback.
      ingredientId: di.ingredient.id,
      canonicalName: di.ingredient.canonicalName,
      conversionRef: di.ingredient.conversionRef,
    };
  });
}

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
  return dish.dishIngredients.map((di) =>
    toEffectiveIngredient(
      {
        name: di.ingredient.displayName,
        quantity: di.quantity,
        unit: di.unit,
        isOptional: di.isOptional,
      },
      {
        id: di.ingredient.id,
        canonicalName: di.ingredient.canonicalName,
        nutritionRefPerUnit: di.ingredient.nutritionRefPerUnit,
        conversionRef: di.ingredient.conversionRef,
      },
    ),
  );
}

// D-WS9-050 P1.2 — the ONE definition of "how a base ingredient + its persisted
// Ingredient row become a grounded estimator input". Used by the persisted-dish
// resolver above AND by the wizard-expand path, where the ingredient list is
// AI-generated (unpersisted) so the caller must batch-look-up the matching
// Ingredient row itself, then pass it here. `row` absent (a brand-new ingredient
// with no catalog row yet) → the ingredient is still returned, ungrounded, so
// the model sees it exists (never dropped — bake-off failure mode B). Only a
// MATCHED usda record grounds; miss-markers / null leave the ref absent.
export type IngredientRowForGrounding = {
  id: string;
  canonicalName: string;
  nutritionRefPerUnit: unknown;
  conversionRef: unknown;
};

export function toEffectiveIngredient(
  base: { name: string; quantity: number; unit: string; isOptional?: boolean },
  row: IngredientRowForGrounding | undefined,
): EffectiveIngredient {
  const eff: EffectiveIngredient = {
    name: base.name,
    quantity: base.quantity,
    unit: base.unit,
    isOptional: base.isOptional ?? false,
  };
  if (!row) return eff;
  if (isMatchedRef(row.nutritionRefPerUnit)) {
    eff.nutritionRefPer100g = row.nutritionRefPerUnit.per100g;
  }
  eff.ingredientId = row.id;
  eff.canonicalName = row.canonicalName;
  eff.conversionRef = row.conversionRef;
  return eff;
}

// D-WS9-050 P1.2 — the canonical-name key an Ingredient row is stored under,
// mirroring resolveIngredients (ingredientResolve.ts:292) so a wizard-expand
// lookup keys identically to how the row was created.
export function ingredientCanonicalKey(name: string): string {
  return name.toLowerCase().trim();
}

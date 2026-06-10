// WS7-6 Fix-Block 3 — Meal-level per-serving macro aggregation.
//
// Bug 3 background: Meal.*PerServing was 0 for every meal in the DB because
// no write path summed per-dish macros up to the meal row. The diagnosis
// surveyed 20/20 meals at 0.
//
// Hans's ruling (the formula): a meal's per-serving macro is the simple
// SUM of each linked dish's per-serving value. Dish serving counts do NOT
// enter the formula — one meal serving = one serving of each component
// dish on the plate.
//
//   Meal.caloriesPerServing = Σ dish.caloriesPerServing
//   Meal.proteinGPerServing = Σ dish.proteinGPerServing
//   Meal.carbsGPerServing   = Σ dish.carbsGPerServing
//   Meal.fatGPerServing     = Σ dish.fatGPerServing
//
// Worked example: lettuce 50 cal/srv + chicken 100 cal/srv + potatoes 200
// cal/srv → meal = 350 cal/srv. Pinned in the unit test.
//
// No rounding is applied at the persistence boundary — Dish per-serving
// values are stored as raw Floats (the AI estimate writes
// result.perServing.calories straight into Dish.caloriesPerServing in
// planMacros.ts:362-368). The sum mirrors that choice. Display-side
// rounding happens in the mobile UI (Math.round at render time) and in
// planMacros.ts roundTotals() at the per-day rollup. Per-serving stays raw.
//
// Honesty constraint: this helper sums whatever exists on the dish rows.
// When a dish has *PerServing = 0 (a known data gap surfaced by Block 3),
// it contributes 0 to the meal sum — that is correct behavior. Dish macro
// estimation (USDA / AI) is a separate concern, not this helper's job.
//
// Single-source-of-truth: the four write paths (materializeMeal,
// rematerializeMeal, wizardActivation, computePlanMacros) and the
// backfill-meal-macros script all call recomputeAndPersistMealMacros so
// the formula lives in exactly one place.

import type { Prisma, PrismaClient } from "@prisma/client";

export interface DishPerServingMacros {
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
}

export interface MealAggregatedMacros {
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
}

/**
 * Pure sum of per-serving macros across a meal's linked dishes.
 * Hans's ruling — see file header.
 *
 * Empty dish list (0-dish meal — shouldn't happen in practice but the
 * write paths may briefly see it during a wipe-and-recreate edit) →
 * all-zero result, which is the correct sum of nothing.
 */
export function aggregateMealMacrosFromDishes(
  dishes: ReadonlyArray<DishPerServingMacros>,
): MealAggregatedMacros {
  let calories = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;
  for (const d of dishes) {
    calories += d.caloriesPerServing;
    protein += d.proteinGPerServing;
    carbs += d.carbsGPerServing;
    fat += d.fatGPerServing;
  }
  return {
    caloriesPerServing: calories,
    proteinGPerServing: protein,
    carbsGPerServing: carbs,
    fatGPerServing: fat,
  };
}

type MealMacrosClient = Prisma.TransactionClient | PrismaClient;

/**
 * Read the meal's currently-linked dishes' per-serving macros, sum them,
 * and write the aggregated values back to the Meal row. Idempotent
 * (recompute-and-set, not increment) so it's safe to call from the
 * backfill script as well as from the live write paths.
 *
 * Pass a `tx` client when calling inside a $transaction so the meal-row
 * write joins the same atomic critical section as the dish writes.
 * Pass the plain PrismaClient for backfill / post-recalc persists.
 */
export async function recomputeAndPersistMealMacros(
  client: MealMacrosClient,
  mealId: string,
): Promise<MealAggregatedMacros> {
  const links = await client.mealDishLink.findMany({
    where: { mealId },
    select: {
      dish: {
        select: {
          caloriesPerServing: true,
          proteinGPerServing: true,
          carbsGPerServing: true,
          fatGPerServing: true,
        },
      },
    },
  });
  const aggregated = aggregateMealMacrosFromDishes(
    links.map((l) => l.dish),
  );
  await client.meal.update({
    where: { id: mealId },
    data: aggregated,
  });
  return aggregated;
}

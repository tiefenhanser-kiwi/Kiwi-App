// WS6 6d-2 / WS7-8a B2 — Prep the Week loader.
// Per kiwi_ws6_plan.md §3 6d-2 + PRD §13.4 / §13.4.6.
//
// Loads a MealPlanInstance into the enriched PrepLoadedPlan shape the
// deterministic combine engine needs: per-ingredient `category` (off the
// Ingredient row), per-dish `baseServings` (dish.servingsDefault), and the
// plan-item `servingsOverride` — so the adapter can scale RAW quantities to
// effective ones. Pure data prep; does NOT invoke the AI. Caller also receives
// the plan's `revisionId` so the cache writer can stamp
// `lastGeneratedFromPlanRevisionId` on the PrepWeekStructure row.
//
// WS7-8a B2: quantities are now left RAW here and scaled in the adapter
// (prepCombineAdapter.ts), mirroring groceryList.ts (base = dish.servingsDefault).
// The old all-AI PrepWeekInput shape (which scaled in the AI prompt) is retired.

import type { PrismaClient } from "@prisma/client";

// ── enriched loader output (engine-ready, pre-scaling) ──────────────────────

export interface PrepLoadedIngredient {
  ingredientId: string;
  ingredientName: string;
  // Ingredient.category — always present (required column). Drives phase +
  // prep-worthy classification in the engine.
  category: string;
  // RAW dish-ingredient quantity (NOT servings-scaled). The adapter scales.
  quantity: number;
  unit: string;
  preparationNote: string | null;
}

export interface PrepLoadedDish {
  dishId: string;
  dishName: string;
  // dish.servingsDefault — the scaling base (matches groceryList.ts).
  baseServings: number;
  ingredients: PrepLoadedIngredient[];
}

export interface PrepLoadedMeal {
  mealId: string;
  mealName: string;
  cuisine: string | null;
  // plan-item servingsOverride (null = use each dish's baseServings).
  servingsOverride: number | null;
  dishes: PrepLoadedDish[];
}

export interface PrepLoadedPlan {
  planId: string;
  planName: string;
  meals: PrepLoadedMeal[];
}

// Route handler maps NotFoundError → 404; access leak prevention follows
// the cookingSequence pattern (treat missing + forbidden as 404).
export class PrepWeekNotFoundError extends Error {
  constructor(planId: string) {
    super(`plan ${planId} not found`);
    this.name = "PrepWeekNotFoundError";
  }
}

export const EMPTY_PLAN_COPY =
  "Kiwi didn't find anything to prep for this plan — add some meals first.";

export class PrepWeekEmptyPlanError extends Error {
  constructor(planId: string) {
    super(`plan ${planId} has nothing to aggregate`);
    this.name = "PrepWeekEmptyPlanError";
  }
}

export interface LoadPrepWeekInputParams {
  planId: string;
  userId: string;
  prisma: PrismaClient;
}

export interface LoadPrepWeekInputResult {
  input: PrepLoadedPlan;
  planRevisionId: number;
}

export async function loadPrepWeekInput(
  params: LoadPrepWeekInputParams,
): Promise<LoadPrepWeekInputResult> {
  const { planId, userId, prisma } = params;

  // Minimal include shape mirroring planMacros.ts — items → meal → dishes
  // → dishIngredients → ingredient. No user-prefs branch (pantry / picky
  // avoidances don't shape prep-aggregation scheduling).
  const plan = await prisma.mealPlanInstance.findUnique({
    where: { id: planId },
    include: {
      items: {
        orderBy: { positionIndex: "asc" },
        include: {
          meal: {
            include: {
              dishLinks: {
                orderBy: { positionIndex: "asc" },
                include: {
                  dish: {
                    include: {
                      dishIngredients: {
                        orderBy: { positionIndex: "asc" },
                        include: { ingredient: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  // Access check — treat missing + forbidden as NotFound to avoid leaking
  // plan existence to non-owners (matches groceryList.ts / cookingSequence
  // convention).
  if (!plan) throw new PrepWeekNotFoundError(planId);
  if (plan.userId !== userId) throw new PrepWeekNotFoundError(planId);

  if (plan.items.length === 0) throw new PrepWeekEmptyPlanError(planId);

  // Build the enriched per-meal payload. Quantities stay RAW; the adapter
  // scales per-dish off dish.servingsDefault using item.servingsOverride
  // (carried through here as servingsOverride). category + baseServings are
  // already fetched by the include below — we just stop dropping them.
  const meals: PrepLoadedMeal[] = [];
  for (const item of plan.items) {
    const meal = item.meal;
    if (meal.dishLinks.length === 0) continue;

    const dishes: PrepLoadedDish[] = meal.dishLinks
      .map((link) => {
        const dish = link.dish;
        const ingredients: PrepLoadedIngredient[] = dish.dishIngredients.map(
          (di) => ({
            ingredientId: di.ingredient.id,
            ingredientName: di.ingredient.displayName,
            category: di.ingredient.category,
            quantity: di.quantity,
            unit: di.unit,
            preparationNote: di.preparationNote ?? null,
          }),
        );
        return {
          dishId: dish.id,
          dishName: dish.title,
          baseServings: dish.servingsDefault,
          ingredients,
        };
      })
      // Skip dishes with no ingredients — nothing to prep.
      .filter((d) => d.ingredients.length > 0);

    if (dishes.length === 0) continue;

    meals.push({
      mealId: meal.id,
      mealName: meal.title,
      cuisine: meal.cuisineType ?? null,
      servingsOverride: item.servingsOverride,
      dishes,
    });
  }

  // After filtering empty meals/dishes, we may still have nothing to prep —
  // treat as empty plan.
  if (meals.length === 0) throw new PrepWeekEmptyPlanError(planId);

  const planName =
    plan.titleOverride ??
    `Plan ${plan.id.slice(0, 8)}`;

  return {
    input: {
      planId: plan.id,
      planName,
      meals,
    },
    planRevisionId: plan.revisionId,
  };
}

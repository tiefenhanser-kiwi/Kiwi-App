// WS6 6d-2 — Prep the Week aggregation loader.
// Per kiwi_ws6_plan.md §3 6d-2 + PRD §13.4 / §13.4.6.
//
// Builds the PrepWeekInputSchema payload from a MealPlanInstance — meals,
// dishes, ingredients, servings-scaled — for the route handler to hand to
// Sonnet via runAICall. Pure data prep; does NOT invoke the AI. Caller
// also receives the plan's `revisionId` so the cache writer can stamp
// `lastGeneratedFromPlanRevisionId` on the PrepWeekStructure row.

import type { PrismaClient } from "@prisma/client";

import type { PrepWeekInput } from "./ai/schemas/prepWeek";

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
  input: PrepWeekInput;
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

  // Build the per-meal payload. Servings scaling follows groceryList.ts:
  // effectiveServings = item.servingsOverride ?? meal.servingsDefault ?? 1.
  // (Plan §2.5 calls the field `meal.baseServings`; the actual Prisma
  // model uses `servingsDefault` — using that here.)
  const meals: PrepWeekInput["meals"] = [];
  for (const item of plan.items) {
    const meal = item.meal;
    if (meal.dishLinks.length === 0) continue;

    const effectiveServings =
      item.servingsOverride ?? meal.servingsDefault ?? 1;

    const dishes = meal.dishLinks
      .map((link) => {
        const dish = link.dish;
        const ingredients = dish.dishIngredients.map((di) => ({
          ingredientId: di.ingredient.id,
          ingredientName: di.ingredient.displayName,
          quantity: di.quantity,
          unit: di.unit,
          ...(di.preparationNote
            ? { preparationNotes: di.preparationNote }
            : {}),
        }));
        return {
          dishId: dish.id,
          dishName: dish.title,
          ingredients,
        };
      })
      // Skip dishes with no ingredients — nothing to prep.
      .filter((d) => d.ingredients.length > 0);

    if (dishes.length === 0) continue;

    meals.push({
      mealId: meal.id,
      mealName: meal.title,
      ...(meal.cuisineType ? { cuisine: meal.cuisineType } : {}),
      servings: effectiveServings,
      dishes,
    });
  }

  // After filtering empty meals/dishes, we may still have nothing to feed
  // the AI — treat as empty plan.
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

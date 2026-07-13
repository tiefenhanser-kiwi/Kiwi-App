// WS7-7-A B5 fix2 (D-WS7-139) — fork-on-acquire deep clone.
//
// When a meal that the requester does NOT own (a curated/null-owner catalog
// meal or another user's still-public meal) is bound into the user's plan, we
// clone it into a USER-OWNED copy and rebind the plan item to the copy. This
// upholds the PRD ownership rule ("any acquisition creates the user's own
// copy") so the user can later edit it — the PATCH /me/meals/:id ownership gate
// (me.ts:1160) then passes, because the bound mealId is the user's own.
//
// Why a dedicated helper (not mealCreate.createMealWithDishes): that helper
// rebuilds dishes from a RecipeOverride shape (name-resolution, override-driven)
// and is lossy for a faithful copy. This one deep-copies the source meal graph
// exactly — Meal + Dish + MealDishLink + DishIngredient (preserving
// ingredientId refs) + RecipeInstructionStep (both meal-owned and dish-owned).
//
// Boundary: a fork mints fresh ids for every row and never mutates the source.
// Other plans that reference the source meal keep their binding untouched —
// each acquisition is its own independent copy.

import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

// Step fields copied verbatim (everything except id/ownerType/ownerId, which
// are re-derived for the clone).
// BUG-018 B2 — parallelGroup retired; not copied on fork (the column stays NULL,
// which is what a clone would produce anyway).
const STEP_COPY_FIELDS = {
  stepIndex: true,
  stepTextRaw: true,
  stepTextTranslated: true,
  estimatedMinutes: true,
  phaseType: true,
  requiresPreheat: true,
  requiresRest: true,
  requiresMarination: true,
  isTimingSensitive: true,
} as const;

/**
 * Deep-clone `sourceMealId` into a new Meal owned by `userId` (isPublic:false)
 * and return the new meal id. Caller rebinds the MealPlanItem to it.
 *
 * Runs inside the caller's transaction so the clone + rebind commit atomically.
 * Throws if the source meal is missing (caller validated existence already; the
 * guard defends against misuse).
 */
export async function forkMealForUser(
  tx: Tx,
  sourceMealId: string,
  userId: string,
): Promise<{ mealId: string }> {
  const source = await tx.meal.findUnique({
    where: { id: sourceMealId },
    include: {
      dishLinks: {
        orderBy: { positionIndex: "asc" },
        include: {
          dish: {
            include: {
              dishIngredients: { orderBy: { positionIndex: "asc" } },
            },
          },
        },
      },
    },
  });
  if (!source) {
    throw new Error(`Source meal not found for fork: ${sourceMealId}`);
  }

  // 1. The meal row. Copy recipe-defining scalars + cached macros verbatim;
  //    take ownership (userId) and privacy (isPublic:false); reset the social /
  //    usage counters (a fresh personal copy has no like/save/use/cook history).
  const newMeal = await tx.meal.create({
    data: {
      userId,
      title: source.title,
      description: source.description,
      mealType: source.mealType,
      sourceType: source.sourceType,
      cuisineType: source.cuisineType,
      difficulty: source.difficulty,
      estimatedTimeMinutes: source.estimatedTimeMinutes,
      imageUrl: source.imageUrl,
      servingsDefault: source.servingsDefault,
      tags: source.tags,
      caloriesPerServing: source.caloriesPerServing,
      proteinGPerServing: source.proteinGPerServing,
      carbsGPerServing: source.carbsGPerServing,
      fatGPerServing: source.fatGPerServing,
      isPublic: false,
      isArchived: false,
    },
    select: { id: true },
  });

  // 2. Each dish → a fresh user-owned dish, linked at the same position/role,
  //    with its ingredients (ingredientId refs preserved) and dish-owned steps.
  for (const link of source.dishLinks) {
    const d = link.dish;
    const newDish = await tx.dish.create({
      data: {
        userId,
        title: d.title,
        description: d.description,
        sourceType: d.sourceType,
        estimatedTimeMinutes: d.estimatedTimeMinutes,
        difficulty: d.difficulty,
        imageUrl: d.imageUrl,
        servingsDefault: d.servingsDefault,
        tags: d.tags,
        caloriesPerServing: d.caloriesPerServing,
        proteinGPerServing: d.proteinGPerServing,
        carbsGPerServing: d.carbsGPerServing,
        fatGPerServing: d.fatGPerServing,
        isArchived: false,
      },
      select: { id: true },
    });

    await tx.mealDishLink.create({
      data: {
        mealId: newMeal.id,
        dishId: newDish.id,
        positionIndex: link.positionIndex,
        roleLabel: link.roleLabel,
      },
    });

    if (d.dishIngredients.length > 0) {
      await tx.dishIngredient.createMany({
        data: d.dishIngredients.map((di) => ({
          dishId: newDish.id,
          ingredientId: di.ingredientId,
          quantity: di.quantity,
          unit: di.unit,
          preparationNote: di.preparationNote,
          isOptional: di.isOptional,
          positionIndex: di.positionIndex,
        })),
      });
    }

    // Dish-owned steps (ownerType "dish") → re-owned to the new dish id.
    const dishSteps = await tx.recipeInstructionStep.findMany({
      where: { ownerType: "dish", ownerId: d.id },
      orderBy: { stepIndex: "asc" },
      select: STEP_COPY_FIELDS,
    });
    if (dishSteps.length > 0) {
      await tx.recipeInstructionStep.createMany({
        data: dishSteps.map((s) => ({
          ...s,
          ownerType: "dish",
          ownerId: newDish.id,
        })),
      });
    }
  }

  // 3. Meal-owned steps (ownerType "meal" — legacy/seed single-dish meals such
  //    as the curated catalog) → re-owned to the new meal id.
  const mealSteps = await tx.recipeInstructionStep.findMany({
    where: { ownerType: "meal", ownerId: sourceMealId },
    orderBy: { stepIndex: "asc" },
    select: STEP_COPY_FIELDS,
  });
  if (mealSteps.length > 0) {
    await tx.recipeInstructionStep.createMany({
      data: mealSteps.map((s) => ({
        ...s,
        ownerType: "meal",
        ownerId: newMeal.id,
      })),
    });
  }

  return { mealId: newMeal.id };
}

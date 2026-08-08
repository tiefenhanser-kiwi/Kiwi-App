// WS7-4-D c4 — Helper for creating a Meal (with Dishes + DishIngredients +
// MealDishLinks + RecipeInstructionSteps) from a RecipeOverride JSON shape.
// Q-P1-6 ruling: extracted alongside its only consumer (promote-override).
//
// Q-P1-2 ruling: free-form RecipeOverrideIngredient.name MUST resolve to an
// existing Ingredient row (case-insensitive canonicalName match). On first
// unresolved name we throw IngredientResolutionError; the route maps that to
// HTTP 422 and the surrounding $transaction rolls back.
//
// Q-P1-3 ruling: RecipeInstructionStep.stepTextTranslated is populated equal
// to stepTextRaw (no inline translation pass on promote).

import type { Prisma } from "@prisma/client";

export interface RecipeOverrideForCreate {
  titleOverride?: string;
  dishes: Array<{
    name: string;
    ingredients: Array<{ name: string; quantity: number; unit: string }>;
  }>;
  steps?: string[];
  createdAt: string;
}

export interface CreateMealWithDishesOpts {
  userId: string;
  sourceMealId: string;
  override: RecipeOverrideForCreate;
}

export class IngredientResolutionError extends Error {
  constructor(public readonly ingredientName: string) {
    super(`Could not resolve ingredient by name: ${ingredientName}`);
    this.name = "IngredientResolutionError";
  }
}

type Tx = Prisma.TransactionClient;

export async function createMealWithDishes(
  tx: Tx,
  opts: CreateMealWithDishesOpts,
): Promise<{ mealId: string }> {
  const { userId, sourceMealId, override } = opts;

  const source = await tx.meal.findUnique({
    where: { id: sourceMealId },
    select: {
      title: true,
      displayTitle: true,
      description: true,
      cuisineType: true,
      mealType: true,
      imageUrl: true,
      servingsDefault: true,
      estimatedTimeMinutes: true,
      difficulty: true,
      tags: true,
    },
  });
  if (!source) {
    // Defensive: the route validates the item exists (and thus its mealId)
    // before calling, but the helper guards against misuse.
    throw new Error(`Source meal not found: ${sourceMealId}`);
  }

  const newMeal = await tx.meal.create({
    data: {
      userId,
      title: override.titleOverride ?? source.title,
      // WS9 3f-4d Part 1c (D-WS9-123) — carry the source's short display name only
      // when the title is NOT overridden; a user-chosen new title makes the old
      // short name stale, so fall back to null (render the new title as-is).
      displayTitle: override.titleOverride ? null : source.displayTitle,
      description: source.description,
      cuisineType: source.cuisineType,
      mealType: source.mealType,
      imageUrl: source.imageUrl,
      servingsDefault: source.servingsDefault,
      estimatedTimeMinutes: source.estimatedTimeMinutes,
      difficulty: source.difficulty,
      sourceType: "manual",
      isPublic: false,
      isArchived: false,
      tags: source.tags,
    },
    select: { id: true },
  });

  // First-dish inheritance source for per-dish meta (Phase 1 §2 c5 spec).
  const firstSourceDishLink = await tx.mealDishLink.findFirst({
    where: { mealId: sourceMealId },
    orderBy: { positionIndex: "asc" },
    include: { dish: true },
  });

  const newDishIds: string[] = [];
  for (let i = 0; i < override.dishes.length; i++) {
    const od = override.dishes[i];

    const newDish = await tx.dish.create({
      data: {
        userId,
        title: od.name,
        sourceType: "manual",
        estimatedTimeMinutes:
          firstSourceDishLink?.dish.estimatedTimeMinutes ?? 30,
        difficulty: firstSourceDishLink?.dish.difficulty ?? "easy",
        servingsDefault: firstSourceDishLink?.dish.servingsDefault ?? 4,
        isArchived: false,
      },
      select: { id: true },
    });
    newDishIds.push(newDish.id);

    await tx.mealDishLink.create({
      data: {
        mealId: newMeal.id,
        dishId: newDish.id,
        positionIndex: i,
        roleLabel: "main",
      },
    });

    for (let j = 0; j < od.ingredients.length; j++) {
      const ing = od.ingredients[j];
      const lower = ing.name.toLowerCase();
      // Q-P1-2: strict canonicalName resolution (case-insensitive equality).
      // No fuzzy/prefix/auto-create.
      const resolved = await tx.ingredient.findFirst({
        where: { canonicalName: { equals: lower, mode: "insensitive" } },
        select: { id: true },
      });
      if (!resolved) {
        throw new IngredientResolutionError(ing.name);
      }
      await tx.dishIngredient.create({
        data: {
          dishId: newDish.id,
          ingredientId: resolved.id,
          quantity: ing.quantity,
          unit: ing.unit,
          positionIndex: j,
        },
      });
    }
  }

  // Steps: Q-P1-3 stepTextRaw == stepTextTranslated. Single-dish-attach
  // semantics: attach to the first dish (Phase 1 §2 c5).
  if (override.steps && override.steps.length > 0 && newDishIds.length > 0) {
    const ownerId = newDishIds[0];
    for (let k = 0; k < override.steps.length; k++) {
      const text = override.steps[k];
      await tx.recipeInstructionStep.create({
        data: {
          ownerType: "dish",
          ownerId,
          stepIndex: k,
          stepTextRaw: text,
          stepTextTranslated: text,
        },
      });
    }
  }

  return { mealId: newMeal.id };
}

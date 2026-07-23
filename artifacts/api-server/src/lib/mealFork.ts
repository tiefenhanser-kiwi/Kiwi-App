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

import { Prisma } from "@prisma/client";
import type { SourceType } from "@prisma/client";

type Tx = Prisma.TransactionClient;

// Target attributes for a clone: who owns it, whether it's pool-visible, and an
// optional provenance override. forkMealForUser and publishMealToStore differ
// ONLY in these — the graph copy below is identical.
interface CloneTarget {
  userId: string | null;
  isPublic: boolean;
  sourceTypeOverride?: SourceType;
}

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
  // Block 3.7 (D-WS9-066) — swappable-component tags MUST survive the fork, or a
  // catalog meal's bought path vanishes on acquire and the clone silently looks
  // like a scratch-only meal (no error, no signal — the exact failure the
  // substitutions fix guarded against). null on base steps copies as null.
  componentKey: true,
  pathKey: true,
} as const;

/**
 * Deep-clone `sourceMealId` into a new user-owned, private Meal (isPublic:false)
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
  return cloneMealInto(tx, sourceMealId, { userId, isPublic: false });
}

/**
 * Plan-Gen Arc · Block 2 (D-WS9-038 / D-WS7-201) — write-back. Deep-clone a
 * just-materialized live meal into a SHARED-POOL Meal (userId:null, isPublic:
 * true) stamped `sourceType: live_writeback`, so a future compose can reuse it.
 * Provenance stamping is mandatory: a live gen must never enter the pool
 * unstamped / indistinguishable from a curated or batch_generated meal.
 * Returns the new pool meal id.
 */
export async function publishMealToStore(
  tx: Tx,
  sourceMealId: string,
): Promise<{ mealId: string }> {
  return cloneMealInto(tx, sourceMealId, {
    userId: null,
    isPublic: true,
    sourceTypeOverride: "live_writeback",
  });
}

/**
 * The shared deep-copy: Meal + Dish + MealDishLink + DishIngredient (ingredientId
 * refs preserved) + RecipeInstructionStep (meal- and dish-owned). Ownership,
 * pool-visibility, and provenance come from `target`; everything else is copied
 * verbatim. Social/usage counters reset (a fresh copy has no history).
 */
async function cloneMealInto(
  tx: Tx,
  sourceMealId: string,
  target: CloneTarget,
): Promise<{ mealId: string }> {
  const userId = target.userId;
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
  //    take ownership + pool-visibility + provenance from `target`; reset the
  //    social / usage counters (a fresh copy has no like/save/use/cook history).
  const newMeal = await tx.meal.create({
    data: {
      userId,
      title: source.title,
      description: source.description,
      mealType: source.mealType,
      sourceType: target.sourceTypeOverride ?? source.sourceType,
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
      isPublic: target.isPublic,
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
        // D-WS9-050 Phase 2 — the fork copies the macro, so it inherits the
        // macro's write-time grounding stamp (the number's provenance travels
        // with the number).
        macroGroundedPct: d.macroGroundedPct,
        // Block 3.6 v3 (D-WS9-064) — substitutions MUST survive the fork, or a
        // catalog meal's convenience swaps vanish the moment it enters a user's
        // plan. Copied verbatim (Prisma reads Json? as the value or null; a null
        // is passed through as DbNull so the column stays SQL NULL on the copy).
        substitutions:
          d.substitutions === null
            ? Prisma.DbNull
            : (d.substitutions as Prisma.InputJsonValue),
        // Block 3.7 (D-WS9-066 / D-WS7-215) — the component registry and the
        // per-user selection must survive the fork alongside substitutions, or a
        // dual-path meal loses the label/order metadata (registry) or the user's
        // saved "make this easier" choice (selections) on acquire. Same DbNull
        // discipline: a null Json? column is passed as Prisma.DbNull so it stays
        // SQL NULL on the copy rather than a literal JSON null (which Prisma
        // rejects on a Json? column).
        componentRegistry:
          d.componentRegistry === null
            ? Prisma.DbNull
            : (d.componentRegistry as Prisma.InputJsonValue),
        componentSelections:
          d.componentSelections === null
            ? Prisma.DbNull
            : (d.componentSelections as Prisma.InputJsonValue),
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
          // Block 3.7 (D-WS9-066) — component tags travel with the ingredient
          // (same reason as steps: the bought path's product / the scratch
          // ingredients it replaces must not silently drop on fork).
          componentKey: di.componentKey,
          pathKey: di.pathKey,
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

// THX-2S Part G (D-WS9-313) — copy ONE catalog dish into the user's own meal:
// the meal-edit "Thanksgiving dishes" button (swap the herb turkey for the
// buttermilk one, add a second pie). POST /me/meals/:mealId/dishes/from-catalog.
//
// The source is a public, non-archived catalog meal holding exactly one dish
// (THX-2G's alternates are single-dish meals tagged `thanksgiving-alternate`).
// The dish is deep-copied — row, ingredients, steps — by the SAME per-dish copy
// the fork uses (mealFork.ts cloneDishForUser), scaled to the target:
//
//   factor = target servings ÷ source servings, where
//     target servings = the TARGET MEAL's authored anchor
//                       (Meal.authoredServingsDefault ?? Meal.servingsDefault):
//                       what every dish in it is written for — the same
//                       meal-anchor rule rematerializeMeal applies (BUG-003);
//     source servings = the SOURCE DISH's authored anchor
//                       (Dish.authoredServingsDefault ?? Dish.servingsDefault):
//                       what its quantities are written for.
//
// The copy is then written AT the target's anchor (authoredServingsDefault =
// target servings, servingsDefault = the target meal's servingsDefault), so the
// new dish scales exactly like its neighbours at render and on the grocery list.
// Ingredient quantities and step amountRefs are scaled; step prose outside a ref
// is copied as written (the pre-existing unmatched-amount class).
//
// Afterwards: finishMealGraphWrite (macros, allergen stamp, time) — the tail
// rematerializeMeal runs after a meal edit. The plan-revision bump is the
// route's, exactly as PATCH /me/meals/:id does it (only with bumpPlanId).

import type { Prisma } from "@prisma/client";

import { cloneDishForUser } from "./mealFork";
import { feastDaysForAddedDish } from "./feastAddedDish";
import { FEAST_MEAL_TAG } from "./prepWeekAggregation";
import { isWholeBirdByCount, isWholeBirdByWeight } from "./prepQuantity";
import { exclusiveDishIdsOf, finishMealGraphWrite } from "./mealMaterialize";

export type CopyCatalogDishResult =
  | { kind: "target_not_found" }
  | { kind: "target_forbidden" }
  | { kind: "source_not_found" }
  | { kind: "source_not_single_dish"; dishCount: number }
  | { kind: "replace_not_found" }
  | { kind: "dish_limit"; max: number }
  | {
      kind: "copied";
      dishId: string;
      /** Every dish of the target, in position order, after the write. */
      dishIds: string[];
      positionIndex: number;
      targetServings: number;
      sourceServings: number;
      factor: number;
    };

export interface CopyCatalogDishArgs {
  userId: string;
  targetMealId: string;
  sourceMealId: string;
  replaceDishId?: string;
  maxDishes: number;
}

export async function copyCatalogDishIntoMeal(
  tx: Prisma.TransactionClient,
  args: CopyCatalogDishArgs,
): Promise<CopyCatalogDishResult> {
  const { userId, targetMealId, sourceMealId, replaceDishId, maxDishes } = args;

  // Owner gate — the PATCH /me/meals/:id gate: 404 missing/archived, 403 for a
  // catalog (userId null) or another user's meal.
  const target = await tx.meal.findUnique({
    where: { id: targetMealId },
    select: { userId: true, isArchived: true, servingsDefault: true, authoredServingsDefault: true, tags: true },
  });
  if (!target || target.isArchived) return { kind: "target_not_found" };
  if (target.userId === null || target.userId !== userId) return { kind: "target_forbidden" };

  // The source: public, live, exactly one dish. Not public reads as missing
  // (never 403), so the route cannot probe private ids.
  const source = await tx.meal.findUnique({
    where: { id: sourceMealId },
    select: {
      isPublic: true,
      isArchived: true,
      dishLinks: {
        orderBy: { positionIndex: "asc" },
        select: { roleLabel: true, dish: { include: { dishIngredients: { orderBy: { positionIndex: "asc" } } } } },
      },
    },
  });
  if (!source || !source.isPublic || source.isArchived) return { kind: "source_not_found" };
  if (source.dishLinks.length !== 1) {
    return { kind: "source_not_single_dish", dishCount: source.dishLinks.length };
  }
  const sourceLink = source.dishLinks[0];
  const sourceDish = sourceLink.dish;

  const links = await tx.mealDishLink.findMany({
    where: { mealId: targetMealId },
    orderBy: { positionIndex: "asc" },
    select: { dishId: true, positionIndex: true },
  });
  const replaced = replaceDishId ? links.find((l) => l.dishId === replaceDishId) : undefined;
  if (replaceDishId && !replaced) return { kind: "replace_not_found" };
  if (!replaced && links.length >= maxDishes) return { kind: "dish_limit", max: maxDishes };

  const targetServings = target.authoredServingsDefault ?? target.servingsDefault;
  const sourceServings = sourceDish.authoredServingsDefault ?? sourceDish.servingsDefault;
  const factor = sourceServings > 0 ? targetServings / sourceServings : 1;

  const dishId = await cloneDishForUser(tx, sourceDish, {
    userId,
    servingsDefault: target.servingsDefault,
    authoredServingsDefault: targetServings,
    quantityFactor: factor,
    mealOwnedStepsOf: sourceMealId,
  });

  // Replace keeps the slot; add goes last.
  // THX-3d (F, R6) — copied into a FEAST, the dish gets its days (feastAddedDish): the
  // replaced dish's tags are read before it is deleted, for its thaw.
  if ((target.tags ?? []).includes(FEAST_MEAL_TAG)) {
    const replacedTags = replaced ? (await tx.dish.findUnique({ where: { id: replaced.dishId }, select: { tags: true } }))?.tags ?? [] : [];
    await giveFeastDays(tx, dishId, sourceDish.title, replacedTags);
  }

  const positionIndex = replaced
    ? replaced.positionIndex
    : links.reduce((max, l) => Math.max(max, l.positionIndex), -1) + 1;
  if (replaced) {
    const [exclusive] = await exclusiveDishIdsOf(tx, userId, targetMealId, [replaced.dishId]);
    await tx.mealDishLink.deleteMany({ where: { mealId: targetMealId, dishId: replaced.dishId } });
    if (exclusive) {
      await tx.recipeInstructionStep.deleteMany({ where: { ownerType: "dish", ownerId: exclusive } });
      await tx.dishIngredient.deleteMany({ where: { dishId: exclusive } });
      await tx.dish.delete({ where: { id: exclusive } });
    }
  }
  await tx.mealDishLink.create({
    data: { mealId: targetMealId, dishId, positionIndex, roleLabel: sourceLink.roleLabel },
  });

  const dishIds = (
    await tx.mealDishLink.findMany({
      where: { mealId: targetMealId },
      orderBy: { positionIndex: "asc" },
      select: { dishId: true },
    })
  ).map((l) => l.dishId);
  await finishMealGraphWrite(tx, targetMealId, dishIds);

  return { kind: "copied", dishId, dishIds, positionIndex, targetServings, sourceServings, factor };
}

/**
 * THX-3d (F, R6) — write an added feast dish's days into its copy: the steps' day
 * phrases (amountRefs moved with the text), the tags, and the code-written thaw and
 * serve steps (feastAddedDish). A dish that already names its days is left alone.
 */
async function giveFeastDays(tx: Prisma.TransactionClient, dishId: string, title: string, replacedTags: readonly string[]): Promise<void> {
  const dish = await tx.dish.findUnique({
    where: { id: dishId },
    select: { tags: true, dishIngredients: { select: { quantity: true, unit: true, ingredient: { select: { canonicalName: true } } } } },
  });
  if (!dish) return;
  const steps = await tx.recipeInstructionStep.findMany({
    where: { ownerType: "dish", ownerId: dishId },
    orderBy: { stepIndex: "asc" },
    select: { id: true, stepIndex: true, stepTextTranslated: true, amountRefs: true },
  });
  const isWholeBird = dish.dishIngredients.some((i) => isWholeBirdByWeight(i.unit, i.ingredient.canonicalName) || isWholeBirdByCount(i.unit, i.ingredient.canonicalName));
  const days = feastDaysForAddedDish({ title, tags: dish.tags, steps: steps.map((st) => ({ stepIndex: st.stepIndex, text: st.stepTextTranslated })), isWholeBird, replacedTags });
  if (days.texts.size === 0 && days.creates.length === 0) return;
  // Latest first, so two rows never share an index mid-move.
  for (const st of [...steps].sort((a, b) => b.stepIndex - a.stepIndex)) {
    const text = days.texts.get(st.stepIndex);
    const moved = text !== undefined ? text.length - st.stepTextTranslated.length : 0;
    const refs = Array.isArray(st.amountRefs)
      ? (st.amountRefs as { charStart: number; charEnd: number }[]).map((r) => ({ ...r, charStart: r.charStart + moved, charEnd: r.charEnd + moved }))
      : st.amountRefs;
    await tx.recipeInstructionStep.update({
      where: { id: st.id },
      data: {
        stepIndex: st.stepIndex + days.shift,
        ...(text !== undefined ? { stepTextRaw: text, stepTextTranslated: text, amountRefs: refs as Prisma.InputJsonValue } : {}),
      },
    });
  }
  // The creates carry their final indexes (the thaw 0, the serve after the moved last).
  for (const c of days.creates) {
    await tx.recipeInstructionStep.create({
      data: { ownerType: "dish", ownerId: dishId, stepIndex: c.stepIndex, stepTextRaw: c.text, stepTextTranslated: c.text, phaseType: c.phaseType, estimatedMinutes: c.estimatedMinutes, isTimingSensitive: false, amountRefs: [] },
    });
  }
  if (days.tags.join("|") !== dish.tags.join("|")) await tx.dish.update({ where: { id: dishId }, data: { tags: days.tags } });
}

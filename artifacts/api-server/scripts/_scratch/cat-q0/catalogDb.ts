// CAT-Q0 — the one read of the catalog every pass shares. READ-ONLY: findMany
// only. "The catalog" = Meal.isPublic && !isArchived (the Cookbook's own filter,
// src/lib/cookbook/search.ts, minus its mealType/allergen/query narrowing), read
// back as STORED (never a model payload), with the default path selected by the
// app's own selectDefaultPathSteps and the times re-derived by deriveMealTiming.

import type { PrismaClient } from "@prisma/client";

import { selectDefaultPathSteps, type SchedulerPhase } from "../../../src/lib/cookingScheduler";
import { deriveMealTiming } from "../../../src/lib/mealTiming";

export interface AmountRef { ingredientId: string; quantity?: number; unit?: string; charStart?: number; charEnd?: number }

export interface CatStep {
  stepIndex: number;
  text: string;
  phaseType: string;
  estimatedMinutes: number;
  isTimingSensitive: boolean;
  parallelGroup: string | null;
  componentKey: string | null;
  pathKey: string | null;
  amountRefs: AmountRef[];
}

export interface CatIngredient {
  ingredientId: string;
  name: string;
  canonicalName: string;
  aliases: string[];
  quantity: number;
  unit: string;
  preparationNote: string | null;
  isOptional: boolean;
  componentKey: string | null;
  pathKey: string | null;
  fromLeftovers: boolean;
}

export interface CatDish {
  dishId: string;
  positionIndex: number;
  role: string;
  title: string;
  servingsDefault: number;
  substitutions: Array<{ product: string; quantity: number; unit: string; replaces: string[] }>;
  ingredients: CatIngredient[];
  /** Every stored step. */
  allSteps: CatStep[];
  /** What the app shows: base + one path per component (selectDefaultPathSteps). */
  steps: CatStep[];
}

export interface CatMeal {
  id: string;
  title: string;
  displayTitle: string | null;
  mealType: string;
  sourceType: string;
  dishFamilyKey: string | null;
  userId: string | null;
  tags: string[];
  servingsDefault: number;
  estimatedTimeMinutes: number;
  activeTimeMinutes: number | null;
  allergens: string[];
  updatedAt: Date;
  dishes: CatDish[];
  /** deriveMealTiming over the stored steps (what the stamp WOULD be today). */
  derived: { totalMinutes: number | null; activeMinutes: number | null };
}

export const CATALOG_WHERE = { isPublic: true, isArchived: false } as const;

function refsOf(j: unknown): AmountRef[] {
  return Array.isArray(j) ? (j.filter((r) => r && typeof r === "object" && typeof (r as AmountRef).ingredientId === "string") as AmountRef[]) : [];
}

/** Every catalog meal (or only `ids`), full graph, id order. */
export async function loadCatalog(prisma: PrismaClient, ids?: readonly string[]): Promise<CatMeal[]> {
  const meals = await prisma.meal.findMany({
    where: ids ? { ...CATALOG_WHERE, id: { in: [...ids] } } : CATALOG_WHERE,
    select: {
      id: true, title: true, displayTitle: true, mealType: true, sourceType: true, dishFamilyKey: true, userId: true,
      tags: true, servingsDefault: true, estimatedTimeMinutes: true, activeTimeMinutes: true, allergens: true, updatedAt: true,
      dishLinks: {
        orderBy: { positionIndex: "asc" },
        select: {
          positionIndex: true, roleLabel: true,
          dish: {
            select: {
              id: true, title: true, servingsDefault: true, substitutions: true,
              dishIngredients: {
                orderBy: { positionIndex: "asc" },
                select: {
                  ingredientId: true, quantity: true, unit: true, preparationNote: true, isOptional: true,
                  componentKey: true, pathKey: true, fromLeftovers: true,
                  ingredient: { select: { displayName: true, canonicalName: true, aliases: true } },
                },
              },
            },
          },
        },
      },
    },
    orderBy: { id: "asc" },
  });
  const dishIds = [...new Set(meals.flatMap((m) => m.dishLinks.map((l) => l.dish.id)))];
  const byDish = new Map<string, CatStep[]>();
  for (let i = 0; i < dishIds.length; i += 2000) {
    const rows = await prisma.recipeInstructionStep.findMany({
      where: { ownerType: "dish", ownerId: { in: dishIds.slice(i, i + 2000) } },
      select: {
        ownerId: true, stepIndex: true, stepTextRaw: true, phaseType: true, estimatedMinutes: true, isTimingSensitive: true,
        parallelGroup: true, componentKey: true, pathKey: true, amountRefs: true,
      },
      orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }],
    });
    for (const s of rows) {
      const list = byDish.get(s.ownerId) ?? [];
      list.push({
        stepIndex: s.stepIndex, text: s.stepTextRaw, phaseType: String(s.phaseType), estimatedMinutes: s.estimatedMinutes,
        isTimingSensitive: s.isTimingSensitive, parallelGroup: s.parallelGroup, componentKey: s.componentKey, pathKey: s.pathKey,
        amountRefs: refsOf(s.amountRefs),
      });
      byDish.set(s.ownerId, list);
    }
  }
  return meals.map((m) => {
    const dishes: CatDish[] = m.dishLinks.map((l) => {
      const allSteps = byDish.get(l.dish.id) ?? [];
      return {
        dishId: l.dish.id,
        positionIndex: l.positionIndex,
        role: String(l.roleLabel),
        title: l.dish.title,
        servingsDefault: l.dish.servingsDefault,
        substitutions: Array.isArray(l.dish.substitutions) ? (l.dish.substitutions as CatDish["substitutions"]) : [],
        ingredients: l.dish.dishIngredients.map((di) => ({
          ingredientId: di.ingredientId, name: di.ingredient.displayName, canonicalName: di.ingredient.canonicalName,
          aliases: di.ingredient.aliases, quantity: di.quantity, unit: di.unit, preparationNote: di.preparationNote,
          isOptional: di.isOptional, componentKey: di.componentKey, pathKey: di.pathKey, fromLeftovers: di.fromLeftovers,
        })),
        allSteps,
        steps: selectDefaultPathSteps(allSteps),
      };
    });
    const timing = deriveMealTiming(dishes.map((d) => ({
      dishId: d.dishId, title: d.title, positionIndex: d.positionIndex,
      steps: d.allSteps.map((s) => ({
        stepIndex: s.stepIndex, estimatedMinutes: s.estimatedMinutes, phaseType: s.phaseType as SchedulerPhase,
        isTimingSensitive: s.isTimingSensitive, parallelGroup: s.parallelGroup, componentKey: s.componentKey, pathKey: s.pathKey,
      })),
    })));
    return {
      id: m.id, title: m.title, displayTitle: m.displayTitle, mealType: String(m.mealType), sourceType: String(m.sourceType),
      dishFamilyKey: m.dishFamilyKey, userId: m.userId, tags: m.tags, servingsDefault: m.servingsDefault,
      estimatedTimeMinutes: m.estimatedTimeMinutes, activeTimeMinutes: m.activeTimeMinutes, allergens: m.allergens,
      updatedAt: m.updatedAt, dishes,
      derived: { totalMinutes: timing.totalMinutes, activeMinutes: timing.activeMinutes },
    };
  });
}

/** The featured-* template meals (THX-1 rail), the everyday ones = no anchorDate. */
export async function loadFeaturedMealIds(prisma: PrismaClient): Promise<Array<{ templateId: string; title: string; anchored: boolean; mealIds: string[] }>> {
  const t = await prisma.mealPlanTemplate.findMany({
    where: { id: { startsWith: "featured-" } },
    select: { id: true, title: true, anchorDate: true, items: { select: { mealId: true, positionIndex: true }, orderBy: { positionIndex: "asc" } } },
    orderBy: { id: "asc" },
  });
  return t.map((x) => ({ templateId: x.id, title: x.title, anchored: x.anchorDate != null, mealIds: x.items.map((i) => i.mealId) }));
}

// THX-2G — the database reads generate.ts, review.ts and approve.ts share: one
// meal graph per thx2- row, read back from what was WRITTEN (never the model's
// payload), so every number printed or reviewed is the stored one.

import type { PrismaClient } from "@prisma/client";

import { explainAllergenMatches } from "../../src/lib/allergens";
import { KEY_PREFIX } from "./thx2Core";

export interface StepRow {
  stepIndex: number;
  text: string;
  phaseType: string;
  estimatedMinutes: number;
  isTimingSensitive: boolean;
  parallelGroup: string | null;
  componentKey: string | null;
  pathKey: string | null;
}

export interface DishRow {
  dishId: string;
  positionIndex: number;
  role: string;
  title: string;
  tags: string[];
  servingsDefault: number;
  substitutions: Array<{ product: string; quantity: number; unit: string; replaces: string[] }>;
  ingredients: Array<{ name: string; quantity: number; unit: string; preparationNote: string | null; isOptional: boolean; pathKey: string | null }>;
  steps: StepRow[];
}

export interface MealGraph {
  id: string;
  key: string;
  title: string;
  displayTitle: string | null;
  description: string | null;
  cuisineType: string | null;
  difficulty: string;
  servingsDefault: number;
  isPublic: boolean;
  tags: string[];
  estimatedTimeMinutes: number;
  activeTimeMinutes: number | null;
  allergens: string[];
  allergenSources: Record<string, string[]>;
  allergensStampedAt: Date | null;
  imageStatus: string;
  imageUrl: string | null;
  imageAttempts: number;
  createdAt: Date;
  dishes: DishRow[];
  ingredientNames: string[];
  explain: ReturnType<typeof explainAllergenMatches>;
}

/** Every thx2- meal (or only `keys`), with its full graph, in key order. */
export async function loadThx2Meals(prisma: PrismaClient, keys?: readonly string[]): Promise<MealGraph[]> {
  const meals = await prisma.meal.findMany({
    where: {
      sourceType: "batch_generated",
      dishFamilyKey: keys ? { in: [...keys] } : { startsWith: KEY_PREFIX },
    },
    select: {
      id: true, title: true, displayTitle: true, description: true, cuisineType: true, difficulty: true,
      servingsDefault: true, isPublic: true, tags: true, dishFamilyKey: true, estimatedTimeMinutes: true,
      activeTimeMinutes: true, allergens: true, allergenSources: true, allergensStampedAt: true,
      imageStatus: true, imageUrl: true, imageAttempts: true, createdAt: true,
      dishLinks: {
        orderBy: { positionIndex: "asc" },
        select: {
          positionIndex: true, roleLabel: true,
          dish: {
            select: {
              id: true, title: true, tags: true, servingsDefault: true, substitutions: true,
              dishIngredients: {
                orderBy: { positionIndex: "asc" },
                select: { quantity: true, unit: true, preparationNote: true, isOptional: true, pathKey: true, ingredient: { select: { displayName: true } } },
              },
            },
          },
        },
      },
    },
    orderBy: { dishFamilyKey: "asc" },
  });
  const dishIds = meals.flatMap((m) => m.dishLinks.map((l) => l.dish.id));
  const steps = dishIds.length
    ? await prisma.recipeInstructionStep.findMany({
        where: { ownerType: "dish", ownerId: { in: dishIds } },
        select: { ownerId: true, stepIndex: true, stepTextRaw: true, phaseType: true, estimatedMinutes: true, isTimingSensitive: true, parallelGroup: true, componentKey: true, pathKey: true },
        orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }],
      })
    : [];
  return meals.map((m) => {
    const dishes: DishRow[] = m.dishLinks.map((l) => ({
      dishId: l.dish.id,
      positionIndex: l.positionIndex,
      role: String(l.roleLabel),
      title: l.dish.title,
      tags: l.dish.tags,
      servingsDefault: l.dish.servingsDefault,
      substitutions: Array.isArray(l.dish.substitutions) ? (l.dish.substitutions as DishRow["substitutions"]) : [],
      ingredients: l.dish.dishIngredients.map((di) => ({
        name: di.ingredient.displayName, quantity: di.quantity, unit: di.unit, preparationNote: di.preparationNote, isOptional: di.isOptional, pathKey: di.pathKey,
      })),
      steps: steps.filter((s) => s.ownerId === l.dish.id).map((s) => ({
        stepIndex: s.stepIndex, text: s.stepTextRaw, phaseType: String(s.phaseType), estimatedMinutes: s.estimatedMinutes,
        isTimingSensitive: s.isTimingSensitive, parallelGroup: s.parallelGroup, componentKey: s.componentKey, pathKey: s.pathKey,
      })),
    }));
    const ingredientNames = dishes.flatMap((d) => d.ingredients.map((i) => i.name));
    return {
      id: m.id,
      key: m.dishFamilyKey ?? "",
      title: m.title,
      displayTitle: m.displayTitle,
      description: m.description,
      cuisineType: m.cuisineType,
      difficulty: String(m.difficulty),
      servingsDefault: m.servingsDefault,
      isPublic: m.isPublic,
      tags: m.tags,
      estimatedTimeMinutes: m.estimatedTimeMinutes,
      activeTimeMinutes: m.activeTimeMinutes,
      allergens: m.allergens,
      allergenSources: (m.allergenSources ?? {}) as Record<string, string[]>,
      allergensStampedAt: m.allergensStampedAt,
      imageStatus: String(m.imageStatus),
      imageUrl: m.imageUrl,
      imageAttempts: m.imageAttempts,
      createdAt: m.createdAt,
      dishes,
      ingredientNames,
      explain: explainAllergenMatches(ingredientNames),
    };
  });
}

/** The flag inputs for a stored meal (flagsFor's `meal` argument). */
export function flagInputs(m: MealGraph) {
  return {
    dishTitles: m.dishes.map((d) => d.title),
    ingredientNames: m.ingredientNames,
    stamp: m.allergens,
    substitutionProducts: m.dishes.flatMap((d) => d.substitutions.map((s) => s.product)),
  };
}

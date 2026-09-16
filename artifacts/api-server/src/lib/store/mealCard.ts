// WS9 Redesign Arc Block 1 — the Pick-screen / Playlist card projection. One
// select + one mapper so POST /wizard/shelf and GET /me/playlist ship the same
// per-meal shape (D-WS9-237): name · description · total AND active minutes
// (DERIVED, never authored — D-WS9-235: both are the stored derived columns,
// activeTimeMinutes null when the meal was never derived) · per-serving macros
// · tags · cuisine · difficulty · dish count.

import type { Prisma } from "@prisma/client";

export const MEAL_CARD_SELECT = {
  id: true,
  title: true,
  description: true,
  cuisineType: true,
  difficulty: true,
  estimatedTimeMinutes: true,
  activeTimeMinutes: true,
  caloriesPerServing: true,
  proteinGPerServing: true,
  carbsGPerServing: true,
  fatGPerServing: true,
  tags: true,
  sourceStoreMealId: true,
  isPublic: true,
  userId: true,
  _count: { select: { dishLinks: true } },
} satisfies Prisma.MealSelect;

export type MealCardRow = Prisma.MealGetPayload<{ select: typeof MEAL_CARD_SELECT }>;

export interface MealCard {
  id: string;
  title: string;
  description: string | null;
  cuisineType: string | null;
  difficulty: string;
  estimatedTimeMinutes: number;
  activeTimeMinutes: number | null;
  macrosPerServing: {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
  };
  tags: string[];
  dishCount: number;
}

export function toMealCard(row: MealCardRow): MealCard {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    cuisineType: row.cuisineType,
    difficulty: row.difficulty,
    estimatedTimeMinutes: row.estimatedTimeMinutes,
    activeTimeMinutes: row.activeTimeMinutes,
    macrosPerServing: {
      calories: row.caloriesPerServing,
      protein: row.proteinGPerServing,
      carbs: row.carbsGPerServing,
      fat: row.fatGPerServing,
    },
    tags: row.tags,
    dishCount: row._count?.dishLinks ?? 0,
  };
}

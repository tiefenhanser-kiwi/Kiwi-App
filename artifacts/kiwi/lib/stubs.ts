// TEMPORARY STUBS — Will be replaced by API calls in WS7.
//
// WS1 removed the hardcoded RECIPES data source (mockData.ts). These
// stubs keep the build green while Home (WS3), meal swap (WS5), and
// API client (WS7) are rebuilt against the new Prisma-backed endpoints.
//
// When any of those workstreams lands, update consumers to call the
// API via lib/api.ts and delete the corresponding stub from this file.

import type { GroceryItem, MealPlan, Recipe } from "./types";
import { DAYS, getMondayISO } from "./domain";

// Empty recipe list. Replaces the hardcoded 12-recipe array.
export const RECIPES: Recipe[] = [];

// Always returns undefined until wired to API.
export function getRecipe(_id: string): Recipe | undefined {
  return undefined;
}

// Returns an empty plan scaffold. AppContext uses this on fresh install
// when there are no saved plans. Empty plan = empty UI state (correct
// behavior until WS3 builds the real Home flow).
export function defaultPlan(): MealPlan {
  return {
    id: "plan-current",
    name: "This Week",
    createdAt: Date.now(),
    weekStart: getMondayISO(),
    meals: DAYS.map((d) => ({
      day: d,
      slot: "Dinner",
      recipeId: "",
    })),
  };
}

// Returns empty grocery list until WS7 wires the real derivation.
export function buildGroceryList(
  _plan: MealPlan,
  _pantry: string[] = [],
): GroceryItem[] {
  return [];
}

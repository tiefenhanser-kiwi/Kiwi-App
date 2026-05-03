// TEMPORARY STUBS — Will be replaced by API calls in WS7.
//
// WS1 removed the hardcoded RECIPES data source (mockData.ts). These
// stubs keep the build green while Home (WS3), meal swap (WS5), and
// API client (WS7) are rebuilt against the new Prisma-backed endpoints.
//
// When any of those workstreams lands, update consumers to call the
// API via lib/api.ts and delete the corresponding stub from this file.

import type {
  DayAssignment,
  DayOfWeek,
  GroceryItem,
  MealPlan,
  MealsFilter,
  Recipe,
  ReviewPlan,
} from "./types";
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
export function buildGroceryList(_plan: MealPlan): GroceryItem[] {
  return [];
}

// ── Plan Discovery (PRD §4.2.5) ──
// WS3-3E adds these so the Home Plan Discovery card renders against
// stubbed data. WS7 swaps getHomePayload to a real fetch.

export type PlanDiscoveryFilter =
  | "my_plans"
  | "featured"
  | "top_rated"
  | "hosting_events";

export const PLAN_DISCOVERY_FILTER_KEYS: readonly PlanDiscoveryFilter[] = [
  "my_plans",
  "featured",
  "top_rated",
  "hosting_events",
];

// Narrows a server-supplied string[] (e.g. user.lastPlanDiscoveryFilters)
// to the typed union, dropping unknown values silently.
export function asPlanDiscoveryFilters(
  arr: string[] | undefined | null,
): PlanDiscoveryFilter[] {
  if (!arr) return [];
  return arr.filter((k): k is PlanDiscoveryFilter =>
    (PLAN_DISCOVERY_FILTER_KEYS as readonly string[]).includes(k),
  );
}

export const MEALS_FILTER_KEYS: readonly MealsFilter[] = [
  "my_meals",
  "all_meals",
];

export function asMealsFilters(
  arr: string[] | undefined | null,
): MealsFilter[] {
  if (!arr) return [];
  return arr.filter((k): k is MealsFilter =>
    (MEALS_FILTER_KEYS as readonly string[]).includes(k),
  );
}

export type PlanDiscoveryCard = {
  planId: string;
  title: string;
  imageUrl: string | null;
  tags: string[];
  badge: PlanDiscoveryFilter | null;
  mealPreviewTitles: string[];
  canExpand: boolean;
};

export type HomePayload = {
  planDiscoveryCards: PlanDiscoveryCard[];
};

export async function getHomePayload(): Promise<HomePayload> {
  return { planDiscoveryCards: [] };
}

// ── Plans tab (PRD §9.2) ──
// WS7 fills this. Same seam pattern as getHomePayload.

export type PlanRowData = {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  meta: string;
  tags: string[];
  filterGroup: PlanDiscoveryFilter;
};

export async function getPlansPayload(): Promise<{ plans: PlanRowData[] }> {
  return { plans: [] };
}

// ── My Meals tab (PRD §9.3) ──
// WS7 fills this. Same seam pattern as getHomePayload and getPlansPayload.

export type MealsFilterGroup = "my_meals" | "all_meals";

export type MealRowData = {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  meta: string;
  cuisineTag: string | null;
  filterGroup: MealsFilterGroup;
};

export async function getMealsPayload(): Promise<{ meals: MealRowData[] }> {
  return { meals: [] };
}

// ── Plan Review (PRD §8) ──
// WS7 fills this. Same seam pattern as the other payload getters above.

/**
 * PRD §8 Plan Review payload stub.
 * Real data ships in WS7 (composite endpoint, server-resolved).
 * For WS5, returns an empty review plan — exercises the §8.6
 * "no meals in this plan yet" valid empty state.
 *
 * @param _planId MealPlanInstance.id (unused at stub stage)
 */
export function getReviewPlan(_planId: string): ReviewPlan {
  // TODO(WS7): Remove this demo branch when getReviewPlan wires to
  // real data. Used for WS5 smoke testing of meal row component.
  if (_planId === "demo") {
    const buildDayStrip = (assignedDay: DayOfWeek | null): DayAssignment[] => {
      const days: DayOfWeek[] = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ];
      return days.map((day) => ({ day, isAssigned: assignedDay === day }));
    };

    return {
      id: _planId,
      name: "Demo Plan",
      prepStatus: "not_prepped",
      optimizationNotes: [
        {
          type: "prep",
          text: "Chicken used in 2 meals — prep both portions at once.",
        },
        {
          type: "cost",
          text: "Garlic shared across 3 meals — buy one head, use it all.",
        },
      ],
      macroDailyAverage: {
        caloriesPerDay: 2100,
        proteinGPerDay: 130,
        carbsGPerDay: 210,
        fatGPerDay: 75,
      },
      scheduledMeals: [
        {
          planItemId: "demo-item-1",
          mealId: "demo-meal-1",
          title: "Salmon Teriyaki",
          thumbnailUrl: undefined,
          metaLine: "Easy · 30 min · serves 4",
          caloriesPerServing: 540,
          dayStrip: buildDayStrip("Tuesday"),
          hasRecipeOverride: false,
        },
        {
          planItemId: "demo-item-2",
          mealId: "demo-meal-2",
          title: "Chicken Stir Fry",
          thumbnailUrl: undefined,
          metaLine: "Easy · 25 min · serves 4",
          caloriesPerServing: 480,
          dayStrip: buildDayStrip("Thursday"),
          hasRecipeOverride: false,
        },
      ],
      unscheduledMeals: [
        {
          planItemId: "demo-item-3",
          mealId: "demo-meal-3",
          title: "Pasta Primavera",
          thumbnailUrl: undefined,
          metaLine: "Medium · 40 min · serves 4",
          caloriesPerServing: 620,
          dayStrip: buildDayStrip(null),
          hasRecipeOverride: false,
        },
      ],
      breakfastDefaults: "",
      lunchDefaults: "",
    };
  }

  return {
    id: _planId,
    name: "",
    prepStatus: "not_prepped",
    optimizationNotes: [],
    macroDailyAverage: {
      caloriesPerDay: 0,
      proteinGPerDay: 0,
      carbsGPerDay: 0,
      fatGPerDay: 0,
    },
    scheduledMeals: [],
    unscheduledMeals: [],
    breakfastDefaults: "",
    lunchDefaults: "",
  };
}

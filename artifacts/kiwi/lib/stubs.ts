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
  ReviewMeal,
  ReviewPlan,
  SavedDish,
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
          proteinGPerServing: 38,
          carbsGPerServing: 32,
          fatGPerServing: 24,
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
          proteinGPerServing: 35,
          carbsGPerServing: 38,
          fatGPerServing: 18,
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
          proteinGPerServing: 22,
          carbsGPerServing: 78,
          fatGPerServing: 22,
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

// ── Meal Detail (PRD §10.6) ──

/**
 * PRD §10.6 Meal Detail page payload stub.
 * Real data ships in WS7.
 * Demo branch matches getReviewPlan's demo rows for smoke testing.
 *
 * @param _mealId Meal.id
 * @param overrideContext Optional: when present, signals
 *   hasActivePlanOverride=true for the §2.5 banner.
 */
export function getMealById(
  _mealId: string,
  overrideContext?: { planId: string; planItemId: string },
): ReviewMeal | null {
  // TODO(WS7): Replace with real API call to GET /meals/:id
  if (_mealId === "demo-meal-1") {
    return {
      id: "demo-meal-1",
      title: "Salmon Teriyaki",
      description:
        "Pan-seared salmon glazed with a homemade teriyaki sauce. Quick weeknight dinner.",
      cuisineType: "Japanese",
      difficulty: "easy",
      estimatedTimeMinutes: 30,
      servingsDefault: 4,
      tags: ["seafood", "weeknight", "quick"],
      caloriesPerServing: 540,
      proteinGPerServing: 38,
      carbsGPerServing: 32,
      fatGPerServing: 24,
      dishes: [
        {
          name: "Salmon",
          ingredients: [
            { quantity: 1.5, unit: "lb", name: "salmon fillets, skin on" },
            { quantity: 2, unit: "tbsp", name: "soy sauce" },
            { quantity: 2, unit: "tbsp", name: "mirin" },
            { quantity: 1, unit: "tbsp", name: "brown sugar" },
            { quantity: 1, unit: "tsp", name: "fresh ginger, grated" },
          ],
        },
        {
          name: "Rice",
          ingredients: [
            { quantity: 1, unit: "cup", name: "jasmine rice" },
            { quantity: 2, unit: "cup", name: "water" },
          ],
        },
      ],
      steps: [
        {
          stepNumber: 1,
          text: "Rinse rice and combine with water in a saucepan. Bring to a boil, reduce to low, cover and simmer 18 minutes.",
          estimatedMinutes: 20,
          isTimingSensitive: true,
        },
        {
          stepNumber: 2,
          text: "Whisk soy sauce, mirin, brown sugar, and ginger in a small bowl.",
          estimatedMinutes: 2,
        },
        {
          stepNumber: 3,
          text: "Heat a non-stick pan over medium-high. Cook salmon skin-side down 4 minutes until skin is crisp.",
          estimatedMinutes: 4,
          isTimingSensitive: true,
        },
        {
          stepNumber: 4,
          text: "Flip salmon and pour teriyaki sauce over. Cook 3 more minutes, basting with sauce.",
          estimatedMinutes: 3,
          isTimingSensitive: true,
        },
        {
          stepNumber: 5,
          text: "Plate over rice; spoon any pan sauce over the top.",
          estimatedMinutes: 1,
        },
      ],
      notes: "Doubled the ginger last time — was great.",
      hasActivePlanOverride: !!overrideContext,
      overrideContext,
    };
  }
  if (_mealId === "demo-meal-2") {
    return {
      id: "demo-meal-2",
      title: "Chicken Stir Fry",
      description:
        "Quick pan stir fry with bell peppers and a garlic-soy sauce.",
      cuisineType: "Chinese",
      difficulty: "easy",
      estimatedTimeMinutes: 25,
      servingsDefault: 4,
      tags: ["weeknight", "quick", "chicken"],
      caloriesPerServing: 480,
      proteinGPerServing: 35,
      carbsGPerServing: 38,
      fatGPerServing: 18,
      dishes: [
        {
          name: "Stir Fry",
          ingredients: [
            { quantity: 1.25, unit: "lb", name: "chicken breast, sliced thin" },
            { quantity: 2, unit: "tbsp", name: "soy sauce" },
            { quantity: 1, unit: "tbsp", name: "cornstarch" },
            { quantity: 2, unit: "tbsp", name: "vegetable oil" },
            { quantity: 3, unit: "clove", name: "garlic, minced" },
            { quantity: 2, unit: "whole", name: "bell peppers, sliced" },
          ],
        },
        {
          name: "Rice",
          ingredients: [
            { quantity: 1, unit: "cup", name: "jasmine rice" },
            { quantity: 2, unit: "cup", name: "water" },
          ],
        },
      ],
      steps: [
        {
          stepNumber: 1,
          text: "Toss chicken with 1 tbsp soy sauce + cornstarch. Set aside 10 min.",
          estimatedMinutes: 10,
        },
        {
          stepNumber: 2,
          text: "Cook rice (rinse, combine with water, simmer covered 18 min).",
          estimatedMinutes: 20,
          isTimingSensitive: true,
        },
        {
          stepNumber: 3,
          text: "Heat oil in wok over high heat. Sear chicken 3 min until just cooked through; remove.",
          estimatedMinutes: 3,
          isTimingSensitive: true,
        },
        {
          stepNumber: 4,
          text: "Add garlic and bell peppers. Stir fry 2 minutes.",
          estimatedMinutes: 2,
        },
        {
          stepNumber: 5,
          text: "Return chicken; add remaining 1 tbsp soy sauce. Toss 1 minute.",
          estimatedMinutes: 1,
        },
        {
          stepNumber: 6,
          text: "Serve over rice.",
          estimatedMinutes: 1,
        },
      ],
      hasActivePlanOverride: !!overrideContext,
      overrideContext,
    };
  }
  if (_mealId === "demo-meal-3") {
    return {
      id: "demo-meal-3",
      title: "Pasta Primavera",
      description: "Spring vegetable pasta with garlic, lemon, and parmesan.",
      cuisineType: "Italian",
      difficulty: "medium",
      estimatedTimeMinutes: 40,
      servingsDefault: 4,
      tags: ["vegetarian", "pasta"],
      caloriesPerServing: 620,
      proteinGPerServing: 22,
      carbsGPerServing: 78,
      fatGPerServing: 22,
      dishes: [
        {
          name: "Pasta",
          ingredients: [
            { quantity: 1, unit: "lb", name: "fettuccine" },
            { quantity: 1, unit: "tbsp", name: "salt (for pasta water)" },
          ],
        },
        {
          name: "Sauce",
          ingredients: [
            { quantity: 3, unit: "tbsp", name: "olive oil" },
            { quantity: 4, unit: "clove", name: "garlic, minced" },
            { quantity: 1, unit: "cup", name: "asparagus, cut 1-inch" },
            { quantity: 1, unit: "cup", name: "cherry tomatoes, halved" },
            { quantity: 1, unit: "whole", name: "lemon, zested and juiced" },
            { quantity: 0.5, unit: "cup", name: "parmesan, grated" },
          ],
        },
      ],
      steps: [
        {
          stepNumber: 1,
          text: "Bring a large pot of salted water to a boil.",
          estimatedMinutes: 8,
        },
        {
          stepNumber: 2,
          text: "Cook fettuccine al dente per package; reserve 1 cup pasta water before draining.",
          estimatedMinutes: 12,
          isTimingSensitive: true,
        },
        {
          stepNumber: 3,
          text: "Heat olive oil in a large pan over medium. Add garlic, cook 30 sec.",
          estimatedMinutes: 1,
          isTimingSensitive: true,
        },
        {
          stepNumber: 4,
          text: "Add asparagus; cook 3 min. Add tomatoes; cook 2 min more.",
          estimatedMinutes: 5,
        },
        {
          stepNumber: 5,
          text: "Add drained pasta to the pan with lemon zest, juice, and parmesan. Toss with reserved pasta water until creamy.",
          estimatedMinutes: 2,
        },
        {
          stepNumber: 6,
          text: "Plate; garnish with extra parmesan.",
          estimatedMinutes: 1,
        },
      ],
      hasActivePlanOverride: !!overrideContext,
      overrideContext,
    };
  }
  return null;
}

// ── Saved Dishes (PRD §10.5 Mode C) ──

/**
 * PRD §10.5 Mode C: saved dishes for combine-into-meal flow.
 * Real data ships in WS7.
 */
export function getSavedDishes(): SavedDish[] {
  // TODO(WS7): Replace with real GET /me/dishes call
  return [
    {
      id: "demo-dish-1",
      name: "Jasmine Rice",
      cuisineType: "Asian",
      ingredients: [
        { quantity: 1, unit: "cup", name: "jasmine rice" },
        { quantity: 2, unit: "cup", name: "water" },
        { quantity: 0.5, unit: "tsp", name: "salt" },
      ],
      caloriesPerServing: 220,
      proteinGPerServing: 4,
      carbsGPerServing: 48,
      fatGPerServing: 1,
      useCount: 5,
      createdAt: "2026-01-12T10:00:00.000Z",
      lastCookedAt: "2026-04-29T18:30:00.000Z",
      estimatedTimeMinutes: 20,
    },
    {
      id: "demo-dish-2",
      name: "Roasted Broccoli",
      cuisineType: "American",
      ingredients: [
        { quantity: 1, unit: "lb", name: "broccoli florets" },
        { quantity: 2, unit: "tbsp", name: "olive oil" },
        { quantity: 1, unit: "tsp", name: "salt" },
        { quantity: 0.5, unit: "tsp", name: "black pepper" },
      ],
      caloriesPerServing: 110,
      proteinGPerServing: 4,
      carbsGPerServing: 8,
      fatGPerServing: 7,
      useCount: 3,
      createdAt: "2026-02-04T14:22:00.000Z",
      lastCookedAt: "2026-04-22T19:00:00.000Z",
      estimatedTimeMinutes: 25,
    },
    {
      id: "demo-dish-3",
      name: "Garlic Green Beans",
      cuisineType: "American",
      ingredients: [
        { quantity: 1, unit: "lb", name: "green beans, trimmed" },
        { quantity: 2, unit: "tbsp", name: "olive oil" },
        { quantity: 3, unit: "clove", name: "garlic, minced" },
        { quantity: 0.5, unit: "tsp", name: "salt" },
      ],
      caloriesPerServing: 95,
      proteinGPerServing: 3,
      carbsGPerServing: 12,
      fatGPerServing: 5,
      useCount: 2,
      createdAt: "2026-03-15T11:10:00.000Z",
      lastCookedAt: "2026-04-10T18:45:00.000Z",
      estimatedTimeMinutes: 15,
    },
    {
      id: "demo-dish-4",
      name: "Mashed Potatoes",
      cuisineType: "American",
      ingredients: [
        { quantity: 2, unit: "lb", name: "yukon gold potatoes" },
        { quantity: 0.5, unit: "cup", name: "butter" },
        { quantity: 0.5, unit: "cup", name: "milk" },
        { quantity: 1, unit: "tsp", name: "salt" },
      ],
      caloriesPerServing: 285,
      proteinGPerServing: 5,
      carbsGPerServing: 36,
      fatGPerServing: 14,
      useCount: 4,
      createdAt: "2025-11-20T09:30:00.000Z",
      lastCookedAt: "2026-04-25T19:15:00.000Z",
      estimatedTimeMinutes: 30,
    },
    {
      id: "demo-dish-5",
      name: "Simple Green Salad",
      cuisineType: "American",
      ingredients: [
        { quantity: 8, unit: "cup", name: "mixed greens" },
        { quantity: 0.25, unit: "cup", name: "olive oil" },
        { quantity: 2, unit: "tbsp", name: "lemon juice" },
        { quantity: 0.5, unit: "tsp", name: "salt" },
        { quantity: 0.25, unit: "tsp", name: "black pepper" },
      ],
      caloriesPerServing: 120,
      proteinGPerServing: 1,
      carbsGPerServing: 5,
      fatGPerServing: 12,
      useCount: 6,
      createdAt: "2026-04-01T08:45:00.000Z",
      lastCookedAt: "2026-05-01T18:00:00.000Z",
      estimatedTimeMinutes: 10,
    },
  ];
}

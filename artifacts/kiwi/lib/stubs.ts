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
  DraftMeal,
  GroceryItem,
  MealPlan,
  MealsFilter,
  MealSummary,
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
  if (_mealId === "demo-meal-4") {
    return {
      id: "demo-meal-4",
      title: "Beef Tacos",
      description:
        "Quick weeknight ground beef tacos with crisp lettuce, cheese, and salsa.",
      cuisineType: "Mexican",
      difficulty: "easy",
      estimatedTimeMinutes: 30,
      servingsDefault: 4,
      tags: ["weeknight", "beef", "tacos"],
      caloriesPerServing: 510,
      proteinGPerServing: 32,
      carbsGPerServing: 42,
      fatGPerServing: 24,
      dishes: [
        {
          name: "Seasoned Beef",
          ingredients: [
            { quantity: 1, unit: "lb", name: "ground beef (85/15)" },
            { quantity: 1, unit: "tbsp", name: "olive oil" },
            { quantity: 1, unit: "tsp", name: "chili powder" },
            { quantity: 1, unit: "tsp", name: "cumin" },
            { quantity: 0.5, unit: "tsp", name: "garlic powder" },
            { quantity: 0.5, unit: "tsp", name: "salt" },
          ],
        },
        {
          name: "Toppings",
          ingredients: [
            { quantity: 8, unit: "whole", name: "small flour or corn tortillas" },
            { quantity: 1, unit: "cup", name: "shredded cheddar" },
            { quantity: 2, unit: "cup", name: "shredded lettuce" },
            { quantity: 1, unit: "cup", name: "fresh salsa" },
            { quantity: 1, unit: "whole", name: "lime, cut in wedges" },
          ],
        },
      ],
      steps: [
        {
          stepNumber: 1,
          text: "Heat olive oil in a skillet over medium-high heat.",
          estimatedMinutes: 2,
        },
        {
          stepNumber: 2,
          text: "Add ground beef and cook, breaking up, until browned, about 6-8 minutes.",
          estimatedMinutes: 8,
          isTimingSensitive: true,
        },
        {
          stepNumber: 3,
          text: "Stir in chili powder, cumin, garlic powder, salt. Cook 1 minute more.",
          estimatedMinutes: 1,
        },
        {
          stepNumber: 4,
          text: "Warm tortillas in a dry skillet or microwave.",
          estimatedMinutes: 3,
        },
        {
          stepNumber: 5,
          text: "Assemble tacos with beef, cheese, lettuce, salsa, lime.",
          estimatedMinutes: 5,
        },
      ],
      hasActivePlanOverride: !!overrideContext,
      overrideContext,
    };
  }
  if (_mealId === "demo-meal-5") {
    return {
      id: "demo-meal-5",
      title: "Greek Salad with Grilled Chicken",
      description:
        "Crunchy Mediterranean salad with grilled chicken, feta, olives, and a lemon-oregano dressing.",
      cuisineType: "Mediterranean",
      difficulty: "easy",
      estimatedTimeMinutes: 25,
      servingsDefault: 4,
      tags: ["salad", "weeknight", "high-protein"],
      caloriesPerServing: 420,
      proteinGPerServing: 36,
      carbsGPerServing: 18,
      fatGPerServing: 22,
      dishes: [
        {
          name: "Grilled Chicken",
          ingredients: [
            { quantity: 1.25, unit: "lb", name: "boneless skinless chicken breast" },
            { quantity: 2, unit: "tbsp", name: "olive oil" },
            { quantity: 1, unit: "tsp", name: "dried oregano" },
            { quantity: 0.5, unit: "tsp", name: "salt" },
            { quantity: 0.25, unit: "tsp", name: "black pepper" },
          ],
        },
        {
          name: "Salad",
          ingredients: [
            { quantity: 1, unit: "whole", name: "English cucumber, diced" },
            { quantity: 2, unit: "whole", name: "Roma tomatoes, diced" },
            { quantity: 0.5, unit: "whole", name: "red onion, thinly sliced" },
            { quantity: 0.5, unit: "cup", name: "kalamata olives, pitted" },
            { quantity: 0.75, unit: "cup", name: "feta, crumbled" },
          ],
        },
        {
          name: "Dressing",
          ingredients: [
            { quantity: 3, unit: "tbsp", name: "olive oil" },
            { quantity: 1, unit: "whole", name: "lemon, juiced" },
            { quantity: 1, unit: "tsp", name: "dried oregano" },
            { quantity: 0.25, unit: "tsp", name: "salt" },
          ],
        },
      ],
      steps: [
        {
          stepNumber: 1,
          text: "Toss chicken with olive oil, oregano, salt, and pepper.",
          estimatedMinutes: 3,
        },
        {
          stepNumber: 2,
          text: "Heat a grill pan or skillet over medium-high. Grill chicken 5-6 minutes per side until cooked through.",
          estimatedMinutes: 12,
          isTimingSensitive: true,
        },
        {
          stepNumber: 3,
          text: "While chicken cooks, combine cucumber, tomatoes, onion, olives, and feta in a large bowl.",
          estimatedMinutes: 5,
        },
        {
          stepNumber: 4,
          text: "Whisk dressing ingredients together; toss with salad.",
          estimatedMinutes: 2,
        },
        {
          stepNumber: 5,
          text: "Slice rested chicken and arrange over salad. Serve.",
          estimatedMinutes: 3,
        },
      ],
      hasActivePlanOverride: !!overrideContext,
      overrideContext,
    };
  }
  if (_mealId === "featured-meal-1") {
    return {
      id: "featured-meal-1",
      title: "Mushroom Risotto",
      description:
        "Creamy parmesan risotto with mixed mushrooms, white wine, and fresh thyme.",
      cuisineType: "Italian",
      difficulty: "medium",
      estimatedTimeMinutes: 50,
      servingsDefault: 4,
      tags: ["vegetarian", "italian", "weekend"],
      caloriesPerServing: 580,
      proteinGPerServing: 18,
      carbsGPerServing: 78,
      fatGPerServing: 22,
      dishes: [
        {
          name: "Risotto",
          ingredients: [
            { quantity: 1.5, unit: "cup", name: "arborio rice" },
            { quantity: 6, unit: "cup", name: "warm chicken or vegetable stock" },
            { quantity: 0.5, unit: "cup", name: "dry white wine" },
            { quantity: 1, unit: "whole", name: "shallot, minced" },
            { quantity: 2, unit: "tbsp", name: "butter" },
            { quantity: 0.75, unit: "cup", name: "parmesan, grated" },
          ],
        },
        {
          name: "Mushrooms",
          ingredients: [
            { quantity: 1, unit: "lb", name: "mixed mushrooms (cremini, shiitake), sliced" },
            { quantity: 2, unit: "tbsp", name: "olive oil" },
            { quantity: 2, unit: "clove", name: "garlic, minced" },
            { quantity: 4, unit: "sprig", name: "fresh thyme, leaves picked" },
            { quantity: 0.5, unit: "tsp", name: "salt" },
          ],
        },
      ],
      steps: [
        {
          stepNumber: 1,
          text: "Heat olive oil in a wide skillet over medium-high. Sear mushrooms in a single layer until golden, 6-8 minutes.",
          estimatedMinutes: 8,
          isTimingSensitive: true,
        },
        {
          stepNumber: 2,
          text: "Add garlic, thyme, and salt to mushrooms. Cook 1 minute. Transfer to a plate.",
          estimatedMinutes: 2,
        },
        {
          stepNumber: 3,
          text: "Melt 1 tbsp butter in the pan; sauté shallot 2 minutes. Add rice and toast 1 minute.",
          estimatedMinutes: 4,
        },
        {
          stepNumber: 4,
          text: "Pour in wine; stir until absorbed. Add warm stock one ladle at a time, stirring until each ladle is absorbed before the next, about 18-22 minutes.",
          estimatedMinutes: 22,
          isTimingSensitive: true,
        },
        {
          stepNumber: 5,
          text: "Stir in remaining butter, parmesan, and seared mushrooms. Season to taste and serve.",
          estimatedMinutes: 3,
        },
      ],
      hasActivePlanOverride: !!overrideContext,
      overrideContext,
    };
  }
  if (_mealId === "featured-meal-2") {
    return {
      id: "featured-meal-2",
      title: "Sheet Pan Lemon Herb Chicken",
      description:
        "One-pan roasted chicken thighs with lemon, garlic, and root vegetables.",
      cuisineType: "Mediterranean",
      difficulty: "easy",
      estimatedTimeMinutes: 45,
      servingsDefault: 4,
      tags: ["one-pan", "chicken", "weeknight"],
      caloriesPerServing: 460,
      proteinGPerServing: 42,
      carbsGPerServing: 28,
      fatGPerServing: 22,
      dishes: [
        {
          name: "Chicken & Vegetables",
          ingredients: [
            { quantity: 8, unit: "whole", name: "bone-in skin-on chicken thighs" },
            { quantity: 1, unit: "lb", name: "baby potatoes, halved" },
            { quantity: 2, unit: "whole", name: "carrots, cut into 1-inch pieces" },
            { quantity: 1, unit: "whole", name: "lemon, sliced" },
            { quantity: 4, unit: "clove", name: "garlic, smashed" },
            { quantity: 3, unit: "tbsp", name: "olive oil" },
            { quantity: 1, unit: "tbsp", name: "Italian seasoning" },
            { quantity: 1, unit: "tsp", name: "kosher salt" },
            { quantity: 0.5, unit: "tsp", name: "black pepper" },
          ],
        },
      ],
      steps: [
        {
          stepNumber: 1,
          text: "Preheat oven to 425°F. Line a sheet pan with parchment.",
          estimatedMinutes: 5,
        },
        {
          stepNumber: 2,
          text: "Toss potatoes and carrots with 1 tbsp olive oil, salt, and pepper. Spread on sheet pan.",
          estimatedMinutes: 4,
        },
        {
          stepNumber: 3,
          text: "Pat chicken dry. Rub with remaining olive oil, Italian seasoning, salt, and pepper. Nestle on the pan with lemon slices and garlic.",
          estimatedMinutes: 5,
        },
        {
          stepNumber: 4,
          text: "Roast 30-35 minutes until chicken reaches 175°F at the thigh and skin is crisp.",
          estimatedMinutes: 35,
          isTimingSensitive: true,
        },
        {
          stepNumber: 5,
          text: "Rest 5 minutes; serve directly from the pan.",
          estimatedMinutes: 5,
        },
      ],
      hasActivePlanOverride: !!overrideContext,
      overrideContext,
    };
  }
  if (_mealId === "featured-meal-3") {
    return {
      id: "featured-meal-3",
      title: "Thai Basil Beef",
      description:
        "Quick stir fry of ground beef, garlic, chilies, and fresh Thai basil over jasmine rice.",
      cuisineType: "Thai",
      difficulty: "medium",
      estimatedTimeMinutes: 30,
      servingsDefault: 4,
      tags: ["weeknight", "beef", "stir-fry"],
      caloriesPerServing: 520,
      proteinGPerServing: 36,
      carbsGPerServing: 38,
      fatGPerServing: 24,
      dishes: [
        {
          name: "Beef Stir Fry",
          ingredients: [
            { quantity: 1, unit: "lb", name: "ground beef (or sliced flank)" },
            { quantity: 2, unit: "tbsp", name: "vegetable oil" },
            { quantity: 5, unit: "clove", name: "garlic, minced" },
            { quantity: 2, unit: "whole", name: "Thai chilies, minced (or 1 serrano)" },
            { quantity: 2, unit: "tbsp", name: "oyster sauce" },
            { quantity: 1, unit: "tbsp", name: "fish sauce" },
            { quantity: 1, unit: "tbsp", name: "soy sauce" },
            { quantity: 1, unit: "tsp", name: "sugar" },
            { quantity: 1, unit: "cup", name: "Thai basil leaves, packed" },
          ],
        },
        {
          name: "Rice",
          ingredients: [
            { quantity: 1.5, unit: "cup", name: "jasmine rice" },
            { quantity: 3, unit: "cup", name: "water" },
          ],
        },
      ],
      steps: [
        {
          stepNumber: 1,
          text: "Rinse rice; combine with water in a saucepan. Bring to a boil, reduce to low, cover and simmer 18 minutes.",
          estimatedMinutes: 20,
          isTimingSensitive: true,
        },
        {
          stepNumber: 2,
          text: "Whisk oyster sauce, fish sauce, soy sauce, and sugar in a small bowl.",
          estimatedMinutes: 2,
        },
        {
          stepNumber: 3,
          text: "Heat oil in a wok over high heat. Add garlic and chilies; stir-fry 30 seconds until fragrant.",
          estimatedMinutes: 1,
          isTimingSensitive: true,
        },
        {
          stepNumber: 4,
          text: "Add beef; stir-fry, breaking up, until browned, 4-5 minutes.",
          estimatedMinutes: 5,
          isTimingSensitive: true,
        },
        {
          stepNumber: 5,
          text: "Pour in sauce; toss to coat. Stir in basil; cook just until wilted, about 30 seconds.",
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
  if (_mealId === "top-rated-meal-1") {
    return {
      id: "top-rated-meal-1",
      title: "Classic Lasagna Bolognese",
      description:
        "Slow-simmered Bolognese ragu layered with pasta, béchamel, and parmesan. Family weekend project.",
      cuisineType: "Italian",
      difficulty: "medium",
      estimatedTimeMinutes: 90,
      servingsDefault: 6,
      tags: ["italian", "weekend", "family"],
      caloriesPerServing: 680,
      proteinGPerServing: 38,
      carbsGPerServing: 52,
      fatGPerServing: 32,
      dishes: [
        {
          name: "Bolognese Ragu",
          ingredients: [
            { quantity: 1, unit: "lb", name: "ground beef (80/20)" },
            { quantity: 0.5, unit: "lb", name: "ground pork" },
            { quantity: 1, unit: "whole", name: "yellow onion, finely diced" },
            { quantity: 2, unit: "whole", name: "carrots, finely diced" },
            { quantity: 2, unit: "stalk", name: "celery, finely diced" },
            { quantity: 4, unit: "clove", name: "garlic, minced" },
            { quantity: 1, unit: "can", name: "whole peeled tomatoes (28 oz)" },
            { quantity: 0.5, unit: "cup", name: "whole milk" },
            { quantity: 0.5, unit: "cup", name: "dry red wine" },
            { quantity: 2, unit: "tbsp", name: "olive oil" },
            { quantity: 1, unit: "tsp", name: "salt" },
          ],
        },
        {
          name: "Béchamel",
          ingredients: [
            { quantity: 4, unit: "tbsp", name: "butter" },
            { quantity: 4, unit: "tbsp", name: "flour" },
            { quantity: 3, unit: "cup", name: "warm whole milk" },
            { quantity: 1, unit: "pinch", name: "nutmeg, grated" },
            { quantity: 0.5, unit: "tsp", name: "salt" },
          ],
        },
        {
          name: "Assembly",
          ingredients: [
            { quantity: 1, unit: "lb", name: "lasagna noodles, no-boil" },
            { quantity: 2, unit: "cup", name: "parmesan, grated" },
            { quantity: 1, unit: "cup", name: "mozzarella, shredded" },
          ],
        },
      ],
      steps: [
        {
          stepNumber: 1,
          text: "Heat olive oil in a Dutch oven over medium-high. Sear beef and pork, breaking up, until browned, 8-10 minutes.",
          estimatedMinutes: 10,
          isTimingSensitive: true,
        },
        {
          stepNumber: 2,
          text: "Reduce heat to medium. Add onion, carrot, celery, garlic. Cook 8 minutes until softened.",
          estimatedMinutes: 8,
        },
        {
          stepNumber: 3,
          text: "Pour in wine; simmer 3 minutes. Add milk; simmer 3 minutes. Crush tomatoes by hand into pot. Add salt.",
          estimatedMinutes: 8,
        },
        {
          stepNumber: 4,
          text: "Reduce to low; partially cover and simmer 45 minutes, stirring occasionally, until thickened.",
          estimatedMinutes: 45,
          isTimingSensitive: true,
        },
        {
          stepNumber: 5,
          text: "Make béchamel: melt butter, whisk in flour, cook 1 min. Slowly whisk in warm milk; cook until thickened, 5 minutes. Season with nutmeg and salt.",
          estimatedMinutes: 8,
        },
        {
          stepNumber: 6,
          text: "Preheat oven to 375°F. Layer ragu, noodles, béchamel, and parmesan in a 9×13 dish. Repeat 3-4 layers, top with mozzarella. Bake 35-40 minutes until bubbling and golden. Rest 10 minutes before serving.",
          estimatedMinutes: 50,
          isTimingSensitive: true,
        },
      ],
      hasActivePlanOverride: !!overrideContext,
      overrideContext,
    };
  }
  if (_mealId === "top-rated-meal-2") {
    return {
      id: "top-rated-meal-2",
      title: "Crispy Korean Fried Chicken",
      description:
        "Double-fried chicken pieces tossed in a sweet-spicy gochujang glaze. Crispy with a sticky bite.",
      cuisineType: "Korean",
      difficulty: "medium",
      estimatedTimeMinutes: 60,
      servingsDefault: 4,
      tags: ["korean", "fried", "spicy"],
      caloriesPerServing: 620,
      proteinGPerServing: 42,
      carbsGPerServing: 38,
      fatGPerServing: 28,
      dishes: [
        {
          name: "Fried Chicken",
          ingredients: [
            { quantity: 2, unit: "lb", name: "chicken wings or boneless thighs, cut into 2-inch pieces" },
            { quantity: 1, unit: "tsp", name: "salt" },
            { quantity: 0.5, unit: "tsp", name: "black pepper" },
            { quantity: 1, unit: "cup", name: "potato starch" },
            { quantity: 0.5, unit: "cup", name: "all-purpose flour" },
            { quantity: 1, unit: "quart", name: "neutral oil for frying" },
          ],
        },
        {
          name: "Gochujang Glaze",
          ingredients: [
            { quantity: 3, unit: "tbsp", name: "gochujang (Korean chili paste)" },
            { quantity: 3, unit: "tbsp", name: "soy sauce" },
            { quantity: 3, unit: "tbsp", name: "honey" },
            { quantity: 2, unit: "tbsp", name: "rice vinegar" },
            { quantity: 4, unit: "clove", name: "garlic, grated" },
            { quantity: 1, unit: "tbsp", name: "sesame oil" },
            { quantity: 1, unit: "tbsp", name: "toasted sesame seeds" },
            { quantity: 2, unit: "whole", name: "scallions, thinly sliced" },
          ],
        },
      ],
      steps: [
        {
          stepNumber: 1,
          text: "Pat chicken dry. Season with salt and pepper. Toss with potato starch and flour to coat thoroughly.",
          estimatedMinutes: 10,
        },
        {
          stepNumber: 2,
          text: "Heat oil to 325°F in a deep pot. Fry chicken in batches for 7-8 minutes until pale and cooked through. Drain on a rack. Let oil come back up to temp between batches.",
          estimatedMinutes: 20,
          isTimingSensitive: true,
        },
        {
          stepNumber: 3,
          text: "Increase oil to 375°F. Fry chicken a second time for 3-4 minutes per batch until deep golden and shatter-crisp. Drain on rack.",
          estimatedMinutes: 12,
          isTimingSensitive: true,
        },
        {
          stepNumber: 4,
          text: "Whisk all glaze ingredients in a wide bowl until smooth.",
          estimatedMinutes: 3,
        },
        {
          stepNumber: 5,
          text: "Toss hot chicken in glaze until evenly coated. Top with sesame seeds and scallions. Serve immediately.",
          estimatedMinutes: 3,
        },
      ],
      hasActivePlanOverride: !!overrideContext,
      overrideContext,
    };
  }
  if (_mealId === "top-rated-meal-3") {
    return {
      id: "top-rated-meal-3",
      title: "Smashburger with Special Sauce",
      description:
        "Cast-iron smashburgers with crispy lacy edges, melty cheese, and a tangy special sauce.",
      cuisineType: "American",
      difficulty: "easy",
      estimatedTimeMinutes: 25,
      servingsDefault: 4,
      tags: ["weeknight", "burger", "beef"],
      caloriesPerServing: 720,
      proteinGPerServing: 38,
      carbsGPerServing: 42,
      fatGPerServing: 42,
      dishes: [
        {
          name: "Burgers",
          ingredients: [
            { quantity: 1.25, unit: "lb", name: "ground beef (80/20), divided into 8 loose 2.5 oz balls" },
            { quantity: 1, unit: "tsp", name: "kosher salt" },
            { quantity: 0.5, unit: "tsp", name: "black pepper" },
            { quantity: 8, unit: "slice", name: "American cheese" },
            { quantity: 4, unit: "whole", name: "potato buns" },
            { quantity: 1, unit: "tbsp", name: "butter, softened" },
          ],
        },
        {
          name: "Special Sauce",
          ingredients: [
            { quantity: 0.25, unit: "cup", name: "mayonnaise" },
            { quantity: 2, unit: "tbsp", name: "ketchup" },
            { quantity: 2, unit: "tbsp", name: "dill pickle relish" },
            { quantity: 1, unit: "tsp", name: "yellow mustard" },
            { quantity: 1, unit: "tsp", name: "white vinegar" },
            { quantity: 0.5, unit: "tsp", name: "smoked paprika" },
          ],
        },
        {
          name: "Toppings",
          ingredients: [
            { quantity: 4, unit: "leaf", name: "iceberg lettuce" },
            { quantity: 1, unit: "whole", name: "ripe tomato, sliced" },
            { quantity: 12, unit: "slice", name: "dill pickles" },
          ],
        },
      ],
      steps: [
        {
          stepNumber: 1,
          text: "Whisk all special sauce ingredients in a small bowl. Refrigerate until needed.",
          estimatedMinutes: 3,
        },
        {
          stepNumber: 2,
          text: "Butter cut sides of buns. Toast in a dry cast-iron skillet over medium until golden.",
          estimatedMinutes: 4,
        },
        {
          stepNumber: 3,
          text: "Heat cast iron over high heat until smoking. Place 2 beef balls on the pan; immediately smash flat with a sturdy spatula. Season tops with salt and pepper.",
          estimatedMinutes: 2,
          isTimingSensitive: true,
        },
        {
          stepNumber: 4,
          text: "Sear 90 seconds for a deep crust. Flip; top each patty with a slice of cheese. Cook 30 seconds more until cheese melts.",
          estimatedMinutes: 3,
          isTimingSensitive: true,
        },
        {
          stepNumber: 5,
          text: "Repeat with remaining patties.",
          estimatedMinutes: 6,
        },
        {
          stepNumber: 6,
          text: "Build burgers: bottom bun, sauce, lettuce, tomato, two stacked patties, pickles, top bun.",
          estimatedMinutes: 4,
        },
      ],
      hasActivePlanOverride: !!overrideContext,
      overrideContext,
    };
  }
  if (_mealId === "hosting-meal-1") {
    return {
      id: "hosting-meal-1",
      title: "Roast Turkey with All the Fixings",
      description:
        "Herb-butter roasted whole turkey with classic gravy, mashed potatoes, and stuffing for a holiday spread.",
      cuisineType: "American",
      difficulty: "hard",
      estimatedTimeMinutes: 240,
      servingsDefault: 8,
      tags: ["holiday", "hosting", "turkey"],
      caloriesPerServing: 740,
      proteinGPerServing: 58,
      carbsGPerServing: 48,
      fatGPerServing: 36,
      dishes: [
        {
          name: "Roast Turkey",
          ingredients: [
            { quantity: 1, unit: "whole", name: "turkey (12-14 lb), thawed and patted dry" },
            { quantity: 8, unit: "tbsp", name: "butter, softened" },
            { quantity: 4, unit: "sprig", name: "fresh thyme, leaves picked" },
            { quantity: 4, unit: "sprig", name: "fresh sage, chopped" },
            { quantity: 4, unit: "clove", name: "garlic, grated" },
            { quantity: 1, unit: "tbsp", name: "kosher salt" },
            { quantity: 1, unit: "tsp", name: "black pepper" },
            { quantity: 1, unit: "whole", name: "lemon, halved" },
            { quantity: 1, unit: "whole", name: "yellow onion, quartered" },
          ],
        },
        {
          name: "Pan Gravy",
          ingredients: [
            { quantity: 3, unit: "tbsp", name: "all-purpose flour" },
            { quantity: 3, unit: "cup", name: "turkey or chicken stock, warm" },
            { quantity: 1, unit: "tbsp", name: "Worcestershire sauce" },
            { quantity: 0.5, unit: "tsp", name: "salt" },
          ],
        },
        {
          name: "Sides",
          ingredients: [
            { quantity: 3, unit: "lb", name: "Yukon Gold potatoes, peeled and cubed" },
            { quantity: 0.5, unit: "cup", name: "butter" },
            { quantity: 1, unit: "cup", name: "warm whole milk" },
            { quantity: 1, unit: "loaf", name: "day-old crusty bread, cubed (for stuffing)" },
            { quantity: 2, unit: "cup", name: "stock (for stuffing)" },
            { quantity: 2, unit: "stalk", name: "celery, diced" },
          ],
        },
      ],
      steps: [
        {
          stepNumber: 1,
          text: "Preheat oven to 425°F. Combine softened butter with thyme, sage, garlic, salt, and pepper.",
          estimatedMinutes: 10,
        },
        {
          stepNumber: 2,
          text: "Loosen turkey skin and rub herb butter under and over the skin. Stuff cavity with lemon and onion. Place breast-side up on a rack in a roasting pan.",
          estimatedMinutes: 15,
        },
        {
          stepNumber: 3,
          text: "Roast 30 minutes at 425°F. Reduce to 325°F and continue roasting until thigh registers 165°F, about 2.5 hours total. Tent with foil if browning too fast.",
          estimatedMinutes: 165,
          isTimingSensitive: true,
        },
        {
          stepNumber: 4,
          text: "Meanwhile, boil potatoes until fork tender, 18-20 minutes. Drain, mash with butter and warm milk; season.",
          estimatedMinutes: 25,
        },
        {
          stepNumber: 5,
          text: "Toss bread cubes with sautéed celery, herbs, and stock. Bake at 350°F for 35 minutes until crisp on top.",
          estimatedMinutes: 40,
        },
        {
          stepNumber: 6,
          text: "Rest turkey 30 minutes. Pour pan drippings into a saucepan, whisk in flour, then warm stock and Worcestershire. Simmer until thickened. Carve and serve with gravy and sides.",
          estimatedMinutes: 35,
          isTimingSensitive: true,
        },
      ],
      hasActivePlanOverride: !!overrideContext,
      overrideContext,
    };
  }
  if (_mealId === "hosting-meal-2") {
    return {
      id: "hosting-meal-2",
      title: "Beef Tenderloin with Red Wine Reduction",
      description:
        "Whole roasted beef tenderloin with a glossy red wine pan sauce. Restaurant-grade centerpiece.",
      cuisineType: "French",
      difficulty: "hard",
      estimatedTimeMinutes: 90,
      servingsDefault: 6,
      tags: ["hosting", "beef", "celebration"],
      caloriesPerServing: 620,
      proteinGPerServing: 48,
      carbsGPerServing: 12,
      fatGPerServing: 38,
      dishes: [
        {
          name: "Tenderloin",
          ingredients: [
            { quantity: 3, unit: "lb", name: "center-cut beef tenderloin, trimmed and tied" },
            { quantity: 2, unit: "tbsp", name: "olive oil" },
            { quantity: 2, unit: "tsp", name: "kosher salt" },
            { quantity: 1, unit: "tsp", name: "cracked black pepper" },
            { quantity: 4, unit: "sprig", name: "fresh thyme" },
            { quantity: 3, unit: "tbsp", name: "butter" },
          ],
        },
        {
          name: "Red Wine Reduction",
          ingredients: [
            { quantity: 2, unit: "whole", name: "shallots, finely minced" },
            { quantity: 2, unit: "clove", name: "garlic, minced" },
            { quantity: 1.5, unit: "cup", name: "dry red wine (Cabernet or Bordeaux)" },
            { quantity: 1.5, unit: "cup", name: "beef stock" },
            { quantity: 1, unit: "tbsp", name: "tomato paste" },
            { quantity: 2, unit: "tbsp", name: "cold butter, cubed" },
            { quantity: 0.5, unit: "tsp", name: "salt" },
          ],
        },
      ],
      steps: [
        {
          stepNumber: 1,
          text: "Take tenderloin out of fridge 45 minutes before cooking. Pat dry; rub with olive oil, salt, and pepper. Preheat oven to 425°F.",
          estimatedMinutes: 50,
        },
        {
          stepNumber: 2,
          text: "Heat a large oven-safe skillet over high heat. Sear tenderloin on all sides until deeply browned, 8-10 minutes total.",
          estimatedMinutes: 10,
          isTimingSensitive: true,
        },
        {
          stepNumber: 3,
          text: "Add butter and thyme to the pan; baste tenderloin. Transfer pan to oven; roast until internal temp reaches 125°F for medium-rare, 18-22 minutes.",
          estimatedMinutes: 22,
          isTimingSensitive: true,
        },
        {
          stepNumber: 4,
          text: "Transfer tenderloin to a board; tent loosely with foil. Pour off all but 1 tbsp fat from skillet.",
          estimatedMinutes: 2,
        },
        {
          stepNumber: 5,
          text: "Sauté shallots and garlic in skillet 2 minutes. Stir in tomato paste; cook 1 minute. Pour in wine; reduce by half over high heat. Add stock; reduce until syrupy, about 8 minutes.",
          estimatedMinutes: 12,
          isTimingSensitive: true,
        },
        {
          stepNumber: 6,
          text: "Off heat, swirl in cold butter cubes one at a time until glossy. Season. Slice rested tenderloin and spoon sauce over.",
          estimatedMinutes: 5,
        },
      ],
      hasActivePlanOverride: !!overrideContext,
      overrideContext,
    };
  }
  if (_mealId === "hosting-meal-3") {
    return {
      id: "hosting-meal-3",
      title: "Cinco de Mayo Carnitas Spread",
      description:
        "Slow-braised pork carnitas with warm tortillas, salsa verde, pickled onions, and toppings bar.",
      cuisineType: "Mexican",
      difficulty: "medium",
      estimatedTimeMinutes: 180,
      servingsDefault: 8,
      tags: ["hosting", "mexican", "celebration"],
      caloriesPerServing: 580,
      proteinGPerServing: 38,
      carbsGPerServing: 42,
      fatGPerServing: 26,
      dishes: [
        {
          name: "Carnitas",
          ingredients: [
            { quantity: 4, unit: "lb", name: "pork shoulder, cut into 3-inch chunks" },
            { quantity: 2, unit: "tbsp", name: "kosher salt" },
            { quantity: 1, unit: "tbsp", name: "cumin" },
            { quantity: 1, unit: "tbsp", name: "oregano" },
            { quantity: 1, unit: "whole", name: "yellow onion, halved" },
            { quantity: 6, unit: "clove", name: "garlic, smashed" },
            { quantity: 2, unit: "whole", name: "oranges, halved" },
            { quantity: 2, unit: "whole", name: "bay leaves" },
            { quantity: 1, unit: "cup", name: "lard or neutral oil" },
          ],
        },
        {
          name: "Salsa Verde",
          ingredients: [
            { quantity: 1, unit: "lb", name: "tomatillos, husked" },
            { quantity: 2, unit: "whole", name: "jalapeños, stemmed" },
            { quantity: 0.5, unit: "whole", name: "white onion" },
            { quantity: 2, unit: "clove", name: "garlic" },
            { quantity: 0.5, unit: "cup", name: "cilantro" },
            { quantity: 1, unit: "whole", name: "lime, juiced" },
            { quantity: 0.5, unit: "tsp", name: "salt" },
          ],
        },
        {
          name: "Spread",
          ingredients: [
            { quantity: 24, unit: "whole", name: "small corn tortillas, warmed" },
            { quantity: 1, unit: "whole", name: "red onion, thinly sliced and pickled" },
            { quantity: 1, unit: "bunch", name: "cilantro, leaves picked" },
            { quantity: 4, unit: "whole", name: "limes, cut in wedges" },
            { quantity: 1, unit: "cup", name: "queso fresco, crumbled" },
          ],
        },
      ],
      steps: [
        {
          stepNumber: 1,
          text: "Preheat oven to 300°F. Toss pork with salt, cumin, and oregano in a Dutch oven.",
          estimatedMinutes: 8,
        },
        {
          stepNumber: 2,
          text: "Tuck in onion, garlic, oranges (juice squeezed in), bay leaves. Pour lard over. Cover and braise 2.5 hours until pork is fork-tender.",
          estimatedMinutes: 150,
          isTimingSensitive: true,
        },
        {
          stepNumber: 3,
          text: "Char tomatillos, jalapeños, onion, and garlic under the broiler 5-6 minutes. Blend with cilantro, lime juice, and salt.",
          estimatedMinutes: 10,
          isTimingSensitive: true,
        },
        {
          stepNumber: 4,
          text: "Lift pork from braise; shred with two forks, discarding bones and aromatics.",
          estimatedMinutes: 10,
        },
        {
          stepNumber: 5,
          text: "Spread shredded pork on a sheet pan; spoon some braising fat over. Broil 4-5 minutes until edges crisp.",
          estimatedMinutes: 6,
          isTimingSensitive: true,
        },
        {
          stepNumber: 6,
          text: "Arrange carnitas, warm tortillas, salsa verde, pickled onions, cilantro, lime, and queso fresco on a platter for guests to build their own tacos.",
          estimatedMinutes: 8,
        },
      ],
      hasActivePlanOverride: !!overrideContext,
      overrideContext,
    };
  }
  if (_mealId === "featured-meal-4") {
    return {
      id: "featured-meal-4",
      title: "Roasted Vegetable Buddha Bowl",
      description:
        "Hearty bowl of roasted sweet potato, chickpeas, and broccoli over quinoa with a tahini-lemon drizzle.",
      cuisineType: "American",
      difficulty: "easy",
      estimatedTimeMinutes: 40,
      servingsDefault: 4,
      tags: ["vegetarian", "vegan", "meal-prep"],
      caloriesPerServing: 480,
      proteinGPerServing: 18,
      carbsGPerServing: 62,
      fatGPerServing: 18,
      dishes: [
        {
          name: "Roasted Vegetables",
          ingredients: [
            { quantity: 1, unit: "lb", name: "sweet potato, cut into 1-inch cubes" },
            { quantity: 1, unit: "head", name: "broccoli, cut into florets" },
            { quantity: 1, unit: "can", name: "chickpeas (15 oz), drained and rinsed" },
            { quantity: 3, unit: "tbsp", name: "olive oil" },
            { quantity: 1, unit: "tsp", name: "smoked paprika" },
            { quantity: 1, unit: "tsp", name: "cumin" },
            { quantity: 0.75, unit: "tsp", name: "salt" },
          ],
        },
        {
          name: "Quinoa",
          ingredients: [
            { quantity: 1, unit: "cup", name: "quinoa, rinsed" },
            { quantity: 2, unit: "cup", name: "water" },
            { quantity: 0.25, unit: "tsp", name: "salt" },
          ],
        },
        {
          name: "Tahini Drizzle",
          ingredients: [
            { quantity: 0.25, unit: "cup", name: "tahini" },
            { quantity: 1, unit: "whole", name: "lemon, juiced" },
            { quantity: 1, unit: "clove", name: "garlic, grated" },
            { quantity: 3, unit: "tbsp", name: "warm water" },
            { quantity: 0.25, unit: "tsp", name: "salt" },
          ],
        },
      ],
      steps: [
        {
          stepNumber: 1,
          text: "Preheat oven to 425°F.",
          estimatedMinutes: 5,
        },
        {
          stepNumber: 2,
          text: "Toss sweet potato, broccoli, and chickpeas with olive oil, paprika, cumin, and salt. Spread on a sheet pan.",
          estimatedMinutes: 5,
        },
        {
          stepNumber: 3,
          text: "Roast 25-30 minutes, stirring once, until vegetables are tender and chickpeas are crisp.",
          estimatedMinutes: 30,
          isTimingSensitive: true,
        },
        {
          stepNumber: 4,
          text: "Meanwhile, combine quinoa, water, and salt in a saucepan. Bring to a boil, reduce to low, cover and cook 15 minutes. Fluff with a fork.",
          estimatedMinutes: 15,
        },
        {
          stepNumber: 5,
          text: "Whisk tahini, lemon juice, garlic, water, and salt until smooth. Adjust with more water for drizzling consistency.",
          estimatedMinutes: 3,
        },
        {
          stepNumber: 6,
          text: "Divide quinoa into bowls; top with roasted vegetables and chickpeas. Drizzle with tahini sauce.",
          estimatedMinutes: 3,
        },
      ],
      hasActivePlanOverride: !!overrideContext,
      overrideContext,
    };
  }
  return null;
}

// ── Import URL parse stub (PRD §10.3) ──

/**
 * PRD §10.3 — stubbed URL parse result for WS5 smoke testing.
 * Real fetch + AI parse lands in WS6 (AI orchestration).
 * Returns a hardcoded demo recipe so the Import URL → review-and-
 * edit flow is smoke-testable end-to-end.
 *
 * @param url The URL the user pasted (used for sourceUrl in
 *   the result; not actually fetched).
 */
export function getDraftMealForUrl(url: string): DraftMeal {
  // TODO(WS6): Replace with real fetch + AI parse pipeline
  return {
    title: "Lemon Garlic Roast Chicken",
    description:
      "One-pan whole roast chicken with crispy skin, fresh herbs, and bright lemon. Imported from URL.",
    cuisineType: "Mediterranean",
    difficulty: "medium",
    estimatedTimeMinutes: 75,
    servingsDefault: 4,
    tags: ["chicken", "one-pan", "weekend"],
    caloriesPerServing: 580,
    proteinGPerServing: 48,
    carbsGPerServing: 12,
    fatGPerServing: 38,
    dishes: [
      {
        name: "Roast Chicken",
        ingredients: [
          { quantity: 1, unit: "whole", name: "whole chicken (3-4 lb)" },
          { quantity: 2, unit: "tbsp", name: "olive oil" },
          { quantity: 1, unit: "whole", name: "lemon, halved" },
          { quantity: 6, unit: "clove", name: "garlic, smashed" },
          { quantity: 4, unit: "sprig", name: "fresh thyme" },
          { quantity: 4, unit: "sprig", name: "fresh rosemary" },
          { quantity: 1, unit: "tsp", name: "kosher salt" },
          { quantity: 0.5, unit: "tsp", name: "black pepper" },
        ],
      },
      {
        name: "Pan Vegetables",
        ingredients: [
          { quantity: 1, unit: "lb", name: "baby potatoes, halved" },
          { quantity: 2, unit: "whole", name: "carrots, cut into 2-inch pieces" },
          { quantity: 1, unit: "whole", name: "yellow onion, quartered" },
          { quantity: 2, unit: "tbsp", name: "olive oil" },
        ],
      },
    ],
    steps: [
      {
        stepNumber: 1,
        text: "Preheat oven to 425°F. Pat chicken dry with paper towels.",
        estimatedMinutes: 5,
      },
      {
        stepNumber: 2,
        text: "Rub chicken with olive oil, salt, and pepper. Stuff cavity with lemon halves, garlic, and herbs.",
        estimatedMinutes: 8,
      },
      {
        stepNumber: 3,
        text: "Toss potatoes, carrots, and onion with olive oil and a pinch of salt in a roasting pan.",
        estimatedMinutes: 5,
      },
      {
        stepNumber: 4,
        text: "Place chicken breast-side up on the vegetables.",
        estimatedMinutes: 1,
      },
      {
        stepNumber: 5,
        text: "Roast 60-65 minutes until thigh registers 165°F. Rest 10 minutes before carving.",
        estimatedMinutes: 65,
        isTimingSensitive: true,
      },
      {
        stepNumber: 6,
        text: "Carve and serve with pan vegetables.",
        estimatedMinutes: 5,
      },
    ],
    sourceUrl: url,
  };
}

// ── Import Image parse stub (PRD §10.4) ──

/**
 * PRD §10.4 — stubbed image parse result for WS5 smoke testing.
 * Real OCR + AI vision parse lands in WS6 (AI orchestration).
 * Returns a different demo recipe than getDraftMealForUrl so
 * smoke tests can distinguish the two paths.
 *
 * @param _imageUri Local URI of the picked image (not actually
 *   processed at the stub stage).
 */
export function getDraftMealForImage(_imageUri: string): DraftMeal {
  // TODO(WS6): Replace with real OCR + AI vision parse pipeline
  return {
    title: "BBQ Pulled Pork",
    description:
      "Slow-cooked pork shoulder with a smoky-sweet BBQ rub, shredded and tossed in tangy vinegar BBQ sauce. Imported from photo.",
    cuisineType: "American",
    difficulty: "medium",
    estimatedTimeMinutes: 480, // 8 hours including slow cook
    servingsDefault: 8,
    tags: ["pork", "bbq", "weekend", "slow-cook"],
    caloriesPerServing: 520,
    proteinGPerServing: 42,
    carbsGPerServing: 18,
    fatGPerServing: 28,
    dishes: [
      {
        name: "Pulled Pork",
        ingredients: [
          { quantity: 4, unit: "lb", name: "pork shoulder, bone-in" },
          { quantity: 2, unit: "tbsp", name: "brown sugar" },
          { quantity: 1, unit: "tbsp", name: "smoked paprika" },
          { quantity: 1, unit: "tbsp", name: "kosher salt" },
          { quantity: 2, unit: "tsp", name: "black pepper" },
          { quantity: 2, unit: "tsp", name: "garlic powder" },
          { quantity: 2, unit: "tsp", name: "onion powder" },
          { quantity: 1, unit: "tsp", name: "cayenne" },
        ],
      },
      {
        name: "Vinegar BBQ Sauce",
        ingredients: [
          { quantity: 1, unit: "cup", name: "apple cider vinegar" },
          { quantity: 0.5, unit: "cup", name: "ketchup" },
          { quantity: 0.25, unit: "cup", name: "brown sugar" },
          { quantity: 1, unit: "tbsp", name: "Worcestershire sauce" },
          { quantity: 1, unit: "tsp", name: "red pepper flakes" },
          { quantity: 0.5, unit: "tsp", name: "salt" },
        ],
      },
      {
        name: "Slaw",
        ingredients: [
          { quantity: 1, unit: "whole", name: "green cabbage, shredded" },
          { quantity: 0.5, unit: "cup", name: "mayonnaise" },
          { quantity: 2, unit: "tbsp", name: "apple cider vinegar" },
          { quantity: 1, unit: "tbsp", name: "sugar" },
          { quantity: 0.5, unit: "tsp", name: "salt" },
        ],
      },
    ],
    steps: [
      {
        stepNumber: 1,
        text: "Combine brown sugar, paprika, salt, pepper, garlic powder, onion powder, and cayenne. Rub all over pork shoulder. Refrigerate at least 4 hours, ideally overnight.",
        estimatedMinutes: 10,
      },
      {
        stepNumber: 2,
        text: "Preheat oven to 275°F. Place pork on a rack in a roasting pan, fat side up.",
        estimatedMinutes: 10,
      },
      {
        stepNumber: 3,
        text: "Roast 6-8 hours until internal temp reaches 200°F and meat is fork-tender.",
        estimatedMinutes: 420,
        isTimingSensitive: true,
      },
      {
        stepNumber: 4,
        text: "While pork rests, whisk together vinegar BBQ sauce ingredients in a saucepan. Simmer 5 minutes.",
        estimatedMinutes: 10,
      },
      {
        stepNumber: 5,
        text: "Combine cabbage, mayo, vinegar, sugar, and salt in a bowl. Toss and refrigerate.",
        estimatedMinutes: 10,
      },
      {
        stepNumber: 6,
        text: "Shred pork with two forks, discarding fat and bone. Toss with sauce.",
        estimatedMinutes: 15,
      },
      {
        stepNumber: 7,
        text: "Pile shredded pork on buns, top with slaw, and serve.",
        estimatedMinutes: 5,
      },
    ],
    // No sourceUrl since this came from an image
  };
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

// ── Saved Meals (PRD §8.4.2 / §8.3.8) ──

export function getSavedMeals(): MealSummary[] {
  return [
    {
      id: "demo-meal-1",
      title: "Salmon Teriyaki",
      cuisineType: "Japanese",
      difficulty: "easy",
      estimatedTimeMinutes: 30,
      servingsDefault: 4,
      caloriesPerServing: 540,
      proteinGPerServing: 38,
      carbsGPerServing: 32,
      fatGPerServing: 24,
      source: "saved",
      timesCooked: 6,
      lastCookedAt: "2026-04-12T18:00:00.000Z",
      createdAt: "2025-11-08T10:00:00.000Z",
    },
    {
      id: "demo-meal-2",
      title: "Chicken Stir Fry",
      cuisineType: "Chinese",
      difficulty: "easy",
      estimatedTimeMinutes: 25,
      servingsDefault: 4,
      caloriesPerServing: 480,
      proteinGPerServing: 35,
      carbsGPerServing: 38,
      fatGPerServing: 18,
      source: "saved",
      timesCooked: 9,
      lastCookedAt: "2026-04-22T18:30:00.000Z",
      createdAt: "2025-09-14T10:00:00.000Z",
    },
    {
      id: "demo-meal-3",
      title: "Pasta Primavera",
      cuisineType: "Italian",
      difficulty: "medium",
      estimatedTimeMinutes: 40,
      servingsDefault: 4,
      caloriesPerServing: 620,
      proteinGPerServing: 22,
      carbsGPerServing: 78,
      fatGPerServing: 22,
      source: "saved",
      timesCooked: 3,
      lastCookedAt: "2026-03-30T18:30:00.000Z",
      createdAt: "2025-12-01T10:00:00.000Z",
    },
    {
      id: "demo-meal-4",
      title: "Beef Tacos",
      cuisineType: "Mexican",
      difficulty: "easy",
      estimatedTimeMinutes: 30,
      servingsDefault: 4,
      caloriesPerServing: 510,
      proteinGPerServing: 32,
      carbsGPerServing: 42,
      fatGPerServing: 24,
      source: "saved",
      timesCooked: 12,
      lastCookedAt: "2026-04-25T19:00:00.000Z",
      createdAt: "2025-08-20T10:00:00.000Z",
    },
    {
      id: "demo-meal-5",
      title: "Greek Salad with Grilled Chicken",
      cuisineType: "Mediterranean",
      difficulty: "easy",
      estimatedTimeMinutes: 25,
      servingsDefault: 4,
      caloriesPerServing: 420,
      proteinGPerServing: 36,
      carbsGPerServing: 18,
      fatGPerServing: 22,
      source: "saved",
      timesCooked: 4,
      lastCookedAt: "2026-04-08T18:00:00.000Z",
      createdAt: "2026-01-15T10:00:00.000Z",
    },
  ];
}

// ── Featured Meals (curated catalog — PRD §8.4.2) ──

export function getFeaturedMeals(): MealSummary[] {
  return [
    {
      id: "featured-meal-1",
      title: "Mushroom Risotto",
      cuisineType: "Italian",
      difficulty: "medium",
      estimatedTimeMinutes: 50,
      servingsDefault: 4,
      caloriesPerServing: 580,
      proteinGPerServing: 18,
      carbsGPerServing: 78,
      fatGPerServing: 22,
      source: "featured",
    },
    {
      id: "featured-meal-2",
      title: "Sheet Pan Lemon Herb Chicken",
      cuisineType: "Mediterranean",
      difficulty: "easy",
      estimatedTimeMinutes: 45,
      servingsDefault: 4,
      caloriesPerServing: 460,
      proteinGPerServing: 42,
      carbsGPerServing: 28,
      fatGPerServing: 22,
      source: "featured",
    },
    {
      id: "featured-meal-3",
      title: "Thai Basil Beef",
      cuisineType: "Thai",
      difficulty: "medium",
      estimatedTimeMinutes: 30,
      servingsDefault: 4,
      caloriesPerServing: 520,
      proteinGPerServing: 36,
      carbsGPerServing: 38,
      fatGPerServing: 24,
      source: "featured",
    },
    {
      id: "featured-meal-4",
      title: "Roasted Vegetable Buddha Bowl",
      cuisineType: "American",
      difficulty: "easy",
      estimatedTimeMinutes: 40,
      servingsDefault: 4,
      caloriesPerServing: 480,
      proteinGPerServing: 18,
      carbsGPerServing: 62,
      fatGPerServing: 18,
      source: "featured",
    },
  ];
}

// ── Top Rated Meals (PRD §4.2.5 + §15.6.4) ──

export function getTopRatedMeals(): MealSummary[] {
  return [
    {
      id: "top-rated-meal-1",
      title: "Classic Lasagna Bolognese",
      cuisineType: "Italian",
      difficulty: "medium",
      estimatedTimeMinutes: 90,
      servingsDefault: 6,
      caloriesPerServing: 680,
      proteinGPerServing: 38,
      carbsGPerServing: 52,
      fatGPerServing: 32,
      source: "top_rated",
    },
    {
      id: "top-rated-meal-2",
      title: "Crispy Korean Fried Chicken",
      cuisineType: "Korean",
      difficulty: "medium",
      estimatedTimeMinutes: 60,
      servingsDefault: 4,
      caloriesPerServing: 620,
      proteinGPerServing: 42,
      carbsGPerServing: 38,
      fatGPerServing: 28,
      source: "top_rated",
    },
    {
      id: "top-rated-meal-3",
      title: "Smashburger with Special Sauce",
      cuisineType: "American",
      difficulty: "easy",
      estimatedTimeMinutes: 25,
      servingsDefault: 4,
      caloriesPerServing: 720,
      proteinGPerServing: 38,
      carbsGPerServing: 42,
      fatGPerServing: 42,
      source: "top_rated",
    },
  ];
}

// ── Hosting & Events Meals (PRD §15.6.2) ──

export function getHostingMeals(): MealSummary[] {
  return [
    {
      id: "hosting-meal-1",
      title: "Roast Turkey with All the Fixings",
      cuisineType: "American",
      difficulty: "hard",
      estimatedTimeMinutes: 240,
      servingsDefault: 8,
      caloriesPerServing: 740,
      proteinGPerServing: 58,
      carbsGPerServing: 48,
      fatGPerServing: 36,
      source: "hosting",
    },
    {
      id: "hosting-meal-2",
      title: "Beef Tenderloin with Red Wine Reduction",
      cuisineType: "French",
      difficulty: "hard",
      estimatedTimeMinutes: 90,
      servingsDefault: 6,
      caloriesPerServing: 620,
      proteinGPerServing: 48,
      carbsGPerServing: 12,
      fatGPerServing: 38,
      source: "hosting",
    },
    {
      id: "hosting-meal-3",
      title: "Cinco de Mayo Carnitas Spread",
      cuisineType: "Mexican",
      difficulty: "medium",
      estimatedTimeMinutes: 180,
      servingsDefault: 8,
      caloriesPerServing: 580,
      proteinGPerServing: 38,
      carbsGPerServing: 42,
      fatGPerServing: 26,
      source: "hosting",
    },
  ];
}

// ── Find Similar (PRD §8.4.x WS5 amendment) ──

/**
 * Returns meals matching the source meal's cuisine, drawn from
 * all four catalogs (saved / featured / top rated / hosting).
 * Excludes the source meal itself.
 *
 * MVP: cuisine match only (deterministic, no AI). AI-driven semantic
 * similarity is logged for WS6+ (D-WS5-XXX in handoff).
 *
 * @param sourceMealId The meal being matched against.
 * @returns MealSummary[] with cuisine matching the source. Empty
 *   array if source not found or no matches.
 */
export function findSimilarMealsByCuisine(
  sourceMealId: string,
): MealSummary[] {
  const sourceMeal = getMealById(sourceMealId);
  if (!sourceMeal || !sourceMeal.cuisineType) {
    return [];
  }
  const targetCuisine = sourceMeal.cuisineType;

  const allMeals: MealSummary[] = [
    ...getSavedMeals(),
    ...getFeaturedMeals(),
    ...getTopRatedMeals(),
    ...getHostingMeals(),
  ];

  return allMeals.filter(
    (m) => m.cuisineType === targetCuisine && m.id !== sourceMealId,
  );
}

// PREP-2 item 1 — the Hub fixtures. A NON-Thanksgiving week rendered by the
// pre-PREP-2 Hub is pinned in prep2HubNonFeast.pre.json; PrepCookHubView.test.ts
// renders the same model with today's component and requires the same tree.
//
// Regenerate the pin ONLY from the pre-PREP-2 component (git show 5c2233b):
//   node --experimental-strip-types --no-warnings --import ./lib/api/__tests__/_setup.mjs \
//     components/__tests__/fixtures/genPrep2Hub.ts

import type { PlanDetail, PlanDetailItem } from "@/lib/api/plans";
import type { MealDetail } from "@/lib/api/meals";

function meal(id: string, title: string, minutes: number, overrides: Partial<MealDetail> = {}): MealDetail {
  return {
    id,
    title,
    cuisine: "",
    minutes,
    servings: 4,
    authoredServingsDefault: 4,
    calories: 500,
    protein: 40,
    carbs: 30,
    fat: 18,
    tags: [],
    image: null,
    description: null,
    difficulty: "medium",
    mealType: "dinner",
    sourceType: "user",
    isPublic: false,
    userId: "u1",
    dishes: [],
    steps: [],
    notes: null,
    effectiveServings: 4,
    ...overrides,
  } as MealDetail;
}

function item(id: string, day: string, m: MealDetail, isPrepped: boolean, servingsOverride: number | null = null): PlanDetailItem {
  return {
    id,
    mealId: m.id,
    positionIndex: 0,
    assignedDayOfWeek: day,
    assignedDate: null,
    servingsOverride,
    isBreakfast: false,
    isLunch: false,
    isDinner: true,
    notes: null,
    isPrepped,
    meal: m,
  } as PlanDetailItem;
}

/** An ordinary week: today's meal, a prepped meal, a partial rollup, a thumbnail. */
export function nonFeastPlan(): PlanDetail {
  return {
    id: "plan-ord",
    name: "Cozy Week",
    status: "this_week",
    startDate: "2026-11-02T00:00:00.000Z",
    endDate: "2026-11-08T00:00:00.000Z",
    revisionId: 3,
    isActiveThisWeek: true,
    userId: "u1",
    sourceType: "user",
    image: null,
    prepStatus: "partial",
    prepStatusIsManual: false,
    optimizationNotes: [],
    breakfastOverrides: "",
    lunchOverrides: "",
    items: [
      item("i-mon", "Monday", meal("m-mon", "Lemon Chicken", 30, { image: "https://example.test/a.jpg" }), true),
      item("i-tue", "Tuesday", meal("m-tue", "Beef Tacos", 25), false, 6),
      item("i-wed", "Wednesday", meal("m-wed", "Mushroom Risotto", 45), false),
    ],
    macroDailyAverage: { caloriesPerDay: null, proteinGPerDay: null, carbsGPerDay: null, fatGPerDay: null },
  } as PlanDetail;
}

export const NON_FEAST_TODAY = "Tuesday";
export const NON_FEAST_TAGS = ["comfort", "quick"];

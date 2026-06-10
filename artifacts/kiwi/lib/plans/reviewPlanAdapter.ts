// WS7-3 C4 c1 — adapter from the GET /plans/:id server payload (PlanDetail)
// to the screen's local-state shape (ReviewPlan). Translates renamed-flat
// meal fields back to the screen's *PerServing / imageUrl / cuisineType
// conventions, splits items into the scheduled / unscheduled clusters using
// toDayOfWeek narrowing, drops archived items (meal === null), and applies
// the C4 commissioning safe defaults for the schema-blocked sub-sections
// (PRD §8.3.3 prep status, §8.3.4 optimization notes) and the WS7-4 deferral
// (§8.3.7 breakfast/lunch persistence).

import type { PlanDetail, PlanDetailItem } from "@/lib/api/plans";
import type { MealDetail } from "@/lib/api/meals";
import { buildDayStrip } from "@/lib/domain";
import type { ReviewPlan, ReviewPlanMealRow } from "@/lib/types";

import { toDayOfWeek } from "./dayOfWeek";

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function planDetailToReviewPlan(detail: PlanDetail): ReviewPlan {
  const liveItems = detail.items.filter(
    (item): item is PlanDetailItem & { meal: NonNullable<PlanDetailItem["meal"]> } =>
      item.meal !== null,
  );

  const scheduledMeals: ReviewPlanMealRow[] = [];
  const unscheduledMeals: ReviewPlanMealRow[] = [];

  for (const item of liveItems) {
    const day = toDayOfWeek(item.assignedDayOfWeek);
    const row = itemToRow(item, day);
    if (day !== null) {
      scheduledMeals.push(row);
    } else {
      unscheduledMeals.push(row);
    }
  }

  return {
    id: detail.id,
    name: detail.name,
    weekStartDate: detail.startDate ?? undefined,
    weekEndDate: detail.endDate ?? undefined,
    // WS7-4-A c6 — server now carries these values end-to-end. Adapter
    // passes them through; C4-era hardcoded defaults are gone.
    prepStatus: detail.prepStatus,
    optimizationNotes: detail.optimizationNotes ?? [],
    macroDailyAverage: detail.macroDailyAverage,
    scheduledMeals,
    unscheduledMeals,
    breakfastOverrides: detail.breakfastOverrides ?? "",
    lunchOverrides: detail.lunchOverrides ?? "",
    // WS7-6 (E) Block 2 §4 — Model 2 resolver-derived. Drives the
    // "Cook This Week" / "This Week's Plan" chip in Plan Review.
    isActiveThisWeek: detail.isActiveThisWeek,
  };
}

function itemToRow(
  item: PlanDetailItem & { meal: NonNullable<PlanDetailItem["meal"]> },
  day: ReturnType<typeof toDayOfWeek>,
): ReviewPlanMealRow {
  const meal = item.meal;
  return {
    planItemId: item.id,
    mealId: item.mealId,
    title: meal.title,
    thumbnailUrl: meal.image ?? undefined,
    // C4 Ruling 4 — widen ReviewPlanMealRow with cuisine so sites #2 and #3
    // can read row.cuisine directly instead of an extra getMealById lookup.
    // Server `cuisine` is always a string ("" when none — see MealListItemSchema).
    cuisine: meal.cuisine.length > 0 ? meal.cuisine : undefined,
    metaLine: formatMealDetailMetaLine(meal),
    caloriesPerServing: meal.calories,
    proteinGPerServing: meal.protein,
    carbsGPerServing: meal.carbs,
    fatGPerServing: meal.fat,
    dayStrip: buildDayStrip(day),
  };
}

function formatMealDetailMetaLine(meal: MealDetail): string {
  return `${capitalize(meal.difficulty)} · ${meal.minutes} min · serves ${meal.servings}`;
}

// Used by the deep-link `?addMealId=...` injection path in app/plan/[id].tsx.
// Builds a fresh row from a MealDetail (the useMeal hook result) — same shape
// as itemToRow but synthesizes a client-side planItemId since no server item
// exists yet (WS7-4 lands the real POST /plans/:id/items + planItemId).
export function mealDetailToRow(meal: MealDetail): ReviewPlanMealRow {
  return {
    planItemId: `pi-${Date.now()}`,
    mealId: meal.id,
    title: meal.title,
    thumbnailUrl: meal.image ?? undefined,
    cuisine: meal.cuisine.length > 0 ? meal.cuisine : undefined,
    metaLine: formatMealDetailMetaLine(meal),
    caloriesPerServing: meal.calories,
    proteinGPerServing: meal.protein,
    carbsGPerServing: meal.carbs,
    fatGPerServing: meal.fat,
    dayStrip: buildDayStrip(null),
  };
}

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
    // WS9-2 2c Commit 5 (D-WS9-144) — `image` removed. Plan Review no longer
    // renders a header photo; a MealPlanInstance has no image of its own and
    // the inherited template imageUrl was null for ~95% of plans, so the field
    // only ever fed a gradient placeholder. The rail keeps its images — that is
    // a different table with real curated photos.
  };
}

function itemToRow(
  item: PlanDetailItem & { meal: NonNullable<PlanDetailItem["meal"]> },
  day: ReturnType<typeof toDayOfWeek>,
): ReviewPlanMealRow {
  const meal = item.meal;
  // WS7-7-A B5 follow-on (D-WS7-141 Fix 2) — the meta line's "serves N" must
  // reflect the plan-instance servings override when set, not the canonical
  // meal default. The override already rides onto the row (servingsOverride
  // below) for the stepper; the displayed string was the one surface still
  // reading meal.servings.
  const effectiveServings = item.servingsOverride ?? meal.servings;
  return {
    planItemId: item.id,
    mealId: item.mealId,
    title: meal.title,
    thumbnailUrl: meal.image ?? undefined,
    // C4 Ruling 4 — widen ReviewPlanMealRow with cuisine so sites #2 and #3
    // can read row.cuisine directly instead of an extra getMealById lookup.
    // Server `cuisine` is always a string ("" when none — see MealListItemSchema).
    cuisine: meal.cuisine.length > 0 ? meal.cuisine : undefined,
    metaLine: formatMealDetailMetaLine(meal, effectiveServings),
    caloriesPerServing: meal.calories,
    proteinGPerServing: meal.protein,
    carbsGPerServing: meal.carbs,
    fatGPerServing: meal.fat,
    dayStrip: buildDayStrip(day),
    // WS7-7-A B5 — carry the plan-instance servings override to Meal Detail.
    servingsOverride: item.servingsOverride,
    // D-WS9-142 — server append order; the unscheduled bucket sorts on this.
    positionIndex: item.positionIndex,
  };
}

// D-WS9-142 (RULED, Hans) — order the UNSCHEDULED bucket newest-first so a just-
// added meal appears at the top of that bucket (server assigns positionIndex =
// max+1 on add). DISPLAY-ONLY: returns a sorted copy, mutates nothing, and the
// stored positionIndex values are untouched (prep sequencing still reads them).
// Optimistic / deep-link stub rows have no positionIndex yet → treated as the
// newest (sorted to top) so the add reads as successful before the refetch. Sort
// is stable, so same-key rows keep their incoming order.
export function sortUnscheduledNewestFirst(
  rows: ReviewPlanMealRow[],
): ReviewPlanMealRow[] {
  const rank = (r: ReviewPlanMealRow) => r.positionIndex ?? Number.MAX_SAFE_INTEGER;
  return [...rows].sort((a, b) => rank(b) - rank(a));
}

// `servings` defaults to the canonical meal default so the deep-link inject
// path (mealDetailToRow — no plan item, no override) is unchanged; itemToRow
// passes the override-aware effective servings (D-WS7-141 Fix 2).
function formatMealDetailMetaLine(
  meal: MealDetail,
  servings: number = meal.servings,
): string {
  return `${capitalize(meal.difficulty)} · ${meal.minutes} min · serves ${servings}`;
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

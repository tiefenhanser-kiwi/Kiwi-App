// BUG-104 — optimistic edits expressed as PlanDetail → PlanDetail transforms.
//
// Why the WIRE shape and not the screen's ReviewPlan mirror:
//
// Plan Review keeps a component-local `reviewPlan` mirror that is re-seeded
// wholesale from `planQuery.data` on every identity change
// (app/plan/[id].tsx). Optimism that lives in that mirror is erased the moment
// any in-flight GET resolves — and it is worse than a display revert, because
// the day-pill handler computes its next value FROM the mirror
// (`row.dayStrip.find(d => d.isAssigned)` in PlanReviewMealRow). A clobbered
// mirror therefore produces a WRONG WRITE: the server's UserActivity log shows
// four A→B→A oscillations where each PATCH's `from` matched the previous `to`.
// The client sent the old day back as a real, server-honoured write.
//
// Putting optimism in the query cache instead makes the mirror harmless: it
// stays a pure derivation of a cache that is already correct.
// `planDetailToReviewPlan` re-derives `dayStrip` from `item.assignedDayOfWeek`,
// so a correct cache is a correct day strip is a correct next write.
//
// PURE: no React, no React Query, no I/O — every function returns a new
// PlanDetail (or the same reference when the edit is a no-op) so the cache's
// identity change is meaningful and unit tests need no QueryClient.

import type { PlanDetail, PlanDetailItem } from "@/lib/api/plans";
import type { MealDetail } from "@/lib/api/meals";
import type { MealSummary } from "@/lib/types";

/** Replace one item by id, leaving the rest (and the item order) untouched. */
function mapItem(
  detail: PlanDetail,
  planItemId: string,
  fn: (item: PlanDetailItem) => PlanDetailItem,
): PlanDetail {
  let touched = false;
  const items = detail.items.map((item) => {
    if (item.id !== planItemId) return item;
    touched = true;
    return fn(item);
  });
  // Same-reference return on a miss keeps a no-op from churning the cache
  // identity (which would fire the screen's re-seed effect for nothing).
  return touched ? { ...detail, items } : detail;
}

/**
 * Day-pill assignment. `null` unassigns, which moves the row into the
 * unscheduled cluster when the adapter re-derives.
 */
export function applyDayAssignmentToDetail(
  detail: PlanDetail,
  planItemId: string,
  day: string | null,
): PlanDetail {
  return mapItem(detail, planItemId, (item) => ({
    ...item,
    assignedDayOfWeek: day,
  }));
}

/** Compost-from-plan: drop the row. */
export function removeItemFromDetail(
  detail: PlanDetail,
  planItemId: string,
): PlanDetail {
  const items = detail.items.filter((item) => item.id !== planItemId);
  return items.length === detail.items.length ? detail : { ...detail, items };
}

/**
 * Change Meal: repoint an existing item at a different meal.
 *
 * Only the fields the row actually renders are synthesized from the summary —
 * `dishes` / `steps` stay as the OUTGOING meal's until the refetch lands,
 * because a swap keeps the row mounted and an empty ingredient list would read
 * as a real (wrong) state rather than as "not loaded yet". Everything
 * user-visible on the Plan Review row comes from the fields set below.
 */
export function replaceItemMealInDetail(
  detail: PlanDetail,
  planItemId: string,
  meal: MealSummary,
): PlanDetail {
  return mapItem(detail, planItemId, (item) => {
    const prevMeal = item.meal;
    const nextMeal: MealDetail | null = prevMeal
      ? {
          ...prevMeal,
          id: meal.id,
          title: meal.title,
          image: meal.imageUrl ?? null,
          cuisine: meal.cuisineType ?? "",
          minutes: meal.estimatedTimeMinutes,
          servings: meal.servingsDefault,
          calories: meal.caloriesPerServing,
          protein: meal.proteinGPerServing,
          carbs: meal.carbsGPerServing,
          fat: meal.fatGPerServing,
          difficulty: meal.difficulty,
        }
      : null;
    return { ...item, mealId: meal.id, meal: nextMeal };
  });
}

/**
 * Change Meal is a server-side delete+create, so the item id CHANGES. The
 * caller repoints the optimistic row the moment the response lands, ahead of
 * the refetch, so a fast second swap targets a live id rather than the
 * just-deleted one (the WS9 3d Part 4 stale-id window).
 */
export function repointItemIdInDetail(
  detail: PlanDetail,
  oldPlanItemId: string,
  newPlanItemId: string,
): PlanDetail {
  return mapItem(detail, oldPlanItemId, (item) => ({
    ...item,
    id: newPlanItemId,
  }));
}

/**
 * Add Meals → existing-meal pick. Builds a placeholder item for the
 * unscheduled cluster.
 *
 * `dishes` / `steps` are empty and `effectiveServings` mirrors the summary:
 * this row is brand new, has never been rendered, and the refetch (~200ms)
 * fills it. That is the SAME invention the screen already did with its
 * `pi-${Date.now()}` stub row — moved one layer down so it lands in the cache
 * instead of only in the mirror.
 *
 * `positionIndex` is Number.MAX_SAFE_INTEGER so sortUnscheduledNewestFirst
 * floats it to the top of the unscheduled bucket (D-WS9-142) until the server
 * assigns the real max+1.
 */
export function buildOptimisticPlanItem(
  meal: MealSummary,
  planItemId: string,
): PlanDetailItem {
  return {
    id: planItemId,
    mealId: meal.id,
    positionIndex: Number.MAX_SAFE_INTEGER,
    assignedDayOfWeek: null,
    assignedDate: null,
    servingsOverride: null,
    isBreakfast: false,
    isLunch: false,
    isDinner: true, // matches the mutator's explicit slot: "dinner" (Q-P0-5)
    notes: null,
    // A brand-new row has no prep session behind it.
    isPrepped: false,
    meal: {
      id: meal.id,
      title: meal.title,
      displayTitle: null,
      description: null,
      cuisine: meal.cuisineType ?? "",
      minutes: meal.estimatedTimeMinutes,
      servings: meal.servingsDefault,
      authoredServingsDefault: meal.servingsDefault,
      calories: meal.caloriesPerServing,
      protein: meal.proteinGPerServing,
      carbs: meal.carbsGPerServing,
      fat: meal.fatGPerServing,
      tags: [],
      image: meal.imageUrl ?? null,
      difficulty: meal.difficulty,
      mealType: "dinner",
      sourceType: "manual",
      isPublic: false,
      userId: null,
      dishes: [],
      steps: [],
      notes: null,
      effectiveServings: meal.servingsDefault,
    } as MealDetail,
  };
}

export function addItemToDetail(
  detail: PlanDetail,
  item: PlanDetailItem,
): PlanDetail {
  return { ...detail, items: [...detail.items, item] };
}

/** Plan-header edits. */
export function setPlanNameInDetail(
  detail: PlanDetail,
  name: string,
): PlanDetail {
  return detail.name === name ? detail : { ...detail, name };
}

export function setPlanDateRangeInDetail(
  detail: PlanDetail,
  startDate: string,
  endDate: string,
): PlanDetail {
  return detail.startDate === startDate && detail.endDate === endDate
    ? detail
    : { ...detail, startDate, endDate };
}

export function setPlanActiveThisWeekInDetail(
  detail: PlanDetail,
  isActiveThisWeek: boolean,
): PlanDetail {
  return detail.isActiveThisWeek === isActiveThisWeek
    ? detail
    : { ...detail, isActiveThisWeek };
}

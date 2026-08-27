// WS9 Block 3c (D-WS9-032, Option A) — adapter from a wizard EXPAND payload
// (WizardExpandedPlan, the hidden-draft shape returned by POST /wizard/expand)
// to the Plan Review screen's local-state shape (ReviewPlan). This is the
// draft-mode sibling of planDetailToReviewPlan: it lets the SHARED Plan Review
// screen render an unsaved wizard draft before any server plan row exists, so
// the action bar can offer "Save for Later" / "Use This Week" and only then
// materialize a real plan (Hans's Option A ruling — no orphan plan rows on a
// curious card tap).
//
// A draft has no MealPlanInstance id, no day assignments, and no dates until it
// is activated: every meal lands in the unscheduled cluster and the synthetic
// planItemId / mealId are display-only (editing is guarded off in draft mode
// per point 6, so they never reach the server). Per-serving macros are summed
// across each meal's dishes; the daily average divides the all-dish total by
// meal count — the same denominator wizard-plan-details.tsx used (one meal =
// one day).

import { buildDayStrip } from "@/lib/domain";
import type {
  WizardExpandedPlan,
  WizardExpandEnrichedMeal,
} from "@/lib/api/wizard";
import type {
  MacroDailyAverage,
  ReviewPlan,
  ReviewPlanMealRow,
} from "@/lib/types";

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Sum one meal's per-serving macros across its dishes, skipping dishes whose
// macro pass failed or is absent — the same trust rule as
// wizard-plan-details.tsx's deriveDailyAverages.
function sumMealMacros(meal: WizardExpandEnrichedMeal): {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
} {
  let calories = 0;
  let proteinG = 0;
  let carbsG = 0;
  let fatG = 0;
  for (const dish of meal.dishes) {
    if (!dish.macros || dish.macros.failed) continue;
    calories += dish.macros.caloriesPerServing;
    proteinG += dish.macros.proteinGPerServing;
    carbsG += dish.macros.carbsGPerServing;
    fatG += dish.macros.fatGPerServing;
  }
  return { calories, proteinG, carbsG, fatG };
}

function mealToRow(
  meal: WizardExpandEnrichedMeal,
  index: number,
): ReviewPlanMealRow {
  const macros = sumMealMacros(meal);
  return {
    // Synthetic, display-only ids — a draft has no server MealPlanItem. Editing
    // is guarded off in draft mode (D-WS9-032 point 6), so these never hit the
    // server; on commit the real plan is refetched with real ids.
    planItemId: `draft-item-${index}`,
    mealId: `draft-meal-${index}`,
    title: meal.title,
    thumbnailUrl: undefined,
    cuisine: meal.cuisineType.length > 0 ? meal.cuisineType : undefined,
    // WS9 BUG-163 — same shape reviewPlanAdapter uses for a SAVED plan
    // (`meal.description ?? undefined`), so a draft and the plan it becomes
    // render the identical sub-text instead of the row appearing only after save.
    description: meal.description ?? undefined,
    metaLine: `${capitalize(meal.difficulty)} · ${meal.estimatedTimeMinutes} min · serves ${meal.servings}`,
    caloriesPerServing: macros.calories,
    proteinGPerServing: macros.proteinG,
    carbsGPerServing: macros.carbsG,
    fatGPerServing: macros.fatG,
    dayStrip: buildDayStrip(null),
  };
}

function deriveDailyAverage(plan: WizardExpandedPlan): MacroDailyAverage {
  const days = plan.meals.length;
  if (days === 0) {
    return {
      caloriesPerDay: null,
      proteinGPerDay: null,
      carbsGPerDay: null,
      fatGPerDay: null,
    };
  }
  let totalCal = 0;
  let totalP = 0;
  let totalC = 0;
  let totalF = 0;
  for (const meal of plan.meals) {
    const m = sumMealMacros(meal);
    totalCal += m.calories;
    totalP += m.proteinG;
    totalC += m.carbsG;
    totalF += m.fatG;
  }
  return {
    caloriesPerDay: Math.round(totalCal / days),
    proteinGPerDay: Math.round(totalP / days),
    carbsGPerDay: Math.round(totalC / days),
    fatGPerDay: Math.round(totalF / days),
  };
}

export function wizardExpandedPlanToReviewPlan(
  plan: WizardExpandedPlan,
): ReviewPlan {
  return {
    // A draft has no MealPlanInstance id; the Plan Review screen keys mutations
    // off the route param (guarded off in draft mode), never off ReviewPlan.id.
    id: "",
    name: plan.title,
    prepStatus: "not_prepped",
    optimizationNotes: [],
    macroDailyAverage: deriveDailyAverage(plan),
    // No day assignments on a draft — every meal is unscheduled until the plan
    // is materialized and the user assigns days on the saved plan.
    scheduledMeals: [],
    unscheduledMeals: plan.meals.map(mealToRow),
    breakfastOverrides: "",
    lunchOverrides: "",
    weekStartDate: undefined,
    weekEndDate: undefined,
    isActiveThisWeek: false,
  };
}

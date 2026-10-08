// Row 13 "Test Kitchen" · Block 2 Part D — the guest plan's view-model.
//
// The guest plan screen renders GET /guest/draft's `expanded` object, which is
// the SAME shape POST /wizard/expand returns. What goes on screen is decided
// here, as pure functions, because `app/**` is outside the test glob (D-WS9-164)
// and two of these decisions are not obvious from the payload:
//
// 🔴 A GUEST'S PLAN HAS NO COOKING STEPS, AND THAT IS NOT A BUG IN THIS BLOCK.
// WS7-5c Block A split the expansion into a details stage (ingredients + macros,
// no steps) and a finalize-steps stage that runs at SAVE or ACTIVATE. Both are
// member-only for a guest, and both are doors. The server also strips `steps`
// from legacy steps-bearing drafts on the GET path, so the shape is consistent.
// So R4's "it's fine to read the full recipe in the plan" is satisfied a
// different way than by reading the draft: every slot in a guest's plan is
// CATALOG-COMPOSED (the expand refuses otherwise — `catalog_only_gap`), so every
// slot carries `sourceStoreMealId`, and the full recipe including steps comes
// from GET /meals/:id — guest-OK, catalog-only. `recipeMealId` below is that
// bridge, and `recipeReadable` is the honest answer when a slot lacks it.
//
// Resub C4 (BUG-366) — THE THUMBNAIL IS NOT ON THE DRAFT EITHER. The expanded
// meal on 27e7eb5 carries `sourceStoreMealId` and no `imageUrl` (server:
// WizardExpandEnrichedMealSchema; storeMealDetails.ts copies no image). So the
// image comes from what the client already held when the plan was made, and
// never from GET /meals/:id per row:
//   1. the three-plan path — the opened candidate's wire `meals[i].imageUrl`
//      (store slots carry it, D-WS9-246), matched by SLOT and checked against
//      the slot's storeMealId;
//   2. the pick path — the picked shelf cards' images, held in GuestContext,
//      matched by `sourceStoreMealId`;
//   3. else null, and the row renders exactly as it did before.
//
// The macro line is derived, not sent: the expand payload carries PER-DISH
// macros and the candidate card's `dailyMacros` belongs to the candidate, not to
// the draft. Summing the dishes is the only per-meal figure available here.

import type { WizardExpandEnrichedMeal, WizardExpandedPlan } from "@/lib/api/wizard";
import type { WizardPlanCandidate } from "@/lib/types";

export interface GuestPlanRow {
  /** Stable within a render — the draft has no per-meal id of its own. */
  key: string;
  title: string;
  description: string | null;
  /** "35 min" / null. */
  timeLabel: string | null;
  difficulty: string;
  servings: number;
  /** The catalog meal behind this slot, or null for a live-expanded one. */
  recipeMealId: string | null;
  /** False when the full recipe cannot be fetched — see the header. */
  recipeReadable: boolean;
  /** Per-serving calories, summed over the dishes, or null when unknown. */
  caloriesPerServing: number | null;
  /** Resub C4 (BUG-366) — the row's thumbnail, or null (the imageless row). */
  imageUrl: string | null;
}

/** Resub C4 — where a guest plan row's image can come from. See the header. */
export interface GuestPlanImageSources {
  /** The three-plan path's cards: the in-tab generation, else GET /guest/session. */
  candidates?: readonly WizardPlanCandidate[] | null;
  /** The pick path's chosen cards: catalog meal id → image url. */
  pickedMealImages?: Readonly<Record<string, string>> | null;
}

export function guestPlanRows(
  expanded: WizardExpandedPlan,
  images: GuestPlanImageSources = {},
): GuestPlanRow[] {
  const candidate =
    images.candidates?.find((c) => c.id === expanded.candidateId) ?? null;
  return expanded.meals.map((meal, index) => {
    const mealId = mealRecipeId(meal);
    return {
      key: `${index}-${meal.title}`,
      title: meal.title,
      description: meal.description ?? null,
      timeLabel:
        typeof meal.estimatedTimeMinutes === "number" && meal.estimatedTimeMinutes > 0
          ? `${meal.estimatedTimeMinutes} min`
          : null,
      difficulty: meal.difficulty,
      servings: meal.servings,
      recipeMealId: mealId,
      recipeReadable: mealId !== null,
      caloriesPerServing: sumCalories(meal),
      imageUrl: rowImage(candidate, index, mealId, images.pickedMealImages ?? null),
    };
  });
}

function rowImage(
  candidate: WizardPlanCandidate | null,
  index: number,
  mealId: string | null,
  picked: Readonly<Record<string, string>> | null,
): string | null {
  const slot = candidate?.meals?.[index];
  // By slot — but a slot whose meal is not this row's catalog meal is a
  // different dinner, and its picture would be a wrong one, not a missing one.
  if (slot?.imageUrl && (!slot.storeMealId || !mealId || slot.storeMealId === mealId)) {
    return slot.imageUrl;
  }
  if (mealId && picked?.[mealId]) return picked[mealId];
  return null;
}

function mealRecipeId(meal: WizardExpandEnrichedMeal): string | null {
  const id = (meal as { sourceStoreMealId?: unknown }).sourceStoreMealId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Per-serving calories for the whole meal — the sum over its dishes, because
 * that is what "a serving of this meal" is. A dish whose macro pass FAILED
 * (`macros.failed`) or is null makes the whole figure unknown rather than
 * understated: a calorie count missing a component is worse than none.
 */
function sumCalories(meal: WizardExpandEnrichedMeal): number | null {
  let total = 0;
  for (const dish of meal.dishes) {
    if (!dish.macros || dish.macros.failed) return null;
    total += dish.macros.caloriesPerServing;
  }
  return Math.round(total);
}

/**
 * The plan's sub-line. `planDurationDays` is not on the draft — the draft is the
 * expanded plan, not the request — so the meal count is the honest figure.
 */
export function guestPlanSubline(expanded: WizardExpandedPlan): string {
  const n = expanded.meals.length;
  return n === 1 ? "1 meal" : `${n} meals`;
}

/** Find one row by its key — the recipe screen's lookup after a route hop. */
export function guestPlanRowByKey(
  rows: GuestPlanRow[],
  key: string | undefined,
): GuestPlanRow | null {
  if (!key) return null;
  return rows.find((r) => r.key === key) ?? null;
}

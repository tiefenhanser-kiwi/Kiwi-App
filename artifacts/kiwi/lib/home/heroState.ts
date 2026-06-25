// WS7-3 Block C2 Commit 1 — pure Hero-card state derivation for the Home tab.
//
// The Home Hero card (PRD §4.2.2 / §4.6) shows one of three states, in
// priority order: today's assigned meal → the active plan → an empty
// "create one" prompt. The selection + the active-plan duration math are
// pulled out of app/(tabs)/index.tsx so they unit-test without a JSX test
// harness (see WS7-3 C2 Phase 1 §10 — no JSX-capable runner installed).

import type { HomePayload } from "@/lib/api/home";
import type { MealListItem } from "@/lib/api/meals";

// The resolved Hero card model — a discriminated union the screen renders
// by `kind`. Carries only what each branch draws so the screen does no
// further data-shape juggling.
export type HeroModel =
  | {
      kind: "today";
      planId: string;
      /** The plan-slot id — threaded so the today card opens Meal Detail with
       *  full plan-item context (servings override + "just this time" edits via
       *  useMeal(mealId, planItemId)). Maps from todaysMeal.mealPlanItemId. */
      planItemId: string;
      meal: MealListItem;
    }
  | { kind: "plan"; planId: string; name: string; durationDays: number | null }
  | { kind: "empty" };

/**
 * Inclusive day span between two ISO date strings, or null when either
 * bound is missing/unparseable. +1 because the range is inclusive
 * (e.g. Mon–Fri = 5 days, not 4).
 */
export function planDurationDays(
  startDate: string | null,
  endDate: string | null,
): number | null {
  if (!startDate || !endDate) return null;
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1);
}

/**
 * Resolve the Hero card model from the GET /home payload. `undefined` (the
 * useHomePayload query still loading, or errored) collapses to the empty
 * state — the screen renders the empty branch as its loading placeholder
 * (WS7-3 C2 Phase 2 Commit 1 ruling — lighter-weight than a spinner).
 */
export function deriveHeroModel(payload: HomePayload | undefined): HeroModel {
  if (!payload) return { kind: "empty" };
  if (payload.todaysMeal) {
    return {
      kind: "today",
      planId: payload.todaysMeal.planId,
      planItemId: payload.todaysMeal.mealPlanItemId,
      meal: payload.todaysMeal.meal,
    };
  }
  if (payload.activePlan) {
    return {
      kind: "plan",
      planId: payload.activePlan.id,
      name: payload.activePlan.name,
      durationDays: planDurationDays(
        payload.activePlan.startDate,
        payload.activePlan.endDate,
      ),
    };
  }
  return { kind: "empty" };
}

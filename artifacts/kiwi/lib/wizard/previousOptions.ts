// Plan-Gen Arc Block 4b-3 (D-WS9-072) — "See Previous Options" decision + param
// helpers, pinned here as pure functions so the link's show/hide rule and its
// wizard-results rehydrate navigation are testable without rendering the screen.

import type { WizardLastBatch, WizardShelfResponse } from "../api/wizard";
import type { WizardShelfRequest } from "./perRunPayload";
import { pickMealsRouteParams, type PickMealsRouteParams } from "./pickMeals";

/**
 * Whether the "See Previous Options" link should render. Hidden when the user
 * has no batch (most new users) or a degenerate empty batch — the link is an
 * assist, never a blocker.
 */
export function shouldShowPreviousOptions(
  batch: WizardLastBatch | null | undefined,
): boolean {
  // Block 2b — a legacy Surprise Me row parses (read-tolerant union) but has
  // no results screen to land on: hide the link rather than rehydrate it.
  if (batch?.source === "surprise") return false;
  // Block 2c Part E — a shelf batch shows when it still has CARDS to re-show
  // (the server already drops stale ids and nulls an emptied batch; a
  // degenerate empty shelf hides here too).
  if (batch?.source === "shelf") return (batch.shelf?.meals.length ?? 0) > 0;
  return !!batch && (batch.candidates?.length ?? 0) > 0;
}

/** Block 2c Part E — the link's subtitle, by batch kind. */
export function previousOptionsSubtitle(batch: WizardLastBatch): string {
  if (batch.source === "shelf") {
    const n = batch.shelf?.meals.length ?? 0;
    return n === 1 ? "Your last suggested meal" : `Your last ${n} suggested meals`;
  }
  const count = batch.candidates?.length ?? 0;
  return count === 1 ? "Your last generated plan" : `Your last ${count} generated plans`;
}

/**
 * Block 2c Part E — the Pick-screen params that re-show a SHELF batch: the
 * server-resolved cards, in order, as the shelf (its totalEligible / hasMore
 * / unmatchedNames as stored); the stored request as the body "Get more
 * options" re-posts (with the shown ids excluded, as always). Selections are
 * NOT restored — this is "here is what you were looking at", not a resumed
 * session. Returns null when the batch is not a shelf or carries no cards.
 */
export function buildShelfRehydrateParams(
  batch: WizardLastBatch,
): PickMealsRouteParams | null {
  if (batch.source !== "shelf" || !batch.shelf) return null;
  const stored = batch.shelf;
  if (stored.meals.length === 0) return null;
  const request = (batch.input ?? {}) as Partial<WizardShelfRequest>;
  const days = Number(request.planDurationDays);
  const household = Number(request.householdSize);
  const shelf: WizardShelfResponse = {
    meals: stored.meals,
    totalEligible: stored.totalEligible,
    hasMore: stored.hasMore,
    unmatchedNames: stored.unmatchedNames,
    ...(stored.metadata ? { metadata: stored.metadata } : {}),
  };
  return pickMealsRouteParams({
    shelf,
    request: request as WizardShelfRequest,
    mode: typeof request.text === "string" && request.text.trim().length > 0 ? "text" : "prefs",
    planDurationDays: Number.isFinite(days) && days > 0 ? days : 5,
    householdSize: Number.isFinite(household) && household > 0 ? household : 2,
    capMinutes:
      typeof request.maxCookTimeMinutes === "number" ? request.maxCookTimeMinutes : null,
  });
}

/**
 * Build the wizard-results route params that re-show a stored batch WITHOUT a
 * generate call (`rehydrate:"1"` + the candidates JSON). Params branch on
 * `source` so the "Use this plan" expand can rebuild candidateContext:
 *   - wizard   → replay the WizardPreferencesInput slice as `input`
 *   - tellkiwi → replay the TellKiwiInput slice as `tellKiwiInput`
 * (Redesign Arc Block 2a Part B — the surprise branch is gone with Surprise Me.)
 *
 * Candidates are serialized VERBATIM, so a rehydrated candidate carries the same
 * title + mealTitles as when generated — which is exactly what makes its
 * server-side content hash match, so re-expanding it reuses the existing draft
 * (a DB read, not an AI call).
 */
export function buildRehydrateParams(
  batch: WizardLastBatch,
): Record<string, string> {
  const base = {
    rehydrate: "1",
    rehydratedCandidates: JSON.stringify(batch.candidates ?? []),
  };
  if (batch.source === "tellkiwi") {
    return {
      ...base,
      source: "tellkiwi",
      ...(batch.input ? { tellKiwiInput: JSON.stringify(batch.input) } : {}),
    };
  }
  return {
    ...base,
    ...(batch.input ? { input: JSON.stringify(batch.input) } : {}),
  };
}

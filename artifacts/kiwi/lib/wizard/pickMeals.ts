// WS9 Redesign Arc Block 2a Part D (D-WS9-237) — the Pick screen's decisions,
// as pure functions. app/** is outside the test glob (D-WS9-164), so every rule
// the screen must not get wrong lives here where it can be asserted:
//
//   • how many "Get more options" rounds a shelf gets (4 normally, 2 when the
//     FIRST response's totalEligible ≤ 10 — a thin shelf, Hans-ruled);
//   • when the button is REPLACED by the exhausted card (rounds used up, or the
//     server says hasMore:false);
//   • over-cap = derived total > the user's cap — COUNTED, never blocked
//     (D-WS9-235);
//   • appending a page keeps selection state and never duplicates a card;
//   • the wizard → Pick route-param codec (expo-router params are strings).

import type { ShelfMeal, WizardShelfResponse } from "@/lib/api/wizard";
import type { WizardShelfRequest } from "@/lib/wizard/perRunPayload";

/** A normal shelf gets this many "Get more options" rounds. */
export const ROUNDS_NORMAL = 4;
/** A THIN shelf (first totalEligible ≤ THIN_SHELF_MAX) gets this many. */
export const ROUNDS_THIN = 2;
export const THIN_SHELF_MAX = 10;
/** The caption's promise — the server returns 3–5 per round (size below). */
export const MORE_PAGE_SIZE = 5;
/** After this long in flight the caption says Kiwi is creating new ones. */
export const SLOW_ROUND_MS = 3000;

/** Rounds for a shelf, from the FIRST response's totalEligible. */
export function roundsFor(firstTotalEligible: number): number {
  return firstTotalEligible <= THIN_SHELF_MAX ? ROUNDS_THIN : ROUNDS_NORMAL;
}

/** Over the user's cap — total (derived, as sent) strictly greater than cap. */
export function isOverCap(
  meal: Pick<ShelfMeal, "estimatedTimeMinutes">,
  capMinutes: number | null,
): boolean {
  return capMinutes !== null && meal.estimatedTimeMinutes > capMinutes;
}

export interface PickState {
  /** Every card shown so far, in display order. */
  meals: ShelfMeal[];
  /** Picked ids IN THE ORDER PICKED — the from-meals body's order. */
  pickedIds: string[];
  /** From the first response; the header's "{N} fit your preferences". */
  totalEligible: number;
  /** Text mode — named meals Kiwi could not find. */
  unmatchedNames: string[];
  /** The server's last word on whether another round could return anything. */
  hasMore: boolean;
  roundsLeft: number;
}

/** The state for a fresh shelf response. */
export function initialPickState(first: WizardShelfResponse): PickState {
  return {
    meals: first.meals,
    pickedIds: [],
    totalEligible: first.totalEligible,
    unmatchedNames: first.unmatchedNames,
    hasMore: first.hasMore,
    roundsLeft: roundsFor(first.totalEligible),
  };
}

/** The button is replaced by the exhausted card when this is true. */
export function isExhausted(state: Pick<PickState, "hasMore" | "roundsLeft">): boolean {
  return !state.hasMore || state.roundsLeft <= 0;
}

/** Toggle a pick; a new pick goes to the END so order = order picked. */
export function togglePick(state: PickState, mealId: string): PickState {
  const picked = state.pickedIds.includes(mealId);
  return {
    ...state,
    pickedIds: picked
      ? state.pickedIds.filter((id) => id !== mealId)
      : [...state.pickedIds, mealId],
  };
}

/**
 * Append a "Get more options" page. Cards already shown are dropped (the
 * server excludes them, but a defensive de-dupe costs nothing), selection is
 * preserved, one round is spent, and hasMore is the server's new answer. An
 * EMPTY page also ends the rounds — nothing more will come.
 */
export function appendPage(state: PickState, page: WizardShelfResponse): PickState {
  const seen = new Set(state.meals.map((m) => m.id));
  const fresh = page.meals.filter((m) => !seen.has(m.id));
  return {
    ...state,
    meals: [...state.meals, ...fresh],
    hasMore: page.hasMore && fresh.length > 0,
    roundsLeft: Math.max(0, state.roundsLeft - 1),
  };
}

/** The ids to exclude on the next round — every card on screen. */
export function excludeIdsFor(state: Pick<PickState, "meals">): string[] {
  return state.meals.map((m) => m.id);
}

/** How many picked cards are over the cap (the footer's terracotta count). */
export function overCapPickedCount(
  state: Pick<PickState, "meals" | "pickedIds">,
  capMinutes: number | null,
): number {
  if (capMinutes === null) return 0;
  const byId = new Map(state.meals.map((m) => [m.id, m]));
  return state.pickedIds.filter((id) => {
    const m = byId.get(id);
    return m ? isOverCap(m, capMinutes) : false;
  }).length;
}

/** The header subline: "{N} fit your preferences · per serving · tap to add". */
export function pickHeaderSubline(totalEligible: number): string {
  return `${totalEligible} fit your preferences · per serving · tap to add`;
}

/** The "Get more options" caption. */
export function moreCaption(roundsLeft: number): string {
  return `3 to 5 more meals · ${roundsLeft} ${roundsLeft === 1 ? "round" : "rounds"} left`;
}

/** Footer line 1. */
export function footerPickedLine(picked: number, days: number): string {
  return `${picked} picked · ${days}-day plan`;
}

// ── Route params: wizard → /pick-meals ────────────────────────────────────
// expo-router params are strings. The shelf response and the request body
// travel JSON-encoded, the same idiom wizard-results uses for tellKiwiResult.

export interface PickMealsParamsInput {
  shelf: WizardShelfResponse;
  request: WizardShelfRequest;
  mode: "prefs" | "text";
  planDurationDays: number;
  householdSize: number;
  capMinutes: number | null;
}

export type PickMealsRouteParams = {
  shelf: string;
  request: string;
  mode: "prefs" | "text";
  planDurationDays: string;
  householdSize: string;
  /** "" when there is no cap. */
  capMinutes: string;
};

export function pickMealsRouteParams(input: PickMealsParamsInput): PickMealsRouteParams {
  return {
    shelf: JSON.stringify(input.shelf),
    request: JSON.stringify(input.request),
    mode: input.mode,
    planDurationDays: String(input.planDurationDays),
    householdSize: String(input.householdSize),
    capMinutes: input.capMinutes === null ? "" : String(input.capMinutes),
  };
}

/** The inverse. `null` when the params are missing or unparseable. */
export function parsePickMealsParams(
  raw: Partial<Record<keyof PickMealsRouteParams, string | string[]>>,
): PickMealsParamsInput | null {
  const one = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;
  try {
    const shelfRaw = one(raw.shelf);
    const requestRaw = one(raw.request);
    if (!shelfRaw || !requestRaw) return null;
    const shelf = JSON.parse(shelfRaw) as WizardShelfResponse;
    const request = JSON.parse(requestRaw) as WizardShelfRequest;
    if (!Array.isArray(shelf.meals)) return null;
    const mode = one(raw.mode) === "text" ? "text" : "prefs";
    const days = Number(one(raw.planDurationDays));
    const household = Number(one(raw.householdSize));
    const capRaw = one(raw.capMinutes);
    const cap = capRaw ? Number(capRaw) : null;
    return {
      shelf,
      request,
      mode,
      planDurationDays: Number.isFinite(days) && days > 0 ? days : request.planDurationDays,
      householdSize:
        Number.isFinite(household) && household > 0 ? household : request.householdSize,
      capMinutes: cap !== null && Number.isFinite(cap) ? cap : null,
    };
  } catch {
    return null;
  }
}

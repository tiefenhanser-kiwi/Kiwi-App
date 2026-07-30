// WS9 3d Part 3 — pure decision helpers for the plan-lifecycle actions
// (Compost + undo D-WS9-001, Use again D-WS9-008, demotion toast D-WS9-011a,
// dietary-staleness note D-WS9-013). The interactive wiring lives in the
// screens (app/(tabs)/plans.tsx + app/plan/[id].tsx, which the test runner does
// not glob); extracting the branch logic here keeps it unit-testable and
// single-sourced across the two entry points.

export interface PlanCardActionTarget {
  source: "instance" | "template";
}

/**
 * "Use again" (D-WS9-008) is offered for any saved plan (instance): 3b-3 copies
 * the plan INSTANCE (not its template), so even a template-less plan is
 * copyable — that is the whole point. Template rows use their own Use-Plan flow.
 */
export function canUseAgain(plan: PlanCardActionTarget): boolean {
  return plan.source === "instance";
}

/**
 * Only the active-this-week plan gets a naming confirm before compost ("This is
 * your active plan for this week."); every other compost relies on the Undo
 * toast alone (friction priority, spec §8.3).
 */
export function needsActiveCompostConfirm(isActiveThisWeek: boolean): boolean {
  return isActiveThisWeek;
}

// NOTE (WS9 3d Part 3b-1): the dietary-staleness DECISION moved server-side
// (computeDietaryStale + GET /plans/:id.dietaryStale) so the client never does
// timestamp math — the former shouldShowDietaryNote helper was removed with it.

/**
 * Demotion-toast copy (D-WS9-011a), or null when this activation displaced
 * nothing. Fires only when the server reported a displaced plan with a name.
 */
export function demotionToastMessage(
  activatedPlanName: string,
  demoted: { id: string; name: string } | null | undefined,
): string | null {
  if (!demoted || !demoted.name) return null;
  return `Now cooking: ${activatedPlanName}. ${demoted.name} taken off this week.`;
}

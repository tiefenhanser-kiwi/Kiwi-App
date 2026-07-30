// WS9 3d Part 3 — pure decision helpers for the plan-lifecycle actions
// (Compost + undo D-WS9-001, Use again D-WS9-008, demotion toast D-WS9-011a,
// dietary-staleness note D-WS9-013). The interactive wiring lives in the
// screens (app/(tabs)/plans.tsx + app/plan/[id].tsx, which the test runner does
// not glob); extracting the branch logic here keeps it unit-testable and
// single-sourced across the two entry points.

export interface PlanCardActionTarget {
  source: "instance" | "template";
  // Optional to match the (additive, optional) wire field — treat both null and
  // undefined as "no backing template".
  mealPlanTemplateId?: string | null;
}

/**
 * "Use again" (D-WS9-008) is offered only for a saved plan (instance) that has
 * a backing MealPlanTemplate to copy. Template rows use their own Use-Plan flow;
 * a template-less instance (e.g. an empty POST /plans) has nothing to copy.
 */
export function canUseAgain(plan: PlanCardActionTarget): boolean {
  return plan.source === "instance" && plan.mealPlanTemplateId != null;
}

/**
 * Only the active-this-week plan gets a naming confirm before compost ("This is
 * your active plan for this week."); every other compost relies on the Undo
 * toast alone (friction priority, spec §8.3).
 */
export function needsActiveCompostConfirm(isActiveThisWeek: boolean): boolean {
  return isActiveThisWeek;
}

/**
 * Passive dietary-staleness note (D-WS9-013): show iff the user's last
 * allergy/dietary edit (dietaryUpdatedAt) post-dates the plan's commit instant
 * (committedAt — NOT createdAt). Never on an unsaved draft; a null on either
 * timestamp keeps the note silent (the safe default for pre-migration rows and
 * users who have not edited dietary prefs).
 */
export function shouldShowDietaryNote(args: {
  isDraft: boolean;
  committedAt: string | null;
  dietaryUpdatedAt: string | null;
}): boolean {
  const { isDraft, committedAt, dietaryUpdatedAt } = args;
  if (isDraft || !committedAt || !dietaryUpdatedAt) return false;
  return (
    new Date(dietaryUpdatedAt).getTime() > new Date(committedAt).getTime()
  );
}

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

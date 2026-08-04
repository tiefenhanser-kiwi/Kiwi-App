// WS7-6 G2 scope (i) — shared post-save navigation contract for the Meal
// Builder CREATE path. All six Add-Meal-originated saves (manual Mode B,
// combine Mode C, Mode A draft, and the text/image/URL imports) funnel through
// one save handler; this pure helper decides where a successful save lands so
// the destination is single-sourced and unit-testable without rendering the
// screen.
//
// Contract (PRD §10.6 — Meal Detail is where a tap from any list lands):
//   - Plan-context save (addToPlanId present): the meal was being added to a
//     specific plan, so return to that plan ("plan-back"). The planId rides
//     along so the caller can `dismissTo` the plan directly — WS7-6 G3 Scope D:
//     import + Ask-Kiwi flows stack an extra input screen between the plan and
//     the builder, so a one-step `router.back()` stranded the user on that
//     input screen instead of the plan. dismissTo(plan) lands on the plan
//     regardless of intermediate stack depth.
//   - Add-Meal-originated save (no plan context): land on the NEW meal's Meal
//     Detail page.
//
// WS9 3f-3 (D-WS9-005) — THIRD outcome: "plan-replace". A save that originated
// from the Change-Meal SWAP context (the SwapMealSheet import quartet) carries
// planId + planItemId (the slot being replaced) but NO addToPlanId. It must
// REPLACE that slot (PRD §8.4.2 → changeMealForPlanItem), NOT append. The
// discriminator is the CREATE branch (no mealId — handled by the caller) plus
// planId + planItemId present. See the precedence note below for the
// (illegal-but-defined) case where both signals arrive.

export type PostSaveNav =
  | { kind: "plan-replace"; planId: string; planItemId: string }
  | { kind: "plan-back"; planId: string }
  | { kind: "meal-detail"; mealId: string };

export function resolvePostSaveNav(args: {
  newMealId: string;
  addToPlanId?: string;
  // WS9 3f-3 — the swap-slot coordinates. Both must be present to signal a
  // replace; a lone planId (no planItemId) is not a replace signal and falls
  // through to append/detail.
  planId?: string;
  planItemId?: string;
}): PostSaveNav {
  // ── Precedence: REPLACE > APPEND > DETAIL. ─────────────────────────────────
  // The append and replace signals come from different entry points and never
  // co-occur in normal use (the swap quartet threads planId+planItemId and NOT
  // addToPlanId; the add/library flows thread addToPlanId and NOT planItemId).
  // For the contradictory case where BOTH arrive, REPLACE deliberately wins:
  // appending here would add the new meal AND leave the old one in the slot —
  // the exact two-meals-from-a-swap bug this block exists to fix — whereas
  // replacing honors the more specific slot-targeted intent. Choosing the
  // safe-against-the-known-bug branch is the tie-break.
  if (args.planId && args.planItemId) {
    return { kind: "plan-replace", planId: args.planId, planItemId: args.planItemId };
  }
  if (args.addToPlanId) {
    return { kind: "plan-back", planId: args.addToPlanId };
  }
  return { kind: "meal-detail", mealId: args.newMealId };
}

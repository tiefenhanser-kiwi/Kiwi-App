// WS9-2 2e Part 2 Phase 4 (§4.5) — does the make lane offer "Add my own meals"?
// Pure; no React, no network.
//
// WHY THIS IS A FILE AND NOT AN INLINE TERNARY: app/(tabs)/index.tsx is outside
// the test runner's glob, and this predicate is the single subtlest decision in
// the 2e Home work — it has THREE inputs' worth of nuance packed into one
// boolean, and every one of them is easy to "simplify" into a bug:
//
//   1. it is NOT `isFirstRun`. Home already has a first-run gate, it is right
//      there in the same component, and it is WRONG for this. firstPlanCreatedAt
//      is a permanent stamp — set once, never cleared — so a user who creates a
//      plan and composts it is no longer first-run while having zero saved
//      plans. That user is precisely who this option exists for.
//
//   2. UNKNOWN IS NOT ZERO. While the plans query is in flight the count is
//      undefined, which means "we have not looked yet", not "there are none".
//      Rendering the option and then retracting it is worse than showing it a
//      beat late (ruled), and it matches the isFirstRun precedent: never assert
//      a state you have not loaded.
//
//   3. the count must come from a source that EXCLUDES composted plans. It does
//      — `my_plans` applies the isArchived:false gate server-side — which is
//      what makes point 1 reachable at all.
//
// Following the lib/plans/planLifecycleActions + planReviewSurface precedent:
// the branch lives here where it can be pinned, and the screen consumes it.

/**
 * §4.5 — "Add my own meals" renders ONLY when the user has NO saved plans.
 *
 * @param savedPlanCount the length of the `my_plans` list, or `undefined` while
 *        that query is still in flight. ⚠️ `undefined` is deliberately NOT
 *        coerced to 0.
 */
export function shouldOfferAddOwnMeals(
  savedPlanCount: number | undefined,
): boolean {
  if (savedPlanCount === undefined) return false;
  return savedPlanCount === 0;
}

/**
 * Shown on arrival at the meal builder, so the user learns the durable path
 * rather than only the one-off entry point they just used.
 *
 * Fired BEFORE the navigation on purpose: the app-level ToastProvider is
 * mounted above the navigator specifically so a toast raised right before a
 * route change survives the transition with its timer running.
 */
export const ADD_OWN_MEALS_TOAST = "Anytime: Recipes → Meals → Add Meal.";

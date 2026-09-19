// WS9-2 2e Part 2 Phase 4 (§4.5) — does the make lane offer its third option
// ("Set up my Playlist" since D-WS9-247)? Pure; no React, no network.
//
// WHY THIS IS A FILE AND NOT AN INLINE TERNARY: app/(tabs)/index.tsx is outside
// the test runner's glob, and this predicate has been the single subtlest
// decision in the Home work since 2e — every input is easy to "simplify" into
// a bug, so the branch lives here where it can be pinned and the screen
// consumes it (the lib/plans/planLifecycleActions + planReviewSurface
// precedent).
//
// THE RULE (D-WS9-247 amendment, Hans on the device, September 18: "it
// displays until a user has a meal or they click the button"):
//
//     offered  ⇔  the user has NO meals  AND  the button has NOT been tapped
//
// Both halves come from GET /home, which the screen already fetches:
//
//   1. `hasMeals` — does the user own ANY non-archived meal (the `my_meals`
//      predicate; a playlist add forks the catalog meal into a row this
//      matches, so authored and playlisted meals both count). Server-side
//      because the client does not actually hold a meal count: the Meals tab
//      fetches a filter-dependent, paginated PAGE (and its filter may be
//      "featured"), not the user's total.
//
//   2. `playlistCtaTappedAt` — the tapped stamp on the USER row, set through
//      PATCH /me/ui-state on the tap. Per-user, not per-device: a tap on one
//      phone must hide the card on another, which is why this is not
//      AsyncStorage.
//
// Two things this is NOT, kept from the 2e version because both are still the
// tempting wrong turn:
//
//   · it is NOT `isFirstRun`. firstPlanCreatedAt is a permanent stamp, and a
//     user who built a plan is not "first run" — but if they have since
//     deleted every meal and never tapped, the option is theirs again.
//
//   · UNKNOWN IS NOT "NO". While GET /home is in flight the payload is
//     undefined, which means "we have not looked yet". Rendering the option
//     and then retracting it is worse than showing it a beat late (ruled), so
//     an unloaded payload suppresses it — the isFirstRun precedent.
//
// The saved-plan count that gated this before the amendment is no longer an
// input: Home's `usePlans(["my_plans"])` reverts to the prefetch it was (it
// warms the Plans tab, the Prep & Cook hub and AddMealToPlanSheet).

import type { HomePayload } from "../api/home";

/** The two halves of the gate, exactly as GET /home carries them. */
export type PlaylistCtaGateInput = Pick<HomePayload, "hasMeals" | "playlistCtaTappedAt">;

/**
 * §4.5 / D-WS9-247 amendment — "Set up my Playlist" renders ONLY when the
 * user has NO meals AND has NOT tapped it.
 *
 * @param home the GET /home payload's gate fields, or `undefined` while that
 *        query is still in flight. ⚠️ `undefined` is deliberately NOT treated
 *        as "no meals, never tapped".
 */
export function shouldOfferAddOwnMeals(
  home: PlaylistCtaGateInput | undefined,
): boolean {
  if (home === undefined) return false;
  return home.hasMeals === false && home.playlistCtaTappedAt === null;
}

// D-WS9-247 — ADD_OWN_MEALS_TOAST ("Anytime: Recipes → Meals → Add Meal.")
// used to live here. The option it accompanied now lands on the Playlist tab,
// and a tab landing is its own confirmation, so the toast was deleted rather
// than re-worded. It had exactly one production reader (Home's handler).

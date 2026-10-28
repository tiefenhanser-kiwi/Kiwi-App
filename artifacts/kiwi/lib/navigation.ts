// WEB-1 Part B (BUG-382) — a back button with nowhere to go.
//
// On the web a screen can be the FIRST entry in the history: a cold load from
// the marketing site, a shared link, a refresh. router.back() there has no
// screen to return to, so the back button did nothing. goBack falls back to a
// replace() onto a real screen instead — replace, not push, so the dead entry
// is not left behind it.
//
// The router is passed in (each screen already holds one from useRouter())
// rather than read from expo-router's global, which keeps this testable
// against the router stub.

import type { Href } from "expo-router";

export interface BackRouter {
  canGoBack: () => boolean;
  back: () => void;
  replace: (href: Href) => void;
}

export function goBack(router: BackRouter, fallback: Href = "/"): void {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}

// CLIENT-5 B (BUG-564) — Cook Mode's back on a direct load or a reload.
//
// /cook-session is a route a web visitor can open first (a shared link, a
// reload mid-cook). Every back the route takes (the Header's, Prep the Week's
// finish and Save & Exit with no plan, the no-params fail-safe) was
// router.back(), so with no history the Header back did nothing. The route's
// router is withBackFallback's: back() is goBack's, onto the screen the session
// was launched from.

/** A router whose back() is goBack(router, fallback); every other method is the router's own. */
export function withBackFallback<R extends BackRouter>(router: R, fallback: Href): R {
  return { ...router, back: () => goBack(router, fallback) };
}

export interface CookSessionParams {
  mealId?: string | string[];
  dishId?: string | string[];
  planId?: string | string[];
  planItemId?: string | string[];
  mode?: string | string[];
  run?: string | string[];
}

const one = (v: string | string[] | undefined): string => (typeof v === "string" ? v : "");

/**
 * Where /cook-session's back lands with no history — the screen that launches it:
 * Prep the Week / Prep the feast → the Prep & Cook Hub (its plan when known); one
 * dish of a plan's meal (a make-ahead row) → that dish screen in plan context; a
 * meal → its meal screen, with the plan item when there is one; a dish alone → the
 * dish screen; nothing to go on → home.
 */
export function cookSessionExitHref(params: CookSessionParams): Href {
  const mealId = one(params.mealId);
  const dishId = one(params.dishId);
  const planId = one(params.planId);
  const planItemId = one(params.planItemId);
  const run = one(params.run);
  const plan = { ...(planId ? { planId } : {}), ...(planItemId ? { planItemId } : {}) };
  if (one(params.mode) === "prep-week") {
    return planId ? { pathname: "/prep-cook", params: { id: planId } } : "/prep-cook";
  }
  if (mealId && dishId) {
    return { pathname: "/dish/[id]", params: { id: dishId, mealId, ...plan, ...(run ? { run } : {}) } };
  }
  if (mealId) return { pathname: "/meal/[id]", params: { id: mealId, ...plan } };
  if (dishId) return { pathname: "/dish/[id]", params: { id: dishId } };
  return "/";
}

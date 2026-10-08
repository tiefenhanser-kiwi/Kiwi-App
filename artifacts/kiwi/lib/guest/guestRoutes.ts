// Row 13 "Test Kitchen" · Block 2 — WHICH PATHS A GUEST TOKEN MAY BE SENT ON.
//
// 🔴 AN ALLOWLIST, NEVER A DENYLIST. A guest token on a requireAuth route is a
// measured 401 (see lib/guest/guestToken.ts's header), and a 401 on an
// authenticated call is what lib/api/client.ts reads as "your session died".
// A denylist would mean every route added to the server from now on is
// guest-sendable until someone remembers to list it; this way a new route is
// member-only until someone decides otherwise, in one line, here.
//
// The list is exactly §1's — read off the server guards, not off the scope doc:
//   routes/guest.ts     POST/GET /guest/session, GET /guest/draft,
//                       POST /guest/events            (requireGuestOrAuth)
//   routes/wizard.ts    POST /wizard/build-plans, POST /wizard/expand
//                       (requireGuestOrAuth — with the shelf below, the ONLY
//                        wizard routes; every other one is a write-shaped
//                        action and therefore a door)
//   routes/meals.ts     GET /meals/:id                (requireGuestOrAuth,
//                        catalog-only for a guest: isPublic AND userId null)
//
// Resub C4 (Hans, October 7: the Test Kitchen ships WITH the member wizard's
// "Meals to choose from / Complete plans" choice — "it should be the same as the
// in-app/with-account flow") — the pick path's two routes, both G1:
//   routes/wizard.ts    POST /wizard/shelf            (requireGuestOrAuth; a
//                        guest may send neither `text` nor `source: "playlist"`)
//                       POST /guest/plan-from-picks   (guest-only; spends the
//                        session's one plan, the same as build-plans does)
//
// Paths are matched in apiClient's spelling: leading slash, no `/api` prefix,
// query string allowed (`/meals/abc?planItemId=x`).

/** Exact paths a guest may call. */
const GUEST_EXACT = new Set<string>([
  "/guest/session",
  "/guest/draft",
  "/guest/events",
  "/wizard/build-plans",
  "/wizard/expand",
  // Resub C4 — "Meals to choose from": the shelf, and its "Get more options".
  "/wizard/shelf",
  // Resub C4 — "Build my week" on the guest Pick screen.
  "/guest/plan-from-picks",
]);

/**
 * GET /meals/:id only. `/meals` (the catalog LIST) is requireAuth, so the
 * pattern must require a non-empty id segment and refuse a second one —
 * `/meals`, `/meals/`, and `/meals/abc/anything` are all member-only.
 */
const GUEST_MEAL_DETAIL = /^\/meals\/[^/]+$/;

/**
 * True when `path` is one of the routes a guest token is allowed on. Everything
 * else — including every route this app has not heard of — is member-only.
 *
 * Pure, and the seam the "a guest never reaches a member route" claim is pinned
 * at: lib/api/client.ts refuses a `principal: "guest"` call whose path this
 * rejects, loudly (a programmer error), rather than sending it and letting the
 * server answer 401.
 */
export function isGuestAllowedPath(path: string): boolean {
  const bare = path.split("?")[0];
  if (GUEST_EXACT.has(bare)) return true;
  return GUEST_MEAL_DETAIL.test(bare);
}

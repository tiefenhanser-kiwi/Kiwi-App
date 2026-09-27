// BUG-312 (Row 13 · Block 1b Part E) — "may this caller read this meal?", once.
//
// ── THE BUG ──────────────────────────────────────────────────────────────
//
// GET /meals/:id composed its response from a bare
// `findUnique({ where: { id }, include: MEAL_DETAIL_INCLUDE })` with NO
// visibility predicate of any kind. Block 1 added a guest pre-check in front of
// it and recorded the rest as a finding: for an AUTHENTICATED caller there was
// no ownership or visibility check at all, so any signed-in user could read any
// other user's private meal — full recipe, ingredients and steps — by id alone.
// Meal ids are cuids, so this is not trivially enumerable, but "hard to guess"
// is not an access control.
//
// ── THE §27.2 REUSE CHECK, AND WHY THIS FILE EXISTS ANYWAY ───────────────
//
// Searched for an existing predicate to reuse before writing one. There is NO
// exported meal-visibility helper in the tree — `grep` for an exported
// `*[Vv]isib*` returns nothing, and lib/planQueries.ts holds catalog/shelf
// queries, not a per-caller gate. What exists is the same two-clause rule
// open-coded at three call sites:
//
//   routes/playlist.ts (~109)          select {userId,isPublic,isArchived}, then
//                                      `!owned && !isPublic` → 403
//   routes/plans.ts (~1488)            the same, batched over distinctIds → 403
//   lib/store/storeMealDetails.ts(195) `OR: [{isPublic:true},{userId}]` in a
//                                      findMany, as a filter not a gate
//
// None of them is reusable here, for two reasons that are not cosmetic:
//
//   1. THEY ANSWER 403. This route must answer 404 — a 403 confirms the id
//      exists, which is exactly the probe the guest pre-check already refuses
//      to be. Reusing a 403-shaped helper would reintroduce that oracle.
//   2. THEY HAVE NO THIRD CLAUSE. A meal legitimately sitting on the caller's
//      own plan can be someone else's private row (a forked or shared meal
//      bound by a MealPlanItem — the same `?planItemId=` path this route
//      already serves). Under the two-clause rule that read 404s, which would
//      break Plan Review on exactly the plans it is meant to show.
//
// So this is the shared thing that did not exist, exported from `lib/` where
// the other three can adopt it later. The three call sites above are NOT
// refactored onto it here: they answer a different status code on a different
// shape (two are batched), and rewriting live ownership checks to prove a point
// about tidiness is a bigger blast radius than this fix is entitled to.
// Recorded as a candidate, not done.

import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Three ways a signed-in caller may read a meal, and no fourth:
 *
 *   1. it is THEIRS            — `userId` matches. No isArchived filter: your
 *                                own archived meal is still yours to read.
 *   2. it is CATALOG/PUBLIC    — isPublic AND not archived. The archived clause
 *                                belongs to this branch only; an unpublished or
 *                                retired meal is not public content.
 *   3. it is ON THEIR PLAN     — referenced by a MealPlanItem whose parent
 *                                instance is the caller's. Covers the
 *                                `?planItemId=` path and any forked or shared
 *                                meal legitimately in their week. Deliberately
 *                                NOT archived-filtered: a meal archived after
 *                                it landed on your plan is still the meal you
 *                                are cooking on Thursday.
 *
 * 🔴 `userId` IS TYPED `string`, NOT `string | undefined`, AND THAT IS LOAD-
 * BEARING. Prisma reads `where: { userId: undefined }` as NO FILTER — clause 1
 * would match every row and clause 3 every plan on the service, turning this
 * gate into a pass. Callers behind requireGuestOrAuth must narrow `req.userId`
 * before calling; the runtime guard below is the second line.
 */
export async function isMealReadableByUser(
  prisma: PrismaClient | Prisma.TransactionClient,
  mealId: string,
  userId: string,
): Promise<boolean> {
  if (!userId) {
    // Defence in depth against the `undefined` hazard above. An empty or
    // missing caller id is not "everyone", it is a bug — refuse.
    return false;
  }
  const visible = await prisma.meal.findFirst({
    where: {
      id: mealId,
      OR: [
        { userId },
        { isPublic: true, isArchived: false },
        { planItems: { some: { planInstance: { userId } } } },
      ],
    },
    select: { id: true },
  });
  return visible !== null;
}

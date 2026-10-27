// CLIENT-3 C (LIFE-2 #9) — the server learns that a cook finished.
//
// The same moment 1.2-NATIVE C counts for the store review prompt
// (CookSessionView's onLeaveAfterLastStep: the cook leaves Cook Mode on its
// last live step). LIFE-2's first_cook email waits for this row; until a
// client sends it, it never fires.
//
// Fire-and-forget: never awaited by the screen, a failure dropped (a server
// before LIFE-2 answers 404). Sent only for a signed-in member and never for a
// guest (the route is member-only; a guest token would be refused before it
// left, lib/guest/guestRoutes.ts). A meal is what finished: a lone dish (the
// Dishes tab's Cook Now) has no meal, and a plan dish run (a make-ahead row's
// dish, mealId + dishId) is one dish of a meal still to cook, so neither sends.

import { postCookFinished } from "@/lib/api/me";

export interface CookFinishedInput {
  signedIn: boolean;
  isGuest: boolean;
  mealId: string;
  dishId: string;
  planItemId: string;
}

export function cookFinishedBody(
  input: CookFinishedInput,
): { mealId: string; planItemId?: string } | null {
  if (!input.signedIn || input.isGuest) return null;
  if (input.mealId.length === 0 || input.dishId.length > 0) return null;
  return input.planItemId.length > 0
    ? { mealId: input.mealId, planItemId: input.planItemId }
    : { mealId: input.mealId };
}

export function reportCookFinished(
  input: CookFinishedInput,
  post: typeof postCookFinished = postCookFinished,
): void {
  const body = cookFinishedBody(input);
  if (!body) return;
  void post(body).catch(() => {});
}

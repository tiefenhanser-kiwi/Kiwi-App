// CLIENT-3 C (LIFE-2 #9) — the server learns that a cook finished.
//
// The same moment 1.2-NATIVE C counts for the store review prompt
// (CookSessionView's onLeaveAfterLastStep: the cook leaves Cook Mode on its
// last live step), and since CLIENT-4 D the moment the cook reaches that step
// (below). LIFE-2's first_cook email waits for this row; until a client sends
// it, it never fires.
//
// Fire-and-forget: never awaited by the screen, a failure dropped (a server
// before LIFE-2 answers 404). Sent only for a signed-in member and never for a
// guest (the route is member-only; a guest token would be refused before it
// left, lib/guest/guestRoutes.ts). A meal is what finished: a lone dish (the
// Dishes tab's Cook Now) has no meal, and a plan dish run (a make-ahead row's
// dish, mealId + dishId) is one dish of a meal still to cook, so neither sends.

import { postCookFinished } from "@/lib/api/me";
import { lastLiveIndex, type CookStep } from "@/lib/cooking/cookSession";

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

// ── CLIENT-4 D (BUG-560) — however Cook Mode was entered ─────────────────────
//
// The leave hook (CookSessionView's unmount) never fires on a direct load or a
// reload of /cook-session on the web: there is no in-app screen to go back to,
// so Back leaves the document and nothing unmounts. Single-meal Cook Mode has
// no Done button, and what it treats as the finish is being on the last live
// step. So the finish is also sent when the cook ADVANCES onto that step (the
// advance button, or a tap on the current step), and when the Header's back
// leaves from it. A jump by tapping a later step is reading ahead, not a finish;
// the leave hook still counts it, as before. Once per session; the review
// prompt (noteCookFinished) is unchanged and stays on the leave hook only.

/** One Cook Mode session's finish: sent at most once, however many signals fire. */
export function makeCookFinish(
  post: typeof postCookFinished = postCookFinished,
): (input: CookFinishedInput) => void {
  let sent = false;
  return (input) => {
    // Nothing to send (a guest, a dish run) does not use up the session's one send.
    if (sent || cookFinishedBody(input) === null) return;
    sent = true;
    reportCookFinished(input, post);
  };
}

/** Whether the cook is on the last live step (CookSessionView's atLastLive). */
export function onLastLiveStep(
  steps: readonly CookStep[],
  doneInPrep: ReadonlySet<string>,
  index: number,
  gatePromptVisible: boolean,
): boolean {
  return !gatePromptVisible && steps.length > 0 && index >= lastLiveIndex(steps, doneInPrep);
}

/** Whether an advance from `from` to `to` lands the cook on the last live step. */
export function advanceFinishes(
  steps: readonly CookStep[],
  doneInPrep: ReadonlySet<string>,
  from: number,
  to: number,
): boolean {
  return to !== from && onLastLiveStep(steps, doneInPrep, to, false);
}

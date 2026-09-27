// Row 13 "Test Kitchen" · Block 1b / D-WS9-263 — the personalize nudge's stamp.
//
// R2: a Test Kitchen sign-up skips onboarding (the claim already copied their
// wizard answers — see R1 in routes/auth.ts), so the first Home shows ONE
// dismissible card instead of a second, empty form:
//
//   "Your plan is saved. Welcome to Kiwi! The Test Kitchen only asked the
//    basics. Tell Kiwi how you really cook — your skill, your gear, who's at
//    the table — and every plan after this one fits you better.
//    [Personalize my plans] [Later]"
//
// ⚠️ "LATER" IS NOT THIS COLUMN. Later is per-DEVICE and lives on the client;
// this stamp is per-USER and one-way, and it flips only when they actually
// personalize (a successful PATCH /me/preferences) or explicitly dismiss for
// good (PATCH /me/ui-state { personalizeNudgeDismissed: true }). Wiring "Later"
// to the server would hide the card on every device the moment it was tapped
// once, which is the opposite of what a "not now" means.
//
// The `personalizeNudgeDismissedAt: null` predicate in the WHERE makes this a
// write-if-null guard, exactly as lib/firstPlan.ts does for the first-plan
// stamp: the FIRST dismissal wins and every later call no-ops. It records WHEN
// they stopped needing the nudge, so a second call must not move it — a
// "dismissed at" that advances every time the client retries is not a fact
// about the user, it is a fact about the retry.
//
// Two call sites, ONE rule, which is why this is a function and not two inline
// updates: routes/me.ts's PATCH /me/ui-state (the explicit dismissal) and its
// PATCH /me/preferences (personalizing IS dismissing). Those two must not be
// able to drift on the guard.

import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Stamp `personalizeNudgeDismissedAt = now()` if and only if it is currently
 * null. Safe to call on a user who has already dismissed, and safe to call on
 * one who never saw the nudge at all — a user whose `signupSource` is not
 * `test_kitchen` never renders the card (see GET /home's `showPersonalizeNudge`),
 * so a stamp on their row is harmless bookkeeping rather than a wrong state.
 *
 * Returns whether THIS call was the one that stamped it — useful to a caller
 * that wants to log the transition, and never used as an error signal: false
 * just means somebody got there first.
 */
export async function markPersonalizeNudgeDismissed(
  db: PrismaClient | Prisma.TransactionClient,
  userId: string,
): Promise<boolean> {
  const stamped = await db.user.updateMany({
    where: { id: userId, personalizeNudgeDismissedAt: null },
    data: { personalizeNudgeDismissedAt: new Date() },
  });
  return stamped.count > 0;
}

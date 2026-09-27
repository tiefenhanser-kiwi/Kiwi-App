// Row 13 "Test Kitchen" · Block 2 Part E (R7) — THE CLAIM, as decisions.
//
// "Sign-up from a guest session sends guestSessionId, platform: 'web' and the
// browser timezone… On success: clear the guest session and token, land on Home.
// 409 guest_session_invalid → sign-up proceeds without the claim and says so in
// one line. If claimRetryable comes back true, keep the guestSessionId so the
// next sign-in retries the claim."
//
// 🔴 ONE THING THE BRIEF'S WORDING ELIDES, AND IT CHANGES THE CODE. A 409 does
// NOT leave a signed-up account behind. Stage 1 of the claim (the preferences
// copy and marking the session claimed) rides INSIDE the same transaction that
// creates the User and the Subscription, and routes/auth.ts says so: "A
// GuestSessionInvalidError thrown below rolls the whole thing back, and the catch
// maps it to 409… the rollback means no half-made account survives it."
//
// So "sign-up proceeds without the claim" cannot mean "carry on" — there is no
// account to carry on with. It means RESEND THE SAME SIGN-UP WITHOUT THE
// guestSessionId, once, and then say the plan could not be brought over. That is
// signupRetryWithoutClaim() below, and it is why it is a decision and not a
// comment.

/** The three fields the auth response carries back for a claim. */
export interface ClaimResponse {
  claimedPlanId?: string | null;
  claimRetryable?: boolean;
  onboardingRequired?: boolean;
}

// ── where the user lands ──────────────────────────────────────────────────

export type ClaimDestination = "home" | "onboarding";

/**
 * R7 — "put the user in the home screen and have a popup".
 *
 * The server decides, not this client: `onboardingRequired` is false after a
 * claim that copied preferences, because the guest's wizard answers ARE the
 * account's starting preferences. An ordinary sign-up (no guest session) leaves
 * it true and keeps today's route to onboarding.
 *
 * ⚠️ An ABSENT field routes to onboarding. It means the server predates the
 * field, and onboarding is today's behaviour — the safe direction: a user sent
 * to onboarding they did not need loses a minute, a user who skipped onboarding
 * they did need has an account with no preferences.
 */
export function claimDestination(res: ClaimResponse): ClaimDestination {
  return res.onboardingRequired === false ? "home" : "onboarding";
}

// ── what happens to the guest session afterwards ──────────────────────────

export type GuestTeardown = "clear" | "keep";

/**
 * R7 — clear on success; KEEP when `claimRetryable` is true, so the next sign-in
 * with the same id retries stage 2 (the plan materialisation, which cannot be in
 * the signup transaction). The server has already released the claim for exactly
 * that purpose (lib/guestClaim.ts releaseClaimForRetry).
 *
 * `claimRetryable` wins over `claimedPlanId` when both somehow arrive: a server
 * that is still telling us to retry is the authority on whether it is done.
 */
export function guestTeardownAfterClaim(res: ClaimResponse): GuestTeardown {
  return res.claimRetryable === true ? "keep" : "clear";
}

// ── the 409 ───────────────────────────────────────────────────────────────

/**
 * True when this failure is "the guest session could not be claimed" and the
 * right response is to resend the sign-up WITHOUT it.
 *
 * Keyed on the CODE, not on the 409: POST /auth/signup can 409 for nothing else
 * today, but keying on status would silently swallow the next thing that does.
 */
export function signupRetryWithoutClaim(
  err: { status?: number; body?: unknown } | null | undefined,
  sentGuestSessionId: boolean,
): boolean {
  if (!sentGuestSessionId) return false;
  if (!err || err.status !== 409) return false;
  const code = (err.body as { code?: unknown } | null | undefined)?.code;
  return code === "guest_session_invalid";
}

// ── copy ──────────────────────────────────────────────────────────────────

/** R7 — the claim takes ~10 s, so the button says what it is doing. */
export const CLAIM_BUSY_LABEL = "Saving your plan…";
/** The one line after a 409 — the account exists, the plan did not come over. */
export const CLAIM_LOST_LINE =
  "Your account is ready, but that Test Kitchen plan had expired — build a fresh one any time.";
/** claimRetryable — the account exists, the plan is still coming. */
export const CLAIM_RETRY_LINE =
  "Your account is ready. Kiwi is still saving your plan — check your plans in a moment.";

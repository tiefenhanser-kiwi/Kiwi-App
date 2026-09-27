// Row 9 (1.1) · OAuth Block 2 Part B — THE ONE COMPLETION PATH.
//
// §2.5 — "extract what Block 2 Part E built in contexts/AuthContext.ts into
// one shared completion path and make the OAuth calls its third and fourth
// callers."
//
// ── WHAT WAS THERE ───────────────────────────────────────────────────────
//
// AuthContext.login and AuthContext.signup had grown the same eight steps
// twice, in slightly different orders, with the claim rules (Row 13 Block 2
// Part E) written out once each:
//
//   1. read the live guest session id
//   2. attach it, with today's LOCAL date, only when there is one
//   3. send
//   4. on 409 guest_session_invalid → drop the claim and send once more
//   5. store the token
//   6. seed the /auth/me cache with the user the response already carried
//   7. put the token in React state
//   8. clear the guest session — unless the server asked us to retry
//
// Two callers is a duplication. Four is a drift: an OAuth first sign-in IS a
// sign-up, so it needs step 4, and a fifth copy of "resend without the claim"
// is a fifth chance to get `claimRetryable` backwards. Hence one function,
// with the two genuine differences as parameters.
//
// ── THE TWO PARAMETERS, AND WHY THEY ARE NOT ONE ─────────────────────────
//
// `send` takes the claim fields rather than closing over them, because step 4
// has to send the SAME request without them. A closure would have to be
// rebuilt by the caller, which is the duplication this removes.
//
// `resendWithoutClaimOn409` is false for a password LOGIN and true for a
// password SIGN-UP and for both OAuth routes. Not because login cannot 409 —
// it is that a 409 there would mean something this code has not been told
// about, and silently retrying an unknown 409 without the claim is how a
// stale-session bug becomes a double sign-in.

import { guestTeardownAfterClaim, signupRetryWithoutClaim } from "@/lib/guest/claim";
import { ApiError } from "@/lib/api/errors";
import type { AuthResponse } from "@/lib/auth";
import type { ClaimResponse } from "@/lib/guest/claim";

export interface AuthClaimFields {
  guestSessionId?: string;
  localDate?: string;
}

/**
 * One attempt. Called once normally, twice when the claim is refused — the
 * second time with `{}`.
 */
export type AuthSend<R extends AuthResponse = AuthResponse> = (
  claim: AuthClaimFields,
) => Promise<R>;

export interface AuthCompletionDeps {
  readGuestSessionId: () => string | null;
  clearGuestSession: () => void;
  todayLocalDate: () => string;
  storeToken: (token: string) => Promise<void>;
  /**
   * Seed the /auth/me cache and flip React state — the two things that turn a
   * response into a session. One callback, because doing either without the
   * other leaves the app authenticated by half.
   */
  adoptSession: (res: AuthResponse) => void;
}

export interface AuthCompletionOptions {
  /** See the header. False only for a password login. */
  resendWithoutClaimOn409: boolean;
}

// Generic in the response so a caller that gets MORE than AuthResponse keeps
// it: the OAuth routes add `isNewUser`, and a non-generic signature would
// widen it away at exactly the point the screens need it (§1).
export async function completeAuth<R extends AuthResponse>(
  send: AuthSend<R>,
  deps: AuthCompletionDeps,
  opts: AuthCompletionOptions,
): Promise<R> {
  // Read ONCE, before anything: a successful claim clears the store, so after
  // the call there is nothing left to tell us there had been one.
  const guestSessionId = deps.readGuestSessionId() ?? undefined;
  const claim: AuthClaimFields = guestSessionId
    ? { guestSessionId, localDate: deps.todayLocalDate() }
    : {};

  let res: R;
  try {
    res = await send(claim);
  } catch (err) {
    // 🔴 A 409 guest_session_invalid ROLLED THE WHOLE THING BACK. Stage 1 of
    // the claim runs inside the User-creating transaction, so there is no
    // half-made account to "proceed" with — see lib/guest/claim.ts's header,
    // which is where this rule is written down. "Proceed without the claim"
    // therefore means RESEND, once, and then say the plan did not come over.
    const refused =
      opts.resendWithoutClaimOn409 &&
      signupRetryWithoutClaim(
        err instanceof ApiError ? { status: err.status, body: err.body } : null,
        !!guestSessionId,
      );
    if (!refused) throw err;
    deps.clearGuestSession();
    res = await send({});
    // The account exists and the plan did not come over. The screens read
    // these two to choose CLAIM_LOST_LINE over silence.
    //
    // The cast is the price of the generic: TypeScript will not accept a
    // spread of `R` back as `R` (a subtype could have narrowed either of
    // these two fields). Both keys are on AuthResponse and both are being
    // set to values their declared types admit, so the cast asserts nothing
    // the constraint does not already guarantee.
    res = { ...res, claimedPlanId: null, claimRetryable: false } as R;
  }

  await deps.storeToken(res.authToken);
  deps.adoptSession(res);

  // Clear on success; KEEP when the server asked us to retry, so the next
  // sign-in with the same id finishes stage 2.
  if (guestSessionId && guestTeardownAfterClaim(res) === "clear") {
    deps.clearGuestSession();
  }
  return res;
}

// ── where a completed sign-in lands ───────────────────────────────────────
//
// §2.5 — "After success, the routing is IDENTICAL to a password
// sign-in/sign-up: onboardingRequired → onboarding, else Home."
//
// This is claimDestination's decision with the route names attached, kept
// beside completeAuth because it is the other half of "what happens after a
// 2xx" and because break (4) of this block aims at exactly one thing: that
// `onboardingRequired` is READ.
//
// ⚠️ An ABSENT field routes to onboarding — the safe direction, and the one
// lib/guest/claim.ts already argues: a user sent to onboarding they did not
// need loses a minute; a user who skipped onboarding they did need has an
// account with no preferences. It is also what a pre-OAuth server would send.

export type AuthLandingRoute = "/(tabs)" | "/onboarding-prefs";

export function authLanding(res: ClaimResponse): AuthLandingRoute {
  return res.onboardingRequired === false ? "/(tabs)" : "/onboarding-prefs";
}

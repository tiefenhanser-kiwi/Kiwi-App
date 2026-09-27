// Row 13 "Test Kitchen" · Block 2 Part E (R7) — the claim's decisions.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLAIM_BUSY_LABEL,
  CLAIM_LOST_LINE,
  CLAIM_RETRY_LINE,
  claimDestination,
  guestTeardownAfterClaim,
  signupRetryWithoutClaim,
} from "../claim";

// ── where the user lands (R7: "put the user in the home screen") ─────────

test("a claim that copied preferences lands on HOME", () => {
  assert.equal(
    claimDestination({ onboardingRequired: false, claimedPlanId: "p1" }),
    "home",
  );
});

test("an ordinary sign-up keeps today's route to onboarding", () => {
  assert.equal(claimDestination({ onboardingRequired: true }), "onboarding");
});

test("🔴 an ABSENT onboardingRequired routes to ONBOARDING — the safe direction", () => {
  // It means the server predates the field. A user sent to onboarding they did
  // not need loses a minute; a user who skipped onboarding they did need has an
  // account with no preferences.
  assert.equal(claimDestination({}), "onboarding");
  assert.equal(claimDestination({ claimedPlanId: "p1" }), "onboarding");
});

// ── the guest session afterwards ─────────────────────────────────────────

test("a successful claim CLEARS the guest session", () => {
  assert.equal(
    guestTeardownAfterClaim({ claimedPlanId: "p1", claimRetryable: false }),
    "clear",
  );
});

test("🔴 claimRetryable KEEPS it — the next sign-in retries stage 2", () => {
  assert.equal(guestTeardownAfterClaim({ claimRetryable: true }), "keep");
});

test("claimRetryable wins over a claimedPlanId when both arrive", () => {
  // A server still telling us to retry is the authority on whether it is done.
  assert.equal(
    guestTeardownAfterClaim({ claimedPlanId: "p1", claimRetryable: true }),
    "keep",
  );
});

test("absent fields clear — there is nothing to retry", () => {
  assert.equal(guestTeardownAfterClaim({}), "clear");
});

// ── the 409 ──────────────────────────────────────────────────────────────

test("🔴 409 guest_session_invalid → RESEND the sign-up without the claim", () => {
  // The 409 rolled the whole sign-up back (stage 1 of the claim is inside the
  // User-creating transaction), so there is no half-made account to proceed
  // with. "Proceeds without the claim" means resend.
  assert.equal(
    signupRetryWithoutClaim({ status: 409, body: { code: "guest_session_invalid" } }, true),
    true,
  );
});

test("no guestSessionId was sent → nothing to retry without", () => {
  assert.equal(
    signupRetryWithoutClaim({ status: 409, body: { code: "guest_session_invalid" } }, false),
    false,
  );
});

test("🔴 keyed on the CODE, not on the 409 — the next thing that 409s must not be swallowed", () => {
  assert.equal(signupRetryWithoutClaim({ status: 409, body: { code: "something_else" } }, true), false);
  assert.equal(signupRetryWithoutClaim({ status: 409, body: {} }, true), false);
  assert.equal(signupRetryWithoutClaim({ status: 409, body: null }, true), false);
  assert.equal(signupRetryWithoutClaim({ status: 409 }, true), false);
});

test("any other status is not this path — a 400, a 429 and a 500 all surface", () => {
  for (const status of [400, 401, 429, 500, 503]) {
    assert.equal(
      signupRetryWithoutClaim({ status, body: { code: "guest_session_invalid" } }, true),
      false,
      String(status),
    );
  }
});

test("a null / undefined error never retries", () => {
  assert.equal(signupRetryWithoutClaim(null, true), false);
  assert.equal(signupRetryWithoutClaim(undefined, true), false);
});

// ── copy ─────────────────────────────────────────────────────────────────

test("the busy label says what is happening (R7 — the claim takes ~10s)", () => {
  assert.equal(CLAIM_BUSY_LABEL, "Saving your plan…");
});

test("both claim lines say the ACCOUNT is ready, and neither mentions a price or a trial", () => {
  for (const line of [CLAIM_LOST_LINE, CLAIM_RETRY_LINE]) {
    assert.match(line, /account is ready/i);
    assert.equal(/trial/i.test(line), false);
    assert.equal(/\$/.test(line), false);
  }
});

// Row 9 (1.1) · OAuth Block 2 Part B — the one completion path, and where a
// completed sign-in lands (§2.5).

import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "@/lib/api/errors";
import { authLanding, completeAuth } from "../authCompletion";
import type { AuthCompletionDeps } from "../authCompletion";
import type { AuthResponse } from "@/lib/auth";
import type { User } from "@/lib/types";

const USER = { id: "u1", email: "a@b.c" } as unknown as User;

function response(over: Partial<AuthResponse> = {}): AuthResponse {
  return { user: USER, authToken: "tok", ...over };
}

interface Recorder {
  deps: AuthCompletionDeps;
  stored: string[];
  adopted: AuthResponse[];
  cleared: number;
  guestSessionId: string | null;
}

function recorder(guestSessionId: string | null): Recorder {
  const r: Recorder = {
    stored: [],
    adopted: [],
    cleared: 0,
    guestSessionId,
    deps: {
      readGuestSessionId: () => r.guestSessionId,
      clearGuestSession: () => {
        r.cleared += 1;
        r.guestSessionId = null;
      },
      todayLocalDate: () => "2026-09-27",
      storeToken: async (t) => {
        r.stored.push(t);
      },
      adoptSession: (res) => {
        r.adopted.push(res);
      },
    },
  };
  return r;
}

const SIGNUP_LIKE = { resendWithoutClaimOn409: true };
const LOGIN_LIKE = { resendWithoutClaimOn409: false };

// ── the ordinary path ────────────────────────────────────────────────────

test("no guest session: an empty claim, then token stored and session adopted", async () => {
  const r = recorder(null);
  const sent: unknown[] = [];
  const res = await completeAuth(
    async (claim) => {
      sent.push(claim);
      return response();
    },
    r.deps,
    SIGNUP_LIKE,
  );
  assert.deepEqual(sent, [{}]);
  assert.deepEqual(r.stored, ["tok"]);
  assert.equal(r.adopted.length, 1);
  assert.equal(r.adopted[0], res);
  assert.equal(r.cleared, 0, "nothing to clear");
});

test("a guest session rides with TODAY'S LOCAL date, and is cleared on success", async () => {
  const r = recorder("gs_1");
  const sent: unknown[] = [];
  await completeAuth(
    async (claim) => {
      sent.push(claim);
      return response({ claimedPlanId: "p1", claimRetryable: false });
    },
    r.deps,
    SIGNUP_LIKE,
  );
  assert.deepEqual(sent, [{ guestSessionId: "gs_1", localDate: "2026-09-27" }]);
  assert.equal(r.cleared, 1);
});

test("🔴 claimRetryable KEEPS the guest session so the next sign-in finishes stage 2", async () => {
  const r = recorder("gs_1");
  await completeAuth(
    async () => response({ claimedPlanId: null, claimRetryable: true }),
    r.deps,
    SIGNUP_LIKE,
  );
  assert.equal(r.cleared, 0);
  assert.equal(r.guestSessionId, "gs_1");
});

test("the guest id is read ONCE, before the call — a cleared store afterwards is too late", async () => {
  const r = recorder("gs_1");
  let reads = 0;
  const base = r.deps.readGuestSessionId;
  r.deps.readGuestSessionId = () => {
    reads += 1;
    return base();
  };
  await completeAuth(
    async () => {
      r.deps.clearGuestSession();
      return response({ claimedPlanId: "p1" });
    },
    r.deps,
    SIGNUP_LIKE,
  );
  assert.equal(reads, 1);
});

// ── the 409 ──────────────────────────────────────────────────────────────

test("409 guest_session_invalid: the claim is dropped and the SAME request is resent once", async () => {
  const r = recorder("gs_1");
  const sent: unknown[] = [];
  const res = await completeAuth(
    async (claim) => {
      sent.push(claim);
      if (sent.length === 1) {
        throw new ApiError("conflict", {
          status: 409,
          body: { code: "guest_session_invalid" },
        });
      }
      return response({ claimedPlanId: "p9", claimRetryable: true });
    },
    r.deps,
    SIGNUP_LIKE,
  );
  assert.deepEqual(sent, [{ guestSessionId: "gs_1", localDate: "2026-09-27" }, {}]);
  // The resend's own claim fields are OVERWRITTEN: the account exists and the
  // plan did not come over, whatever the second response happened to echo.
  assert.equal(res.claimedPlanId, null);
  assert.equal(res.claimRetryable, false);
  assert.deepEqual(r.stored, ["tok"], "exactly one token stored");
});

test("🔴 a password LOGIN does not resend — an unknown 409 propagates", async () => {
  const r = recorder("gs_1");
  let calls = 0;
  await assert.rejects(
    () =>
      completeAuth(
        async () => {
          calls += 1;
          throw new ApiError("conflict", {
            status: 409,
            body: { code: "guest_session_invalid" },
          });
        },
        r.deps,
        LOGIN_LIKE,
      ),
    /conflict/,
  );
  assert.equal(calls, 1);
  assert.equal(r.stored.length, 0, "no token on a refusal");
});

test("a 409 with a DIFFERENT code is not resent", async () => {
  const r = recorder("gs_1");
  let calls = 0;
  await assert.rejects(
    () =>
      completeAuth(
        async () => {
          calls += 1;
          throw new ApiError("conflict", { status: 409, body: { code: "email_taken" } });
        },
        r.deps,
        SIGNUP_LIKE,
      ),
    /conflict/,
  );
  assert.equal(calls, 1);
});

test("a 409 with no claim sent is not resent — there was nothing to drop", async () => {
  const r = recorder(null);
  let calls = 0;
  await assert.rejects(
    () =>
      completeAuth(
        async () => {
          calls += 1;
          throw new ApiError("conflict", {
            status: 409,
            body: { code: "guest_session_invalid" },
          });
        },
        r.deps,
        SIGNUP_LIKE,
      ),
    /conflict/,
  );
  assert.equal(calls, 1);
});

test("a 401 propagates untouched, with no token stored and no session adopted", async () => {
  const r = recorder("gs_1");
  await assert.rejects(
    () =>
      completeAuth(
        async () => {
          throw new ApiError("refused", { status: 401, body: null });
        },
        r.deps,
        SIGNUP_LIKE,
      ),
    /refused/,
  );
  assert.equal(r.stored.length, 0);
  assert.equal(r.adopted.length, 0);
  assert.equal(r.guestSessionId, "gs_1", "a refused sign-in does not spend the session");
});

// ── ordering ─────────────────────────────────────────────────────────────

test("the token is stored BEFORE the session is adopted", async () => {
  const order: string[] = [];
  const r = recorder(null);
  r.deps.storeToken = async () => {
    order.push("store");
  };
  r.deps.adoptSession = () => {
    order.push("adopt");
  };
  await completeAuth(async () => response(), r.deps, SIGNUP_LIKE);
  assert.deepEqual(order, ["store", "adopt"]);
});

// ── extra response fields survive (the generic) ──────────────────────────

test("a response with isNewUser keeps it — including through the 409 resend", async () => {
  const r = recorder("gs_1");
  let first = true;
  const res = await completeAuth(
    async () => {
      if (first) {
        first = false;
        throw new ApiError("conflict", {
          status: 409,
          body: { code: "guest_session_invalid" },
        });
      }
      return { ...response(), isNewUser: true };
    },
    r.deps,
    SIGNUP_LIKE,
  );
  assert.equal(res.isNewUser, true);
  assert.equal(res.claimedPlanId, null);
});

// ── 🔴 break (4): the landing must READ onboardingRequired ────────────────

test("🔴 onboardingRequired === false lands on HOME; true lands on ONBOARDING", () => {
  assert.equal(authLanding({ onboardingRequired: false }), "/(tabs)");
  assert.equal(authLanding({ onboardingRequired: true }), "/onboarding-prefs");
});

test("🔴 an ABSENT onboardingRequired lands on ONBOARDING — the safe direction", () => {
  // It means the server predates the field. A user sent to onboarding they did
  // not need loses a minute; a user who skipped onboarding they did need has
  // an account with no preferences.
  assert.equal(authLanding({}), "/onboarding-prefs");
});

test("🔴 a claimed plan does NOT override onboardingRequired", () => {
  // The two are decided by the server together: a claim that copied
  // preferences is exactly what sets onboardingRequired false. Reading
  // claimedPlanId instead would land a retryable claim on Home with no
  // preferences.
  assert.equal(authLanding({ claimedPlanId: "p1" }), "/onboarding-prefs");
  assert.equal(
    authLanding({ claimedPlanId: "p1", onboardingRequired: false }),
    "/(tabs)",
  );
  assert.equal(
    authLanding({ claimedPlanId: null, onboardingRequired: false }),
    "/(tabs)",
  );
});

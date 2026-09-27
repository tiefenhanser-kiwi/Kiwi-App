// D-WS9-241 B (BUG-258) — the pure bootstrap seam.
//
// deriveBootstrapStatus: what AuthContext exposes as bootstrapStatus.
// sessionGateShouldEvict: what app/_layout.tsx's SessionGate asks before it
// calls router.replace. app/** is outside the test glob (D-WS9-164), so the
// non-eviction guarantee is pinned HERE, on the function the gate calls.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BOOTSTRAP_DEADLINE_MS,
  GUEST_ROUTE_GROUP,
  deriveBootstrapStatus,
  deriveGuestRouteStatus,
  isGuestRouteGroup,
  sessionGateShouldEvict,
} from "../sessionBootstrap";

test("the ruled deadline is 10 seconds", () => {
  assert.equal(BOOTSTRAP_DEADLINE_MS, 10_000);
});

// ── deriveBootstrapStatus ──────────────────────────────────────────────

test("storage not yet read → pending, whatever else is true", () => {
  assert.equal(
    deriveBootstrapStatus({ storageRead: false, token: null, hasMeData: false, meIsError: false }),
    "pending",
  );
  assert.equal(
    deriveBootstrapStatus({ storageRead: false, token: "t", hasMeData: true, meIsError: true }),
    "pending",
  );
});

test("no token → ok (Welcome); this is also where a readToken() rejection lands", () => {
  assert.equal(
    deriveBootstrapStatus({ storageRead: true, token: null, hasMeData: false, meIsError: false }),
    "ok",
  );
  // A stale error from a previous session's query must not resurrect a
  // failure screen for a signed-out user.
  assert.equal(
    deriveBootstrapStatus({ storageRead: true, token: null, hasMeData: false, meIsError: true }),
    "ok",
  );
});

test("token + /auth/me in flight (no data, no error) → pending", () => {
  assert.equal(
    deriveBootstrapStatus({ storageRead: true, token: "t", hasMeData: false, meIsError: false }),
    "pending",
  );
});

test("token + /auth/me resolved → ok (a 401's null resolution included)", () => {
  assert.equal(
    deriveBootstrapStatus({ storageRead: true, token: "t", hasMeData: true, meIsError: false }),
    "ok",
  );
});

test("token + /auth/me threw (abort / network / 5xx) → failed", () => {
  assert.equal(
    deriveBootstrapStatus({ storageRead: true, token: "t", hasMeData: false, meIsError: true }),
    "failed",
  );
});

test("an error AFTER a successful load (mid-session refetch) is not a bootstrap failure", () => {
  // react-query keeps the last data on a failed refetch; the user is still
  // signed in and must not be dropped onto the failure screen mid-use.
  assert.equal(
    deriveBootstrapStatus({ storageRead: true, token: "t", hasMeData: true, meIsError: true }),
    "ok",
  );
});

// ── sessionGateShouldEvict ─────────────────────────────────────────────

const DEAD_SESSION_GROUPS = ["(tabs)", "plan", "meal", "grocery-list", "preferences"];

test("pending → never evicts", () => {
  for (const group of [undefined, "(auth)", ...DEAD_SESSION_GROUPS]) {
    assert.equal(
      sessionGateShouldEvict({ bootstrapStatus: "pending", hasUser: false, group }),
      false,
      `group=${String(group)}`,
    );
  }
});

test("FAILED → never evicts, on any route (the non-eviction the failure screen depends on)", () => {
  for (const group of [undefined, "(auth)", ...DEAD_SESSION_GROUPS]) {
    assert.equal(
      sessionGateShouldEvict({ bootstrapStatus: "failed", hasUser: false, group }),
      false,
      `group=${String(group)}`,
    );
  }
});

test("ok + user present → never evicts", () => {
  for (const group of [undefined, "(auth)", ...DEAD_SESSION_GROUPS]) {
    assert.equal(
      sessionGateShouldEvict({ bootstrapStatus: "ok", hasUser: true, group }),
      false,
      `group=${String(group)}`,
    );
  }
});

test("ok + no user at '/' or inside '(auth)' → stays (index.tsx / sign-in own those)", () => {
  assert.equal(
    sessionGateShouldEvict({ bootstrapStatus: "ok", hasUser: false, group: undefined }),
    false,
  );
  assert.equal(
    sessionGateShouldEvict({ bootstrapStatus: "ok", hasUser: false, group: "(auth)" }),
    false,
  );
});

test("ok + no user on an authenticated route → evicts (WS9 BUG-239, unchanged)", () => {
  for (const group of DEAD_SESSION_GROUPS) {
    assert.equal(
      sessionGateShouldEvict({ bootstrapStatus: "ok", hasUser: false, group }),
      true,
      `group=${group}`,
    );
  }
});

// ── Row 13 "Test Kitchen" · Block 2 Part B — the guest ─────────────────
//
// 🔴 THE CASE THAT WOULD HAVE BROKEN THE TEST KITCHEN OUTRIGHT. "/test-kitchen"
// is a top-level route, so useSegments()[0] is "test-kitchen": not undefined and
// not "(auth)". A visitor there holds no user token, so deriveBootstrapStatus
// answers "ok" and hasUser is false — the exact triple this gate evicts. Without
// the isGuest read the gate replaced the guest wizard with /(auth)/sign-in the
// instant it mounted.

test("🔴 a guest on the Test Kitchen route is NOT evicted", () => {
  assert.equal(
    sessionGateShouldEvict({
      bootstrapStatus: "ok",
      hasUser: false,
      group: "test-kitchen",
      isGuest: true,
    }),
    false,
  );
});

// ── Row 13 Block 2b (BUG-314) — guest territory is decided by PATH ─────
//
// 🔴 THE COLD DOOR. A Block 2 test stood exactly here asserting the OPPOSITE of
// the first case below — "WITHOUT the guest flag the same route evicts" — and it
// was green, because it pinned the bug: GuestContext derives
// isGuest from a STORED CREDENTIAL, and on a first visit there is none until
// POST /guest/session resolves (~580 ms, measured). Every browser-pass cold
// entry to /test-kitchen therefore landed on /(auth)/sign-in and stayed there.
// The case is inverted below, deliberately, and that inversion IS the fix.

test("🔴 COLD guest route — no token yet — is guest_pending and is NEVER evicted", () => {
  assert.equal(deriveGuestRouteStatus("test-kitchen", false), "guest_pending");
  assert.equal(
    sessionGateShouldEvict({ bootstrapStatus: "ok", hasUser: false, group: "test-kitchen" }),
    false,
  );
  // Explicit-false isGuest is the same cold state, spelled out.
  assert.equal(
    sessionGateShouldEvict({
      bootstrapStatus: "ok",
      hasUser: false,
      group: "test-kitchen",
      isGuest: false,
    }),
    false,
  );
});

test("a guest route WITH a token is `guest` — and still not evicted", () => {
  assert.equal(deriveGuestRouteStatus("test-kitchen", true), "guest");
  assert.equal(
    sessionGateShouldEvict({
      bootstrapStatus: "ok",
      hasUser: false,
      group: "test-kitchen",
      isGuest: true,
    }),
    false,
  );
});

test("a FAILED guest session create is still the guest route, not sign-in", () => {
  // POST /guest/session rejected (network / 403 Turnstile / 429 / 503): the
  // credential never arrives, so isGuest stays false forever on this screen.
  // The gate must still not move — app/test-kitchen/index.tsx's `status ===
  // "failed"` card (with its own retry) owns that state.
  assert.equal(deriveGuestRouteStatus(GUEST_ROUTE_GROUP, false), "guest_pending");
  assert.equal(
    sessionGateShouldEvict({
      bootstrapStatus: "ok",
      hasUser: false,
      group: GUEST_ROUTE_GROUP,
      isGuest: false,
    }),
    false,
  );
});

test("the path rule covers the guest route group only — a MEMBER route with no token still evicts", () => {
  assert.equal(isGuestRouteGroup(GUEST_ROUTE_GROUP), true);
  for (const group of [...DEAD_SESSION_GROUPS, "test-kitchen-ish", "test", undefined, "(auth)"]) {
    assert.equal(isGuestRouteGroup(group), false, `group=${String(group)}`);
    assert.equal(deriveGuestRouteStatus(group, false), "not_guest_route", `group=${String(group)}`);
  }
  // And the eviction those member groups get is unchanged (BUG-239).
  for (const group of DEAD_SESSION_GROUPS) {
    assert.equal(
      sessionGateShouldEvict({ bootstrapStatus: "ok", hasUser: false, group }),
      true,
      `group=${group}`,
    );
  }
});

test("the guest route is not evicted on ANY bootstrap status — the path outranks all of them", () => {
  for (const bootstrapStatus of ["pending", "ok", "failed"] as const) {
    assert.equal(
      sessionGateShouldEvict({
        bootstrapStatus,
        hasUser: false,
        group: GUEST_ROUTE_GROUP,
      }),
      false,
      bootstrapStatus,
    );
  }
});

test("a signed-in MEMBER on the guest route keeps today's behaviour — no eviction, no redirect", () => {
  // hasUser short-circuits above the path check, so this was already false
  // before Block 2b and still is. Pinned so the path rule cannot be read as
  // having changed it.
  assert.equal(
    sessionGateShouldEvict({
      bootstrapStatus: "ok",
      hasUser: true,
      group: GUEST_ROUTE_GROUP,
      isGuest: false,
    }),
    false,
  );
});

test("a guest is not evicted from ANY route — the flag is about the visitor, not the path", () => {
  for (const group of [undefined, "(auth)", "test-kitchen", ...DEAD_SESSION_GROUPS]) {
    assert.equal(
      sessionGateShouldEvict({
        bootstrapStatus: "ok",
        hasUser: false,
        group,
        isGuest: true,
      }),
      false,
      `group=${String(group)}`,
    );
  }
});

test("a guest is not treated as SIGNED IN — hasUser stays the only signed-in signal", () => {
  // The guest flag suppresses the eviction and nothing else. A real user on a
  // dead session is still evicted; deriveBootstrapStatus never sees isGuest at
  // all, so a guest with a token in hand (a claim mid-flight) still bootstraps.
  assert.equal(
    deriveBootstrapStatus({
      storageRead: true,
      token: null,
      hasMeData: false,
      meIsError: false,
    }),
    "ok",
  );
  assert.equal(
    sessionGateShouldEvict({
      bootstrapStatus: "ok",
      hasUser: false,
      group: "(tabs)",
      isGuest: false,
    }),
    true,
  );
});

test("isGuest is optional — every pre-Row-13 call keeps its meaning", () => {
  assert.equal(
    sessionGateShouldEvict({ bootstrapStatus: "ok", hasUser: false, group: "(tabs)" }),
    true,
  );
  assert.equal(
    sessionGateShouldEvict({ bootstrapStatus: "pending", hasUser: false, group: "(tabs)" }),
    false,
  );
});

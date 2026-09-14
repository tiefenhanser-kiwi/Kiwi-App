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
  deriveBootstrapStatus,
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

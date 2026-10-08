// Resub C3 (BUG-361) — the pre-warmed Turnstile token's store and the decision
// at the Explore tap. Boundaries are LITERALS (239 s, 240 s, 241 s), not derived
// from TURNSTILE_TOKEN_FRESH_MS: a test that reads the constant it is checking
// cannot notice the constant moving.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decideTurnstileEntry,
  decideTurnstileRetry,
  isFreshTurnstileToken,
  TURNSTILE_TOKEN_FRESH_MS,
  TURNSTILE_WARM_IDLE,
  turnstileWarmReducer,
  type TurnstileWarmStore,
} from "../turnstilePrewarm";

const T0 = 1_760_000_000_000;
const READY: TurnstileWarmStore = { status: "ready", token: "tok", issuedAt: T0 };

test("fresh for 240 s: the widget's 300 s less a minute", () => {
  assert.equal(TURNSTILE_TOKEN_FRESH_MS, 240_000);
});

test("🔴 fresh at 239 s, stale at 240 s and 241 s", () => {
  assert.equal(isFreshTurnstileToken(READY, T0 + 239_000), true);
  assert.equal(isFreshTurnstileToken(READY, T0 + 240_000), false);
  assert.equal(isFreshTurnstileToken(READY, T0 + 241_000), false);
});

test("no token, or no issue time, is never fresh", () => {
  assert.equal(isFreshTurnstileToken(TURNSTILE_WARM_IDLE, T0), false);
  assert.equal(isFreshTurnstileToken({ status: "ready", token: "tok", issuedAt: null }, T0), false);
  assert.equal(isFreshTurnstileToken({ status: "ready", token: null, issuedAt: T0 }, T0), false);
});

test("the warm: idle → warming → ready with the token and its time", () => {
  const warming = turnstileWarmReducer(TURNSTILE_WARM_IDLE, { type: "warm" });
  assert.deepEqual(warming, { status: "warming", token: null, issuedAt: null });
  assert.deepEqual(turnstileWarmReducer(warming, { type: "token", token: "tok", at: T0 }), READY);
});

test("interactive: a warming widget that wants a checkbox stands down", () => {
  const warming = turnstileWarmReducer(TURNSTILE_WARM_IDLE, { type: "warm" });
  assert.deepEqual(turnstileWarmReducer(warming, { type: "interactive" }), {
    status: "interactive",
    token: null,
    issuedAt: null,
  });
  // A token already held is not undone by it.
  assert.deepEqual(turnstileWarmReducer(READY, { type: "interactive" }), READY);
});

test("failed: only from warming; a token or an interactive verdict is kept", () => {
  const warming = turnstileWarmReducer(TURNSTILE_WARM_IDLE, { type: "warm" });
  assert.equal(turnstileWarmReducer(warming, { type: "failed" }).status, "failed");
  assert.deepEqual(turnstileWarmReducer(READY, { type: "failed" }), READY);
  const interactive = turnstileWarmReducer(warming, { type: "interactive" });
  assert.equal(turnstileWarmReducer(interactive, { type: "failed" }).status, "interactive");
});

test("expired: the widget re-solves — the token goes, the store is warming again", () => {
  assert.deepEqual(turnstileWarmReducer(READY, { type: "expired" }), {
    status: "warming",
    token: null,
    issuedAt: null,
  });
});

test("consume and discard both empty the store (single use; stale)", () => {
  assert.deepEqual(turnstileWarmReducer(READY, { type: "consume" }), TURNSTILE_WARM_IDLE);
  assert.deepEqual(turnstileWarmReducer(READY, { type: "discard" }), TURNSTILE_WARM_IDLE);
});

test("🔴 decideTurnstileEntry: use_token ONLY for a fresh ready token", () => {
  assert.equal(decideTurnstileEntry(READY, T0 + 239_000), "use_token");
  assert.equal(decideTurnstileEntry(READY, T0 + 241_000), "show_gate");
  for (const status of ["idle", "warming", "interactive", "failed"] as const) {
    // Even a token-shaped leftover in another status is not used.
    assert.equal(
      decideTurnstileEntry({ status, token: "tok", issuedAt: T0 }, T0 + 1_000),
      "show_gate",
      status,
    );
  }
});

// ── Resub C4 · BUG-368 — a retry never resends a token ─────────────────────

const C4_T0 = 1_000_000;
const readyStore = (token: string, issuedAt = C4_T0) => ({ status: "ready" as const, token, issuedAt });

test("C4 🔴 BUG-368 the token in hand was already sent → regate, never a resend", () => {
  const d = decideTurnstileRetry({
    gated: true,
    tokenInHand: "tok-1",
    sentTokens: new Set(["tok-1"]),
    warm: TURNSTILE_WARM_IDLE,
    now: C4_T0,
  });
  assert.deepEqual(d, { action: "regate" });
});

test("C4 BUG-368 a FRESH pre-warmed token that arrived since is taken instead of re-solving", () => {
  const d = decideTurnstileRetry({
    gated: true,
    tokenInHand: "tok-1",
    sentTokens: new Set(["tok-1"]),
    warm: readyStore("tok-2", C4_T0),
    now: C4_T0 + 1_000,
  });
  assert.deepEqual(d, { action: "start", token: "tok-2", fromWarm: true });
});

test("C4 BUG-368 a pre-warmed token that was itself the one sent, or is stale, is not reused", () => {
  assert.deepEqual(
    decideTurnstileRetry({
      gated: true,
      tokenInHand: "tok-2",
      sentTokens: new Set(["tok-2"]),
      warm: readyStore("tok-2"),
      now: C4_T0 + 1_000,
    }),
    { action: "regate" },
  );
  assert.deepEqual(
    decideTurnstileRetry({
      gated: true,
      tokenInHand: null,
      sentTokens: new Set(),
      warm: readyStore("tok-3", C4_T0),
      now: C4_T0 + TURNSTILE_TOKEN_FRESH_MS,
    }),
    { action: "regate" },
  );
});

test("C4 BUG-368 an unsent token in hand is used; Turnstile off sends none", () => {
  assert.deepEqual(
    decideTurnstileRetry({ gated: true, tokenInHand: "tok-9", sentTokens: new Set(), warm: TURNSTILE_WARM_IDLE, now: C4_T0 }),
    { action: "start", token: "tok-9", fromWarm: false },
  );
  assert.deepEqual(
    decideTurnstileRetry({ gated: false, tokenInHand: "tok-9", sentTokens: new Set(["tok-9"]), warm: TURNSTILE_WARM_IDLE, now: C4_T0 }),
    { action: "start", token: null, fromWarm: false },
  );
});

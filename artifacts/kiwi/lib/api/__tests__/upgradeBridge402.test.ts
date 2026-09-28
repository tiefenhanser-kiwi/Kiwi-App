// Row 9 (1.1) · Stripe S2 Part D — 402 REACHES THE SHEET, FROM THE FETCH LAYER.
//
// §2.7's rule is that 402 is handled at ONE place and that no screen handles it on
// its own. The half of that which can be tested without a device is this: does a
// 402 anywhere in the client announce on upgrade-bridge, in BOTH error modes, and
// does nothing else announce?
//
// 🔴 DELIBERATE BREAK (3) IN THE S2 REPORT REMOVES THE emitUpgradeRequired CALL
// FROM lib/api/client.ts AND THIS FILE GOES RED. That is the whole reason it is a
// bridge test and not a component test: a component test would prove the sheet
// renders from a state value, which is not the thing that breaks.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import * as SecureStore from "expo-secure-store";

import { apiClient } from "../client";
import { UpgradeRequiredError } from "../errors";
import { __resetForTests as resetAuthBridge } from "../auth-bridge";
import {
  __resetForTests as resetUpgradeBridge,
  subscribeUpgradeEvents,
  type UpgradeRequiredEvent,
} from "../upgrade-bridge";

const TOKEN_KEY = "kiwi_authToken";

function stubFetch(status: number, body: unknown): void {
  (globalThis as { fetch: unknown }).fetch = async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => (body === undefined ? "" : JSON.stringify(body)),
    }) as unknown as Response;
}

/** The bridge dispatches in a microtask, so a test must let one drain. */
async function drain(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
}

let seen: UpgradeRequiredEvent[] = [];
let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  (
    SecureStore as unknown as { __setForTests(k: string, v: string): void }
  ).__setForTests(TOKEN_KEY, "test-token");
  resetAuthBridge();
  resetUpgradeBridge();
  seen = [];
  unsubscribe = subscribeUpgradeEvents((e) => {
    seen.push(e);
  });
});

afterEach(() => {
  unsubscribe?.();
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
  resetAuthBridge();
  resetUpgradeBridge();
});

// ── the rule ─────────────────────────────────────────────────────────────

test("🔴 a 402 in THROW mode announces on the bridge, and still throws the typed error", async () => {
  stubFetch(402, {
    error: "upgrade required",
    code: "subscription_required",
    reason: "Your free trial has ended.",
  });
  await assert.rejects(
    () => apiClient("/wizard/build-plans", { method: "POST" }),
    UpgradeRequiredError,
  );
  await drain();
  assert.equal(seen.length, 1, "the sheet is opened from here, not by the screen");
  assert.equal(seen[0].path, "/wizard/build-plans");
  assert.deepEqual(seen[0].body, {
    error: "upgrade required",
    code: "subscription_required",
    reason: "Your free trial has ended.",
  });
});

test("🔴 a 402 in ENVELOPE mode announces TOO — half the gated routes use it", async () => {
  // grocery generate and recipe import are envelope-mode callers, and they are the
  // paths most likely to meet a gate. Announcing only in throw mode would mean the
  // paywall never opens for them.
  stubFetch(402, { code: "subscription_required" });
  const res = await apiClient("/plans/plan-1/generate-grocery-list", {
    method: "POST",
    errorMode: "envelope",
  });
  assert.equal(res.success, false);
  assert.ok(!res.success && res.error instanceof UpgradeRequiredError);
  await drain();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, "/plans/plan-1/generate-grocery-list");
});

test("the body is carried through even when the server sent none", async () => {
  stubFetch(402, undefined);
  await assert.rejects(() => apiClient("/recipes/scale", { method: "POST" }));
  await drain();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body, undefined);
});

// ── and nothing else announces ───────────────────────────────────────────

test("no other status announces — a 401, 403, 429, 500 or 200 is silent here", async () => {
  for (const status of [200, 401, 403, 404, 429, 500, 503]) {
    resetUpgradeBridge();
    seen = [];
    unsubscribe?.();
    unsubscribe = subscribeUpgradeEvents((e) => seen.push(e));
    resetAuthBridge();
    stubFetch(status, status === 200 ? {} : { error: "nope" });
    try {
      await apiClient("/me", { errorMode: "envelope" });
    } catch {
      // A 401 fires the session cascade and may throw; irrelevant here.
    }
    await drain();
    assert.equal(seen.length, 0, `status ${status} must not open the paywall`);
  }
});

test("a network failure does not announce — there is no refusal, only no answer", async () => {
  (globalThis as { fetch: unknown }).fetch = async () => {
    throw new Error("offline");
  };
  await assert.rejects(() => apiClient("/me"));
  await drain();
  assert.equal(seen.length, 0);
});

// ── the fan-out, and why there is no latch ──────────────────────────────

test("concurrent 402s announce once EACH — the subscriber's setState is what de-dupes", async () => {
  // Unlike the 401 cascade, which tears down a session and therefore latches,
  // opening a sheet is idempotent. A latch here would need resetting by whoever
  // closed the sheet, and a latch nobody reset is a paywall that never opens again.
  stubFetch(402, { code: "subscription_required" });
  await Promise.all([
    apiClient("/a", { errorMode: "envelope" }),
    apiClient("/b", { errorMode: "envelope" }),
    apiClient("/c", { errorMode: "envelope" }),
  ]);
  await drain();
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.map((e) => e.path).sort(), ["/a", "/b", "/c"]);
});

test("a THROWING subscriber does not stop the others being told", async () => {
  const alsoSeen: string[] = [];
  const u1 = subscribeUpgradeEvents(() => {
    throw new Error("a subscriber that blew up");
  });
  const u2 = subscribeUpgradeEvents((e) => alsoSeen.push(e.path));
  try {
    stubFetch(402, {});
    await apiClient("/d", { errorMode: "envelope" });
    await drain();
    assert.deepEqual(alsoSeen, ["/d"]);
  } finally {
    u1();
    u2();
  }
});

test("unsubscribing actually stops delivery", async () => {
  unsubscribe?.();
  unsubscribe = null;
  stubFetch(402, {});
  await apiClient("/e", { errorMode: "envelope" });
  await drain();
  assert.equal(seen.length, 0);
});

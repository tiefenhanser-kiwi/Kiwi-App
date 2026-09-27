// Row 9 (1.1) · Stripe S2 Part B — the three routes, their error ladders, and
// the one platform branch.
//
// The link-out branch is asserted through `billingLinkMode` (pure) and through
// `openBillingUrl` with injected sinks, rather than by mutating the react-native
// stub's Platform.OS: the branch is a decision, and a decision is worth a
// function. What a device does with the URL it is handed is in the S2 script.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import * as SecureStore from "expo-secure-store";

import { __resetForTests as resetAuthBridge } from "@/lib/api/auth-bridge";

import {
  SubscriptionPayloadSchema,
  billingLinkMode,
  createCheckoutSession,
  createPortalSession,
  currentBillingPlatform,
  fetchSubscription,
  openBillingUrl,
  SUBSCRIPTION_QUERY_KEY,
} from "../api";

// ── the fetch harness ───────────────────────────────────────────────────

let lastRequest: { url: string; init: RequestInit } | null = null;

function stubFetch(status: number, body: unknown): void {
  lastRequest = null;
  (globalThis as { fetch: unknown }).fetch = async (
    url: string,
    init: RequestInit = {},
  ) => {
    lastRequest = { url: String(url), init };
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => (body === undefined ? "" : JSON.stringify(body)),
    } as unknown as Response;
  };
}

// apiClient requires a token for an authed call; lib/auth.ts reads it from the
// SecureStore stub, so it is seeded per test — the same harness lib/api's own
// tests use, including the auth-bridge reset (a 401 fires the session cascade
// once and stays latched until it is reset).
const TOKEN_KEY = "kiwi_authToken";

beforeEach(() => {
  (
    SecureStore as unknown as { __setForTests(k: string, v: string): void }
  ).__setForTests(TOKEN_KEY, "test-token");
  resetAuthBridge();
});

afterEach(() => {
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
  resetAuthBridge();
});

const WIRE = {
  status: "trialing",
  planCode: "free",
  trialEndsAt: "2026-10-11T12:00:00.000Z",
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  billingAvailable: true,
  enforced: false,
  earlyPayBonusDays: 14,
  firstChargeDateIfSubscribedNow: "2026-10-25T12:00:00.000Z",
};

// ── GET /me/subscription ────────────────────────────────────────────────

test("fetchSubscription hits /me/subscription and parses the S1 shape", async () => {
  stubFetch(200, WIRE);
  const sub = await fetchSubscription();
  assert.ok(lastRequest?.url.endsWith("/me/subscription"), lastRequest?.url);
  assert.equal(sub.status, "trialing");
  assert.equal(sub.enforced, false);
  assert.equal(sub.earlyPayBonusDays, 14);
});

test("an unrecognised status is REFUSED, not rendered as a guess", async () => {
  // A status this client has no branch for cannot be shown correctly, and a
  // paywall shown to the wrong account is worse than a failed query.
  stubFetch(200, { ...WIRE, status: "incomplete_expired" });
  await assert.rejects(() => fetchSubscription(), /schema/i);
});

test("hasBillingAccount is optional — an older server still parses", async () => {
  stubFetch(200, WIRE);
  const sub = await fetchSubscription();
  assert.equal(sub.hasBillingAccount, undefined);
  stubFetch(200, { ...WIRE, hasBillingAccount: true });
  assert.equal((await fetchSubscription()).hasBillingAccount, true);
});

test("an unknown extra field is stripped, not fatal — S1 widened a body this way", () => {
  const parsed = SubscriptionPayloadSchema.parse({ ...WIRE, somethingNew: 7 });
  assert.equal("somethingNew" in parsed, false);
});

test("the query key is the one both the sheet and Settings refetch", () => {
  assert.deepEqual([...SUBSCRIPTION_QUERY_KEY], ["me", "subscription"]);
});

// ── POST /billing/checkout-session ──────────────────────────────────────

test("createCheckoutSession posts the plan + platform and returns the url", async () => {
  stubFetch(200, { url: "https://checkout.stripe.com/c/pay/cs_test_1" });
  const res = await createCheckoutSession("annual");
  assert.deepEqual(res, { success: true, url: "https://checkout.stripe.com/c/pay/cs_test_1" });
  assert.ok(lastRequest?.url.endsWith("/billing/checkout-session"));
  assert.equal(lastRequest?.init.method, "POST");
  const body = JSON.parse(String(lastRequest?.init.body));
  assert.equal(body.plan, "annual");
  // The stub reports ios; the server's enum accepts it.
  assert.equal(body.platform, currentBillingPlatform());
});

test("409 → already_subscribed, 503 → billing_unavailable, 401 → unauthenticated", async () => {
  stubFetch(409, { code: "already_subscribed" });
  assert.deepEqual(await createCheckoutSession("monthly"), {
    success: false,
    error: "already_subscribed",
  });
  stubFetch(503, { code: "billing_unavailable" });
  assert.deepEqual(await createCheckoutSession("monthly"), {
    success: false,
    error: "billing_unavailable",
  });
  stubFetch(401, { error: "unauthenticated" });
  assert.deepEqual(await createCheckoutSession("monthly"), {
    success: false,
    error: "unauthenticated",
  });
});

test("an unmapped status carries its number through so a log can name it", async () => {
  stubFetch(500, { error: "boom" });
  assert.deepEqual(await createCheckoutSession("monthly"), {
    success: false,
    error: "unknown",
    status: 500,
  });
});

test("a body-less 503 still reads as billing_unavailable — a proxy sends no code", async () => {
  // Keyed on status, not on the body's `code`, exactly so this case works.
  stubFetch(503, undefined);
  assert.deepEqual(await createCheckoutSession("annual"), {
    success: false,
    error: "billing_unavailable",
  });
});

test("a malformed success body is `unknown`, never a navigation to undefined", async () => {
  stubFetch(200, { urls: "oops" });
  const res = await createCheckoutSession("monthly");
  assert.deepEqual(res, { success: false, error: "unknown" });
});

// ── POST /billing/portal-session ────────────────────────────────────────

test("createPortalSession returns the url; 409 is no_billing_account, not already_subscribed", async () => {
  stubFetch(200, { url: "https://billing.stripe.com/p/session/x" });
  assert.deepEqual(await createPortalSession(), {
    success: true,
    url: "https://billing.stripe.com/p/session/x",
  });
  assert.ok(lastRequest?.url.endsWith("/billing/portal-session"));
  stubFetch(409, { code: "no_billing_account" });
  assert.deepEqual(await createPortalSession(), {
    success: false,
    error: "no_billing_account",
  });
  stubFetch(503, { code: "billing_unavailable" });
  assert.deepEqual(await createPortalSession(), {
    success: false,
    error: "billing_unavailable",
  });
});

// ── the link-out ────────────────────────────────────────────────────────

test("🔴 web navigates; every native platform gets the SYSTEM browser", () => {
  assert.equal(billingLinkMode("web"), "navigate");
  for (const os of ["ios", "android", "macos", "windows"]) {
    assert.equal(billingLinkMode(os), "external", os);
  }
});

test("openBillingUrl on native hands the url to the external opener", async () => {
  const opened: string[] = [];
  const ok = await openBillingUrl("https://checkout.stripe.com/x", {
    navigate: () => assert.fail("web path taken on a native platform"),
    openExternal: async (u) => {
      opened.push(u);
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(opened, ["https://checkout.stripe.com/x"]);
});

test("a device with no browser resolves FALSE instead of rejecting", async () => {
  // The screen shows a line; it must not get an unhandled rejection or a button
  // stuck in its busy state.
  const ok = await openBillingUrl("https://checkout.stripe.com/x", {
    navigate: () => assert.fail("web path taken"),
    openExternal: async () => {
      throw new Error("no activity found to handle Intent");
    },
  });
  assert.equal(ok, false);
});

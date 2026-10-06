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
  billingRail,
  createCheckoutSession,
  createPortalSession,
  currentBillingPlatform,
  fetchSubscription,
  openBillingUrl,
  syncStoreSubscription,
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

// Resub C2 — S2's "native gets the SYSTEM browser" is REVERSED on purpose: a
// Stripe link-out in the app was one of Apple's 3.1.1 findings. Native sells
// through the store now (lib/billing/store.ts), and this is the second lock.

test("🔴 web navigates; NO native platform opens a Stripe URL at all", () => {
  assert.equal(billingLinkMode("web"), "navigate");
  for (const os of ["ios", "android", "macos", "windows"]) {
    assert.equal(billingLinkMode(os), "none", os);
  }
});

test("🔴 openBillingUrl on native opens nothing and resolves false", async () => {
  // The react-native stub reports ios.
  const ok = await openBillingUrl("https://checkout.stripe.com/x", {
    navigate: () => assert.fail("a Stripe URL was opened on a native platform"),
  });
  assert.equal(ok, false);
});

test("the rail: web pays through Stripe, iOS and Android through the store", () => {
  assert.equal(billingRail("web"), "stripe");
  assert.equal(billingRail("ios"), "store");
  assert.equal(billingRail("android"), "store");
});

// ── Resub B1 / C2 — the store fields, the 409s, store-sync ─────────────────

test("either server shape parses: with the bonus fields (B1) and without them", () => {
  const withBonus = SubscriptionPayloadSchema.parse({ ...WIRE, earlyPayBonusDays: 0, firstChargeDateIfSubscribedNow: null });
  assert.equal(withBonus.status, "trialing");
  const { earlyPayBonusDays: _a, firstChargeDateIfSubscribedNow: _b, ...noBonus } = WIRE;
  const without = SubscriptionPayloadSchema.parse(noBonus);
  assert.equal(without.earlyPayBonusDays, undefined);
});

test("the B1 store fields parse, and a pre-B1 server (none of them) still parses", () => {
  const b1 = SubscriptionPayloadSchema.parse({
    ...WIRE,
    source: "apple",
    managementUrl: "https://apps.apple.com/account/subscriptions",
    storeBillingAvailable: true,
  });
  assert.equal(b1.source, "apple");
  assert.equal(b1.storeBillingAvailable, true);
  const old = SubscriptionPayloadSchema.parse(WIRE);
  assert.equal(old.source, undefined);
  assert.equal(old.storeBillingAvailable, undefined);
});

test("checkout 409 subscribed_elsewhere is NOT already_subscribed — it carries the store", async () => {
  stubFetch(409, {
    code: "subscribed_elsewhere",
    source: "google",
    managementUrl: "https://play.google.com/store/account/subscriptions",
  });
  assert.deepEqual(await createCheckoutSession("monthly"), {
    success: false,
    error: "subscribed_elsewhere",
    source: "google",
    managementUrl: "https://play.google.com/store/account/subscriptions",
  });
});

test("portal 409 subscribed_elsewhere is NOT no_billing_account; a missing url is null", async () => {
  stubFetch(409, { code: "subscribed_elsewhere", source: "apple", managementUrl: null });
  assert.deepEqual(await createPortalSession(), {
    success: false,
    error: "subscribed_elsewhere",
    source: "apple",
    managementUrl: null,
  });
});

test("store-sync posts {} and answers with the subscription", async () => {
  stubFetch(200, { ...WIRE, status: "active", source: "apple", storeBillingAvailable: true });
  const res = await syncStoreSubscription();
  assert.ok(lastRequest?.url.endsWith("/billing/store-sync"), lastRequest?.url);
  assert.equal(lastRequest?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(lastRequest?.init.body)), {});
  assert.equal(res.success, true);
  if (res.success) assert.equal(res.subscription.status, "active");
});

test("store-sync errors: 502 store_sync_failed, 503 billing_unavailable, 429 rate_limited", async () => {
  stubFetch(502, { code: "store_sync_failed" });
  assert.deepEqual(await syncStoreSubscription(), { success: false, error: "store_sync_failed" });
  stubFetch(503, { code: "billing_unavailable" });
  assert.deepEqual(await syncStoreSubscription(), { success: false, error: "billing_unavailable" });
  stubFetch(429, { error: "slow down" });
  assert.deepEqual(await syncStoreSubscription(), { success: false, error: "rate_limited" });
});

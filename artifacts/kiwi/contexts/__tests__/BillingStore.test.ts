// Resub C2 — BillingProvider on iOS, end to end through the real AuthProvider,
// apiClient and lib/billing/*, with only fetch, SecureStore and the RevenueCat
// SDK replaced.
//
// The three things a unit test cannot prove, because they are WIRING:
//   · a purchase on native never touches a Stripe route or a Stripe URL;
//   · Restore asks the store first and Kiwi second, in that order;
//   · while store-sync is failing, the money is treated as taken — retried, and
//     a second tap on a price is refused rather than sent to the store again.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import * as SecureStore from "expo-secure-store";
import * as ReactNative from "react-native";

import { AuthProvider } from "../AuthContext";
import { BillingProvider, useBilling, type BillingContextValue } from "../BillingContext";
import { __resetForTests as resetAuthBridge } from "@/lib/api/auth-bridge";
import { __resetForTests as resetUpgradeBridge } from "@/lib/api/upgrade-bridge";
import {
  __resetStoreForTests,
  __setStoreSdkForTests,
  type StorePackage,
  type StoreSdk,
} from "@/lib/billing/store";
import { __setStoreSyncBackoffForTests } from "@/lib/billing/storeConfirm";
import type { User } from "@/lib/types";

const store = SecureStore as unknown as {
  __resetForTests(): void;
  __setForTests(k: string, v: string): void;
};
const rn = ReactNative as unknown as {
  Platform: { OS: string };
  __getLinkingCalls(): string[];
  __resetLinking(): void;
};
const IOS_KEY = "EXPO_PUBLIC_REVENUECAT_IOS_KEY";
const realKey = process.env[IOS_KEY];
const realOS = rn.Platform.OS;

function user(): User {
  return {
    id: "u1",
    email: "ada@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    phone: null,
    zipCode: null,
    timezone: "UTC",
    accountStatus: "active",
    subscriptionStatus: "free",
    defaultHouseholdSize: 2,
    lastPlanDiscoveryFilters: [],
    lastPlansFilters: [],
    lastMealsFilters: [],
    marketingConsentEmail: false,
    marketingConsentSms: false,
    onboardingComplete: true,
    firstRunChoiceMade: true,
    subscription: null,
    createdAt: "2026-01-01T00:00:00Z",
  } as User;
}

function subscription(status: string) {
  return {
    status,
    planCode: status === "active" ? "monthly" : "free",
    trialEndsAt: status === "trialing" ? "2026-10-17T11:00:00.000Z" : null,
    currentPeriodEnd: status === "active" ? "2026-11-05T00:00:00.000Z" : null,
    cancelAtPeriodEnd: false,
    billingAvailable: true,
    enforced: true,
    earlyPayBonusDays: 0,
    firstChargeDateIfSubscribedNow: null,
    hasBillingAccount: false,
    source: status === "active" ? "apple" : null,
    managementUrl: null,
    storeBillingAvailable: true,
  };
}

function pkg(id: string, price: string, period: string): StorePackage {
  return {
    identifier: id,
    packageType: id === "monthly" ? "MONTHLY" : "ANNUAL",
    product: { identifier: `kiwi_premium_${id}`, priceString: price, subscriptionPeriod: period },
  };
}

// ── the world: one ordered event log across the store SDK and the server ──

let events: string[];
let requested: string[];
let storeSyncQueue: Array<(r: Response) => void>;
let captured: BillingContextValue | null;
let renderer: TestRenderer.ReactTestRenderer | null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeSdk(): StoreSdk {
  let appUser: string | null = null;
  return {
    configure(c) {
      events.push(`sdk:configure:${c.appUserID}`);
      appUser = c.appUserID ?? null;
    },
    async logIn(id) {
      events.push(`sdk:logIn:${id}`);
      appUser = id;
      return {};
    },
    async logOut() {
      events.push("sdk:logOut");
      appUser = null;
      return {};
    },
    async isAnonymous() {
      return appUser === null;
    },
    async getAppUserID() {
      return appUser ?? "$RCAnonymousID:x";
    },
    async getOfferings() {
      return {
        current: { monthly: pkg("monthly", "$9.99", "P1M"), annual: pkg("annual", "$99.99", "P1Y") },
      };
    },
    async purchasePackage(p) {
      events.push(`sdk:purchase:${p.identifier}`);
      return {};
    },
    async restorePurchases() {
      events.push("sdk:restore");
      return { entitlements: { active: { premium: {} } } };
    },
  };
}

beforeEach(() => {
  events = [];
  requested = [];
  storeSyncQueue = [];
  captured = null;
  renderer = null;
  rn.Platform.OS = "ios";
  rn.__resetLinking();
  process.env[IOS_KEY] = "appl_test_key";
  __resetStoreForTests();
  __setStoreSdkForTests(fakeSdk());
  __setStoreSyncBackoffForTests([0, 0, 0, 0]);
  store.__resetForTests();
  store.__setForTests("kiwi_authToken", "member-jwt");
  resetAuthBridge();
  resetUpgradeBridge();
  (globalThis as { fetch: typeof fetch }).fetch = ((url: string) => {
    const path = String(url).replace(/^.*\/api/, "");
    requested.push(path);
    if (path.startsWith("/auth/me")) return Promise.resolve(json({ user: user() }));
    if (path.startsWith("/me/subscription")) return Promise.resolve(json(subscription("trialing")));
    if (path.startsWith("/billing/store-sync")) {
      events.push("server:store-sync");
      return new Promise<Response>((resolve) => storeSyncQueue.push(resolve));
    }
    return Promise.resolve(json({}));
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  if (renderer) {
    const r = renderer;
    renderer = null;
    await act(async () => r.unmount());
  }
  __setStoreSyncBackoffForTests(null);
  __resetStoreForTests();
  store.__resetForTests();
  rn.Platform.OS = realOS;
  if (realKey === undefined) delete process.env[IOS_KEY];
  else process.env[IOS_KEY] = realKey;
});

function Probe(): null {
  captured = useBilling();
  return null;
}

async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function until(pred: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await settle(1);
  }
  assert.fail(`timed out waiting for: ${label}`);
}

async function mountWithSheet(): Promise<void> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(
          AuthProvider,
          null,
          React.createElement(BillingProvider, null, React.createElement(Probe)),
        ),
      ),
    );
  });
  await until(() => captured?.subscription?.status === "trialing", "the trial subscription");
  await act(async () => captured!.openSheet("trialing"));
  await until(() => captured?.storeOfferStatus === "ready", "the store offering");
}

/** Answer the oldest pending store-sync. */
async function answerStoreSync(status: number, body: unknown): Promise<void> {
  await until(() => storeSyncQueue.length > 0, "a store-sync request");
  const resolve = storeSyncQueue.shift()!;
  await act(async () => resolve(json(body, status)));
  await settle(3);
}

test("RevenueCat's customer is the Kiwi user from boot — configured with the id, never anonymous", async () => {
  await mountWithSheet();
  assert.equal(events[0], "sdk:configure:u1");
  assert.ok(!events.some((e) => e.includes("undefined") || e.includes("null")), events.join(" "));
});

test("🔴 no Stripe call on native: a purchase goes to the store, the portal never opens", async () => {
  await mountWithSheet();
  await act(async () => {
    void captured!.startCheckout("monthly");
  });
  await answerStoreSync(200, subscription("active"));
  await until(() => captured?.storePhase === "idle", "the purchase to settle");

  assert.ok(events.includes("sdk:purchase:monthly"), events.join(" "));
  await act(async () => captured!.openPortal());
  await settle(2);

  const stripeRoutes = requested.filter((p) => p.includes("checkout-session") || p.includes("portal-session"));
  assert.deepEqual(stripeRoutes, [], "a Stripe route was called on iOS");
  assert.ok(
    !rn.__getLinkingCalls().some((u) => /stripe\.com/.test(u)),
    `a Stripe URL was opened: ${rn.__getLinkingCalls().join(", ")}`,
  );
});

test("after a purchase the answer refreshes billing state and the sheet closes", async () => {
  await mountWithSheet();
  await act(async () => {
    void captured!.startCheckout("annual");
  });
  await answerStoreSync(200, subscription("active"));
  await until(() => captured?.subscription?.status === "active", "the active subscription");
  assert.equal(captured!.sheet, null);
  assert.equal(captured!.storeMessage, null);
});

test("🔴 Restore calls restorePurchases, THEN store-sync", async () => {
  await mountWithSheet();
  await act(async () => {
    void captured!.restorePurchases();
  });
  await answerStoreSync(200, subscription("active"));
  await until(() => captured?.storePhase === "idle", "the restore to settle");
  const order = events.filter((e) => e === "sdk:restore" || e === "server:store-sync");
  assert.deepEqual(order, ["sdk:restore", "server:store-sync"]);
  assert.equal(captured!.subscription?.status, "active");
});

test("a restore with nothing to restore says so, and keeps the sheet open", async () => {
  await mountWithSheet();
  await act(async () => {
    void captured!.restorePurchases();
  });
  await answerStoreSync(200, subscription("trialing"));
  await until(() => captured?.storePhase === "idle", "the restore to settle");
  assert.equal(captured!.storeMessage, "There's no Kiwi Premium purchase to restore on this account.");
  assert.equal(captured!.sheet, "trialing");
});

test("🔴 store-sync 502 is retried while 'confirming', and a second tap NEVER reaches the store", async () => {
  await mountWithSheet();
  await act(async () => {
    void captured!.startCheckout("monthly");
  });
  await until(() => captured?.storePhase === "confirming", "the confirming phase");

  // The person taps a price again while Kiwi is still confirming.
  await act(async () => {
    void captured!.startCheckout("annual");
  });
  await answerStoreSync(502, { code: "store_sync_failed" });
  assert.equal(captured!.storePhase, "confirming", "still confirming after a 502");
  await act(async () => {
    void captured!.startCheckout("monthly");
  });
  await answerStoreSync(502, { code: "store_sync_failed" });
  await answerStoreSync(200, subscription("active"));
  await until(() => captured?.storePhase === "idle", "the confirmation to land");

  const purchases = events.filter((e) => e.startsWith("sdk:purchase"));
  assert.deepEqual(purchases, ["sdk:purchase:monthly"], "a second purchase was sent to the store");
  assert.equal(events.filter((e) => e === "server:store-sync").length, 3);
  assert.equal(captured!.subscription?.status, "active");
});

test("when the retries run out it is 'stalled' — Check again re-syncs, still no purchase", async () => {
  await mountWithSheet();
  await act(async () => {
    void captured!.startCheckout("monthly");
  });
  for (let i = 0; i < 5; i++) await answerStoreSync(502, { code: "store_sync_failed" });
  await until(() => captured?.storePhase === "stalled", "the stall");

  await act(async () => {
    void captured!.startCheckout("monthly");
  });
  await act(async () => {
    void captured!.checkStoreAgain();
  });
  await answerStoreSync(200, subscription("active"));
  await until(() => captured?.storePhase === "idle", "the re-sync");
  assert.deepEqual(events.filter((e) => e.startsWith("sdk:purchase")), ["sdk:purchase:monthly"]);
});

// ── the web: Stripe stays, but never a second subscription ─────────────────

test("web 409 subscribed_elsewhere: says where it is managed, with the store's link", async (t) => {
  rn.Platform.OS = "web";
  // On the web the member token lives in sessionStorage (lib/auth.ts).
  const session = new Map<string, string>([["kiwi_authToken", "member-jwt"]]);
  const g = globalThis as { sessionStorage?: unknown };
  const hadSession = Object.prototype.hasOwnProperty.call(g, "sessionStorage");
  Object.defineProperty(g, "sessionStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => void session.set(k, v),
      removeItem: (k: string) => void session.delete(k),
    },
  });
  t.after(() => {
    if (!hadSession) delete g.sessionStorage;
  });
  const base = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    if (String(url).includes("/billing/checkout-session")) {
      requested.push("/billing/checkout-session");
      return Promise.resolve(
        json(
          {
            code: "subscribed_elsewhere",
            source: "apple",
            managementUrl: "https://apps.apple.com/account/subscriptions",
          },
          409,
        ),
      );
    }
    return base(url, init);
  }) as unknown as typeof fetch;

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(
          AuthProvider,
          null,
          React.createElement(BillingProvider, null, React.createElement(Probe)),
        ),
      ),
    );
  });
  await until(() => captured?.subscription !== null, "the subscription");
  await act(async () => {
    await captured!.startCheckout("monthly");
  });
  assert.equal(captured!.linkError, "You're subscribed through the App Store — manage it there.");
  assert.deepEqual(captured!.elsewhere, {
    source: "apple",
    managementUrl: "https://apps.apple.com/account/subscriptions",
  });
  assert.ok(!events.some((e) => e.startsWith("sdk:")), "the web never touches the store SDK");
});

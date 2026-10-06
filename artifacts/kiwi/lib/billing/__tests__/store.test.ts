// Resub C2 — lib/billing/store.ts: the RevenueCat SDK, wrapped.
//
// Driven through an injected fake SDK that records every call, so the
// identity rule (never anonymous) and the purchase outcomes are asserted on
// what the SDK was actually asked to do.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { Platform } from "react-native";

import {
  __resetStoreForTests,
  __setStoreSdkForTests,
  isStoreCancel,
  loadStoreOffer,
  periodOf,
  purchaseStorePackage,
  restoreStorePurchases,
  revenueCatKey,
  syncStoreIdentity,
  type StorePackage,
  type StoreSdk,
} from "../store";

const platform = Platform as unknown as { OS: string };
const IOS_KEY = "EXPO_PUBLIC_REVENUECAT_IOS_KEY";
const realKey = process.env[IOS_KEY];

function pkg(
  identifier: string,
  packageType: string,
  priceString: string,
  subscriptionPeriod: string | null,
): StorePackage {
  return {
    identifier,
    packageType,
    product: { identifier: `kiwi_premium_${identifier}`, priceString, subscriptionPeriod },
  };
}

const MONTHLY = pkg("monthly", "MONTHLY", "$9.99", "P1M");
const ANNUAL = pkg("annual", "ANNUAL", "$99.99", "P1Y");

interface FakeSdk extends StoreSdk {
  calls: string[];
  appUserId: string | null;
}

function fakeSdk(over: Partial<StoreSdk> = {}): FakeSdk {
  const fake: FakeSdk = {
    calls: [],
    appUserId: null,
    configure(c) {
      fake.calls.push(`configure:${c.appUserID ?? "anonymous"}`);
      fake.appUserId = c.appUserID ?? null;
    },
    async logIn(id) {
      fake.calls.push(`logIn:${id}`);
      fake.appUserId = id;
      return {};
    },
    async logOut() {
      fake.calls.push("logOut");
      fake.appUserId = null;
      return {};
    },
    async isAnonymous() {
      return fake.appUserId === null;
    },
    async getAppUserID() {
      return fake.appUserId ?? "$RCAnonymousID:x";
    },
    async getOfferings() {
      fake.calls.push("getOfferings");
      return { current: { monthly: MONTHLY, annual: ANNUAL } };
    },
    async purchasePackage(p) {
      fake.calls.push(`purchase:${p.identifier}:as:${fake.appUserId}`);
      return {};
    },
    async restorePurchases() {
      fake.calls.push(`restore:as:${fake.appUserId}`);
      return { entitlements: { active: { premium: {} } } };
    },
    ...over,
  };
  return fake;
}

beforeEach(() => {
  __resetStoreForTests();
  platform.OS = "ios";
  process.env[IOS_KEY] = "appl_test_key";
});

afterEach(() => {
  __resetStoreForTests();
  platform.OS = "ios";
  if (realKey === undefined) delete process.env[IOS_KEY];
  else process.env[IOS_KEY] = realKey;
});

// ── the key ──────────────────────────────────────────────────────────────

test("the key is per platform; web and a blank key have none", () => {
  const env = {
    EXPO_PUBLIC_REVENUECAT_IOS_KEY: " appl_x ",
    EXPO_PUBLIC_REVENUECAT_ANDROID_KEY: "goog_y",
  };
  assert.equal(revenueCatKey("ios", env), "appl_x");
  assert.equal(revenueCatKey("android", env), "goog_y");
  assert.equal(revenueCatKey("web", env), null);
  assert.equal(revenueCatKey("ios", { EXPO_PUBLIC_REVENUECAT_IOS_KEY: "  " }), null);
});

test("the key is read as a LITERAL process.env.EXPO_PUBLIC_… (BUG-357's rule)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "store.ts"),
    "utf8",
  );
  assert.ok(src.includes("process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY"));
  assert.ok(src.includes("process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY"));
  assert.equal(revenueCatKey("ios"), "appl_test_key", "the default env is read at call time");
});

// ── the identity: never anonymous ───────────────────────────────────────

test("🔴 the SDK is configured at the first signed-in user, WITH that id — never anonymously", async () => {
  const sdk = fakeSdk();
  __setStoreSdkForTests(sdk);
  await syncStoreIdentity(null); // a signed-out boot: nothing to configure for
  assert.deepEqual(sdk.calls, []);
  await syncStoreIdentity("u1");
  assert.deepEqual(sdk.calls, ["configure:u1"]);
});

test("a later user is logIn; the same user again is nothing", async () => {
  const sdk = fakeSdk();
  __setStoreSdkForTests(sdk);
  await syncStoreIdentity("u1");
  await syncStoreIdentity("u1");
  await syncStoreIdentity("u2");
  assert.deepEqual(sdk.calls, ["configure:u1", "logIn:u2"]);
});

test("sign-out is logOut — and NOT called for an already-anonymous customer (it throws)", async () => {
  const sdk = fakeSdk({
    async logOut() {
      if (sdk.appUserId === null) throw new Error("LogOut was called but the current user is anonymous");
      sdk.calls.push("logOut");
      sdk.appUserId = null;
      return {};
    },
  });
  __setStoreSdkForTests(sdk);
  await syncStoreIdentity("u1");
  await syncStoreIdentity(null);
  await syncStoreIdentity(null); // second sign-out signal: must not call logOut again
  assert.deepEqual(sdk.calls, ["configure:u1", "logOut"]);
});

test("no key on the build, or the web: the SDK is never touched", async () => {
  const sdk = fakeSdk();
  __setStoreSdkForTests(sdk);
  delete process.env[IOS_KEY];
  await syncStoreIdentity("u1");
  platform.OS = "web";
  process.env[IOS_KEY] = "appl_test_key";
  await syncStoreIdentity("u1");
  assert.deepEqual(sdk.calls, []);
});

// ── the offering ─────────────────────────────────────────────────────────

test("the offering: monthly and annual with the store's price and their periods", async () => {
  const sdk = fakeSdk();
  __setStoreSdkForTests(sdk);
  await syncStoreIdentity("u1");
  const offer = await loadStoreOffer();
  assert.equal(offer?.monthly?.priceString, "$9.99");
  assert.equal(offer?.monthly?.period, "month");
  assert.equal(offer?.annual?.priceString, "$99.99");
  assert.equal(offer?.annual?.period, "year");
});

test("no current offering, or neither package, is null — no buy buttons", async () => {
  __setStoreSdkForTests(fakeSdk({ getOfferings: async () => ({ current: null }) }));
  await syncStoreIdentity("u1");
  assert.equal(await loadStoreOffer(), null);
  __resetStoreForTests();
  __setStoreSdkForTests(fakeSdk({ getOfferings: async () => ({ current: { monthly: null, annual: null } }) }));
  await syncStoreIdentity("u1");
  assert.equal(await loadStoreOffer(), null);
});

test("an unconfigured SDK (nobody signed in) offers nothing", async () => {
  __setStoreSdkForTests(fakeSdk());
  assert.equal(await loadStoreOffer(), null);
});

test("a package whose period disagrees with its slot is dropped, not mislabelled", () => {
  assert.equal(periodOf(pkg("m", "MONTHLY", "$1", "P1M")), "month");
  assert.equal(periodOf(pkg("a", "ANNUAL", "$1", null)), "year");
  assert.equal(periodOf(pkg("w", "WEEKLY", "$1", "P1W")), null);
});

// ── buying and restoring ─────────────────────────────────────────────────

test("🔴 a purchase re-asserts the identity first, so it is made AS the Kiwi user", async () => {
  const sdk = fakeSdk();
  __setStoreSdkForTests(sdk);
  const out = await purchaseStorePackage(MONTHLY, "u1");
  assert.deepEqual(out, { kind: "purchased" });
  assert.deepEqual(sdk.calls, ["configure:u1", "purchase:monthly:as:u1"]);
});

test("the cancel is silent: code 1 or userCancelled → cancelled", async () => {
  __setStoreSdkForTests(fakeSdk({ purchasePackage: async () => { throw { code: "1" }; } }));
  assert.deepEqual(await purchaseStorePackage(MONTHLY, "u1"), { kind: "cancelled" });
  __resetStoreForTests();
  __setStoreSdkForTests(fakeSdk({ purchasePackage: async () => { throw { userCancelled: true, code: "0" }; } }));
  assert.deepEqual(await purchaseStorePackage(MONTHLY, "u1"), { kind: "cancelled" });
  assert.equal(isStoreCancel({ code: "2" }), false);
});

test("a deferred payment is pending; anything else is failed", async () => {
  __setStoreSdkForTests(fakeSdk({ purchasePackage: async () => { throw { code: "20" }; } }));
  assert.deepEqual(await purchaseStorePackage(ANNUAL, "u1"), { kind: "pending" });
  __resetStoreForTests();
  __setStoreSdkForTests(fakeSdk({ purchasePackage: async () => { throw { code: "2" }; } }));
  assert.deepEqual(await purchaseStorePackage(ANNUAL, "u1"), { kind: "failed" });
});

test("restore runs as the Kiwi user and reports whether premium came back", async () => {
  const sdk = fakeSdk();
  __setStoreSdkForTests(sdk);
  assert.deepEqual(await restoreStorePurchases("u1"), { kind: "restored", premiumActive: true });
  assert.deepEqual(sdk.calls, ["configure:u1", "restore:as:u1"]);
});

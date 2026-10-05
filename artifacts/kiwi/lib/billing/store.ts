// Resub C2 — THE STORE RAIL: react-native-purchases (RevenueCat), iOS and Android.
//
// Apple rejected 1.0 under 3.1.1 because Kiwi Premium could not be bought in the
// app. iOS sells through the App Store and Android through Google Play, both via
// RevenueCat; the server (Resub B1) mirrors the result into the one billing row
// through its webhook and POST /billing/store-sync. The web keeps Stripe and never
// reaches this file's network side.
//
// This file is the SDK, wrapped: the key, the identity, the offering, a purchase
// and a restore. What the sheet shows and when is BillingContext's wiring and
// subscriptionView.ts's decisions.
//
// ── THE IDENTITY RULE ────────────────────────────────────────────────────
//
// 🔴 RevenueCat's customer is ALWAYS the Kiwi user id, never anonymous: the
// server's webhook and store-sync look the purchase up by that id, and a
// purchase made by an anonymous customer belongs to nobody Kiwi knows. So:
//   · the SDK is configured ONCE, the first time a signed-in user is known
//     (at boot for a signed-in launch, else at the first sign-in), WITH that id
//     as `appUserID` — configuring earlier would mint an anonymous customer
//     before there is anyone to buy for;
//   · every later user change is `logIn(id)` (a no-op when already that id);
//   · sign-out is `logOut()`, guarded — RevenueCat throws for a customer that is
//     already anonymous;
//   · a purchase or a restore re-asserts the identity first, so even a missed
//     effect cannot buy for the wrong customer.
// All of it runs through one queue, so a fast sign-out / sign-in cannot
// interleave a logOut into the middle of a logIn.

import { Platform } from "react-native";
import Purchases from "react-native-purchases";

// ── the key ──────────────────────────────────────────────────────────────

/**
 * The build's RevenueCat public SDK keys.
 *
 * 🔴 READ AS LITERAL `process.env.EXPO_PUBLIC_…`. babel-preset-expo inlines an
 * EXPO_PUBLIC_ variable only where the source spells out that member expression;
 * an alias of `process.env` survives the build as a read of an empty object (Resub
 * C1 found it in turnstile.ts, C2 in providers.ts — BUG-357).
 */
function buildEnv(): Record<string, string | undefined> {
  return {
    EXPO_PUBLIC_REVENUECAT_IOS_KEY: process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY,
    EXPO_PUBLIC_REVENUECAT_ANDROID_KEY: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY,
  };
}

/** The key for a platform, or null (web, or a build without one). */
export function revenueCatKey(
  platform: string,
  env: Record<string, string | undefined> = buildEnv(),
): string | null {
  const raw =
    platform === "ios"
      ? env.EXPO_PUBLIC_REVENUECAT_IOS_KEY
      : platform === "android"
        ? env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY
        : undefined;
  return raw && raw.trim().length > 0 ? raw.trim() : null;
}

/** This build's key on this device, or null. */
export function storeKey(): string | null {
  return revenueCatKey(Platform.OS);
}

// ── the SDK, as this app uses it ─────────────────────────────────────────

export interface StoreProduct {
  identifier: string;
  priceString: string;
  /** ISO 8601 — "P1M", "P1Y". Null on Amazon and some StoreKit 1 products. */
  subscriptionPeriod: string | null;
}

export interface StorePackage {
  identifier: string;
  /** "MONTHLY", "ANNUAL", … */
  packageType: string;
  product: StoreProduct;
}

export interface StoreOffering {
  monthly: StorePackage | null;
  annual: StorePackage | null;
}

/** The slice of react-native-purchases this app calls. Tests inject a fake. */
export interface StoreSdk {
  configure(config: { apiKey: string; appUserID?: string | null }): void;
  logIn(appUserID: string): Promise<unknown>;
  logOut(): Promise<unknown>;
  isAnonymous(): Promise<boolean>;
  getAppUserID(): Promise<string>;
  getOfferings(): Promise<{ current: StoreOffering | null }>;
  purchasePackage(pkg: StorePackage): Promise<unknown>;
  restorePurchases(): Promise<{ entitlements?: { active?: Record<string, unknown> } }>;
}

let sdk: StoreSdk = Purchases as unknown as StoreSdk;
let configured = false;
let queue: Promise<unknown> = Promise.resolve();

/** Test-only. Production code never calls these. */
export function __setStoreSdkForTests(fake: StoreSdk): void {
  sdk = fake;
}
export function __resetStoreForTests(): void {
  sdk = Purchases as unknown as StoreSdk;
  configured = false;
  queue = Promise.resolve();
}

/** Run `op` after everything already queued; never rejects the queue itself. */
function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = queue.then(op, op);
  queue = run.catch(() => undefined);
  return run;
}

/** The RevenueCat entitlement that unlocks Kiwi (Hans's console). */
export const PREMIUM_ENTITLEMENT = "premium";

// ── the identity ─────────────────────────────────────────────────────────

/**
 * Make RevenueCat's customer match the signed-in Kiwi user — see the header.
 * Called by BillingContext on every user change (boot, each sign-in, sign-out,
 * account deletion). A no-op on the web and on a build without a key. Never
 * throws: a failed logIn is retried by the next call, and a purchase re-asserts
 * the identity before it starts.
 */
export function syncStoreIdentity(userId: string | null): Promise<void> {
  return enqueue(async () => {
    const key = storeKey();
    if (key === null) return;
    try {
      if (!configured) {
        // Nobody to buy for yet: stay unconfigured rather than mint an
        // anonymous customer.
        if (userId === null) return;
        sdk.configure({ apiKey: key, appUserID: userId });
        configured = true;
        return;
      }
      if (userId !== null) {
        if ((await sdk.getAppUserID()) !== userId) await sdk.logIn(userId);
        return;
      }
      // Signed out. logOut THROWS for an anonymous customer, so ask first.
      if (!(await sdk.isAnonymous())) await sdk.logOut();
    } catch (err) {
      console.warn("[store] identity sync failed", err);
    }
  });
}

/** True once the SDK has been configured for a signed-in user. */
export function storeConfigured(): boolean {
  return configured;
}

// ── the offering ─────────────────────────────────────────────────────────

export interface StorePackageView {
  plan: "monthly" | "annual";
  /** The store's own localized price, e.g. "$9.99" or "9,99 €". */
  priceString: string;
  period: "month" | "year";
  pkg: StorePackage;
}

export interface StoreOfferView {
  monthly: StorePackageView | null;
  annual: StorePackageView | null;
}

/** The package's billing period, from the store product first, then the package type. */
export function periodOf(pkg: StorePackage): "month" | "year" | null {
  const p = pkg.product.subscriptionPeriod;
  if (p === "P1M") return "month";
  if (p === "P1Y" || p === "P12M") return "year";
  if (pkg.packageType === "MONTHLY") return "month";
  if (pkg.packageType === "ANNUAL") return "year";
  return null;
}

function viewOf(plan: "monthly" | "annual", pkg: StorePackage | null): StorePackageView | null {
  if (!pkg) return null;
  const period = periodOf(pkg);
  const expected = plan === "monthly" ? "month" : "year";
  // A package whose period disagrees with its slot is a console mistake; showing
  // it would put the wrong period beside the price.
  if (period !== expected) return null;
  return { plan, priceString: pkg.product.priceString, period, pkg };
}

/**
 * The current offering's monthly and annual packages, or null when there is
 * nothing to sell (no key, not configured, no current offering, neither package,
 * or the store did not answer). Null means "no buy buttons".
 */
export async function loadStoreOffer(): Promise<StoreOfferView | null> {
  if (storeKey() === null || !configured) return null;
  try {
    const offerings = await sdk.getOfferings();
    const current = offerings.current;
    if (!current) return null;
    const view = {
      monthly: viewOf("monthly", current.monthly),
      annual: viewOf("annual", current.annual),
    };
    return view.monthly || view.annual ? view : null;
  } catch (err) {
    console.warn("[store] getOfferings failed", err);
    return null;
  }
}

// ── buying and restoring ─────────────────────────────────────────────────

export type StorePurchaseOutcome =
  | { kind: "purchased" }
  /** The person closed the store sheet. Not an error: say nothing. */
  | { kind: "cancelled" }
  /** Ask to Buy / a deferred payment: approved later, delivered by webhook. */
  | { kind: "pending" }
  | { kind: "failed" };

const CANCELLED_CODE = "1"; // PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR
const PENDING_CODE = "20"; // PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR

function errorCode(err: unknown): string | null {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "string" || typeof c === "number" ? String(c) : null;
}

/** RevenueCat's cancel, by its code or its (deprecated) flag. */
export function isStoreCancel(err: unknown): boolean {
  return (
    (err as { userCancelled?: unknown } | null)?.userCancelled === true ||
    errorCode(err) === CANCELLED_CODE
  );
}

/** Buy one package for `userId`. The identity is re-asserted first. */
export async function purchaseStorePackage(
  pkg: StorePackage,
  userId: string,
): Promise<StorePurchaseOutcome> {
  await syncStoreIdentity(userId);
  if (!configured) return { kind: "failed" };
  try {
    await enqueue(() => sdk.purchasePackage(pkg));
    return { kind: "purchased" };
  } catch (err) {
    if (isStoreCancel(err)) return { kind: "cancelled" };
    if (errorCode(err) === PENDING_CODE) return { kind: "pending" };
    console.warn("[store] purchase failed", err);
    return { kind: "failed" };
  }
}

export type StoreRestoreOutcome =
  | { kind: "restored"; premiumActive: boolean }
  | { kind: "failed" };

/** Restore Purchases for `userId`. The identity is re-asserted first. */
export async function restoreStorePurchases(userId: string): Promise<StoreRestoreOutcome> {
  await syncStoreIdentity(userId);
  if (!configured) return { kind: "failed" };
  try {
    const info = await enqueue(() => sdk.restorePurchases());
    const active = info?.entitlements?.active ?? {};
    return { kind: "restored", premiumActive: PREMIUM_ENTITLEMENT in active };
  } catch (err) {
    console.warn("[store] restore failed", err);
    return { kind: "failed" };
  }
}

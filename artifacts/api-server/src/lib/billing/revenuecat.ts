// Resubmission B1 — REVENUECAT, THE SOURCE OF TRUTH FOR STORE PURCHASES.
//
// Apple In-App Purchase and Google Play Billing reach Kiwi through RevenueCat.
// This file is the one place that talks to RevenueCat's REST API and the one
// place that turns its answer into the columns of a `subscriptions` row.
//
// ── THE WEBHOOK NEVER MAPS EVENT FIELDS ONTO THE ROW ─────────────────────
//
// RevenueCat's own guidance (docs → Integrations → Webhooks): "we recommend
// calling the `GET /subscribers` REST API endpoint after receiving any
// webhook." So every webhook, every POST /billing/store-sync and every stale
// store row on GET /me/subscription does the same thing: re-read the customer
// and derive the row from what RevenueCat says is true NOW. Event ORDER stops
// mattering, because no event's payload is ever written.
//
// ── THE FIELDS, AS VERIFIED 2026-10-04 ───────────────────────────────────
//
// GET https://api.revenuecat.com/v1/subscribers/{app_user_id}
// (docs → REST API v1 → Customers, "Get or Create a Customer" — it CREATES the
// customer when it does not exist, which is harmless here: an empty customer
// has no entitlements.) The v1 reference carries no deprecation notice.
//
//   subscriber.entitlements.<id>  { expires_date, grace_period_expires_date,
//                                   product_identifier, purchase_date }
//   subscriber.subscriptions.<product_identifier>
//                                 { expires_date, grace_period_expires_date,
//                                   billing_issues_detected_at,
//                                   unsubscribe_detected_at, store, is_sandbox,
//                                   purchase_date, store_transaction_id, … }
//   subscriber.management_url     (a store URL; null when nothing to manage)
//
// `store` values used here: `app_store` → apple, `play_store` → google.
// Anything else (`promotional`, `stripe`, `amazon`, …) is LOGGED AND IGNORED —
// Stripe purchases reach Kiwi through Kiwi's own Stripe webhook, never here.
//
// 🔴 SANDBOX IS ACCEPTED, IN PRODUCTION. App Review buys with sandbox accounts
// against the production build and the production server. Nothing in this
// file looks at `is_sandbox` / `environment` to refuse anything.

import type { BillingSource, SubscriptionPlan, SubscriptionStatus } from "@prisma/client";

import { logger } from "../logger";

export const REVENUECAT_API_BASE = "https://api.revenuecat.com/v1";

/** Product id (the part before `:` for Play's `subscriptionId:basePlanId`) → plan. */
export const STORE_PRODUCT_PLANS: Readonly<Record<string, SubscriptionPlan>> = {
  kiwi_premium_monthly: "premium_monthly",
  kiwi_premium_annual: "premium_annual",
};

/** RevenueCat's `store` → Kiwi's BillingSource. Absent = not a store we sell through. */
const STORE_SOURCES: Readonly<Record<string, BillingSource>> = {
  app_store: "apple",
  play_store: "google",
};

export interface RevenueCatEntitlement {
  expires_date?: string | null;
  grace_period_expires_date?: string | null;
  product_identifier?: string | null;
  purchase_date?: string | null;
}

export interface RevenueCatSubscription {
  expires_date?: string | null;
  grace_period_expires_date?: string | null;
  billing_issues_detected_at?: string | null;
  unsubscribe_detected_at?: string | null;
  store?: string | null;
  is_sandbox?: boolean | null;
  purchase_date?: string | null;
}

export interface RevenueCatSubscriber {
  entitlements?: Record<string, RevenueCatEntitlement> | null;
  subscriptions?: Record<string, RevenueCatSubscription> | null;
  management_url?: string | null;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class RevenueCatFetchError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "RevenueCatFetchError";
    this.status = status;
  }
}

/** Well inside RevenueCat's own 60 s webhook budget, with room to write after. */
export const REVENUECAT_FETCH_TIMEOUT_MS = 10_000;

/**
 * GET /v1/subscribers/{appUserId}. Throws `RevenueCatFetchError` on any
 * non-2xx, a timeout, or a body without `subscriber` — the callers answer 5xx
 * (the webhook, so RevenueCat retries) or 502 (store-sync).
 *
 * `fetchImpl` is injectable and has NO default that a test could reach by
 * accident: callers pass `globalThis.fetch` explicitly at the production seam.
 */
export async function fetchSubscriber(
  appUserId: string,
  opts: { secretApiKey: string; fetchImpl: FetchLike; timeoutMs?: number },
): Promise<RevenueCatSubscriber> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? REVENUECAT_FETCH_TIMEOUT_MS,
  );
  let res;
  try {
    res = await opts.fetchImpl(
      `${REVENUECAT_API_BASE}/subscribers/${encodeURIComponent(appUserId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${opts.secretApiKey}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      },
    );
  } catch (err) {
    throw new RevenueCatFetchError(
      err instanceof Error ? `RevenueCat request failed: ${err.message}` : "RevenueCat request failed",
      null,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new RevenueCatFetchError(`RevenueCat answered ${res.status}`, res.status);
  }
  const body = (await res.json()) as { subscriber?: RevenueCatSubscriber } | null;
  if (!body || typeof body !== "object" || !body.subscriber) {
    throw new RevenueCatFetchError("RevenueCat answered with no subscriber", res.status);
  }
  return body.subscriber;
}

/** What one RevenueCat customer means for one `subscriptions` row. */
export type StoreState =
  | {
      kind: "entitled_or_lapsed";
      source: BillingSource;
      status: SubscriptionStatus;
      /** Null when the product is not one of STORE_PRODUCT_PLANS — leave planCode. */
      planCode: SubscriptionPlan | null;
      storeProductId: string;
      currentPeriodStart: Date | null;
      currentPeriodEnd: Date | null;
      cancelAtPeriodEnd: boolean;
      managementUrl: string | null;
      isSandbox: boolean;
    }
  /** No entitlement at all under the configured id. */
  | { kind: "none"; managementUrl: string | null }
  /** An entitlement we do not act on (an unknown store, a lifetime grant). Logged by the caller. */
  | { kind: "ignored"; note: string; store: string | null; productId: string | null };

function parseDate(raw: string | null | undefined): Date | null {
  if (typeof raw !== "string" || raw === "") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/** `kiwi_premium_monthly:monthly-base` → `kiwi_premium_monthly`. */
export function storeProductBase(productId: string): string {
  const i = productId.indexOf(":");
  return i === -1 ? productId : productId.slice(0, i);
}

/**
 * Derive the row from one subscriber. Pure; `now` is the caller's clock.
 *
 *   status    active if the entitlement's end (expires_date, or the store's
 *             grace_period_expires_date when later) is in the future;
 *             past_due if still active but `billing_issues_detected_at` is set
 *             (the store's grace period — it keeps the end in the future);
 *             canceled once it has passed.
 *   cancelAtPeriodEnd ← `unsubscribe_detected_at` is set (and not yet expired).
 *   currentPeriodEnd  ← that end (expires, or the later grace end).
 *   source    ← `store`: app_store → apple, play_store → google, else ignored.
 *   planCode  ← the product id's part before `:`.
 */
export function deriveStoreState(
  subscriber: RevenueCatSubscriber,
  entitlementId: string,
  now: Date,
): StoreState {
  const managementUrl = subscriber.management_url ?? null;
  const ent = subscriber.entitlements?.[entitlementId];
  if (!ent) return { kind: "none", managementUrl };

  const productId = ent.product_identifier ?? null;
  if (productId === null) {
    return { kind: "ignored", note: "entitlement_without_product", store: null, productId };
  }
  const sub = subscriber.subscriptions?.[productId];
  const store = sub?.store ?? null;
  const source = store !== null ? STORE_SOURCES[store] : undefined;
  if (!sub || !source) {
    return { kind: "ignored", note: "store_not_handled", store, productId };
  }

  const expires = parseDate(sub.expires_date ?? ent.expires_date);
  if (expires === null) {
    // A non-expiring entitlement is a lifetime or promotional grant, which
    // Kiwi does not sell. Not guessed at.
    return { kind: "ignored", note: "no_expiry", store, productId };
  }
  const end = laterOf(
    expires,
    parseDate(sub.grace_period_expires_date ?? ent.grace_period_expires_date),
  );
  const live = end !== null && end.getTime() > now.getTime();
  const status: SubscriptionStatus = !live
    ? "canceled"
    : sub.billing_issues_detected_at
      ? "past_due"
      : "active";

  return {
    kind: "entitled_or_lapsed",
    source,
    status,
    planCode: STORE_PRODUCT_PLANS[storeProductBase(productId)] ?? null,
    storeProductId: productId,
    currentPeriodStart: parseDate(sub.purchase_date ?? ent.purchase_date),
    currentPeriodEnd: end,
    cancelAtPeriodEnd: live && Boolean(sub.unsubscribe_detected_at),
    managementUrl,
    isSandbox: sub.is_sandbox === true,
  };
}

/** A RevenueCat anonymous id — never a Kiwi user, never written. */
export function isAnonymousAppUserId(id: string): boolean {
  return id.startsWith("$RCAnonymousID:");
}

/** For the logs: never the key, only that the call happened and how it went. */
export function logRevenueCatFetchFailure(userId: string, err: unknown): void {
  logger.error(
    {
      event: "revenuecat_fetch_failed",
      userId,
      status: err instanceof RevenueCatFetchError ? err.status : null,
      err: err instanceof Error ? err.message : "unknown",
    },
    "Could not read the customer from RevenueCat — the row is LEFT UNCHANGED",
  );
}

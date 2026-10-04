// Resubmission B1 — a stand-in for RevenueCat's GET /v1/subscribers/{id}.
//
// Every route that re-reads RevenueCat takes a `FetchLike` seam, and every
// test hands in THIS instead of the global fetch: `pnpm test` loads .env, and
// a default that reached api.revenuecat.com with a real secret key would read
// (and, since GET creates a missing customer, write) live customers.
//
// The bodies follow the v1 example response verbatim in shape (docs → REST
// API v1 → Customers, checked 2026-10-04): `subscriber.entitlements.<id>`,
// `subscriber.subscriptions.<product_identifier>`, `subscriber.management_url`.

import type { FetchLike, RevenueCatSubscriber } from "../../../lib/billing/revenuecat";

export const RC_CONFIGURED: Record<string, string> = {
  REVENUECAT_WEBHOOK_AUTH: "Bearer rc-webhook-test-auth",
  REVENUECAT_SECRET_API_KEY: "sk_rc_test_key",
};

export const APPLE_MANAGEMENT_URL = "https://apps.apple.com/account/subscriptions";

/** One store subscriber with the `premium` entitlement. */
export function storeSubscriber(opts: {
  store?: "app_store" | "play_store" | "promotional" | "stripe";
  productId?: string;
  expires: Date | null;
  grace?: Date | null;
  billingIssue?: Date | null;
  unsubscribed?: Date | null;
  purchased?: Date;
  sandbox?: boolean;
  entitlementId?: string;
  managementUrl?: string | null;
}): RevenueCatSubscriber {
  const productId = opts.productId ?? "kiwi_premium_monthly";
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  return {
    entitlements: {
      [opts.entitlementId ?? "premium"]: {
        expires_date: iso(opts.expires),
        grace_period_expires_date: iso(opts.grace ?? null),
        product_identifier: productId,
        purchase_date: iso(opts.purchased ?? new Date("2026-10-01T00:00:00Z")),
      },
    },
    subscriptions: {
      [productId]: {
        expires_date: iso(opts.expires),
        grace_period_expires_date: iso(opts.grace ?? null),
        billing_issues_detected_at: iso(opts.billingIssue ?? null),
        unsubscribe_detected_at: iso(opts.unsubscribed ?? null),
        store: opts.store ?? "app_store",
        is_sandbox: opts.sandbox ?? false,
        purchase_date: iso(opts.purchased ?? new Date("2026-10-01T00:00:00Z")),
      },
    },
    management_url:
      opts.managementUrl === undefined ? APPLE_MANAGEMENT_URL : opts.managementUrl,
  };
}

/** A customer RevenueCat knows nothing live about. */
export function emptySubscriber(): RevenueCatSubscriber {
  return { entitlements: {}, subscriptions: {}, management_url: null };
}

export interface FakeRevenueCat {
  fetchImpl: FetchLike;
  /** Every app user id that was read, in order. */
  reads: string[];
  /** Every Authorization header that was sent. */
  authHeaders: string[];
}

/**
 * `byUser` maps an app user id to the subscriber RevenueCat answers with, or
 * to a number to answer that HTTP status instead. A user absent from the map
 * gets an empty subscriber (GET creates the customer).
 */
export function makeFakeRevenueCat(
  byUser: Record<string, RevenueCatSubscriber | number>,
): FakeRevenueCat {
  const reads: string[] = [];
  const authHeaders: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const id = decodeURIComponent(url.split("/subscribers/")[1] ?? "");
    reads.push(id);
    authHeaders.push(init.headers.Authorization ?? "");
    const answer = byUser[id] ?? emptySubscriber();
    if (typeof answer === "number") {
      return { ok: false, status: answer, json: async () => ({ message: "error" }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ request_date_ms: 0, subscriber: answer }),
    };
  };
  return { fetchImpl, reads, authHeaders };
}

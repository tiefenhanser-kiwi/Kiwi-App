// Row 9 (1.1) · Stripe S2 Part B — the billing routes, and the web link-out.
//
// Thin by design. Every decision this client makes lives in subscriptionView.ts;
// this file is the wire, plus the one platform branch (`billingRail`) that
// decides which rail takes the money.
//
// 🔴 RESUB C2 — NATIVE HAS NO STRIPE AT ALL. 1.0 opened Checkout and the Portal
// in the system browser on iOS and Android, and that link-out was itself one of
// Apple's 3.1.1 findings. iOS and Android now sell through the store
// (lib/billing/store.ts, RevenueCat) and confirm with POST /billing/store-sync;
// the Stripe routes below are web-only and `openBillingUrl` refuses to open
// anything on native. On web it is a full navigation, not a popup, because a
// blocked popup is a checkout that silently did not happen.
//
// Per lib/api/README.md: every call passes a Zod schema, paths carry a leading
// slash and no `/api` prefix. The two POSTs use ENVELOPE mode and re-project into
// discriminated unions, following lib/api/grocery.ts — their 409s are real
// product states (already subscribed; nothing to manage) that a screen must
// branch on, not failures to alert about.

import { Platform } from "react-native";
import { z } from "zod";

import { apiClient } from "@/lib/api/client";
import { ApiError, UnauthenticatedError } from "@/lib/api/errors";

import type { SubscriptionPayload } from "./subscriptionView";

// ── GET /me/subscription ────────────────────────────────────────────────

export const SubscriptionStatusSchema = z.enum([
  "trialing",
  "active",
  "past_due",
  "none",
  "canceled",
]);

/**
 * ⚠️ TOLERANT WHERE THE SERVER MAY WIDEN, STRICT WHERE IT MUST NOT.
 *
 * `status` is an enum because an unrecognised status is a state this client
 * cannot render correctly and must not guess at. `hasBillingAccount` is
 * `.optional()` because an older server does not send it and
 * `canManageBilling` has a documented fallback. Zod strips unknown keys by
 * default, so a server that adds a field does not break a shipped build —
 * which is the property that let S1 add `code` beside `error` on every 402.
 */
export const SubscriptionPayloadSchema = z.object({
  status: SubscriptionStatusSchema,
  planCode: z.string(),
  trialEndsAt: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  billingAvailable: z.boolean(),
  enforced: z.boolean(),
  // Resub C2 — the bonus is gone and nothing reads these. Optional so a server
  // that still sends them (B1 does, as 0 / null) and one that has dropped them
  // both parse.
  earlyPayBonusDays: z.number().optional(),
  firstChargeDateIfSubscribedNow: z.string().nullable().optional(),
  hasBillingAccount: z.boolean().optional(),
  // Resub B1. Optional so a pre-B1 server still parses; `source` is a plain
  // string so a new rail cannot fail the whole read (subscriptionSource narrows).
  source: z.string().nullable().optional(),
  managementUrl: z.string().nullable().optional(),
  storeBillingAvailable: z.boolean().optional(),
});

export async function fetchSubscription(): Promise<SubscriptionPayload> {
  return apiClient("/me/subscription", { schema: SubscriptionPayloadSchema });
}

/** The React Query key. `personal` tier, but refetched on foreground by §2.3. */
export const SUBSCRIPTION_QUERY_KEY = ["me", "subscription"] as const;

// ── which rail takes the money (Resub C2) ───────────────────────────────

/**
 * "web" → Stripe; iOS and Android → the store. The ONE platform branch for
 * payments: BillingContext's startCheckout / openPortal switch on it, and
 * nothing on the store rail ever reaches a Stripe route or a Stripe URL.
 */
export function billingRail(os: string): "stripe" | "store" {
  return os === "web" ? "stripe" : "store";
}

// ── POST /billing/checkout-session (web) ────────────────────────────────

export type BillingPlan = "monthly" | "annual";

const SessionUrlSchema = z.object({ url: z.string() });

/**
 * Resub B1 — the 409 a store subscriber gets from either Stripe route: Kiwi
 * never sells a second subscription to someone the App Store or Google Play is
 * already billing, and a store subscription is managed in the store.
 */
export interface SubscribedElsewhere {
  source: "apple" | "google";
  managementUrl: string | null;
}

export type CheckoutSessionResult =
  | { success: true; url: string }
  /** 409 — already paying. Two devices, or a paywall that never refetched. */
  | { success: false; error: "already_subscribed" }
  /** 409 `subscribed_elsewhere` — paying through the App Store / Google Play. */
  | ({ success: false; error: "subscribed_elsewhere" } & SubscribedElsewhere)
  /** 503 — the deploy has no Stripe. Every button that leads here is gated off. */
  | { success: false; error: "billing_unavailable" }
  | { success: false; error: "unauthenticated" }
  | { success: false; error: "unknown"; status?: number };

/**
 * `platform` for the session's metadata — the conversion read, per platform.
 *
 * Returns undefined for anything the server's enum does not accept (RN reports
 * "macos" and "windows" too). The field is optional precisely so an unknown
 * platform is a missing metadata row rather than a 400 on the one screen that
 * takes money.
 */
export function currentBillingPlatform(): "web" | "ios" | "android" | undefined {
  const os = Platform.OS;
  return os === "web" || os === "ios" || os === "android" ? os : undefined;
}

export async function createCheckoutSession(
  plan: BillingPlan,
): Promise<CheckoutSessionResult> {
  const res = await apiClient("/billing/checkout-session", {
    method: "POST",
    body: { plan, platform: currentBillingPlatform() },
    schema: SessionUrlSchema,
    errorMode: "envelope",
  });
  if (res.success) return { success: true, url: res.data.url };
  return mapSessionError(res.error, {
    409: "already_subscribed",
    503: "billing_unavailable",
  }) as CheckoutSessionResult;
}

// ── POST /billing/portal-session (web) ──────────────────────────────────

export type PortalSessionResult =
  | { success: true; url: string }
  /** 409 — there is no Stripe customer yet, so there is nothing to manage. */
  | { success: false; error: "no_billing_account" }
  /** 409 `subscribed_elsewhere` — the subscription lives in a store. */
  | ({ success: false; error: "subscribed_elsewhere" } & SubscribedElsewhere)
  | { success: false; error: "billing_unavailable" }
  | { success: false; error: "unauthenticated" }
  | { success: false; error: "unknown"; status?: number };

export async function createPortalSession(): Promise<PortalSessionResult> {
  const res = await apiClient("/billing/portal-session", {
    method: "POST",
    schema: SessionUrlSchema,
    errorMode: "envelope",
  });
  if (res.success) return { success: true, url: res.data.url };
  return mapSessionError(res.error, {
    409: "no_billing_account",
    503: "billing_unavailable",
  }) as PortalSessionResult;
}

// ── POST /billing/store-sync (iOS / Android, Resub B1) ──────────────────

export type StoreSyncResult =
  /** 200 — the GET /me/subscription body, re-read from RevenueCat. */
  | { success: true; subscription: SubscriptionPayload }
  /** 502 `store_sync_failed` — RevenueCat did not answer. Worth retrying. */
  | { success: false; error: "store_sync_failed" }
  /** 503 `billing_unavailable` — no RevenueCat on the deploy. Not retried. */
  | { success: false; error: "billing_unavailable" }
  /** 429 — 6 a minute. Worth retrying after the backoff. */
  | { success: false; error: "rate_limited" }
  | { success: false; error: "unauthenticated" }
  | { success: false; error: "unknown"; status?: number };

/**
 * Ask the server to re-read RevenueCat for the signed-in user, right after a
 * purchase or a Restore. The answer is the subscription itself, so the app
 * unlocks without waiting for the webhook or a second round trip.
 */
export async function syncStoreSubscription(): Promise<StoreSyncResult> {
  const res = await apiClient("/billing/store-sync", {
    method: "POST",
    body: {},
    schema: SubscriptionPayloadSchema,
    errorMode: "envelope",
  });
  if (res.success) return { success: true, subscription: res.data };
  if (res.error instanceof UnauthenticatedError) {
    return { success: false, error: "unauthenticated" };
  }
  if (res.error instanceof ApiError) {
    if (res.error.status === 502) return { success: false, error: "store_sync_failed" };
    if (res.error.status === 503) return { success: false, error: "billing_unavailable" };
    if (res.error.status === 429) return { success: false, error: "rate_limited" };
    return { success: false, error: "unknown", status: res.error.status };
  }
  // A network failure or a malformed body: no status, but worth a retry.
  return { success: false, error: "unknown" };
}

/**
 * The shared error ladder. One function so the two Stripe routes cannot drift
 * into two slightly different readings of the same statuses.
 *
 * ⚠️ KEYED ON STATUS, EXCEPT ONE 409. Each route had exactly one 409 and one
 * 503, so the status was enough — and a 503 emitted by something in front of the
 * route (a cold Cloud Run revision, a proxy) carries no body at all and still
 * means "not right now". Resub B1 gave each route a SECOND 409,
 * `subscribed_elsewhere`, so a 409 now reads the body's `code` first and falls
 * back to the route's own 409 meaning.
 */
function mapSessionError(
  err: unknown,
  byStatus: Record<number, string>,
): { success: false; error: string; status?: number } & Partial<SubscribedElsewhere> {
  if (err instanceof UnauthenticatedError) {
    return { success: false, error: "unauthenticated" };
  }
  if (err instanceof ApiError) {
    if (err.status === 409) {
      const elsewhere = subscribedElsewhereFrom(err.body);
      if (elsewhere) return { success: false, error: "subscribed_elsewhere", ...elsewhere };
    }
    const mapped = byStatus[err.status];
    if (mapped) return { success: false, error: mapped };
    return { success: false, error: "unknown", status: err.status };
  }
  // ApiNetworkError / ApiSchemaError — no status to report.
  return { success: false, error: "unknown" };
}

function subscribedElsewhereFrom(body: unknown): SubscribedElsewhere | null {
  const b = body as { code?: unknown; source?: unknown; managementUrl?: unknown } | null;
  if (!b || b.code !== "subscribed_elsewhere") return null;
  if (b.source !== "apple" && b.source !== "google") return null;
  return {
    source: b.source,
    managementUrl: typeof b.managementUrl === "string" && b.managementUrl.length > 0
      ? b.managementUrl
      : null,
  };
}

// ── the web link-out ─────────────────────────────────────────────────────

/**
 * Where a Stripe URL is opened. Injected so the branch is testable without a
 * browser: the production sink is the default.
 */
export interface BillingLinkSinks {
  /** Web: a full navigation. `window.location.assign`, not `open`. */
  navigate: (url: string) => void;
}

export function defaultBillingLinkSinks(): BillingLinkSinks {
  return {
    navigate: (url) => {
      // `globalThis.location` rather than a bare `window`: this module is
      // imported by node:test, where neither exists, and a top-level reference
      // to `window` would throw on import rather than on use.
      const loc = (globalThis as { location?: { assign?: (u: string) => void } })
        .location;
      if (loc?.assign) loc.assign(url);
    },
  };
}

/** "web" → navigate; native → nothing, ever (Resub C2: no Stripe link-out). */
export function billingLinkMode(os: string): "navigate" | "none" {
  return os === "web" ? "navigate" : "none";
}

/**
 * Open a Stripe-hosted URL — on the web only. Resolves `false` on iOS and
 * Android without opening anything: a Stripe link-out in the app is a 3.1.1
 * problem, and BillingContext never calls this there; this is the second lock.
 */
export async function openBillingUrl(
  url: string,
  sinks: BillingLinkSinks = defaultBillingLinkSinks(),
): Promise<boolean> {
  if (billingLinkMode(Platform.OS) !== "navigate") return false;
  sinks.navigate(url);
  return true;
}

// Row 9 (1.1) · Stripe S2 Part B — the three billing routes, and the link-out.
//
// Thin by design. Every decision this client makes lives in subscriptionView.ts;
// this file is the wire, plus the one platform branch that decides HOW a
// Stripe-hosted URL is opened.
//
// 🔴 THE SYSTEM BROWSER, NEVER A WEBVIEW. On iOS and Android the checkout and
// portal URLs go to `Linking.openURL` — the D-WS9-267 rails ruling and Stripe's
// own guidance agree, and an in-app WebView for a payment page is both an App
// Review problem and a place where a password manager does not work. On web it is
// a full navigation, not a popup, because a blocked popup is a checkout that
// silently did not happen.
//
// Per lib/api/README.md: every call passes a Zod schema, paths carry a leading
// slash and no `/api` prefix. The two POSTs use ENVELOPE mode and re-project into
// discriminated unions, following lib/api/grocery.ts — their 409s are real
// product states (already subscribed; nothing to manage) that a screen must
// branch on, not failures to alert about.

import { Linking, Platform } from "react-native";
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
  earlyPayBonusDays: z.number(),
  firstChargeDateIfSubscribedNow: z.string().nullable(),
  hasBillingAccount: z.boolean().optional(),
});

export async function fetchSubscription(): Promise<SubscriptionPayload> {
  return apiClient("/me/subscription", { schema: SubscriptionPayloadSchema });
}

/** The React Query key. `personal` tier, but refetched on foreground by §2.3. */
export const SUBSCRIPTION_QUERY_KEY = ["me", "subscription"] as const;

// ── POST /billing/checkout-session ──────────────────────────────────────

export type BillingPlan = "monthly" | "annual";

const SessionUrlSchema = z.object({ url: z.string() });

export type CheckoutSessionResult =
  | { success: true; url: string }
  /** 409 — already paying. Two devices, or a paywall that never refetched. */
  | { success: false; error: "already_subscribed" }
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

// ── POST /billing/portal-session ────────────────────────────────────────

export type PortalSessionResult =
  | { success: true; url: string }
  /** 409 — there is no Stripe customer yet, so there is nothing to manage. */
  | { success: false; error: "no_billing_account" }
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

/**
 * The shared error ladder. One function so the two routes cannot drift into two
 * slightly different readings of the same three statuses.
 *
 * ⚠️ KEYED ON STATUS, NOT ON THE BODY'S `code`. The server sends both, and the
 * body is the better key in general — it is what S1 added `code` for. Here the
 * status is enough and is the more robust of the two: each route has exactly one
 * 409 and one 503, so there is no ambiguity to resolve, and a 503 emitted by
 * something in front of the route (a cold Cloud Run revision, a proxy) carries no
 * body at all and still means "not right now".
 */
function mapSessionError(
  err: unknown,
  byStatus: Record<number, string>,
): { success: false; error: string; status?: number } {
  if (err instanceof UnauthenticatedError) {
    return { success: false, error: "unauthenticated" };
  }
  if (err instanceof ApiError) {
    const mapped = byStatus[err.status];
    if (mapped) return { success: false, error: mapped };
    return { success: false, error: "unknown", status: err.status };
  }
  // ApiNetworkError / ApiSchemaError — no status to report.
  return { success: false, error: "unknown" };
}

// ── the link-out ────────────────────────────────────────────────────────

/**
 * Where a Stripe URL is opened. Injected so the branch is testable without a
 * browser or a device: the production sinks are the defaults, and the S2 test
 * asserts which one each platform picks.
 */
export interface BillingLinkSinks {
  /** Web: a full navigation. `window.location.assign`, not `open`. */
  navigate: (url: string) => void;
  /** Native: the SYSTEM browser. */
  openExternal: (url: string) => Promise<unknown>;
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
    openExternal: (url) => Linking.openURL(url),
  };
}

/** "web" → navigate; everything else → the system browser. */
export function billingLinkMode(os: string): "navigate" | "external" {
  return os === "web" ? "navigate" : "external";
}

/**
 * Open a Stripe-hosted URL. Resolves `false` when the device refused it (a
 * device with no browser — `Linking.openURL` rejects), so the caller can show a
 * line instead of leaving a spinner on a button that already finished.
 */
export async function openBillingUrl(
  url: string,
  sinks: BillingLinkSinks = defaultBillingLinkSinks(),
): Promise<boolean> {
  if (billingLinkMode(Platform.OS) === "navigate") {
    sinks.navigate(url);
    return true;
  }
  try {
    await sinks.openExternal(url);
    return true;
  } catch {
    return false;
  }
}

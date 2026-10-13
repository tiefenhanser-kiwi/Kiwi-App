// Resubmission B1 — THE ONE SHAPE of `GET /me/subscription`, now built in one
// place because two routes answer with it: `GET /me/subscription` itself, and
// `POST /billing/store-sync`, which hands the app the same body right after a
// purchase or a Restore so it can unlock without a second round trip.
//
// The field-by-field reasoning for the S1/S2 fields lives with the route
// (routes/me.ts); what changed here:
//
//   · `source` — which rail the row describes: "stripe" | "apple" | "google",
//     or null (a trial, or never paid). The client keys "Manage subscription"
//     on it: stripe → the Portal; apple / google → `managementUrl`.
//   · `managementUrl` — RevenueCat's `management_url`, store rows only (null
//     for Stripe and for no source). Kiwi cannot cancel a store subscription;
//     this is where the user does.
//   · `storeBillingAvailable` — the deploy has RevenueCat configured. The store
//     twin of `billingAvailable` (which stays Stripe's): a purchase sheet on a
//     deploy without it would take the money and never unlock the account.
//   · `earlyPayBonusDays` is always 0 and `firstChargeDateIfSubscribedNow`
//     always null — the bonus is gone (Hans, 2026-10-04). Both are still SENT
//     because the shipped client's schema requires them (kiwi
//     lib/billing/api.ts: `z.number()`, `z.string().nullable()`); the client
//     lane drops its reads, then these go.

import type { BillingConfig } from "./config";
import { effectiveStatus, type SubscriptionSnapshot } from "../subscriptionService";

export interface SubscriptionPayload {
  status: string;
  planCode: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  billingAvailable: boolean;
  enforced: boolean;
  earlyPayBonusDays: 0;
  firstChargeDateIfSubscribedNow: null;
  hasBillingAccount: boolean;
  source: "stripe" | "apple" | "google" | null;
  managementUrl: string | null;
  storeBillingAvailable: boolean;
}

/**
 * [bill-3] — is there a Stripe billing relationship worth a Portal?
 *
 * TRUE ONCE A STRIPE SUBSCRIPTION HAS EXISTED FOR THE ROW: `stripeSubscriptionId`,
 * written by checkout.session.completed and by every mirrored
 * customer.subscription.* event, and never cleared (a cancelled subscriber keeps
 * it, and keeps Manage: invoices and resubscribe live behind the Portal).
 *
 * NOT the customer id alone. POST /billing/checkout-session persists the
 * customer BEFORE creating the session (so a retry reuses it), which meant a
 * FAILED or abandoned checkout lit up "Manage" on a trial that never paid
 * (Hans, 2026-10-13) and opened an empty Portal. The customer is still
 * required — the Portal is scoped to it.
 *
 * POST /billing/portal-session answers 409 `no_billing_account` on exactly the
 * rows this says false for, so the button and the route cannot disagree.
 */
export function hasStripeBillingAccount(
  snapshot: Pick<SubscriptionSnapshot, "stripeCustomerId" | "stripeSubscriptionId"> | null,
): boolean {
  return snapshot?.stripeCustomerId != null && snapshot.stripeSubscriptionId != null;
}

export function buildSubscriptionPayload(
  snapshot: SubscriptionSnapshot | null,
  config: BillingConfig,
  now: Date,
): SubscriptionPayload {
  // No row is corruption (it is written in the same transaction as the User),
  // but this endpoint must still answer something a client can render. `none`
  // is the honest answer and it shows a paywall rather than a spinner.
  const status = snapshot === null ? "none" : effectiveStatus(snapshot, now);
  const source = snapshot?.source ?? null;
  const isStore = source === "apple" || source === "google";
  return {
    status,
    planCode: snapshot?.planCode ?? "free",
    trialEndsAt: snapshot?.trialEndsAt?.toISOString() ?? null,
    currentPeriodEnd: snapshot?.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: snapshot?.cancelAtPeriodEnd ?? false,
    billingAvailable: config.available,
    enforced: config.enforced,
    earlyPayBonusDays: 0,
    firstChargeDateIfSubscribedNow: null,
    hasBillingAccount: hasStripeBillingAccount(snapshot),
    source,
    managementUrl: isStore ? (snapshot?.storeManagementUrl ?? null) : null,
    storeBillingAvailable: config.revenuecatAvailable,
  };
}

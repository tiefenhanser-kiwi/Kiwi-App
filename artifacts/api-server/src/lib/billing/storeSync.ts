// Resubmission B1 — RE-READ, DERIVE, DECIDE, WRITE: the one store-row writer.
//
// Three callers, one function:
//   · POST /api/webhooks/revenuecat — for every affected Kiwi user;
//   · POST /api/billing/store-sync — right after a purchase or a Restore,
//     because the webhook can land seconds after the app wants to unlock;
//   · GET /api/me/subscription — for a store row past its period by > 3 days
//     (subscriptionService.isStoreRowPastGrace), before answering.
//
// The write is SAFE TO REPEAT by construction: every column is set from
// RevenueCat's current answer, none is incremented, so two concurrent syncs
// (a webhook and a store-sync racing) write the same row.
//
// ── WHAT A STORE ANSWER MAY NEVER DO ─────────────────────────────────────
//
// 🔴 A NOT-ENTITLED ANSWER WRITES ONLY ONTO A ROW THE STORE ALREADY OWNS.
// "No entitlement" (or an expired one) means "this person has nothing live in
// the App Store / Google Play" — it says NOTHING about Stripe and nothing about
// Kiwi's own trial. So when `row.source` is not this store (NULL = a trial,
// `stripe` = a web subscriber, or the OTHER store), a not-entitled answer is
// logged and the row is left alone. It must never cancel a Stripe subscriber
// and never end a trial. (The ruling names RevenueCat "none"; an EXPIRED store
// entitlement restored onto a trial account is the same class and gets the
// same answer.)
//
// An ENTITLED answer goes through lib/billing/sourceRule.ts, which is what
// stops a store purchase from overwriting a longer-lived Stripe subscription
// (and the other way round in webhookMirror.ts).

import type { PrismaClient } from "@prisma/client";

import { logger } from "../logger";
import type { BillingConfig } from "./config";
import {
  deriveStoreState,
  fetchSubscriber,
  type FetchLike,
  type StoreState,
} from "./revenuecat";
import { decideSourceWrite } from "./sourceRule";
import { isEntitled } from "../subscriptionService";

type PrismaLike = Pick<PrismaClient, "subscription">;

export interface StoreSyncDeps {
  prisma: PrismaLike;
  config: BillingConfig;
  /** The outbound seam. Production passes `globalThis.fetch`; tests a fake. */
  fetchImpl: FetchLike;
  now?: () => Date;
}

export interface StoreSyncOutcome {
  written: boolean;
  /** Why — for the route's log line and the tests. */
  reason:
    | "written"
    | "no_row"
    | "ignored"
    | "not_store_owned"
    | "dual_subscription";
  state: StoreState["kind"];
}

/**
 * Re-read one user from RevenueCat and write their row under the rule.
 *
 * Throws only when RevenueCat cannot be read (`RevenueCatFetchError`) or the
 * write itself fails — the webhook turns that into a 500 so RevenueCat retries,
 * store-sync into a 502. Every refusal is a normal return with a reason.
 *
 * `originalTransactionId` comes from the webhook event (its
 * `original_transaction_id`) — an IDENTITY for the subscription chain, not
 * state; GET /subscribers does not carry it. Written only when the row write
 * itself goes through, and never blanked.
 */
export async function syncStoreSubscription(
  deps: StoreSyncDeps,
  userId: string,
  opts: { originalTransactionId?: string | null } = {},
): Promise<StoreSyncOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const secretApiKey = deps.config.revenuecatSecretApiKey;
  if (secretApiKey === null) {
    // The routes check `revenuecatAvailable` first; this is the belt.
    throw new Error("syncStoreSubscription called with RevenueCat unconfigured");
  }

  const subscriber = await fetchSubscriber(userId, {
    secretApiKey,
    fetchImpl: deps.fetchImpl,
  });
  const state = deriveStoreState(subscriber, deps.config.revenuecatEntitlementId, now);

  const row = await deps.prisma.subscription.findUnique({
    where: { userId },
    select: { source: true, status: true, trialEndsAt: true, currentPeriodEnd: true },
  });
  if (row === null) {
    logger.error(
      { event: "store_sync_no_row", userId },
      "A store sync for a user with no Subscription row — nothing written (the row is created with the User, so this is corruption)",
    );
    return { written: false, reason: "no_row", state: state.kind };
  }

  if (state.kind === "ignored") {
    logger.warn(
      { event: "store_entitlement_ignored", userId, note: state.note, store: state.store, productId: state.productId },
      "RevenueCat reports an entitlement Kiwi does not act on (unknown store, or no expiry) — row LEFT UNCHANGED",
    );
    return { written: false, reason: "ignored", state: state.kind };
  }

  if (state.kind === "none") {
    // 🔴 See the header: "none" writes only onto a store-owned row.
    if (row.source !== "apple" && row.source !== "google") {
      logger.info(
        { event: "store_none_not_store_owned", userId, rowSource: row.source },
        "RevenueCat reports no entitlement; the row is not store-sourced (a trial or a Stripe subscriber) — LEFT UNCHANGED",
      );
      return { written: false, reason: "not_store_owned", state: state.kind };
    }
    await deps.prisma.subscription.update({
      where: { userId },
      data: {
        status: "canceled",
        cancelAtPeriodEnd: false,
        storeManagementUrl: state.managementUrl,
        sourceUpdatedAt: now,
      },
    });
    logger.info(
      { event: "store_subscription_mirrored", userId, source: row.source, status: "canceled", note: "no_entitlement" },
      "Store subscription mirrored — no entitlement left (expired or refunded)",
    );
    return { written: true, reason: "written", state: state.kind };
  }

  const entitled = isEntitled(state.status);
  if (!entitled && row.source !== state.source) {
    // Same class as "none": a lapsed store entitlement says nothing about a
    // row this store does not own.
    logger.info(
      { event: "store_lapsed_not_store_owned", userId, rowSource: row.source, storeSource: state.source },
      "RevenueCat reports an EXPIRED store subscription on a row this store does not own — LEFT UNCHANGED",
    );
    return { written: false, reason: "not_store_owned", state: state.kind };
  }

  const decision = decideSourceWrite(
    row,
    { source: state.source, entitled, currentPeriodEnd: state.currentPeriodEnd },
    now,
  );
  if (!decision.write) {
    logger.warn(
      {
        event: "billing_dual_subscription",
        userId,
        rowSource: decision.rowSource,
        incomingSource: state.source,
        incomingPeriodEnd: state.currentPeriodEnd?.toISOString() ?? null,
        rowPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
      },
      "Two live subscriptions on one account — the row keeps the longer-lived one; this store subscription is NOT mirrored",
    );
    return { written: false, reason: "dual_subscription", state: state.kind };
  }

  await deps.prisma.subscription.update({
    where: { userId },
    data: {
      source: state.source,
      status: state.status,
      ...(state.planCode !== null ? { planCode: state.planCode } : {}),
      storeProductId: state.storeProductId,
      currentPeriodStart: state.currentPeriodStart,
      currentPeriodEnd: state.currentPeriodEnd,
      cancelAtPeriodEnd: state.cancelAtPeriodEnd,
      storeManagementUrl: state.managementUrl,
      sourceUpdatedAt: now,
      ...(opts.originalTransactionId
        ? { storeOriginalTransactionId: opts.originalTransactionId }
        : {}),
    },
  });
  if (state.planCode === null) {
    logger.warn(
      { event: "store_product_not_mapped", userId, productId: state.storeProductId },
      "A store product id matches no Kiwi plan — planCode left unchanged",
    );
  }
  logger.info(
    {
      event: "store_subscription_mirrored",
      userId,
      source: state.source,
      status: state.status,
      sandbox: state.isSandbox,
      decision: decision.reason,
    },
    "Store subscription mirrored",
  );
  return { written: true, reason: "written", state: state.kind };
}

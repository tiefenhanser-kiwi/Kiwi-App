// Row 9 (1.1) · Stripe S1 Part E — what DELETE /me owes Stripe.
//
// This is lib/oauth/revokeOnDelete.ts's pattern, applied to billing, and for the
// same reason: the account is about to vanish and something outside Kiwi has to
// be told first, because afterwards there is nothing left to tell it with (the
// customer and subscription ids live on the `subscriptions` row, which cascades
// with the user).
//
// 🔴 BEST-EFFORT, BY RULING (D-WS9-257). Nothing here can stop a deletion:
//
//   · no Stripe configuration on the deploy → logged, skipped
//   · no customer (the user never checked out) → nothing to do
//   · Stripe 4xx/5xx/timeout/throw → logged, skipped
//
// A person asking to be deleted GETS DELETED. The alternative is an account that
// cannot be removed because a third party is having an outage — worse for them
// and worse for us under GDPR than an un-cancelled subscription whose account no
// longer exists.
//
// ── BUT THE FAILURE MODE HERE IS WORSE THAN APPLE'S, AND IS SAID SO ──────
//
// An un-revoked Apple token is a privacy loose end. AN UN-CANCELLED STRIPE
// SUBSCRIPTION KEEPS CHARGING A CARD for an account that no longer exists, and
// the person has no way left to stop it — they cannot log in to reach the Portal,
// and the Kiwi row that knew their customer id is gone. So every skip is logged
// at `error` with the customer and subscription ids IN the line, because that log
// is the only remaining thread back to a live subscription nobody owns. Those ids
// are not secrets (they identify a Stripe object, they do not authorise anything)
// and having them is the difference between a refund Hans can action and a
// support ticket with nothing in it.
//
// ── ORDER: CANCEL, THEN DELETE THE CUSTOMER ──────────────────────────────
//
// Deleting a Stripe customer cancels its subscriptions as a side effect, so this
// could be one call. It is two, in this order, because the explicit cancel is the
// one that must not be skipped and the customer delete is the tidy-up: if the
// delete fails we have still stopped the charging, which is the part that costs
// the person money.

import type { PrismaClient } from "@prisma/client";

import { logger } from "../logger";
import type { BillingConfig } from "./config";
import { getStripe, type StripeLike } from "./stripeClient";

export interface CancelStripeForUserOptions {
  prisma: Pick<PrismaClient, "subscription">;
  userId: string;
  config: BillingConfig;
  /** Injected in tests; there is deliberately no default that reaches Stripe. */
  stripe?: StripeLike;
}

export interface CancelStripeForUserResult {
  /** Whether the account had a Stripe customer at all. */
  hadCustomer: boolean;
  /** Whether a subscription was cancelled at Stripe. */
  cancelled: boolean;
  /** Whether the customer object was deleted. */
  customerDeleted: boolean;
  /** Why anything was skipped — names of reasons, for the log. */
  skipped: string[];
}

export async function cancelStripeForUser(
  opts: CancelStripeForUserOptions,
): Promise<CancelStripeForUserResult> {
  const { prisma, userId, config } = opts;
  const result: CancelStripeForUserResult = {
    hadCustomer: false,
    cancelled: false,
    customerDeleted: false,
    skipped: [],
  };

  const row = await prisma.subscription.findUnique({
    where: { userId },
    select: { stripeCustomerId: true, stripeSubscriptionId: true, status: true },
  });
  const customerId = row?.stripeCustomerId ?? null;
  const subscriptionId = row?.stripeSubscriptionId ?? null;
  result.hadCustomer = customerId !== null;

  // The overwhelmingly common case while enforcement is off: a trial account
  // that never paid. Nothing to do and nothing to say.
  if (customerId === null && subscriptionId === null) return result;

  if (!config.available) {
    result.skipped.push("not_configured");
    logger.error(
      {
        event: "stripe_cancel_skipped",
        userId,
        reason: "not_configured",
        // See the header: these ids are the only remaining thread.
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        vars: config.missing,
      },
      "Account deleted WITHOUT cancelling its Stripe subscription — the deploy has no Stripe configuration. THE CARD MAY STILL BE CHARGED and the user can no longer reach the Portal; cancel it by hand in the Dashboard",
    );
    return result;
  }

  let stripe: StripeLike;
  try {
    stripe = opts.stripe ?? getStripe(config);
  } catch (err) {
    result.skipped.push("no_client");
    logger.error(
      { event: "stripe_cancel_skipped", userId, reason: "no_client", stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId, err },
      "Account deleted WITHOUT cancelling its Stripe subscription — could not build a Stripe client. Cancel it by hand in the Dashboard",
    );
    return result;
  }

  // 1. The cancel. The part that stops money moving.
  if (subscriptionId !== null) {
    // An already-terminal subscription needs no call, and asking Stripe to cancel
    // one it has already cancelled is a 400 that would read like a real failure.
    if (row?.status === "canceled") {
      result.skipped.push("already_canceled");
    } else {
      try {
        await stripe.subscriptions.cancel(subscriptionId);
        result.cancelled = true;
      } catch (err) {
        result.skipped.push("cancel_failed");
        logger.error(
          { event: "stripe_cancel_failed", userId, stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId, err },
          "Stripe refused the subscription cancellation — deletion proceeds. THE CARD MAY STILL BE CHARGED; cancel it by hand in the Dashboard",
        );
      }
    }
  }

  // 2. The tidy-up. Also cancels any subscription the row did not know about,
  //    which is why it still runs when step 1 failed or found nothing.
  if (customerId !== null) {
    try {
      await stripe.customers.del(customerId);
      result.customerDeleted = true;
    } catch (err) {
      result.skipped.push("customer_delete_failed");
      logger.warn(
        { event: "stripe_customer_delete_failed", userId, stripeCustomerId: customerId, err },
        "Could not delete the Stripe customer — deletion proceeds. Lower stakes than the cancel above: a customer with no active subscription costs nobody anything",
      );
    }
  }

  return result;
}

// Row 9 (1.1) · Stripe S1 Part E — THE MIRROR.
//
// Everything Kiwi knows about a Stripe subscription arrives here and nowhere
// else. The routes that create Checkout and Portal sessions write no
// subscription state at all (see routes/billing.ts), so this file is the single
// writer — which is what makes "the webhook is the source of truth" a property
// of the code rather than a promise in a document.
//
// ── THE FOUR THINGS THAT ARE EASY TO GET WRONG ───────────────────────────
//
//   1. WHICH USER. An event carries a Stripe customer and, if we set it, a
//      userId in metadata. Metadata is preferred because it is what WE wrote;
//      the two id lookups are fallbacks for subscriptions created outside our
//      checkout (a Dashboard-created subscription, a migration, a test clock).
//      An event we cannot attribute is LOGGED AND DROPPED, never guessed at.
//
//   2. WHICH STATUS. Stripe has eight; Kiwi's enum has five. `unpaid` maps to
//      `canceled` because dunning is exhausted and the user has lost access,
//      which is what `canceled` means to the entitlement check. `incomplete`,
//      `incomplete_expired` and `paused` map to NOTHING — see the map below.
//
//   3. WHEN. Stripe promises delivery, not ORDER. A `customer.subscription.updated`
//      from 10:00 can arrive after the one from 10:05, and mirroring it would
//      write stale truth that nothing would ever correct. So an event older than
//      the row's `sourceUpdatedAt` triggers a REFETCH of the subscription by id,
//      and the fresh object is mirrored instead of the event's payload. This is
//      Stripe's own recommendation over trusting order.
//
//   4. WHERE THE PERIOD DATES ARE. On the pinned API version they are on the
//      subscription ITEM. `readPeriod()` in stripeClient.ts is the only place
//      that knows, and this file goes through it.

import type { PrismaClient, SubscriptionPlan, SubscriptionStatus } from "@prisma/client";

import { isEntitled } from "../subscriptionService";

import { logger } from "../logger";
import type { BillingConfig } from "./config";
import { decideSourceWrite } from "./sourceRule";
import {
  readCustomerId,
  readPeriod,
  readPriceId,
  type StripeEventLike,
  type StripeLike,
  type StripeSubscriptionLike,
} from "./stripeClient";

/**
 * Stripe's `subscription.status` → Kiwi's enum.
 *
 * ⚠️ THREE STATUSES MAP TO `null`, WHICH MEANS "CHANGE NOTHING":
 *
 *   · `incomplete` / `incomplete_expired` — the FIRST payment never succeeded,
 *     so no subscription ever really began. Writing `canceled` would tell a user
 *     still inside their Kiwi trial that their subscription ended, which is both
 *     false and the worst possible moment to say it. Writing `active` would be
 *     worse. Leaving the row alone keeps the trial they actually have.
 *   · `paused` — a Stripe pause behaviour we do not configure and have no product
 *     meaning for. Guessing between "entitled" and "not" on a state we never
 *     asked for is how a paying customer gets locked out by a Dashboard setting
 *     someone toggled.
 *
 * All three are LOGGED, so a deploy that starts seeing them is visible rather
 * than silently inert.
 */
export const STRIPE_STATUS_MAP: Record<string, SubscriptionStatus | null> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  canceled: "canceled",
  // Dunning exhausted. The user has lost access, which is what `canceled` means
  // to isEntitled(), so it is the honest mapping even though Stripe keeps the
  // subscription object around.
  unpaid: "canceled",
  incomplete: null,
  incomplete_expired: null,
  paused: null,
};

export function mapStripeStatus(raw: string): SubscriptionStatus | null {
  return STRIPE_STATUS_MAP[raw] ?? null;
}

/** The price id decides the plan. Unknown → leave `planCode` alone and log. */
export function mapPriceToPlan(
  priceId: string | null,
  config: BillingConfig,
): SubscriptionPlan | null {
  if (priceId === null) return null;
  if (priceId === config.priceMonthly) return "premium_monthly";
  if (priceId === config.priceAnnual) return "premium_annual";
  return null;
}

type PrismaLike = Pick<PrismaClient, "subscription" | "billingEvent">;

export interface MirrorDeps {
  prisma: PrismaLike;
  stripe: StripeLike;
  config: BillingConfig;
}

/** What a handler did, for the route's log line and for the tests. */
export interface HandlerOutcome {
  handled: boolean;
  userId?: string | null;
  /** Set when the out-of-order guard refetched instead of trusting the payload. */
  refetched?: boolean;
  note?: string;
}

// ── attribution ──────────────────────────────────────────────────────────

/**
 * Find the Kiwi user an event belongs to, in order of how much we trust each
 * signal. Returns null when the event cannot be attributed — the caller logs and
 * acknowledges 200, because retrying an event we will never be able to place
 * just makes Stripe retry it for three days.
 */
export async function resolveUserId(
  deps: MirrorDeps,
  opts: {
    metadataUserId?: string | null;
    subscriptionId?: string | null;
    customerId?: string | null;
  },
): Promise<string | null> {
  // 1. What we wrote ourselves, on subscription_data.metadata at checkout.
  if (opts.metadataUserId) return opts.metadataUserId;

  // 2. The subscription id, if we have already mirrored this subscription.
  if (opts.subscriptionId) {
    const row = await deps.prisma.subscription.findFirst({
      where: { stripeSubscriptionId: opts.subscriptionId },
      select: { userId: true },
    });
    if (row) return row.userId;
  }

  // 3. The customer id. Weakest of the three because a customer can in principle
  //    have more than one subscription, but it is the only signal a
  //    Dashboard-created subscription carries.
  if (opts.customerId) {
    const row = await deps.prisma.subscription.findFirst({
      where: { stripeCustomerId: opts.customerId },
      select: { userId: true },
    });
    if (row) return row.userId;
  }

  return null;
}

// ── the write ────────────────────────────────────────────────────────────

/**
 * Mirror one subscription object onto one user's row.
 *
 * SAFE TO REPLAY BY CONSTRUCTION: every field is set from the object, none is
 * incremented or appended, so applying the same object twice leaves the same
 * row. That is the property the idempotency ledger protects as an optimisation
 * rather than depends on for correctness.
 */
export async function mirrorSubscription(
  deps: MirrorDeps,
  userId: string,
  sub: StripeSubscriptionLike,
  eventCreatedSeconds: number,
): Promise<boolean> {
  const status = mapStripeStatus(sub.status);
  const { currentPeriodStart, currentPeriodEnd } = readPeriod(sub);
  const priceId = readPriceId(sub);
  const planCode = mapPriceToPlan(priceId, deps.config);

  if (status === null) {
    logger.info(
      { event: "stripe_status_not_mapped", userId, stripeStatus: sub.status, subscriptionId: sub.id },
      `Stripe status '${sub.status}' has no Kiwi equivalent — the row's status is LEFT UNCHANGED (see STRIPE_STATUS_MAP)`,
    );
  }
  if (priceId !== null && planCode === null) {
    logger.warn(
      { event: "stripe_price_not_mapped", userId, priceId },
      "A subscription's price id matches neither STRIPE_PRICE_MONTHLY nor STRIPE_PRICE_ANNUAL — planCode left unchanged",
    );
  }

  // ── Resubmission B1 — one row, two possible sources ──
  //
  // A row an App Store / Google Play subscription currently entitles is not
  // Stripe's to overwrite unless this Stripe subscription is live AND runs
  // longer (lib/billing/sourceRule.ts). Checkout already refuses a store
  // subscriber (409 subscribed_elsewhere), so reaching this means a
  // subscription made outside Kiwi's checkout — logged, never double-written.
  const current = await deps.prisma.subscription.findUnique({
    where: { userId },
    select: { source: true, status: true, trialEndsAt: true, currentPeriodEnd: true },
  });
  if (current !== null) {
    const decision = decideSourceWrite(
      current,
      {
        source: "stripe",
        entitled: status !== null && isEntitled(status),
        currentPeriodEnd,
      },
      new Date(),
    );
    if (!decision.write) {
      logger.warn(
        {
          event: "billing_dual_subscription",
          userId,
          rowSource: decision.rowSource,
          incomingSource: "stripe",
          subscriptionId: sub.id,
          incomingPeriodEnd: currentPeriodEnd?.toISOString() ?? null,
          rowPeriodEnd: current.currentPeriodEnd?.toISOString() ?? null,
        },
        "Two live subscriptions on one account — the row keeps the longer-lived store subscription; this Stripe subscription is NOT mirrored",
      );
      return false;
    }
  }

  await deps.prisma.subscription.update({
    where: { userId },
    data: {
      // Only the fields we actually know. A null mapping must not blank a column.
      ...(status !== null ? { status } : {}),
      ...(planCode !== null ? { planCode } : {}),
      stripeSubscriptionId: sub.id,
      stripePriceId: priceId,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      currentPeriodStart,
      currentPeriodEnd,
      // Checkout sets no trial_end any more (the pay-early bonus is gone,
      // Resubmission B1), so a Stripe trial_end only appears on a subscription
      // made by hand in the Dashboard. When it does, Stripe holds that trial and
      // it becomes Kiwi's trialEndsAt; otherwise trialEndsAt is Kiwi's own and
      // nothing here touches it.
      ...(sub.trial_end !== null
        ? { trialEndsAt: new Date(sub.trial_end * 1000) }
        : {}),
      // Stripe's clock, not ours. See the header, point 3.
      sourceUpdatedAt: new Date(eventCreatedSeconds * 1000),
      // Resubmission B1 — this row now describes the Stripe subscription.
      source: "stripe",
      ...(readCustomerId(sub.customer) !== null
        ? { stripeCustomerId: readCustomerId(sub.customer) as string }
        : {}),
    },
  });
  return true;
}

/**
 * The out-of-order guard. Returns the subscription that should actually be
 * mirrored: the event's own payload when the event is current, or a FRESH
 * refetch when the event is older than what we last mirrored.
 */
export async function resolveFreshSubscription(
  deps: MirrorDeps,
  userId: string,
  fromEvent: StripeSubscriptionLike,
  eventCreatedSeconds: number,
): Promise<{ sub: StripeSubscriptionLike; refetched: boolean }> {
  const row = await deps.prisma.subscription.findUnique({
    where: { userId },
    select: { sourceUpdatedAt: true },
  });
  // Resubmission B1: the column is shared with the RevenueCat mirror, which
  // stamps it with OUR clock at its re-read. Comparing a Stripe event against
  // that can at worst trigger one unnecessary refetch — which is always safe,
  // because the refetch is authoritative.
  const lastMirrored = row?.sourceUpdatedAt ?? null;
  if (lastMirrored === null) return { sub: fromEvent, refetched: false };

  if (eventCreatedSeconds * 1000 >= lastMirrored.getTime()) {
    return { sub: fromEvent, refetched: false };
  }

  // The event predates what we already have. Its payload is a snapshot of a
  // moment we have moved past, so mirroring it would be a regression. Ask Stripe
  // what is true NOW.
  logger.info(
    {
      event: "stripe_event_out_of_order",
      userId,
      subscriptionId: fromEvent.id,
      eventCreated: eventCreatedSeconds,
      lastMirrored: lastMirrored.toISOString(),
    },
    "Stripe event is older than the last mirrored state — refetching the subscription instead of trusting the payload",
  );
  try {
    const fresh = await deps.stripe.subscriptions.retrieve(fromEvent.id);
    // The refetch is authoritative as of NOW, so it is stamped with now rather
    // than with the stale event's `created`.
    return { sub: fresh, refetched: true };
  } catch (err) {
    // A failed refetch must not apply the stale payload — that is the exact
    // regression the guard exists to prevent. Leave the row alone.
    logger.error(
      { event: "stripe_refetch_failed", userId, subscriptionId: fromEvent.id, err },
      "Could not refetch the subscription for an out-of-order event — the row is LEFT UNCHANGED rather than regressed",
    );
    throw err;
  }
}

// ── the handlers ─────────────────────────────────────────────────────────

/**
 * `checkout.session.completed` — attach the ids.
 *
 * It deliberately does NOT set the status. The session completing means Stripe
 * took the checkout, not that the subscription is active; a
 * `customer.subscription.created` follows with the real state, usually within the
 * same second. Writing `active` here would be a guess that the subscription
 * event then has to correct.
 */
export async function handleCheckoutSessionCompleted(
  deps: MirrorDeps,
  event: StripeEventLike,
): Promise<HandlerOutcome> {
  const session = event.data.object as {
    client_reference_id?: string | null;
    customer?: string | { id: string } | null;
    subscription?: string | { id: string } | null;
    metadata?: Record<string, string> | null;
  };
  const customerId = readCustomerId(session.customer);
  const subscriptionId = readCustomerId(session.subscription);
  const userId = await resolveUserId(deps, {
    metadataUserId: session.client_reference_id ?? session.metadata?.userId ?? null,
    subscriptionId,
    customerId,
  });
  if (userId === null) {
    logger.error(
      { event: "stripe_event_unattributable", type: event.type, eventId: event.id, customerId },
      "checkout.session.completed could not be attributed to a Kiwi user — acknowledged and DROPPED",
    );
    return { handled: false, userId: null, note: "unattributable" };
  }

  await deps.prisma.subscription.update({
    where: { userId },
    data: {
      ...(customerId !== null ? { stripeCustomerId: customerId } : {}),
      ...(subscriptionId !== null ? { stripeSubscriptionId: subscriptionId } : {}),
    },
  });
  logger.info(
    { event: "stripe_checkout_completed", userId, subscriptionId, customerId },
    "Checkout completed — ids attached; the subscription event sets the status",
  );
  return { handled: true, userId };
}

/** `customer.subscription.created | updated | deleted` — the real mirror. */
export async function handleSubscriptionEvent(
  deps: MirrorDeps,
  event: StripeEventLike,
): Promise<HandlerOutcome> {
  const sub = event.data.object as StripeSubscriptionLike;
  const userId = await resolveUserId(deps, {
    metadataUserId: sub.metadata?.userId ?? null,
    subscriptionId: sub.id,
    customerId: readCustomerId(sub.customer),
  });
  if (userId === null) {
    logger.error(
      { event: "stripe_event_unattributable", type: event.type, eventId: event.id, subscriptionId: sub.id },
      `${event.type} could not be attributed to a Kiwi user — acknowledged and DROPPED`,
    );
    return { handled: false, userId: null, note: "unattributable" };
  }

  // `customer.subscription.deleted` carries the subscription with its final
  // status (`canceled`), so it needs no special case — the map handles it. That
  // is also why it is safe to replay: the object is terminal.
  const { sub: fresh, refetched } = await resolveFreshSubscription(
    deps,
    userId,
    sub,
    event.created,
  );
  const written = await mirrorSubscription(
    deps,
    userId,
    fresh,
    // A refetch is authoritative as of now; the stale event's `created` must not
    // be written or the next out-of-order event would compare against the past.
    refetched ? Math.floor(Date.now() / 1000) : event.created,
  );
  if (!written) {
    return { handled: true, userId, refetched, note: "dual_subscription" };
  }
  logger.info(
    { event: "stripe_subscription_mirrored", type: event.type, userId, subscriptionId: fresh.id, status: fresh.status, refetched },
    "Subscription mirrored",
  );
  return { handled: true, userId, refetched };
}

/**
 * `invoice.paid` / `invoice.payment_failed` — LOG, and mirror by refetch.
 *
 * Stripe drives the status through the subscription events; these are here
 * because the invoice event is often what arrives first and because a failed
 * payment is the one thing worth having in the log with the amount beside it. The
 * subscription is refetched rather than read from the invoice, because an invoice
 * does not carry the subscription's status.
 */
export async function handleInvoiceEvent(
  deps: MirrorDeps,
  event: StripeEventLike,
): Promise<HandlerOutcome> {
  const invoice = event.data.object as {
    subscription?: string | { id: string } | null;
    customer?: string | { id: string } | null;
    amount_paid?: number | null;
    amount_due?: number | null;
    // On newer API versions the pointer moved onto the line items' parent.
    parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null;
  };
  const subscriptionId =
    readCustomerId(invoice.subscription) ??
    readCustomerId(invoice.parent?.subscription_details?.subscription);
  const customerId = readCustomerId(invoice.customer);
  const userId = await resolveUserId(deps, { subscriptionId, customerId });

  logger.info(
    {
      event: event.type === "invoice.paid" ? "stripe_invoice_paid" : "stripe_invoice_payment_failed",
      userId,
      subscriptionId,
      customerId,
      amountPaid: invoice.amount_paid ?? null,
      amountDue: invoice.amount_due ?? null,
    },
    event.type === "invoice.paid" ? "Stripe invoice paid" : "Stripe invoice payment FAILED — Stripe dunning takes over",
  );

  if (userId === null || subscriptionId === null) {
    // Not an error worth retrying: a one-off invoice with no subscription is a
    // thing Stripe sends, and the log line above is the whole point of this
    // handler anyway.
    return { handled: false, userId, note: "no_subscription" };
  }

  const fresh = await deps.stripe.subscriptions.retrieve(subscriptionId);
  const written = await mirrorSubscription(deps, userId, fresh, event.created);
  return {
    handled: true,
    userId,
    refetched: true,
    ...(written ? {} : { note: "dual_subscription" }),
  };
}

/** The dispatch table. Anything absent is acknowledged 200 and counted. */
export const HANDLED_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

export async function dispatchStripeEvent(
  deps: MirrorDeps,
  event: StripeEventLike,
): Promise<HandlerOutcome> {
  switch (event.type) {
    case "checkout.session.completed":
      return handleCheckoutSessionCompleted(deps, event);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return handleSubscriptionEvent(deps, event);
    case "invoice.paid":
    case "invoice.payment_failed":
      return handleInvoiceEvent(deps, event);
    default:
      // Stripe endpoints are often configured with more events than a server
      // handles, and an unhandled event is NOT an error — 200 is the correct
      // answer, or Stripe retries it for three days and eventually disables the
      // endpoint.
      logger.info(
        { event: "stripe_event_ignored", type: event.type, eventId: event.id },
        "Stripe event type is not handled — acknowledged",
      );
      return { handled: false, note: "ignored" };
  }
}

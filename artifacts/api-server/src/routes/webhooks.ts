// Row 9 (1.1) · Stripe S1 Part E — POST /api/webhooks/stripe.
//
// ── THE RAW BODY IS NOT OPTIONAL ─────────────────────────────────────────
//
// Stripe signs the EXACT BYTES it sent. `express.json()` parses and discards
// them, and `JSON.stringify(req.body)` does not reproduce them — key order,
// whitespace and number formatting are all free to differ — so a parsed body
// makes every signature fail. Two things together keep the bytes:
//
//   1. this path is in app.ts's `ROUTE_SCOPED_JSON_PATHS`, which skips the
//      global default parser (the same mechanism /api/recipes/import-image uses
//      for its 35 MiB limit), and
//   2. `express.raw({ type: "application/json" })` is mounted on the route,
//      giving `req.body` as a Buffer.
//
// ⚠️ BOTH ARE REQUIRED. With only (2) the global parser runs first and wins; with
// only (1) `req.body` is undefined. bug220ParserOrder.test.ts exists because this
// class of ordering mistake has already shipped once in this file's neighbour.
//
// ── THE SIGNATURE IS THE AUTHENTICATION ──────────────────────────────────
//
// This is the second unauthenticated WRITE surface in the server (the first is
// the guest lane, Row 13). It has no session, no bearer token and no allowlist:
// the `stripe-signature` header over the raw body IS the credential, verified
// against STRIPE_WEBHOOK_SECRET with an HMAC and a timestamp window. Anyone can
// POST here; only Stripe can produce a body that verifies. A bad signature is a
// 400 and a log line, and nothing else happens — no database read, no
// attribution attempt, no hint in the response about what was wrong.
//
// ── IDEMPOTENCY: CLAIM, THEN RELEASE ON FAILURE ──────────────────────────
//
// Stripe delivers AT LEAST ONCE and retries for three days on any non-2xx. The
// route claims the event id in `billing_events` (provider "stripe") before doing any work, so two
// concurrent deliveries cannot both proceed — the second INSERT raises P2002 and
// is acknowledged, ignored.
//
// 🔴 AND IT RELEASES THE CLAIM IF THE HANDLER THROWS. This is the subtle half. A
// claim that survived a failed handler would mark the event permanently seen, so
// Stripe's retry — the thing that makes at-least-once delivery useful — would be
// discarded as a duplicate and the update would be lost forever. So the claim is
// deleted on the error path and the route answers 500, which is what asks Stripe
// to try again.

import { createHash, timingSafeEqual } from "node:crypto";
import express, { Router, type IRouter } from "express";
import type { PrismaClient } from "@prisma/client";

import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { readBillingConfig, type BillingConfig } from "../lib/billing/config";
import { getStripe, type StripeLike } from "../lib/billing/stripeClient";
import { dispatchStripeEvent } from "../lib/billing/webhookMirror";
import { isAnonymousAppUserId, type FetchLike } from "../lib/billing/revenuecat";
import { syncStoreSubscription } from "../lib/billing/storeSync";

/** The path, exported so app.ts and the tests cannot disagree about it. */
export const STRIPE_WEBHOOK_PATH = "/webhooks/stripe";

/** The ledger's provider half for Stripe events (billing_events PK). */
export const STRIPE_PROVIDER = "stripe";

export interface WebhooksRouterDeps {
  prisma: PrismaClient;
  billingConfig: BillingConfig;
  stripe: StripeLike;
  /**
   * Resubmission B1 — the RevenueCat re-read seam. Defaults to the global
   * fetch; every test injects a fake (`pnpm test` loads .env).
   */
  fetchImpl: FetchLike;
  now: () => Date;
}

export function createWebhooksRouter(
  deps: Partial<WebhooksRouterDeps> = {},
): IRouter {
  const prisma = deps.prisma ?? productionPrisma;
  const billingConfig = deps.billingConfig ?? readBillingConfig();
  const router: IRouter = Router();
  const stripeFor = (): StripeLike => deps.stripe ?? getStripe(billingConfig);
  const fetchImpl: FetchLike = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const now = deps.now ?? (() => new Date());

  router.post(
    STRIPE_WEBHOOK_PATH,
    // No limiter. A rate limit on a webhook is a self-inflicted outage: Stripe
    // can legitimately burst (a batch of renewals all invoice at once), and a
    // 429 makes it retry the whole burst for three days. The signature check is
    // the guard, and it is cheap — an HMAC over bytes we already have.
    express.raw({ type: "application/json" }),
    async (req, res) => {
      if (!billingConfig.available || billingConfig.webhookSecret === null) {
        // Not a 503 with a helpful body: this endpoint answers a machine. Stripe
        // reads the STATUS and retries; a code in the body is for a client that
        // does not exist here.
        logger.error(
          { event: "stripe_webhook_unconfigured", vars: billingConfig.missing },
          "A Stripe webhook arrived at a deploy with no STRIPE_WEBHOOK_SECRET — cannot verify, refusing",
        );
        return res.status(503).end();
      }

      const signature = req.headers["stripe-signature"];
      if (typeof signature !== "string" || signature === "") {
        logger.warn(
          { event: "stripe_webhook_no_signature" },
          "Stripe webhook with no stripe-signature header — 400",
        );
        return res.status(400).end();
      }

      // `express.raw` gives a Buffer. If something upstream parsed the body it
      // will be a plain object here, and the signature check below would fail in
      // a way that reads like a wrong secret — so it is named explicitly.
      if (!Buffer.isBuffer(req.body)) {
        logger.error(
          { event: "stripe_webhook_body_not_raw", bodyType: typeof req.body },
          `The webhook body is not a Buffer — a JSON parser ran before express.raw. Check that ${STRIPE_WEBHOOK_PATH} is in app.ts's ROUTE_SCOPED_JSON_PATHS`,
        );
        return res.status(400).end();
      }

      let event;
      try {
        event = stripeFor().webhooks.constructEvent(
          req.body,
          signature,
          billingConfig.webhookSecret,
        );
      } catch (err) {
        // The ONLY thing logged is that verification failed. Not the body, not
        // the header — an unverified payload is attacker-controlled input and
        // does not belong in a log sink.
        logger.warn(
          { event: "stripe_webhook_bad_signature", err: err instanceof Error ? err.message : "unknown" },
          "Stripe webhook signature verification FAILED — 400",
        );
        return res.status(400).end();
      }

      // ── the claim ──
      try {
        await prisma.billingEvent.create({
          data: { provider: STRIPE_PROVIDER, id: event.id, type: event.type },
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "P2002") {
          // Seen before. The database arbitrated, not application logic.
          logger.info(
            { event: "stripe_webhook_replay", eventId: event.id, type: event.type },
            "Stripe event already processed — acknowledged, ignored",
          );
          return res.status(200).json({ received: true, duplicate: true });
        }
        logger.error(
          { event: "stripe_webhook_claim_failed", eventId: event.id, err },
          "Could not claim the Stripe event id — answering 500 so Stripe retries",
        );
        return res.status(500).end();
      }

      try {
        const outcome = await dispatchStripeEvent(
          { prisma, stripe: stripeFor(), config: billingConfig },
          event,
        );
        return res.status(200).json({ received: true, handled: outcome.handled });
      } catch (err) {
        // 🔴 RELEASE THE CLAIM. See the header: a claim that outlives a failed
        // handler turns Stripe's retry into a discarded duplicate and loses the
        // update permanently.
        try {
          await prisma.billingEvent.delete({
            where: { provider_id: { provider: STRIPE_PROVIDER, id: event.id } },
          });
        } catch (delErr) {
          // Now the event IS stuck — the claim stands and the retry will be
          // ignored. Nothing else can be done here, so it is logged at error
          // with both failures, because this is the one state that needs a human.
          logger.error(
            { event: "stripe_webhook_claim_stuck", eventId: event.id, err: delErr },
            "Handler failed AND the event claim could not be released — Stripe's retry will be treated as a duplicate and this event is LOST. Delete the row from billing_events (provider stripe) to allow a manual replay",
          );
        }
        logger.error(
          { event: "stripe_webhook_handler_failed", eventId: event.id, type: event.type, err },
          "Stripe webhook handler failed — claim released, answering 500 so Stripe retries",
        );
        return res.status(500).end();
      }
    },
  );

  // ── POST /api/webhooks/revenuecat — Resubmission B1 ─────────────────────
  //
  // Apple In-App Purchase and Google Play Billing, through RevenueCat. Same
  // three properties as the Stripe route above, by different means:
  //
  //   · AUTHENTICATION is the whole `Authorization` header, compared to
  //     REVENUECAT_WEBHOOK_AUTH in constant time. RevenueCat sends the value
  //     configured in its dashboard on every request; it signs nothing, so the
  //     body is parsed by the global JSON parser like any other route.
  //   · IDEMPOTENCY is the same claim-then-release on `billing_events`, keyed
  //     (provider "revenuecat", event.id). RevenueCat reuses `event.id` on its
  //     retries (up to 5, at 5/10/20/40/80 minutes).
  //   · THE PAYLOAD IS NEVER WRITTEN. Each affected user is RE-READ from
  //     RevenueCat (lib/billing/storeSync.ts), which is RevenueCat's own
  //     recommendation and makes delivery order irrelevant.
  //
  // 🔴 SANDBOX EVENTS ARE PROCESSED IN PRODUCTION. App Review buys with sandbox
  // accounts against the production server; refusing `environment: SANDBOX`
  // would leave the reviewer's purchase locked, which is a rejection. There is
  // no switch for it.
  //
  // RevenueCat disconnects at 60 s. One re-read is one HTTPS GET (10 s cap)
  // plus one row write, and only TRANSFER touches more than one user.

  router.post(REVENUECAT_WEBHOOK_PATH, async (req, res) => {
    const expected = billingConfig.revenuecatWebhookAuth;
    if (!billingConfig.revenuecatAvailable || expected === null) {
      logger.error(
        { event: "revenuecat_webhook_unconfigured", vars: billingConfig.revenuecatMissing },
        "A RevenueCat webhook arrived at a deploy with RevenueCat unconfigured — refusing",
      );
      return res.status(503).end();
    }

    const header = req.headers.authorization;
    if (typeof header !== "string" || !constantTimeEquals(header, expected)) {
      // Nothing about the request is logged beyond the fact: an
      // unauthenticated body is attacker-controlled input.
      logger.warn(
        { event: "revenuecat_webhook_bad_auth", hadHeader: typeof header === "string" },
        "RevenueCat webhook Authorization did not match — 401",
      );
      return res.status(401).end();
    }

    const event = (req.body as { event?: RevenueCatWebhookEvent } | undefined)?.event;
    if (
      !event ||
      typeof event !== "object" ||
      typeof event.id !== "string" ||
      event.id === "" ||
      typeof event.type !== "string"
    ) {
      logger.warn({ event: "revenuecat_webhook_malformed" }, "RevenueCat webhook body has no event id/type — 400");
      return res.status(400).end();
    }

    // ── the claim ──
    try {
      await prisma.billingEvent.create({
        data: { provider: REVENUECAT_PROVIDER, id: event.id, type: event.type },
      });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") {
        logger.info(
          { event: "revenuecat_webhook_replay", eventId: event.id, type: event.type },
          "RevenueCat event already processed — acknowledged, ignored",
        );
        return res.status(200).json({ received: true, duplicate: true });
      }
      logger.error(
        { event: "revenuecat_webhook_claim_failed", eventId: event.id, err },
        "Could not claim the RevenueCat event id — answering 500 so RevenueCat retries",
      );
      return res.status(500).end();
    }

    if (!REVENUECAT_RESYNC_TYPES.has(event.type)) {
      // TEST (the dashboard's "send test event") and every type that says
      // nothing about entitlement. 200, or RevenueCat retries it.
      logger.info(
        { event: "revenuecat_event_ignored", eventId: event.id, type: event.type, environment: event.environment ?? null },
        "RevenueCat event type does not affect entitlement — acknowledged",
      );
      return res.status(200).json({ received: true, handled: false });
    }

    try {
      const candidates = affectedAppUserIds(event);
      const anonymous = candidates.filter(isAnonymousAppUserId);
      if (anonymous.length > 0) {
        logger.warn(
          { event: "revenuecat_anonymous_user", eventId: event.id, type: event.type, count: anonymous.length },
          "RevenueCat event names an anonymous app user id — not a Kiwi user, never written (the app must logIn(userId) before purchase)",
        );
      }
      const named = candidates.filter((id) => !isAnonymousAppUserId(id));
      const known =
        named.length === 0
          ? []
          : (
              await prisma.user.findMany({
                where: { id: { in: named } },
                select: { id: true },
              })
            ).map((u) => u.id);
      const unknown = named.filter((id) => !known.includes(id));
      if (unknown.length > 0) {
        logger.warn(
          { event: "revenuecat_unknown_user", eventId: event.id, type: event.type, count: unknown.length },
          "RevenueCat event names app user ids that are not Kiwi users — skipped",
        );
      }

      const outcomes: Array<{ userId: string; written: boolean; reason: string }> = [];
      for (const userId of known) {
        const outcome = await syncStoreSubscription(
          { prisma, config: billingConfig, fetchImpl, now },
          userId,
          {
            originalTransactionId:
              typeof event.original_transaction_id === "string"
                ? event.original_transaction_id
                : null,
          },
        );
        outcomes.push({ userId, written: outcome.written, reason: outcome.reason });
      }
      logger.info(
        {
          event: "revenuecat_webhook_handled",
          eventId: event.id,
          type: event.type,
          environment: event.environment ?? null,
          outcomes,
        },
        "RevenueCat event handled — affected users re-read",
      );
      return res.status(200).json({ received: true, handled: true, users: outcomes.length });
    } catch (err) {
      // 🔴 RELEASE THE CLAIM — the same reasoning as the Stripe route: a claim
      // that outlives a failed re-read turns RevenueCat's retry into a discarded
      // duplicate.
      try {
        await prisma.billingEvent.delete({
          where: { provider_id: { provider: REVENUECAT_PROVIDER, id: event.id } },
        });
      } catch (delErr) {
        logger.error(
          { event: "revenuecat_webhook_claim_stuck", eventId: event.id, err: delErr },
          "Handler failed AND the claim could not be released — RevenueCat's retry will be treated as a duplicate. POST /api/billing/store-sync from the app, or delete the billing_events row, recovers it",
        );
      }
      logger.error(
        { event: "revenuecat_webhook_handler_failed", eventId: event.id, type: event.type, err: err instanceof Error ? err.message : "unknown" },
        "RevenueCat webhook handler failed — claim released, answering 500 so RevenueCat retries",
      );
      return res.status(500).end();
    }
  });

  return router;
}

/** Resubmission B1 — the path, exported so the tests cannot disagree about it. */
export const REVENUECAT_WEBHOOK_PATH = "/webhooks/revenuecat";

/** The ledger's provider half for RevenueCat events (billing_events PK). */
export const REVENUECAT_PROVIDER = "revenuecat";

/**
 * The event types after which a user's entitlement may have changed, so the
 * customer is re-read. Everything else (TEST, EXPERIMENT_ENROLLMENT,
 * SUBSCRIBER_ALIAS, INVOICE_ISSUANCE, price-increase consent, virtual
 * currency, …) is acknowledged and logged. Re-reading is always safe, so an
 * over-broad set costs a GET, never a wrong row.
 */
export const REVENUECAT_RESYNC_TYPES: ReadonlySet<string> = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "CANCELLATION",
  "UNCANCELLATION",
  "EXPIRATION",
  "BILLING_ISSUE",
  "PRODUCT_CHANGE",
  "TRANSFER",
  "SUBSCRIPTION_PAUSED",
  "SUBSCRIPTION_EXTENDED",
  "REFUND_REVERSED",
  "TEMPORARY_ENTITLEMENT_GRANT",
  "NON_RENEWING_PURCHASE",
]);

/** The fields of a RevenueCat webhook event this route reads. */
export interface RevenueCatWebhookEvent {
  id: string;
  type: string;
  app_user_id?: string | null;
  transferred_from?: string[] | null;
  transferred_to?: string[] | null;
  environment?: string | null;
  original_transaction_id?: string | null;
}

/**
 * TRANSFER moves a purchase between app user ids (a Restore on another
 * account), so BOTH sides change: every id in `transferred_from` ∪
 * `transferred_to`. Every other type: `app_user_id`. Deduplicated.
 */
export function affectedAppUserIds(event: RevenueCatWebhookEvent): string[] {
  const ids =
    event.type === "TRANSFER"
      ? [...(event.transferred_from ?? []), ...(event.transferred_to ?? [])]
      : [event.app_user_id ?? ""];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id !== ""))];
}

/** Constant-time over digests, so a length difference leaks nothing either. */
function constantTimeEquals(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

const webhooksRouter: IRouter = createWebhooksRouter();
export default webhooksRouter;

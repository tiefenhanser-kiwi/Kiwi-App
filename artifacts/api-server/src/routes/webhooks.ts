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
// route claims the event id in `stripe_events` before doing any work, so two
// concurrent deliveries cannot both proceed — the second INSERT raises P2002 and
// is acknowledged, ignored.
//
// 🔴 AND IT RELEASES THE CLAIM IF THE HANDLER THROWS. This is the subtle half. A
// claim that survived a failed handler would mark the event permanently seen, so
// Stripe's retry — the thing that makes at-least-once delivery useful — would be
// discarded as a duplicate and the update would be lost forever. So the claim is
// deleted on the error path and the route answers 500, which is what asks Stripe
// to try again.

import express, { Router, type IRouter } from "express";
import type { PrismaClient } from "@prisma/client";

import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { readBillingConfig, type BillingConfig } from "../lib/billing/config";
import { getStripe, type StripeLike } from "../lib/billing/stripeClient";
import { dispatchStripeEvent } from "../lib/billing/webhookMirror";

/** The path, exported so app.ts and the tests cannot disagree about it. */
export const STRIPE_WEBHOOK_PATH = "/webhooks/stripe";

export interface WebhooksRouterDeps {
  prisma: PrismaClient;
  billingConfig: BillingConfig;
  stripe: StripeLike;
}

export function createWebhooksRouter(
  deps: Partial<WebhooksRouterDeps> = {},
): IRouter {
  const prisma = deps.prisma ?? productionPrisma;
  const billingConfig = deps.billingConfig ?? readBillingConfig();
  const router: IRouter = Router();
  const stripeFor = (): StripeLike => deps.stripe ?? getStripe(billingConfig);

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
        await prisma.stripeEvent.create({
          data: { id: event.id, type: event.type },
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
          await prisma.stripeEvent.delete({ where: { id: event.id } });
        } catch (delErr) {
          // Now the event IS stuck — the claim stands and the retry will be
          // ignored. Nothing else can be done here, so it is logged at error
          // with both failures, because this is the one state that needs a human.
          logger.error(
            { event: "stripe_webhook_claim_stuck", eventId: event.id, err: delErr },
            "Handler failed AND the event claim could not be released — Stripe's retry will be treated as a duplicate and this event is LOST. Delete the row from stripe_events to allow a manual replay",
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

  return router;
}

const webhooksRouter: IRouter = createWebhooksRouter();
export default webhooksRouter;

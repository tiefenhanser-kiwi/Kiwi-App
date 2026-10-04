// Row 9 (1.1) · Stripe S1 Part D — /billing/* — THE TWO LINK-OUTS, and
// (Resubmission B1) the store sync.
//
// Kiwi never sees a card number. The two Stripe routes do the same small
// thing: mint a Stripe-hosted URL and hand it back. Since Resubmission B1 they
// are the WEB's rail only — on iOS and Android the app sells through Apple
// In-App Purchase and Google Play Billing via RevenueCat (Apple rejected 1.0
// under 3.1.1 for a subscription that could not be bought in the app), and
// those purchases reach Kiwi through POST /api/webhooks/revenuecat and
// POST /billing/store-sync below.
//
// ── WHAT THE STRIPE ROUTES DELIBERATELY DO NOT DO ────────────────────────
//
// They do not write subscription state. Not the status, not the plan, not the
// period. `POST /billing/checkout-session` persists exactly ONE thing — the
// Stripe customer id, because that is a fact about the customer rather than
// about a subscription, and creating a second customer for the same user on
// every checkout attempt would fragment their billing history permanently.
//
// Everything else arrives by webhook. The return URL is not evidence: a user can
// open it by hand, bookmark it, or never reach it because they closed the tab
// after paying. THE SOURCE OF TRUTH FOR ANYTHING STRIPE KNOWS IS THE WEBHOOK,
// and the only way to keep that true is for this file to have no write path for
// it to contradict.
//
// ── NO PAY-EARLY BONUS (Resubmission B1) ─────────────────────────────────
//
// D-WS9-270 §5a's "pay early, get more" is gone on every platform (Hans,
// 2026-10-04: "we can run pricing promos to trigger early conversions").
// Subscribing during the trial bills at purchase: Checkout sets no
// `subscription_data.trial_end`, exactly as the App Store and Google Play
// charge at purchase with no introductory offer configured. Promotions are
// Stripe promotion codes (`allow_promotion_codes` stays on) and store offers.
//
// ── ONE ACCOUNT, ONE PAID RAIL ───────────────────────────────────────────
//
// A user entitled through the App Store or Google Play is refused a Stripe
// checkout and the Stripe Portal with 409 `subscribed_elsewhere { source }` —
// Kiwi must never sell a second subscription to someone already paying, and
// the store subscription is managed in the store (`managementUrl`).

import { Router, type IRouter, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import { logger } from "../lib/logger";
import { prisma as productionPrisma } from "../lib/prisma";
import { rateLimit } from "../lib/rateLimit";
import { createRequireAuth } from "../middleware/auth";
import { readBillingConfig, type BillingConfig } from "../lib/billing/config";
import {
  getStripe,
  readCustomerId,
  type StripeLike,
} from "../lib/billing/stripeClient";
import {
  effectiveStatus,
  isEntitled,
  readSubscriptionSnapshot,
  type SubscriptionSnapshot,
} from "../lib/subscriptionService";
import { RevenueCatFetchError, type FetchLike } from "../lib/billing/revenuecat";
import { syncStoreSubscription } from "../lib/billing/storeSync";
import { buildSubscriptionPayload } from "../lib/billing/subscriptionPayload";

const CheckoutRequestSchema = z.object({
  plan: z.enum(["monthly", "annual"]),
  // Recorded on the session's metadata for the conversion read; it changes
  // nothing about the session itself, so an unknown value is not worth a 400.
  platform: z.enum(["web", "ios", "android"]).optional(),
});

export interface BillingRouterDeps {
  prisma: PrismaClient;
  billingConfig: BillingConfig;
  /**
   * The outbound seam. NO DEFAULT that reaches Stripe: this is built from the
   * config only when the routes are actually called, so a test that injects
   * nothing and never calls them touches nothing, and a test that DOES call them
   * must hand in a fake. `pnpm test` loads .env — `customers.create` against a
   * live key makes a real customer.
   */
  stripe: StripeLike;
  /**
   * Resubmission B1 — the RevenueCat re-read seam for POST /billing/store-sync.
   * Defaults to the global fetch; every test injects a fake.
   */
  storeFetch: FetchLike;
  now?: () => Date;
  limiterOpts?: { capacity: number; refillPerSec: number };
  storeSyncLimiterOpts?: { capacity: number; refillPerSec: number };
}

/**
 * The 409 for a store-entitled row, or null. `source` is apple | google; the
 * client turns it into "Manage in the App Store / Google Play" and opens
 * `managementUrl`.
 */
function storeOwnedRefusal(
  snapshot: SubscriptionSnapshot | null,
  status: ReturnType<typeof effectiveStatus> | "none",
): { code: "subscribed_elsewhere"; source: "apple" | "google"; managementUrl: string | null } | null {
  const source = snapshot?.source ?? null;
  if (source !== "apple" && source !== "google") return null;
  if (status === "none" || !isEntitled(status)) return null;
  return {
    code: "subscribed_elsewhere",
    source,
    managementUrl: snapshot?.storeManagementUrl ?? null,
  };
}

export function createBillingRouter(deps: Partial<BillingRouterDeps> = {}): IRouter {
  const prisma = deps.prisma ?? productionPrisma;
  const billingConfig = deps.billingConfig ?? readBillingConfig();
  const requireAuth = createRequireAuth({ prisma });
  const now = deps.now ?? (() => new Date());
  const storeFetch: FetchLike =
    deps.storeFetch ?? (globalThis.fetch as unknown as FetchLike);
  const router: IRouter = Router();

  // Resolved lazily and only when a route runs, so an unconfigured deploy never
  // constructs a client and a test that injects one never builds the real one.
  const stripeFor = (): StripeLike => deps.stripe ?? getStripe(billingConfig);

  // Both routes are one outbound call to Stripe and a redirect. A human taps
  // "Subscribe" once, maybe twice; anything faster is a loop or a probe, and
  // each attempt can create a Stripe customer.
  const limiter = rateLimit({
    ...(deps.limiterOpts ?? { capacity: 10, refillPerSec: 10 / 60 }),
    keyFn: (req) => `billing:${req.userId ?? "anonymous"}`,
  });

  // Store-sync is one outbound GET to RevenueCat per call, triggered by a
  // purchase, a Restore, or the app coming back to the foreground after one.
  // Its own bucket so a Restore loop cannot starve checkout, and the reverse.
  const storeSyncLimiter = rateLimit({
    ...(deps.storeSyncLimiterOpts ?? { capacity: 6, refillPerSec: 6 / 60 }),
    keyFn: (req) => `billing-store-sync:${req.userId ?? "anonymous"}`,
  });

  /** The 503 both routes answer when the deploy has no Stripe. NAMES, never values. */
  function unavailable(res: Response) {
    logger.warn(
      { event: "billing_route_unavailable", vars: billingConfig.missing },
      "A billing route was called on a deploy with no Stripe configuration — answering 503",
    );
    return res.status(503).json({ code: "billing_unavailable" });
  }

  // ── POST /billing/checkout-session ────────────────────────────────────

  router.post("/billing/checkout-session", requireAuth, limiter, async (req, res) => {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "unauthenticated" });
    if (!billingConfig.available) return unavailable(res);

    const parsed = CheckoutRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: "invalid request body",
        details: parsed.error.flatten(),
      });
    }
    const { plan, platform } = parsed.data;
    const priceId =
      plan === "monthly" ? billingConfig.priceMonthly : billingConfig.priceAnnual;
    // `available` already proved both are set; this satisfies the compiler and
    // would catch a future config shape that let one through.
    if (!priceId) return unavailable(res);

    try {
      const snapshot = await readSubscriptionSnapshot(prisma, userId);
      const status = snapshot === null ? "none" : effectiveStatus(snapshot, now());

      // 🔴 Resubmission B1 — paying through the App Store or Google Play. A
      // second (Stripe) subscription would double-charge; refuse it here,
      // before a customer is created.
      const elsewhere = storeOwnedRefusal(snapshot, status);
      if (elsewhere !== null) {
        logger.info(
          { event: "billing_checkout_subscribed_elsewhere", userId, source: elsewhere.source },
          "Checkout refused — the account is entitled through a store subscription",
        );
        return res.status(409).json(elsewhere);
      }

      // Already paying. NOT an error the user caused — two devices, or a stale
      // paywall that never refetched — so it is a 409 with a code the client can
      // turn into "You're already subscribed" and a refetch, rather than a 400.
      if (status === "active" || status === "past_due") {
        return res.status(409).json({ code: "already_subscribed" });
      }

      const stripe = stripeFor();

      // ── the customer, created at most once per user, ever ──
      let customerId = snapshot?.stripeCustomerId ?? null;
      if (customerId === null) {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { email: true },
        });
        const created = await stripe.customers.create({
          // Prefills the Checkout page and is what Stripe's receipts go to.
          email: user?.email ?? undefined,
          // 🔴 THE BACK-REFERENCE. A Stripe customer with no userId is an
          // orphan nobody can reconcile — and the webhook's fallback path reads
          // it when an event carries no client_reference_id.
          metadata: { userId },
        });
        customerId = created.id;
        // Persisted BEFORE the session is created. If the session call fails,
        // the next attempt reuses this customer instead of minting a second one.
        await prisma.subscription.update({
          where: { userId },
          data: { stripeCustomerId: customerId },
        });
      }

      const base = billingConfig.returnUrlBase;
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        customer: customerId,
        // Two back-references, because they answer different questions: this one
        // is on the SESSION (what the checkout.session.completed handler reads)…
        client_reference_id: userId,
        allow_promotion_codes: true,
        // Stripe Tax (§10). Prices are tax-exclusive — $9.99 + tax, the US norm.
        automatic_tax: { enabled: true },
        // `{CHECKOUT_SESSION_ID}` is Stripe's own template token; it must reach
        // Stripe unescaped, which is why this is a plain string and not a URL.
        success_url: `${base}/billing/return?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/billing/cancelled`,
        // NO `trial_end` — see this file's header. The first charge is today.
        subscription_data: {
          // …and this one is on the SUBSCRIPTION, which is what every later
          // customer.subscription.* event carries. The session's metadata is
          // gone by then.
          metadata: { userId },
        },
        metadata: {
          userId,
          ...(platform ? { platform } : {}),
        },
      });

      if (!session.url) {
        // Stripe returns a null url only for a session that cannot be hosted.
        // Nothing the client can do with a 200 here.
        logger.error(
          { event: "billing_checkout_no_url", userId, sessionId: session.id },
          "Stripe returned a Checkout Session with no url",
        );
        return res.status(502).json({ code: "billing_session_failed" });
      }

      logger.info(
        {
          event: "billing_checkout_session_created",
          userId,
          plan,
          platform: platform ?? null,
          status,
        },
        "Checkout Session created",
      );
      return res.json({ url: session.url });
    } catch (err) {
      logger.error({ event: "billing_checkout_failed", userId, err }, "Checkout Session failed");
      return res.status(502).json({ code: "billing_session_failed" });
    }
  });

  // ── POST /billing/portal-session ───────────────────────────────────────
  //
  // The Portal is where changing the card, switching monthly ↔ annual and
  // CANCELLING a STRIPE subscription live. Kiwi builds no cancel UI (PRD
  // §14.7). A store-sourced row is refused (Resubmission B1): the Stripe Portal
  // cannot touch an App Store or Google Play subscription, and the client
  // sends the user to `managementUrl` instead.

  router.post("/billing/portal-session", requireAuth, limiter, async (req, res) => {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "unauthenticated" });
    if (!billingConfig.available) return unavailable(res);

    try {
      const snapshot = await readSubscriptionSnapshot(prisma, userId);

      const source = snapshot?.source ?? null;
      if (source === "apple" || source === "google") {
        return res.status(409).json({
          code: "subscribed_elsewhere",
          source,
          managementUrl: snapshot?.storeManagementUrl ?? null,
        });
      }

      const customerId = snapshot?.stripeCustomerId ?? null;
      // No customer means this user has never reached checkout, so there is
      // nothing to manage. A 409 with a code, not a 404: the ACCOUNT exists, the
      // billing relationship does not, and the client's correct response is to
      // show the paywall rather than an error.
      if (customerId === null) {
        return res.status(409).json({ code: "no_billing_account" });
      }

      const session = await stripeFor().billingPortal.sessions.create({
        customer: customerId,
        return_url: `${billingConfig.returnUrlBase}/billing/return`,
      });
      logger.info({ event: "billing_portal_session_created", userId }, "Portal Session created");
      return res.json({ url: session.url });
    } catch (err) {
      logger.error({ event: "billing_portal_failed", userId, err }, "Portal Session failed");
      return res.status(502).json({ code: "billing_session_failed" });
    }
  });

  // ── POST /billing/store-sync — Resubmission B1 ─────────────────────────
  //
  // The app calls this right after an App Store / Google Play purchase or a
  // Restore Purchases, because RevenueCat's webhook can land seconds later and
  // the user is looking at the paywall in the meantime. It re-reads the
  // signed-in user from RevenueCat, writes the row under the one-row rule
  // (lib/billing/storeSync.ts), and answers with the GET /me/subscription
  // body — so the client unlocks from this response alone.
  //
  // The client sends NOTHING about the purchase. The user is `req.userId` (the
  // app logs RevenueCat in with the Kiwi user id), and the truth is
  // RevenueCat's, so there is no body for a tampered client to lie in.

  router.post("/billing/store-sync", requireAuth, storeSyncLimiter, async (req, res) => {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "unauthenticated" });
    if (!billingConfig.revenuecatAvailable) {
      logger.warn(
        { event: "billing_store_sync_unavailable", vars: billingConfig.revenuecatMissing },
        "POST /billing/store-sync on a deploy with RevenueCat unconfigured — answering 503",
      );
      return res.status(503).json({ code: "billing_unavailable" });
    }

    try {
      const outcome = await syncStoreSubscription(
        { prisma, config: billingConfig, fetchImpl: storeFetch, now },
        userId,
      );
      logger.info(
        { event: "billing_store_sync", userId, written: outcome.written, reason: outcome.reason, state: outcome.state },
        "Store sync done",
      );
      const snapshot = await readSubscriptionSnapshot(prisma, userId);
      return res.json(buildSubscriptionPayload(snapshot, billingConfig, now()));
    } catch (err) {
      if (err instanceof RevenueCatFetchError) {
        logger.error(
          { event: "billing_store_sync_fetch_failed", userId, status: err.status },
          "Store sync could not read RevenueCat — 502",
        );
        return res.status(502).json({ code: "store_sync_failed" });
      }
      logger.error({ event: "billing_store_sync_failed", userId, err }, "Store sync failed");
      return res.status(500).json({ code: "store_sync_failed" });
    }
  });

  return router;
}

/** Re-exported so tests and the webhook share one reader. */
export { readCustomerId };

const billingRouter: IRouter = createBillingRouter();
export default billingRouter;

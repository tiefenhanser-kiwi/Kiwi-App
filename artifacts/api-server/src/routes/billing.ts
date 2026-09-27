// Row 9 (1.1) · Stripe S1 Part D — /billing/* — THE TWO LINK-OUTS.
//
// Kiwi never sees a card number. Both routes do the same small thing: mint a
// Stripe-hosted URL and hand it back. The web sets `window.location`; iOS and
// Android open the SYSTEM BROWSER (never a WebView — the D-WS9-267 rails ruling
// and Stripe's own guidance agree), and the user comes back to the app by hand.
//
// ── WHAT THESE ROUTES DELIBERATELY DO NOT DO ─────────────────────────────
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
// ── PAY EARLY, GET MORE (D-WS9-270 §5a) ──────────────────────────────────
//
// A user who subscribes DURING the trial gets `subscription_data.trial_end =
// trialEndsAt + BILLING_EARLY_PAY_BONUS_DAYS`. The card goes on file, the first
// charge lands on that date, and the paid term starts then — so for the user it
// is "the rest of my trial plus two weeks free", and for Stripe it is an
// ordinary trial with a card: no proration, no credit notes, and the pre-charge
// reminder email is Stripe's own (keep "send trial-ending emails" ON in the
// Dashboard — several card-network and FTC rules want a reminder before a card
// on file is charged at the end of a free period).
//
// After the trial has lapsed there is NO bonus and no `trial_end` — checkout
// charges today. A second free period for someone who already had fourteen days
// is not an experiment, it is a giveaway with no end condition.

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
  readSubscriptionSnapshot,
} from "../lib/subscriptionService";

/**
 * Checkout requires `trial_end` to be at least 48 hours in the future. During a
 * running trial with the default 14-day bonus this is always comfortably true,
 * but `BILLING_EARLY_PAY_BONUS_DAYS=0` on the last day of a trial is a
 * configuration Hans can legitimately set, and it lands inside the window. So it
 * is asserted rather than assumed: too close → the trial_end is DROPPED and the
 * session is still created (the user can pay; they just pay today), with a log
 * line naming it. Refusing the checkout instead would turn a bonus-tuning knob
 * into an outage on the one screen that takes money.
 */
export const STRIPE_MIN_TRIAL_END_SECONDS = 48 * 60 * 60;

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
  now?: () => Date;
  limiterOpts?: { capacity: number; refillPerSec: number };
}

export function createBillingRouter(deps: Partial<BillingRouterDeps> = {}): IRouter {
  const prisma = deps.prisma ?? productionPrisma;
  const billingConfig = deps.billingConfig ?? readBillingConfig();
  const requireAuth = createRequireAuth({ prisma });
  const now = deps.now ?? (() => new Date());
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

      // ── pay early, get more ──
      let trialEnd: number | null = null;
      let earlyPayBonusApplied = false;
      if (status === "trialing" && snapshot?.trialEndsAt) {
        const candidate = Math.floor(
          (snapshot.trialEndsAt.getTime() +
            billingConfig.earlyPayBonusDays * 24 * 60 * 60 * 1000) /
            1000,
        );
        const earliest =
          Math.floor(now().getTime() / 1000) + STRIPE_MIN_TRIAL_END_SECONDS;
        if (candidate >= earliest) {
          trialEnd = candidate;
          earlyPayBonusApplied = billingConfig.earlyPayBonusDays > 0;
        } else {
          // See STRIPE_MIN_TRIAL_END_SECONDS. The user can still pay.
          logger.warn(
            {
              event: "billing_trial_end_too_soon",
              userId,
              bonusDays: billingConfig.earlyPayBonusDays,
              candidate,
              earliest,
            },
            "Computed trial_end is inside Stripe's 48-hour minimum — creating the session WITHOUT a trial (the first charge is today)",
          );
        }
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
        subscription_data: {
          ...(trialEnd !== null ? { trial_end: trialEnd } : {}),
          // …and this one is on the SUBSCRIPTION, which is what every later
          // customer.subscription.* event carries. The session's metadata is
          // gone by then.
          metadata: {
            userId,
            earlyPayBonusApplied: String(earlyPayBonusApplied),
            bonusDays: String(billingConfig.earlyPayBonusDays),
          },
        },
        metadata: {
          userId,
          earlyPayBonusApplied: String(earlyPayBonusApplied),
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
          trialEnd,
          earlyPayBonusApplied,
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
  // CANCELLING live. Kiwi builds no cancel UI (PRD §14.7): App Review is
  // satisfied by the link-out because Kiwi sells nothing in-app.

  router.post("/billing/portal-session", requireAuth, limiter, async (req, res) => {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "unauthenticated" });
    if (!billingConfig.available) return unavailable(res);

    try {
      const snapshot = await readSubscriptionSnapshot(prisma, userId);
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

  return router;
}

/** Re-exported so tests and the webhook share one reader. */
export { readCustomerId };

const billingRouter: IRouter = createBillingRouter();
export default billingRouter;

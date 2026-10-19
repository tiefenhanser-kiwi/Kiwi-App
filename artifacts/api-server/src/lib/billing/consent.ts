// FIX-8 (D-WS9-317) — CALIFORNIA AUTO-RENEWAL CONSENT AT WEB CHECKOUT.
//
// Counsel, 2026-10-18: California requires the consumer's consent to the
// AUTOMATIC RENEWAL itself, separate from signing up for the service, and
// proof of that consent kept for three years. No specific form of proof is
// prescribed. Kiwi's answer has two halves:
//
//   1. THE CHECKBOX. Every web Checkout Session asks Stripe for
//      `consent_collection.terms_of_service: 'required'` with our own
//      acceptance text, which names the renewal, the period and the price.
//      Checkout cannot be completed without ticking it.
//   2. THE RECORD. On `checkout.session.completed` one `billing_consents` row
//      keeps the text the customer was SHOWN (read back off the completed
//      session, not re-rendered), Stripe's `consent.terms_of_service`, the
//      price facts and the moment. A second copy goes on the Stripe
//      subscription's metadata.
//
// Store purchases (Apple, Google) are out of scope; counsel is asked
// separately.
//
// ── THE TEXT CANNOT DRIFT FROM THE PRICE ─────────────────────────────────
//
// The amount and the interval are read from the configured Stripe price
// object, never typed here. A price change in the Dashboard is a new price id
// (Stripe prices are immutable in amount), so the text follows the env var
// that names the price. The read is cached per client and price id.
//
// ── A WORDING CHANGE IS A NEW VERSION ────────────────────────────────────
//
// The template below is V1. Changing a word means adding a V2 constant,
// pointing AUTO_RENEW_CONSENT_TEXT at it and bumping the version string, so
// every stored row says which wording its customer agreed to.

import type { PrismaClient } from "@prisma/client";

import { logger } from "../logger";
import {
  readCustomerId,
  type StripeEventLike,
  type StripeLike,
  type StripePriceLike,
} from "./stripeClient";

/** V1, verbatim from FIX-8. `{interval}` and `{amount}` come from the price. */
export const AUTO_RENEW_CONSENT_TEXT_V1 =
  "I agree to the [Terms of Service](https://kitchenwizard.ai/terms.html). Kiwi Premium renews automatically every {interval} at {amount} plus any sales tax until I cancel. I can cancel anytime with Manage in my Kiwi profile.";

/** The template in force, and its version. Bump both together. */
export const AUTO_RENEW_CONSENT_TEXT = AUTO_RENEW_CONSENT_TEXT_V1;
export const AUTO_RENEW_CONSENT_TEXT_VERSION = "v1";

/**
 * The session-metadata keys the checkout route stamps and the webhook reads.
 * A completed session WITHOUT the version key was not created by FIX-8's
 * checkout (a pre-deploy session, a Dashboard or Payment Link session) and
 * its customer was never shown the checkbox, so it writes no row.
 */
export const CONSENT_META_VERSION = "consentTextVersion";
export const CONSENT_META_PRICE_ID = "consentPriceId";

/** What the text and the record need from a Stripe price. */
export interface PriceTerms {
  priceId: string;
  /** Minor units (999 = $9.99). */
  unitAmount: number;
  /** Stripe's lowercase ISO code, e.g. "usd". */
  currency: string;
  /** "day" | "week" | "month" | "year". */
  interval: string;
  intervalCount: number;
}

/** Thrown when a configured price cannot carry the consent text. */
export class ConsentPriceError extends Error {
  constructor(priceId: string, why: string) {
    super(`Stripe price ${priceId} cannot render the auto-renewal consent text: ${why}`);
    this.name = "ConsentPriceError";
  }
}

// Per client, so a test's fake never sees another test's prices and the real
// (memoised) client keeps its cache for the life of the process.
const priceCache = new WeakMap<StripeLike, Map<string, PriceTerms>>();

function toTerms(priceId: string, p: StripePriceLike): PriceTerms {
  if (typeof p.unit_amount !== "number") {
    throw new ConsentPriceError(priceId, "it has no unit_amount (tiered or custom pricing)");
  }
  if (!p.recurring || typeof p.recurring.interval !== "string") {
    throw new ConsentPriceError(priceId, "it is not a recurring price");
  }
  return {
    priceId,
    unitAmount: p.unit_amount,
    currency: p.currency,
    interval: p.recurring.interval,
    intervalCount: p.recurring.interval_count ?? 1,
  };
}

/**
 * The price's amount and interval, fetched once per client and price id. A
 * failed fetch is NOT cached, so the next checkout tries again.
 */
export async function readPriceTerms(stripe: StripeLike, priceId: string): Promise<PriceTerms> {
  let byId = priceCache.get(stripe);
  if (!byId) {
    byId = new Map();
    priceCache.set(stripe, byId);
  }
  const hit = byId.get(priceId);
  if (hit) return hit;
  const terms = toTerms(priceId, await stripe.prices.retrieve(priceId));
  byId.set(priceId, terms);
  return terms;
}

/** "$9.99" — the currency's own minor-unit count, so a zero-decimal one reads right. */
export function formatPriceAmount(unitAmount: number, currency: string): string {
  const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() });
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  return fmt.format(unitAmount / 10 ** digits);
}

/** "month", or "3 months" for an interval_count above one. */
export function formatInterval(interval: string, count: number): string {
  return count === 1 ? interval : `${count} ${interval}s`;
}

/** The acceptance message for one price, in the wording in force. */
export function renderAutoRenewConsent(terms: PriceTerms): string {
  return AUTO_RENEW_CONSENT_TEXT.replace(
    "{interval}",
    formatInterval(terms.interval, terms.intervalCount),
  ).replace("{amount}", formatPriceAmount(terms.unitAmount, terms.currency));
}

// ── the record ───────────────────────────────────────────────────────────

/** The fields of a completed Checkout Session the record reads. */
export interface CompletedSessionLike {
  id?: string;
  mode?: string | null;
  livemode?: boolean;
  customer?: string | { id: string } | null;
  subscription?: string | { id: string } | null;
  metadata?: Record<string, string> | null;
  consent?: { terms_of_service?: string | null } | null;
  custom_text?: {
    terms_of_service_acceptance?: { message?: string | null } | null;
  } | null;
}

export interface ConsentDeps {
  prisma: Pick<PrismaClient, "billingConsent">;
  stripe: StripeLike;
}

export type ConsentOutcome =
  | "recorded"
  | "already_recorded"
  | "not_subscription"
  | "no_version_stamp";

function prismaCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

/**
 * Write the one `billing_consents` row for a completed subscription session.
 *
 * SAFE TO REPLAY: the session id is UNIQUE, and a second insert (a released
 * claim's retry, or a manual replay after deleting the billing_events row) is
 * acknowledged as `already_recorded` without touching Stripe again.
 *
 * Consent that is not `accepted` is written anyway, with Stripe's value, and
 * warned about. The subscription mirror never waits on it.
 */
export async function recordCheckoutConsent(
  deps: ConsentDeps,
  event: StripeEventLike,
  session: CompletedSessionLike,
  userId: string | null,
): Promise<ConsentOutcome> {
  if (session.mode !== "subscription") return "not_subscription";

  const version = session.metadata?.[CONSENT_META_VERSION] ?? null;
  const sessionId = typeof session.id === "string" ? session.id : null;
  if (version === null || sessionId === null) {
    // Forward-only (D-WS9-230): this customer was never shown the checkbox.
    logger.info(
      { event: "billing_consent_not_stamped", eventId: event.id, sessionId, userId },
      "Completed subscription session carries no consent version — created before FIX-8 or outside Kiwi's checkout; no consent row",
    );
    return "no_version_stamp";
  }

  const priceId = session.metadata?.[CONSENT_META_PRICE_ID];
  if (!priceId) {
    throw new Error(`checkout session ${sessionId} has a consent version but no ${CONSENT_META_PRICE_ID}`);
  }
  const terms = await readPriceTerms(deps.stripe, priceId);

  const shown = session.custom_text?.terms_of_service_acceptance?.message ?? null;
  let consentText = shown;
  if (consentText === null || consentText === "") {
    consentText = renderAutoRenewConsent(terms);
    logger.warn(
      { event: "billing_consent_text_missing", eventId: event.id, sessionId, version },
      "Completed session carries no custom acceptance text — recording the text Kiwi renders for this price instead",
    );
  }

  const termsOfService = session.consent?.terms_of_service ?? null;
  if (termsOfService !== "accepted") {
    logger.warn(
      { event: "billing_consent_not_accepted", eventId: event.id, sessionId, userId, termsOfService },
      "Completed subscription session's terms_of_service consent is not 'accepted' — recorded as-is; the subscription is mirrored regardless",
    );
  }

  const subscriptionId = readCustomerId(session.subscription);
  // The session has no completion timestamp; the completed event's `created`
  // is the moment Stripe accepted the checkout.
  const acceptedAt = new Date(event.created * 1000);
  const data = {
    userId,
    stripeCustomerId: readCustomerId(session.customer),
    stripeSessionId: sessionId,
    stripeSubscriptionId: subscriptionId,
    priceId,
    unitAmount: terms.unitAmount,
    currency: terms.currency,
    interval: terms.interval,
    intervalCount: terms.intervalCount,
    consentText,
    consentTextVersion: version,
    termsOfService,
    acceptedAt,
    livemode: session.livemode === true,
  };

  try {
    try {
      await deps.prisma.billingConsent.create({ data });
    } catch (err) {
      // The account was deleted between checkout and completion: the proof
      // stands without it, exactly as it will after any later deletion.
      if (prismaCode(err) !== "P2003" || userId === null) throw err;
      logger.warn(
        { event: "billing_consent_user_gone", sessionId, userId },
        "Consent's user no longer exists — recorded with a null user id",
      );
      await deps.prisma.billingConsent.create({ data: { ...data, userId: null } });
    }
  } catch (err) {
    if (prismaCode(err) === "P2002") {
      logger.info(
        { event: "billing_consent_replay", eventId: event.id, sessionId },
        "Consent for this checkout session is already recorded — nothing written",
      );
      return "already_recorded";
    }
    throw err;
  }

  logger.info(
    { event: "billing_consent_recorded", sessionId, userId, subscriptionId, version, termsOfService },
    "Auto-renewal consent recorded",
  );

  // The second copy, held by Stripe. Logged, never retried: the row above is
  // the record, and a subscription that has since been deleted would fail
  // this forever.
  if (subscriptionId !== null) {
    try {
      await deps.stripe.subscriptions.update(subscriptionId, {
        metadata: {
          [CONSENT_META_VERSION]: version,
          consentAcceptedAt: acceptedAt.toISOString(),
        },
      });
    } catch (err) {
      logger.warn(
        {
          event: "billing_consent_metadata_failed",
          sessionId,
          subscriptionId,
          err: err instanceof Error ? err.message : "unknown",
        },
        "Could not copy the consent version onto the Stripe subscription's metadata — the billing_consents row stands",
      );
    }
  }
  return "recorded";
}

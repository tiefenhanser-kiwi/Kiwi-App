// Row 9 (1.1) · Stripe S1 — THE FAKE, and the reason it is a fixture rather
// than a local in each test file.
//
// `pnpm test` loads `.env`. Once Hans commissions S3 that environment has a live
// `STRIPE_SECRET_KEY`, and the calls this block makes are not idempotent reads:
// `customers.create` makes a real customer, `customers.del` deletes one, and
// `subscriptions.cancel` cancels a real person's subscription. There is no
// default in `BillingRouterDeps.stripe` for a forgotten stub to fall through
// to — but the fake has to be easy enough to reach for that nobody is tempted to
// write a one-line `as never` that accidentally satisfies the type and then
// calls the real thing.
//
// It implements `StripeLike` and NOTHING ELSE, so a future block that needs
// another Stripe call has to add it to the seam first — deliberately, in one
// place — rather than discovering at runtime that the fake was permissive.
//
// Every call is RECORDED. Several of this block's assertions are about what was
// sent to Stripe (the trial_end, the metadata back-references, the promotion-code
// flag) rather than about what came back, and those are the ones that would
// otherwise be untestable without a live account.

import type {
  StripeCheckoutSessionLike,
  StripeEventLike,
  StripeLike,
  StripeSubscriptionLike,
} from "../../../lib/billing/stripeClient";

export interface FakeStripeCalls {
  customersCreate: Array<{ email?: string | undefined; metadata: Record<string, string> }>;
  customersDel: string[];
  checkoutSessions: Array<Record<string, unknown>>;
  portalSessions: Array<{ customer: string; return_url: string }>;
  subscriptionsRetrieve: string[];
  subscriptionsCancel: string[];
  constructEvent: Array<{ payload: string; header: string; secret: string }>;
}

export interface FakeStripeOptions {
  /** The id `customers.create` answers. */
  customerId?: string;
  /** The session `checkout.sessions.create` answers; `url: null` is reachable. */
  checkoutSession?: Partial<StripeCheckoutSessionLike>;
  portalUrl?: string;
  /** What `subscriptions.retrieve` answers — the out-of-order refetch reads this. */
  subscription?: StripeSubscriptionLike;
  /** What `webhooks.constructEvent` returns; omit to make it throw (bad signature). */
  event?: StripeEventLike;
  /** Make a named method throw, to prove a failure never takes the caller with it. */
  throwOn?: Partial<
    Record<
      | "customersCreate"
      | "customersDel"
      | "checkoutSessionsCreate"
      | "portalSessionsCreate"
      | "subscriptionsRetrieve"
      | "subscriptionsCancel",
      Error
    >
  >;
}

export interface FakeStripe extends StripeLike {
  calls: FakeStripeCalls;
}

/** A minimal, valid-shaped subscription. Override only what a test is about. */
export function fakeSubscription(
  over: Partial<StripeSubscriptionLike> & {
    currentPeriodStart?: number;
    currentPeriodEnd?: number;
    priceId?: string;
  } = {},
): StripeSubscriptionLike {
  const {
    currentPeriodStart = 1_760_000_000,
    currentPeriodEnd = 1_762_592_000,
    priceId = "price_monthly_test",
    ...rest
  } = over;
  return {
    id: "sub_test",
    status: "active",
    cancel_at_period_end: false,
    trial_end: null,
    customer: "cus_test",
    metadata: {},
    // 🔴 THE PERIOD DATES LIVE ON THE ITEM, not the subscription — that is the
    // shape stripe@22.6.2's pinned API version (2026-08-26.dahlia) actually
    // sends, and building the fixture the honest way is what makes
    // readPeriod()'s item-first read a tested claim rather than a comment.
    items: {
      data: [
        {
          current_period_start: currentPeriodStart,
          current_period_end: currentPeriodEnd,
          price: { id: priceId },
        },
      ],
    },
    ...rest,
  };
}

export function makeFakeStripe(opts: FakeStripeOptions = {}): FakeStripe {
  const calls: FakeStripeCalls = {
    customersCreate: [],
    customersDel: [],
    checkoutSessions: [],
    portalSessions: [],
    subscriptionsRetrieve: [],
    subscriptionsCancel: [],
    constructEvent: [],
  };
  const boom = (k: keyof NonNullable<FakeStripeOptions["throwOn"]>): void => {
    const err = opts.throwOn?.[k];
    if (err) throw err;
  };

  return {
    calls,
    customers: {
      create: async (params) => {
        calls.customersCreate.push(params);
        boom("customersCreate");
        return { id: opts.customerId ?? "cus_fake" };
      },
      del: async (id) => {
        calls.customersDel.push(id);
        boom("customersDel");
        return { id, deleted: true };
      },
    },
    checkout: {
      sessions: {
        create: async (params) => {
          calls.checkoutSessions.push(params);
          boom("checkoutSessionsCreate");
          return {
            id: "cs_fake",
            url: "https://checkout.stripe.test/session",
            ...opts.checkoutSession,
          };
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (params) => {
          calls.portalSessions.push(params);
          boom("portalSessionsCreate");
          return { url: opts.portalUrl ?? "https://portal.stripe.test/session" };
        },
      },
    },
    subscriptions: {
      retrieve: async (id) => {
        calls.subscriptionsRetrieve.push(id);
        boom("subscriptionsRetrieve");
        return opts.subscription ?? fakeSubscription({ id });
      },
      cancel: async (id) => {
        calls.subscriptionsCancel.push(id);
        boom("subscriptionsCancel");
        return opts.subscription ?? fakeSubscription({ id, status: "canceled" });
      },
    },
    webhooks: {
      constructEvent: (payload, header, secret) => {
        calls.constructEvent.push({
          payload: typeof payload === "string" ? payload : payload.toString("utf8"),
          header,
          secret,
        });
        if (!opts.event) {
          // What the real SDK does on a signature it cannot verify. The route's
          // 400 branch is driven by this throw, not by a boolean.
          throw Object.assign(new Error("No signatures found matching the expected signature for payload"), {
            type: "StripeSignatureVerificationError",
          });
        }
        return opts.event;
      },
    },
  };
}

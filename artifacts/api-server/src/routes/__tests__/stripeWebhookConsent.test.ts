// FIX-8 (D-WS9-317) — the auto-renewal consent RECORD, written by
// POST /api/webhooks/stripe on `checkout.session.completed`.
//
// California wants proof of the consent kept for three years. The claims:
//
//   1. ONE completed, stamped subscription session writes EXACTLY ONE row,
//      holding the text the customer was SHOWN (read off the session), Stripe's
//      consent value, the price facts and the event's `created` as the moment.
//   2. A REPLAY WRITES NOTHING. The billing_events claim stops an identical
//      redelivery; the UNIQUE session id is what stops the manual replay the
//      webhook's own log line tells an operator to do (delete the claim, resend).
//   3. Consent not `accepted` is written anyway and never blocks the mirror.
//   4. No version stamp (a pre-FIX-8 or Dashboard session) → no row, forward-only.
//
// The stub models the two constraints the database enforces here — the unique
// session id (P2002) and the user FK (P2003) — because a stub that accepted
// every insert would let the replay through while this file stayed green.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { readBillingConfig } from "../../lib/billing/config";
import type { StripeEventLike } from "../../lib/billing/stripeClient";
import { createWebhooksRouter, STRIPE_PROVIDER, STRIPE_WEBHOOK_PATH } from "../webhooks";
import { makeFakeStripe, type FakeStripe, type FakeStripeOptions } from "./fixtures/fakeStripe";

const USER_ID = "consent-user";
const CUSTOMER = "cus_consent";
const SUBSCRIPTION = "sub_consent";
const SESSION = "cs_test_consent";
const COMPLETED_AT = 1_760_400_000;

const MONTHLY_TEXT =
  "I agree to the [Terms of Service](https://kitchenwizard.ai/terms.html). Kiwi Premium renews automatically every month at $9.99 plus any sales tax until I cancel. I can cancel anytime with Manage in my Kiwi profile.";

const CONFIGURED: Record<string, string> = {
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
  STRIPE_PRICE_MONTHLY: "price_monthly_test",
  STRIPE_PRICE_ANNUAL: "price_annual_test",
  BILLING_RETURN_URL_BASE: "https://app.example",
};

type ConsentRow = Record<string, unknown> & { stripeSessionId: string; userId: string | null };

function stubPrisma(opts: { users?: string[] } = {}) {
  const users = new Set(opts.users ?? [USER_ID]);
  const events = new Map<string, unknown>();
  const consents: ConsentRow[] = [];
  const subscriptionUpdates: Array<Record<string, unknown>> = [];
  return {
    subscription: {
      findUnique: async () => null,
      findFirst: async () => null,
      update: async (args: { data: Record<string, unknown> }) => {
        subscriptionUpdates.push(args.data);
        return {};
      },
    },
    billingEvent: {
      create: async ({ data }: { data: { provider: string; id: string } }) => {
        const key = `${data.provider}:${data.id}`;
        if (events.has(key)) throw Object.assign(new Error("dup"), { code: "P2002" });
        events.set(key, data);
        return data;
      },
      delete: async ({ where }: { where: { provider_id: { provider: string; id: string } } }) => {
        events.delete(`${where.provider_id.provider}:${where.provider_id.id}`);
        return where.provider_id;
      },
    },
    billingConsent: {
      create: async ({ data }: { data: ConsentRow }) => {
        // billing_consents_stripeSessionId_key
        if (consents.some((c) => c.stripeSessionId === data.stripeSessionId)) {
          throw Object.assign(new Error("Unique constraint failed on the fields: (`stripeSessionId`)"), {
            code: "P2002",
          });
        }
        // billing_consents_userId_fkey
        if (data.userId !== null && !users.has(data.userId)) {
          throw Object.assign(new Error("Foreign key constraint violated: billing_consents_userId_fkey"), {
            code: "P2003",
          });
        }
        consents.push({ ...data });
        return data;
      },
    },
    _events: events,
    _consents: consents,
    _subscriptionUpdates: subscriptionUpdates,
  };
}

interface Harness {
  prisma: ReturnType<typeof stubPrisma>;
  stripe: FakeStripe;
  send: () => Promise<Response>;
  close: () => Promise<void>;
}

async function spinUp(
  event: StripeEventLike,
  opts: { users?: string[]; stripe?: FakeStripeOptions } = {},
): Promise<Harness> {
  const prisma = stubPrisma(opts.users ? { users: opts.users } : {});
  const stripe = makeFakeStripe({ ...opts.stripe, event });
  const app: Express = express();
  app.use(
    "/api",
    createWebhooksRouter({
      prisma: prisma as never,
      billingConfig: readBillingConfig(CONFIGURED),
      stripe,
    }),
  );
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const { port } = server.address() as { port: number };
  return {
    prisma,
    stripe,
    send: () =>
      fetch(`http://127.0.0.1:${port}/api${STRIPE_WEBHOOK_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=x" },
        body: JSON.stringify({ any: "bytes" }),
      }),
    close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
  };
}

/** A completed session as Kiwi's FIX-8 checkout creates it. Override what a case is about. */
function completed(
  session: Record<string, unknown> = {},
  over: Partial<StripeEventLike> = {},
): StripeEventLike {
  return {
    id: "evt_consent",
    type: "checkout.session.completed",
    created: COMPLETED_AT,
    data: {
      object: {
        id: SESSION,
        mode: "subscription",
        livemode: false,
        client_reference_id: USER_ID,
        customer: CUSTOMER,
        subscription: SUBSCRIPTION,
        metadata: { userId: USER_ID, consentTextVersion: "v1", consentPriceId: "price_monthly_test" },
        consent: { promotions: null, terms_of_service: "accepted" },
        custom_text: { terms_of_service_acceptance: { message: MONTHLY_TEXT } },
        ...session,
      },
    },
    ...over,
  };
}

describe("checkout.session.completed records the auto-renewal consent (FIX-8)", () => {
  it("one completed session writes EXACTLY ONE row, with the text the customer was shown", async () => {
    const h = await spinUp(completed());
    try {
      assert.equal((await h.send()).status, 200);
      assert.equal(h.prisma._consents.length, 1, "exactly one consent row");
      assert.deepEqual(h.prisma._consents[0], {
        userId: USER_ID,
        stripeCustomerId: CUSTOMER,
        stripeSessionId: SESSION,
        stripeSubscriptionId: SUBSCRIPTION,
        priceId: "price_monthly_test",
        unitAmount: 999,
        currency: "usd",
        interval: "month",
        intervalCount: 1,
        consentText: MONTHLY_TEXT,
        consentTextVersion: "v1",
        termsOfService: "accepted",
        acceptedAt: new Date(COMPLETED_AT * 1000),
        livemode: false,
      });
      // The ids still attach — the mirror's half is unchanged.
      assert.deepEqual(h.prisma._subscriptionUpdates, [
        { stripeCustomerId: CUSTOMER, stripeSubscriptionId: SUBSCRIPTION },
      ]);
      // The second copy, on the Stripe subscription.
      assert.deepEqual(h.stripe.calls.subscriptionsUpdate, [
        {
          id: SUBSCRIPTION,
          params: {
            metadata: {
              consentTextVersion: "v1",
              consentAcceptedAt: new Date(COMPLETED_AT * 1000).toISOString(),
            },
          },
        },
      ]);
    } finally {
      await h.close();
    }
  });

  it("records the SHOWN text even if Kiwi would render something else today", async () => {
    const shown = "An older wording the customer actually saw.";
    const h = await spinUp(
      completed({ custom_text: { terms_of_service_acceptance: { message: shown } } }),
    );
    try {
      assert.equal((await h.send()).status, 200);
      assert.equal(h.prisma._consents[0].consentText, shown);
    } finally {
      await h.close();
    }
  });

  it("a REPLAY writes nothing — identical redelivery, and a manual replay after the claim is deleted", async () => {
    const h = await spinUp(completed());
    try {
      assert.equal((await h.send()).status, 200);
      // The same event again: the billing_events claim stops it.
      const dup = await h.send();
      assert.equal(dup.status, 200);
      assert.deepEqual(await dup.json(), { received: true, duplicate: true });
      // The operator's manual replay (webhooks.ts: "Delete the row from
      // billing_events … to allow a manual replay"): the handler runs again,
      // and only the UNIQUE session id keeps the row single.
      h.prisma._events.delete(`${STRIPE_PROVIDER}:evt_consent`);
      const replay = await h.send();
      assert.equal(replay.status, 200, "a replay is acknowledged, not a 500 loop");
      assert.equal(h.prisma._consents.length, 1, "still exactly one consent row");
      assert.equal(h.stripe.calls.subscriptionsUpdate.length, 1, "Stripe's copy is not rewritten");
    } finally {
      await h.close();
    }
  });

  it("consent NOT accepted is written as-is, and the mirror still attaches the ids", async () => {
    const h = await spinUp(completed({ consent: { promotions: null, terms_of_service: null } }));
    try {
      assert.equal((await h.send()).status, 200);
      assert.equal(h.prisma._consents.length, 1);
      assert.equal(h.prisma._consents[0].termsOfService, null);
      assert.equal(h.prisma._subscriptionUpdates.length, 1, "the mirror is never blocked by it");
    } finally {
      await h.close();
    }
  });

  it("a session with NO version stamp (pre-FIX-8, Dashboard) writes no row — forward-only", async () => {
    const h = await spinUp(
      completed({ metadata: { userId: USER_ID }, consent: null, custom_text: null }),
    );
    try {
      assert.equal((await h.send()).status, 200);
      assert.equal(h.prisma._consents.length, 0);
      assert.equal(h.stripe.calls.subscriptionsUpdate.length, 0);
      assert.equal(h.prisma._subscriptionUpdates.length, 1, "the ids still attach");
    } finally {
      await h.close();
    }
  });

  it("a non-subscription session writes no row", async () => {
    const h = await spinUp(completed({ mode: "payment" }));
    try {
      assert.equal((await h.send()).status, 200);
      assert.equal(h.prisma._consents.length, 0);
    } finally {
      await h.close();
    }
  });

  it("a session no Kiwi user can be found for still keeps its proof, with a null user id", async () => {
    const h = await spinUp(
      completed({
        client_reference_id: null,
        metadata: { consentTextVersion: "v1", consentPriceId: "price_monthly_test" },
      }),
    );
    try {
      assert.equal((await h.send()).status, 200);
      assert.equal(h.prisma._consents.length, 1);
      assert.equal(h.prisma._consents[0].userId, null);
      assert.equal(h.prisma._subscriptionUpdates.length, 0, "nothing was guessed at");
    } finally {
      await h.close();
    }
  });

  it("an account deleted before the completion arrives: the row is written with a null user id", async () => {
    const h = await spinUp(completed(), { users: [] });
    try {
      assert.equal((await h.send()).status, 200);
      assert.equal(h.prisma._consents.length, 1);
      assert.equal(h.prisma._consents[0].userId, null);
    } finally {
      await h.close();
    }
  });

  it("a failed Stripe metadata copy is logged, not retried — 200, and the row stands", async () => {
    const h = await spinUp(completed(), {
      stripe: { throwOn: { subscriptionsUpdate: new Error("no such subscription") } },
    });
    try {
      assert.equal((await h.send()).status, 200);
      assert.equal(h.prisma._consents.length, 1);
      assert.equal(h.prisma._events.size, 1, "the claim stands — nothing asks Stripe to retry");
    } finally {
      await h.close();
    }
  });

  it("a failed price read releases the claim (500) so Stripe retries the record", async () => {
    const h = await spinUp(completed(), {
      stripe: { throwOn: { pricesRetrieve: new Error("stripe timeout") } },
    });
    try {
      assert.equal((await h.send()).status, 500);
      assert.equal(h.prisma._consents.length, 0);
      assert.equal(h.prisma._events.size, 0, "claim released for the retry");
    } finally {
      await h.close();
    }
  });
});

describe("billing_consents DDL (FIX-8)", () => {
  it("🔴 the session id is UNIQUE and the user FK is SET NULL — asserted against the migration SQL", async () => {
    // No database in this suite, so the evidence is the DDL itself (the
    // oauthAppleRevoke.test.ts pattern).
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const sql = readFileSync(
      fileURLToPath(
        new URL(
          "../../../prisma/migrations/20261018120000_fix8_billing_consents/migration.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    assert.match(
      sql,
      /CREATE UNIQUE INDEX "billing_consents_stripeSessionId_key" ON "billing_consents"\("stripeSessionId"\)/,
    );
    // Account deletion keeps the proof and drops the attribution.
    assert.match(
      sql,
      /ALTER TABLE "billing_consents" ADD CONSTRAINT "billing_consents_userId_fkey" FOREIGN KEY \("userId"\) REFERENCES "users"\("id"\) ON DELETE SET NULL/,
    );
    // Additive only.
    assert.doesNotMatch(sql, /\b(DROP|ALTER TABLE "(?!billing_consents")[a-z_]+")/);
  });
});

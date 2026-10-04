// Row 9 (1.1) · Stripe S1 Part E — POST /api/webhooks/stripe.
//
// This is the only unauthenticated WRITE path in the billing lane, and it is the
// only writer of subscription state anywhere in the server, so the tests are
// weighted towards the four ways a webhook silently corrupts data:
//
//   1. A BAD SIGNATURE IS NOT PROCESSED. Asserted as "400 AND nothing was
//      written AND the event id was not even claimed" — a route that verified
//      after claiming would pass a status-code-only test.
//   2. A REPLAY IS A NO-OP. Stripe delivers at least once and retries for three
//      days; the second delivery must not re-apply anything.
//   3. A FAILED HANDLER RELEASES ITS CLAIM. This is the subtle one. A claim that
//      outlived a failure would turn Stripe's retry into a discarded duplicate
//      and lose the update permanently — so the test asserts the ledger row is
//      GONE after a 500, and that a retry then works.
//   4. AN OLD EVENT DOES NOT REGRESS THE ROW. It refetches through the seam and
//      mirrors what Stripe says now.
//
// Plus the status map, including `unpaid → canceled` and the three statuses that
// map to nothing at all.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";
import type { SubscriptionStatus } from "@prisma/client";

import { readBillingConfig } from "../../lib/billing/config";
import type { StripeEventLike } from "../../lib/billing/stripeClient";
import { createWebhooksRouter, STRIPE_WEBHOOK_PATH } from "../webhooks";
import { makeFakeStripe, fakeSubscription, type FakeStripe } from "./fixtures/fakeStripe";

const USER_ID = "webhook-user";
const CUSTOMER = "cus_wh";
const SUBSCRIPTION = "sub_wh";

const CONFIGURED: Record<string, string> = {
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
  STRIPE_PRICE_MONTHLY: "price_monthly_test",
  STRIPE_PRICE_ANNUAL: "price_annual_test",
  BILLING_RETURN_URL_BASE: "https://app.example",
};

interface RowState {
  userId: string;
  status: SubscriptionStatus;
  planCode: string;
  trialEndsAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  sourceUpdatedAt: Date | null;
  source: "stripe" | "apple" | "google" | null;
}

function makeRow(over: Partial<RowState> = {}): RowState {
  return {
    userId: USER_ID,
    status: "trialing",
    planCode: "free",
    trialEndsAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    stripeCustomerId: CUSTOMER,
    stripeSubscriptionId: null,
    stripePriceId: null,
    sourceUpdatedAt: null,
    source: null,
    ...over,
  };
}

/** A stub that models the ledger's PRIMARY KEY, because that is the mechanism. */
function stubPrisma(row: RowState, opts: { updateThrows?: Error } = {}) {
  const events = new Map<string, { provider: string; id: string; type: string }>();
  const updates: Array<Record<string, unknown>> = [];
  return {
    subscription: {
      findUnique: async () => ({ ...row }),
      findFirst: async (args: { where: Record<string, unknown> }) => {
        const w = args.where;
        if (w.stripeSubscriptionId && w.stripeSubscriptionId === row.stripeSubscriptionId) {
          return { userId: row.userId };
        }
        if (w.stripeCustomerId && w.stripeCustomerId === row.stripeCustomerId) {
          return { userId: row.userId };
        }
        return null;
      },
      update: async (args: { where: unknown; data: Record<string, unknown> }) => {
        if (opts.updateThrows) throw opts.updateThrows;
        updates.push(args.data);
        Object.assign(row, args.data);
        return { ...row };
      },
    },
    billingEvent: {
      create: async ({ data }: { data: { provider: string; id: string; type: string } }) => {
        // 🔴 THE CONSTRAINT IS MODELLED, not faked. A stub that accepted every
        // insert would let a replay through and the idempotency test would pass
        // while the defect shipped.
        // Resubmission B1: the key is (provider, id).
        const key = `${data.provider}:${data.id}`;
        if (events.has(key)) {
          throw Object.assign(new Error("Unique constraint failed on the fields: (`provider`,`id`)"), {
            code: "P2002",
            meta: { target: ["provider", "id"] },
          });
        }
        events.set(key, data);
        return data;
      },
      delete: async ({ where }: { where: { provider_id: { provider: string; id: string } } }) => {
        events.delete(`${where.provider_id.provider}:${where.provider_id.id}`);
        return where.provider_id;
      },
    },
    _events: events,
    _updates: updates,
    _row: () => row,
  };
}

interface Harness {
  baseUrl: string;
  prisma: ReturnType<typeof stubPrisma>;
  stripe: FakeStripe;
  close: () => Promise<void>;
}

async function spinUp(
  row: RowState,
  opts: {
    event?: StripeEventLike;
    env?: Record<string, string>;
    subscription?: ReturnType<typeof fakeSubscription>;
    updateThrows?: Error;
  } = {},
): Promise<Harness> {
  const prisma = stubPrisma(row, opts.updateThrows ? { updateThrows: opts.updateThrows } : {});
  const stripe = makeFakeStripe({
    ...(opts.event ? { event: opts.event } : {}),
    ...(opts.subscription ? { subscription: opts.subscription } : {}),
  });
  const app: Express = express();
  // ⚠️ NO express.json() HERE, on purpose: this mirrors app.ts, which skips the
  // default parser for this path. Mounting one would make every test pass
  // against a body shape production never sees.
  app.use(
    "/api",
    createWebhooksRouter({
      prisma: prisma as never,
      billingConfig: readBillingConfig(opts.env ?? CONFIGURED),
      stripe,
    }),
  );
  return await new Promise<Harness>((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("server did not bind"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/api`,
        prisma,
        stripe,
        close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

function send(h: Harness, body: unknown = { any: "bytes" }, signature: string | null = "t=1,v1=deadbeef") {
  return fetch(`${h.baseUrl}${STRIPE_WEBHOOK_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(signature === null ? {} : { "stripe-signature": signature }),
    },
    body: JSON.stringify(body),
  });
}

function subEvent(
  over: Partial<StripeEventLike> = {},
  sub: Partial<Parameters<typeof fakeSubscription>[0]> = {},
): StripeEventLike {
  return {
    id: "evt_1",
    type: "customer.subscription.updated",
    created: 1_760_000_500,
    data: {
      object: fakeSubscription({
        id: SUBSCRIPTION,
        customer: CUSTOMER,
        metadata: { userId: USER_ID },
        ...sub,
      }),
    },
    ...over,
  };
}

// ── 1. the signature ────────────────────────────────────────────────────

describe("the webhook signature is the authentication", () => {
  it("a bad signature is 400, writes NOTHING, and does not even claim the event id", async () => {
    // makeFakeStripe with no `event` makes constructEvent throw, which is what
    // the real SDK does on a signature it cannot verify.
    const h = await spinUp(makeRow());
    try {
      const res = await send(h);
      assert.equal(res.status, 400);
      assert.equal(h.prisma._updates.length, 0, "nothing was mirrored");
      // A route that claimed before verifying would leave a row here — and would
      // then swallow the legitimate retry of a real event with the same id.
      assert.equal(h.prisma._events.size, 0, "the event id was not claimed");
    } finally {
      await h.close();
    }
  });

  it("a MISSING signature header is 400 before anything is read", async () => {
    const h = await spinUp(makeRow(), { event: subEvent() });
    try {
      const res = await send(h, { any: "bytes" }, null);
      assert.equal(res.status, 400);
      assert.equal(h.stripe.calls.constructEvent.length, 0, "verification was not even attempted");
      assert.equal(h.prisma._events.size, 0);
    } finally {
      await h.close();
    }
  });

  it("the RAW bytes and the configured secret are what get verified", async () => {
    const h = await spinUp(makeRow(), { event: subEvent() });
    try {
      const body = { hello: "world", n: 1 };
      await send(h, body, "t=123,v1=abc");
      assert.equal(h.stripe.calls.constructEvent.length, 1);
      const call = h.stripe.calls.constructEvent[0];
      // Byte-for-byte what the client sent — if a parser had run, this would be
      // a re-serialisation and could differ.
      assert.equal(call.payload, JSON.stringify(body));
      assert.equal(call.header, "t=123,v1=abc");
      assert.equal(call.secret, "whsec_test_secret");
    } finally {
      await h.close();
    }
  });

  it("no STRIPE_WEBHOOK_SECRET → 503, and no attempt to verify", async () => {
    const env = { ...CONFIGURED };
    delete env.STRIPE_WEBHOOK_SECRET;
    const h = await spinUp(makeRow(), { event: subEvent(), env });
    try {
      assert.equal((await send(h)).status, 503);
      assert.equal(h.stripe.calls.constructEvent.length, 0);
    } finally {
      await h.close();
    }
  });
});

// ── 2 + 3. idempotency ─────────────────────────────────────────────────

describe("the webhook is idempotent, and releases its claim on failure", () => {
  it("the same event id twice: the second is acknowledged and mirrors nothing", async () => {
    const h = await spinUp(makeRow(), { event: subEvent() });
    try {
      const first = await send(h);
      assert.equal(first.status, 200);
      assert.equal(h.prisma._updates.length, 1);

      const second = await send(h);
      assert.equal(second.status, 200, "a duplicate is a 200, or Stripe retries for three days");
      assert.deepEqual(await second.json(), { received: true, duplicate: true });
      assert.equal(h.prisma._updates.length, 1, "the second delivery changed nothing");
    } finally {
      await h.close();
    }
  });

  it("a FAILED handler answers 500 and DELETES the claim, so Stripe's retry is not a duplicate", async () => {
    const h = await spinUp(makeRow(), {
      event: subEvent(),
      updateThrows: new Error("neon fell over"),
    });
    try {
      const res = await send(h);
      assert.equal(res.status, 500, "500 is what asks Stripe to retry");
      // 🔴 THE POINT. A surviving claim would make the retry a discarded
      // duplicate and the update would be lost forever.
      assert.equal(h.prisma._events.size, 0, "the claim was released");
    } finally {
      await h.close();
    }
  });

  it("after a released claim, the retry SUCCEEDS and mirrors", async () => {
    // Two harnesses cannot share state, so this drives the same shape by
    // flipping the failure off between calls.
    const row = makeRow();
    const failure = { current: new Error("transient") as Error | undefined };
    const events = new Map<string, unknown>();
    const updates: Array<Record<string, unknown>> = [];
    const prisma = {
      subscription: {
        findUnique: async () => ({ ...row }),
        findFirst: async () => ({ userId: USER_ID }),
        update: async (args: { data: Record<string, unknown> }) => {
          if (failure.current) throw failure.current;
          updates.push(args.data);
          Object.assign(row, args.data);
          return { ...row };
        },
      },
      billingEvent: {
        create: async ({ data }: { data: { provider: string; id: string } }) => {
          const key = `${data.provider}:${data.id}`;
          if (events.has(key)) {
            throw Object.assign(new Error("dup"), { code: "P2002" });
          }
          events.set(key, data);
          return data;
        },
        delete: async ({ where }: { where: { provider_id: { provider: string; id: string } } }) => {
          events.delete(`${where.provider_id.provider}:${where.provider_id.id}`);
          return where.provider_id;
        },
      },
    };
    const app: Express = express();
    app.use(
      "/api",
      createWebhooksRouter({
        prisma: prisma as never,
        billingConfig: readBillingConfig(CONFIGURED),
        stripe: makeFakeStripe({ event: subEvent() }),
      }),
    );
    const server: Server = await new Promise((r) => {
      const s = app.listen(0, () => r(s));
    });
    const { port } = server.address() as { port: number };
    const url = `http://127.0.0.1:${port}/api${STRIPE_WEBHOOK_PATH}`;
    const fire = () =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=x" },
        body: JSON.stringify({ any: "bytes" }),
      });
    try {
      assert.equal((await fire()).status, 500);
      assert.equal(events.size, 0);
      failure.current = undefined;
      assert.equal((await fire()).status, 200, "the retry is not treated as a duplicate");
      assert.equal(updates.length, 1);
    } finally {
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    }
  });

  it("an UNHANDLED event type is 200 and counted, never an error", async () => {
    const h = await spinUp(makeRow(), {
      event: { id: "evt_x", type: "customer.discount.created", created: 1, data: { object: {} } },
    });
    try {
      const res = await send(h);
      // A 4xx/5xx here makes Stripe retry for three days and eventually disable
      // the endpoint — for an event we simply do not care about.
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { received: true, handled: false });
      assert.equal(h.prisma._updates.length, 0);
    } finally {
      await h.close();
    }
  });
});

// ── the mirror ──────────────────────────────────────────────────────────

describe("customer.subscription.* mirrors the row", () => {
  it("mirrors status, price → planCode, period dates FROM THE ITEM, and cancelAtPeriodEnd", async () => {
    const h = await spinUp(
      makeRow(),
      {
        event: subEvent({}, {
          status: "active",
          cancel_at_period_end: true,
          priceId: "price_annual_test",
          currentPeriodStart: 1_760_000_000,
          currentPeriodEnd: 1_762_592_000,
        }),
      },
    );
    try {
      assert.equal((await send(h)).status, 200);
      const row = h.prisma._row();
      assert.equal(row.status, "active");
      assert.equal(row.planCode, "premium_annual");
      assert.equal(row.stripeSubscriptionId, SUBSCRIPTION);
      assert.equal(row.stripePriceId, "price_annual_test");
      assert.equal(row.cancelAtPeriodEnd, true);
      // 🔴 THE API-VERSION GOTCHA. The fixture puts these on the ITEM, which is
      // where 2026-08-26.dahlia sends them; reading the subscription level would
      // leave both null here.
      assert.equal(row.currentPeriodStart?.getTime(), 1_760_000_000 * 1000);
      assert.equal(row.currentPeriodEnd?.getTime(), 1_762_592_000 * 1000);
      // Stripe's clock, not ours.
      assert.equal(row.sourceUpdatedAt?.getTime(), 1_760_000_500 * 1000);
    } finally {
      await h.close();
    }
  });

  it("the monthly price maps to premium_monthly", async () => {
    const h = await spinUp(makeRow(), {
      event: subEvent({}, { status: "active", priceId: "price_monthly_test" }),
    });
    try {
      await send(h);
      assert.equal(h.prisma._row().planCode, "premium_monthly");
    } finally {
      await h.close();
    }
  });

  it("an UNKNOWN price leaves planCode alone rather than guessing", async () => {
    const h = await spinUp(makeRow({ planCode: "free" }), {
      event: subEvent({}, { status: "active", priceId: "price_someone_made_in_the_dashboard" }),
    });
    try {
      await send(h);
      assert.equal(h.prisma._row().planCode, "free");
      // The status is still mirrored — one unknown field must not block the rest.
      assert.equal(h.prisma._row().status, "active");
    } finally {
      await h.close();
    }
  });

  it("Stripe's trial_end becomes trialEndsAt — Stripe holds the trial once a subscription exists", async () => {
    const trialEnd = 1_765_000_000;
    const h = await spinUp(makeRow(), {
      event: subEvent({}, { status: "trialing", trial_end: trialEnd }),
    });
    try {
      await send(h);
      assert.equal(h.prisma._row().trialEndsAt?.getTime(), trialEnd * 1000);
    } finally {
      await h.close();
    }
  });

  it("customer.subscription.deleted mirrors canceled and is safe to replay", async () => {
    const h = await spinUp(makeRow({ status: "active" }), {
      event: subEvent({ type: "customer.subscription.deleted" }, { status: "canceled" }),
    });
    try {
      await send(h);
      assert.equal(h.prisma._row().status, "canceled");
    } finally {
      await h.close();
    }
  });

  it("an event we cannot attribute to a user is 200 and DROPPED, not retried forever", async () => {
    const h = await spinUp(
      makeRow({ stripeCustomerId: "cus_someone_else", stripeSubscriptionId: null }),
      {
        event: subEvent({}, {
          id: "sub_unknown",
          customer: "cus_unknown",
          metadata: {},
        }),
      },
    );
    try {
      const res = await send(h);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { received: true, handled: false });
      assert.equal(h.prisma._updates.length, 0, "nothing was guessed at");
    } finally {
      await h.close();
    }
  });
});

// ── the status map ──────────────────────────────────────────────────────

describe("the Stripe → Kiwi status map", () => {
  const mapped: Array<[string, SubscriptionStatus]> = [
    ["trialing", "trialing"],
    ["active", "active"],
    ["past_due", "past_due"],
    ["canceled", "canceled"],
    // Dunning exhausted; the user has lost access, which is what `canceled`
    // means to isEntitled().
    ["unpaid", "canceled"],
  ];
  for (const [stripeStatus, expected] of mapped) {
    it(`${stripeStatus} → ${expected}`, async () => {
      const h = await spinUp(makeRow({ status: "active" }), {
        event: subEvent({}, { status: stripeStatus }),
      });
      try {
        await send(h);
        assert.equal(h.prisma._row().status, expected);
      } finally {
        await h.close();
      }
    });
  }

  for (const stripeStatus of ["incomplete", "incomplete_expired", "paused"]) {
    it(`${stripeStatus} changes the status NOT AT ALL — the trial the user has is not overwritten`, async () => {
      const h = await spinUp(makeRow({ status: "trialing" }), {
        event: subEvent({}, { status: stripeStatus }),
      });
      try {
        await send(h);
        // Writing `canceled` here would tell a user still inside their Kiwi trial
        // that their subscription ended, which is false; `active` would be worse.
        assert.equal(h.prisma._row().status, "trialing");
        // The other fields still mirror — only the status is withheld.
        assert.equal(h.prisma._row().stripeSubscriptionId, SUBSCRIPTION);
      } finally {
        await h.close();
      }
    });
  }
});

// ── 4. out of order ────────────────────────────────────────────────────

describe("out-of-order events refetch instead of regressing the row", () => {
  it("an event OLDER than sourceUpdatedAt refetches through the seam and mirrors THAT", async () => {
    const h = await spinUp(
      // We already mirrored something from 10:05.
      makeRow({ status: "active", sourceUpdatedAt: new Date(1_760_000_500 * 1000) }),
      {
        // …and now a 10:00 event arrives saying `past_due`.
        event: subEvent({ created: 1_760_000_200 }, { status: "past_due" }),
        // Stripe, asked what is true NOW, says active.
        subscription: fakeSubscription({
          id: SUBSCRIPTION,
          customer: CUSTOMER,
          status: "active",
          priceId: "price_monthly_test",
        }),
      },
    );
    try {
      assert.equal((await send(h)).status, 200);
      assert.deepEqual(h.stripe.calls.subscriptionsRetrieve, [SUBSCRIPTION]);
      // The stale payload said past_due; the refetch said active, and the refetch
      // is what was written.
      assert.equal(h.prisma._row().status, "active");
    } finally {
      await h.close();
    }
  });

  it("a CURRENT event does not refetch — the payload is trusted when it is not stale", async () => {
    const h = await spinUp(
      makeRow({ sourceUpdatedAt: new Date(1_760_000_200 * 1000) }),
      { event: subEvent({ created: 1_760_000_500 }, { status: "past_due" }) },
    );
    try {
      await send(h);
      assert.equal(h.stripe.calls.subscriptionsRetrieve.length, 0, "no needless round trip");
      assert.equal(h.prisma._row().status, "past_due");
    } finally {
      await h.close();
    }
  });

  it("a row never mirrored before trusts the payload (nothing to be stale against)", async () => {
    const h = await spinUp(makeRow({ sourceUpdatedAt: null }), {
      event: subEvent({ created: 1 }, { status: "active" }),
    });
    try {
      await send(h);
      assert.equal(h.stripe.calls.subscriptionsRetrieve.length, 0);
      assert.equal(h.prisma._row().status, "active");
    } finally {
      await h.close();
    }
  });

  it("a FAILED refetch leaves the row unchanged and asks Stripe to retry", async () => {
    const row = makeRow({ status: "active", sourceUpdatedAt: new Date(1_760_000_500 * 1000) });
    const prisma = stubPrisma(row);
    const stripe = makeFakeStripe({
      event: subEvent({ created: 1_760_000_200 }, { status: "canceled" }),
      throwOn: { subscriptionsRetrieve: new Error("stripe timeout") },
    });
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
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api${STRIPE_WEBHOOK_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=x" },
        body: JSON.stringify({ any: "bytes" }),
      });
      assert.equal(res.status, 500);
      // The stale `canceled` must NOT have been applied — that is the exact
      // regression the guard exists to prevent.
      assert.equal(prisma._row().status, "active");
      assert.equal(prisma._events.size, 0, "claim released for the retry");
    } finally {
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    }
  });
});

// ── checkout.session.completed ─────────────────────────────────────────

describe("checkout.session.completed attaches the ids", () => {
  it("attaches customer + subscription (and nothing about a bonus — Resubmission B1)", async () => {
    const h = await spinUp(makeRow({ stripeCustomerId: null }), {
      event: {
        id: "evt_cs",
        type: "checkout.session.completed",
        created: 1_760_000_000,
        data: {
          object: {
            client_reference_id: USER_ID,
            customer: CUSTOMER,
            subscription: SUBSCRIPTION,
            // A session minted before Resubmission B1 still carries the flag;
            // it must be ignored now that the column is gone.
            metadata: { userId: USER_ID, earlyPayBonusApplied: "true" },
          },
        },
      },
    });
    try {
      assert.equal((await send(h)).status, 200);
      const row = h.prisma._row();
      assert.equal(row.stripeCustomerId, CUSTOMER);
      assert.equal(row.stripeSubscriptionId, SUBSCRIPTION);
      assert.equal("earlyPayBonusApplied" in row, false, "the bonus column is gone; nothing writes it");
      // 🔴 IT DOES NOT SET THE STATUS. The session completing means Stripe took
      // the checkout, not that the subscription is active — the subscription
      // event that follows carries the real state.
      assert.equal(row.status, "trialing", "the status is the subscription event's to set");
    } finally {
      await h.close();
    }
  });

  it("falls back to the customer id when there is no client_reference_id", async () => {
    const h = await spinUp(makeRow(), {
      event: {
        id: "evt_cs3",
        type: "checkout.session.completed",
        created: 1,
        data: { object: { customer: CUSTOMER, subscription: SUBSCRIPTION } },
      },
    });
    try {
      assert.equal((await send(h)).status, 200);
      assert.equal(h.prisma._row().stripeSubscriptionId, SUBSCRIPTION);
    } finally {
      await h.close();
    }
  });
});

// ── invoices ───────────────────────────────────────────────────────────

describe("invoice events log and mirror by refetch", () => {
  for (const type of ["invoice.paid", "invoice.payment_failed"]) {
    it(`${type} refetches the subscription and mirrors its status`, async () => {
      const h = await spinUp(makeRow({ stripeSubscriptionId: SUBSCRIPTION }), {
        event: {
          id: `evt_${type}`,
          type,
          created: 1_760_001_000,
          data: {
            object: {
              subscription: SUBSCRIPTION,
              customer: CUSTOMER,
              amount_paid: type === "invoice.paid" ? 999 : 0,
              amount_due: 999,
            },
          },
        },
        subscription: fakeSubscription({
          id: SUBSCRIPTION,
          customer: CUSTOMER,
          status: type === "invoice.paid" ? "active" : "past_due",
          priceId: "price_monthly_test",
        }),
      });
      try {
        assert.equal((await send(h)).status, 200);
        // An invoice does not carry the subscription's STATUS, so it has to be
        // asked for rather than inferred.
        assert.deepEqual(h.stripe.calls.subscriptionsRetrieve, [SUBSCRIPTION]);
        assert.equal(
          h.prisma._row().status,
          type === "invoice.paid" ? "active" : "past_due",
        );
      } finally {
        await h.close();
      }
    });
  }

  it("an invoice with NO subscription (a one-off) is 200 and mirrors nothing", async () => {
    const h = await spinUp(makeRow(), {
      event: {
        id: "evt_oneoff",
        type: "invoice.paid",
        created: 1,
        data: { object: { customer: CUSTOMER, amount_paid: 500 } },
      },
    });
    try {
      assert.equal((await send(h)).status, 200);
      assert.equal(h.stripe.calls.subscriptionsRetrieve.length, 0);
      assert.equal(h.prisma._updates.length, 0);
    } finally {
      await h.close();
    }
  });

  it("reads the subscription pointer from invoice.parent when that is where it is", async () => {
    // Newer API versions moved the pointer; both shapes are accepted.
    const h = await spinUp(makeRow({ stripeSubscriptionId: SUBSCRIPTION }), {
      event: {
        id: "evt_parent",
        type: "invoice.paid",
        created: 1,
        data: {
          object: {
            customer: CUSTOMER,
            parent: { subscription_details: { subscription: SUBSCRIPTION } },
          },
        },
      },
    });
    try {
      assert.equal((await send(h)).status, 200);
      assert.deepEqual(h.stripe.calls.subscriptionsRetrieve, [SUBSCRIPTION]);
    } finally {
      await h.close();
    }
  });
});

// ── Resubmission B1 — one row, two possible sources ─────────────────────

describe("Resubmission B1 — a Stripe event against a store-entitled row (the one-row rule)", () => {
  // Wall-clock based (the mirror has no injected clock), so the store row's
  // period is set far in the future to stay entitled whatever day this runs.
  const APPLE_END = new Date("2031-01-01T00:00:00.000Z");
  const appleRow = () =>
    makeRow({
      status: "active",
      source: "apple",
      currentPeriodEnd: APPLE_END,
      stripeSubscriptionId: null,
    });

  it("a live Stripe subscription that ends SOONER does not take the row — logged, never double-written", async () => {
    const row = appleRow();
    const h = await spinUp(row, {
      // Stripe period end 2025-11 < APPLE_END.
      event: subEvent({}, { status: "active", priceId: "price_monthly_test" }),
    });
    try {
      const res = await send(h);
      assert.equal(res.status, 200, "acknowledged — refusing to mirror is not an error to retry");
      assert.equal(h.prisma._updates.length, 0, "the store row was not touched");
      assert.equal(h.prisma._row().source, "apple");
      assert.equal(h.prisma._row().currentPeriodEnd?.getTime(), APPLE_END.getTime());
    } finally {
      await h.close();
    }
  });

  it("a CANCELED Stripe subscription never takes a live store row, even with a later period end", async () => {
    const h = await spinUp(appleRow(), {
      event: subEvent(
        { type: "customer.subscription.deleted" },
        { status: "canceled", currentPeriodEnd: Math.floor(Date.parse("2032-01-01") / 1000) },
      ),
    });
    try {
      assert.equal((await send(h)).status, 200);
      assert.equal(h.prisma._updates.length, 0);
      assert.equal(h.prisma._row().status, "active");
      assert.equal(h.prisma._row().source, "apple");
    } finally {
      await h.close();
    }
  });

  it("a live Stripe subscription that runs LONGER takes the row, and the row says stripe", async () => {
    const h = await spinUp(appleRow(), {
      event: subEvent(
        {},
        { status: "active", currentPeriodEnd: Math.floor(Date.parse("2032-01-01") / 1000) },
      ),
    });
    try {
      assert.equal((await send(h)).status, 200);
      assert.equal(h.prisma._updates.length, 1);
      assert.equal(h.prisma._row().source, "stripe");
      assert.equal(h.prisma._row().stripeSubscriptionId, SUBSCRIPTION);
    } finally {
      await h.close();
    }
  });

  it("a trial row (no source) is written and stamped source = stripe — unchanged S1 behaviour", async () => {
    const h = await spinUp(makeRow(), { event: subEvent({}, { status: "active" }) });
    try {
      assert.equal((await send(h)).status, 200);
      assert.equal(h.prisma._row().status, "active");
      assert.equal(h.prisma._row().source, "stripe");
    } finally {
      await h.close();
    }
  });
});

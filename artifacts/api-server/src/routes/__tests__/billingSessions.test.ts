// Row 9 (1.1) · Stripe S1 Part D — POST /billing/checkout-session and
// /billing/portal-session.
//
// Most of what matters here is WHAT WAS SENT TO STRIPE, not what came back —
// the session's own fields are Stripe's to honour, and getting them wrong is
// invisible until a real card is involved. So the fake records every call and
// these tests read the recording:
//
//   · NO `trial_end`, ever (Resubmission B1 — the pay-early bonus is gone;
//     subscribing during the trial bills at purchase).
//   · 409 `subscribed_elsewhere` for an account entitled through the App Store
//     or Google Play, before any customer is created (Resubmission B1).
//   · the two metadata back-references, on the session AND on the subscription,
//     because the second is the only one that survives to the events the mirror
//     reads.
//   · one customer per user, ever, persisted BEFORE the session call.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";
import type { SubscriptionStatus } from "@prisma/client";

import { signToken } from "../../lib/auth";
import { readBillingConfig } from "../../lib/billing/config";
import { createBillingRouter } from "../billing";
import { withSessionUser } from "./fixtures/sessionUserStub";
import { makeFakeStripe, type FakeStripe, type FakeStripeOptions } from "./fixtures/fakeStripe";

const USER_ID = "billing-user";
const NOW = new Date("2026-09-27T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const CONFIGURED: Record<string, string> = {
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_x",
  STRIPE_PRICE_MONTHLY: "price_monthly_test",
  STRIPE_PRICE_ANNUAL: "price_annual_test",
  BILLING_RETURN_URL_BASE: "https://app.kitchenwizard.ai",
};

interface RowFixture {
  status: SubscriptionStatus;
  trialEndsAt?: Date | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  source?: "stripe" | "apple" | "google" | null;
  currentPeriodEnd?: Date | null;
  storeManagementUrl?: string | null;
}

function stubPrisma(row: RowFixture | null, email = "cook@example.com") {
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const state = { ...row } as RowFixture;
  return {
    subscription: {
      findUnique: async () =>
        row === null
          ? null
          : {
              status: state.status,
              planCode: "free",
              trialEndsAt: state.trialEndsAt ?? null,
              currentPeriodEnd: state.currentPeriodEnd ?? null,
              cancelAtPeriodEnd: false,
              stripeCustomerId: state.stripeCustomerId ?? null,
              stripeSubscriptionId: state.stripeSubscriptionId ?? null,
              source: state.source ?? null,
              storeManagementUrl: state.storeManagementUrl ?? null,
            },
      update: async (args: { where: unknown; data: Record<string, unknown> }) => {
        updates.push(args);
        Object.assign(state, args.data);
        return {};
      },
    },
    user: {
      findUnique: async () => ({ email, tokensValidFrom: null }),
    },
    _updates: updates,
  };
}

interface Harness {
  baseUrl: string;
  stripe: FakeStripe;
  prisma: ReturnType<typeof stubPrisma>;
  close: () => Promise<void>;
}

async function spinUp(
  row: RowFixture | null,
  opts: { env?: Record<string, string>; stripe?: FakeStripeOptions; email?: string } = {},
): Promise<Harness> {
  const prisma = stubPrisma(row, opts.email);
  const stripe = makeFakeStripe(opts.stripe ?? {});
  const app: Express = express();
  app.use(express.json());
  app.use(
    createBillingRouter({
      prisma: withSessionUser(prisma) as never,
      billingConfig: readBillingConfig(opts.env ?? CONFIGURED),
      stripe,
      now: () => NOW,
      // A human taps Subscribe once; these tests tap it many times.
      limiterOpts: { capacity: 1_000_000, refillPerSec: 0 },
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
        baseUrl: `http://127.0.0.1:${addr.port}`,
        stripe,
        prisma,
        close: () =>
          new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

function post(h: Harness, path: string, body: unknown = {}) {
  return fetch(`${h.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${signToken(USER_ID)}`,
    },
    body: JSON.stringify(body),
  });
}

/** The one session the fake recorded. */
function session(h: Harness): Record<string, unknown> {
  assert.equal(h.stripe.calls.checkoutSessions.length, 1, "expected exactly one session");
  return h.stripe.calls.checkoutSessions[0];
}
function subData(h: Harness): Record<string, unknown> {
  return session(h).subscription_data as Record<string, unknown>;
}

// ── the session's fixed shape ────────────────────────────────────────────

describe("POST /billing/checkout-session — the session Stripe is asked for", () => {
  it("returns { url } and asks for a subscription-mode session with the MONTHLY price", async () => {
    const h = await spinUp({ status: "none" });
    try {
      const res = await post(h, "/billing/checkout-session", { plan: "monthly" });
      assert.equal(res.status, 200);
      assert.equal(
        ((await res.json()) as { url: string }).url,
        "https://checkout.stripe.test/session",
      );
      const s = session(h);
      assert.equal(s.mode, "subscription");
      assert.deepEqual(s.line_items, [{ price: "price_monthly_test", quantity: 1 }]);
    } finally {
      await h.close();
    }
  });

  it("annual selects the ANNUAL price — the two must not be crossed", async () => {
    const h = await spinUp({ status: "none" });
    try {
      await post(h, "/billing/checkout-session", { plan: "annual" });
      assert.deepEqual(session(h).line_items, [
        { price: "price_annual_test", quantity: 1 },
      ]);
    } finally {
      await h.close();
    }
  });

  it("carries the promotion-code box, Stripe Tax, and both return URLs", async () => {
    const h = await spinUp({ status: "none" });
    try {
      await post(h, "/billing/checkout-session", { plan: "monthly" });
      const s = session(h);
      assert.equal(s.allow_promotion_codes, true);
      assert.deepEqual(s.automatic_tax, { enabled: true });
      // `{CHECKOUT_SESSION_ID}` is Stripe's template token and must arrive
      // UNESCAPED — if this ever gets URL-encoded the return page cannot
      // identify the session.
      assert.equal(
        s.success_url,
        "https://app.kitchenwizard.ai/billing/return?session_id={CHECKOUT_SESSION_ID}",
      );
      assert.equal(s.cancel_url, "https://app.kitchenwizard.ai/billing/cancelled");
    } finally {
      await h.close();
    }
  });

  it("a trailing slash on the return base does not produce a double slash", async () => {
    const h = await spinUp(
      { status: "none" },
      { env: { ...CONFIGURED, BILLING_RETURN_URL_BASE: "https://app.kitchenwizard.ai/" } },
    );
    try {
      await post(h, "/billing/checkout-session", { plan: "monthly" });
      assert.equal(session(h).cancel_url, "https://app.kitchenwizard.ai/billing/cancelled");
    } finally {
      await h.close();
    }
  });

  it("puts userId on the SESSION and on the SUBSCRIPTION — the second is the one that survives", async () => {
    const h = await spinUp({ status: "none" });
    try {
      await post(h, "/billing/checkout-session", { plan: "monthly", platform: "ios" });
      assert.equal(session(h).client_reference_id, USER_ID);
      assert.equal((session(h).metadata as Record<string, string>).userId, USER_ID);
      assert.equal((session(h).metadata as Record<string, string>).platform, "ios");
      // Every later customer.subscription.* event carries THIS, not the session's.
      assert.equal((subData(h).metadata as Record<string, string>).userId, USER_ID);
    } finally {
      await h.close();
    }
  });

  it("rejects an unknown plan with 400 and never calls Stripe", async () => {
    const h = await spinUp({ status: "none" });
    try {
      const res = await post(h, "/billing/checkout-session", { plan: "lifetime" });
      assert.equal(res.status, 400);
      assert.equal(h.stripe.calls.checkoutSessions.length, 0);
      assert.equal(h.stripe.calls.customersCreate.length, 0);
    } finally {
      await h.close();
    }
  });

  it("requires auth", async () => {
    const h = await spinUp({ status: "none" });
    try {
      const res = await fetch(`${h.baseUrl}/billing/checkout-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "monthly" }),
      });
      assert.equal(res.status, 401);
    } finally {
      await h.close();
    }
  });
});

// ── no trial_end, ever (Resubmission B1) ─────────────────────────────────

describe("POST /billing/checkout-session — no pay-early bonus (Resubmission B1)", () => {
  // Hans, 2026-10-04: "we can run pricing promos to trigger early conversions."
  // One rule on all three platforms — subscribing during the trial bills at
  // purchase. Every case below once produced a trial_end; none may now.
  const cases: Array<[string, RowFixture]> = [
    ["DURING the trial (10 days left)", { status: "trialing", trialEndsAt: new Date(NOW.getTime() + 10 * DAY) }],
    ["on the trial's LAST hour", { status: "trialing", trialEndsAt: new Date(NOW.getTime() + 60 * 60 * 1000) }],
    ["an unbounded trial (NULL trialEndsAt)", { status: "trialing", trialEndsAt: null }],
    ["after the trial (none)", { status: "none", trialEndsAt: new Date(NOW.getTime() - 5 * DAY) }],
    ["a canceled account", { status: "canceled", trialEndsAt: null }],
  ];
  for (const [label, row] of cases) {
    it(`${label}: the session carries NO trial_end and no bonus metadata`, async () => {
      const h = await spinUp(row);
      try {
        const res = await post(h, "/billing/checkout-session", { plan: "monthly" });
        assert.equal(res.status, 200);
        assert.equal("trial_end" in subData(h), false, "the first charge is today");
        const subMeta = subData(h).metadata as Record<string, string>;
        assert.deepEqual(subMeta, { userId: USER_ID });
        const sessMeta = session(h).metadata as Record<string, string>;
        assert.equal("earlyPayBonusApplied" in sessMeta, false);
      } finally {
        await h.close();
      }
    });
  }

  it("a leftover BILLING_EARLY_PAY_BONUS_DAYS in the env changes nothing", async () => {
    const h = await spinUp(
      { status: "trialing", trialEndsAt: new Date(NOW.getTime() + 5 * DAY) },
      { env: { ...CONFIGURED, BILLING_EARLY_PAY_BONUS_DAYS: "30" } },
    );
    try {
      await post(h, "/billing/checkout-session", { plan: "monthly" });
      assert.equal("trial_end" in subData(h), false);
    } finally {
      await h.close();
    }
  });
});

// ── one account, one paid rail (Resubmission B1) ─────────────────────────

describe("POST /billing/checkout-session + /portal-session — 409 subscribed_elsewhere", () => {
  const STORE_URL = "https://apps.apple.com/account/subscriptions";

  it("checkout: an account ENTITLED through Apple gets 409 { source: apple } and Stripe is never called", async () => {
    const h = await spinUp({
      status: "active",
      source: "apple",
      currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY),
      storeManagementUrl: STORE_URL,
    });
    try {
      const res = await post(h, "/billing/checkout-session", { plan: "monthly" });
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), {
        code: "subscribed_elsewhere",
        source: "apple",
        managementUrl: STORE_URL,
      });
      assert.equal(h.stripe.calls.customersCreate.length, 0, "no customer for a store subscriber");
      assert.equal(h.stripe.calls.checkoutSessions.length, 0);
    } finally {
      await h.close();
    }
  });

  it("checkout: Google past_due (the store's grace) is still entitled → 409 { source: google }", async () => {
    const h = await spinUp({
      status: "past_due",
      source: "google",
      currentPeriodEnd: new Date(NOW.getTime() + 2 * DAY),
    });
    try {
      const res = await post(h, "/billing/checkout-session", { plan: "annual" });
      assert.equal(res.status, 409);
      const body = (await res.json()) as { code: string; source: string };
      assert.equal(body.code, "subscribed_elsewhere");
      assert.equal(body.source, "google");
    } finally {
      await h.close();
    }
  });

  it("checkout: a LAPSED store row may subscribe on the web — the refusal is for entitled rows only", async () => {
    const h = await spinUp({
      status: "canceled",
      source: "apple",
      currentPeriodEnd: new Date(NOW.getTime() - 30 * DAY),
    });
    try {
      const res = await post(h, "/billing/checkout-session", { plan: "monthly" });
      assert.equal(res.status, 200);
    } finally {
      await h.close();
    }
  });

  it("checkout: a store row >3 days past its period is NOT trusted — it can subscribe on the web", async () => {
    // Stored `active`, but its period ended 5 days ago: the missed-EXPIRATION
    // guard reads it as canceled, so it must not block a real purchase.
    const h = await spinUp({
      status: "active",
      source: "apple",
      currentPeriodEnd: new Date(NOW.getTime() - 5 * DAY),
    });
    try {
      const res = await post(h, "/billing/checkout-session", { plan: "monthly" });
      assert.equal(res.status, 200);
    } finally {
      await h.close();
    }
  });

  it("checkout: a Stripe subscriber still gets the existing already_subscribed, not subscribed_elsewhere", async () => {
    const h = await spinUp({ status: "active", source: "stripe", stripeCustomerId: "cus_1" });
    try {
      const res = await post(h, "/billing/checkout-session", { plan: "monthly" });
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { code: "already_subscribed" });
    } finally {
      await h.close();
    }
  });

  it("portal: a store-sourced row gets 409 subscribed_elsewhere with the management url, and no Portal session", async () => {
    const h = await spinUp({
      status: "active",
      source: "apple",
      stripeCustomerId: "cus_had_web_checkout_once",
      currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY),
      storeManagementUrl: STORE_URL,
    });
    try {
      const res = await post(h, "/billing/portal-session");
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), {
        code: "subscribed_elsewhere",
        source: "apple",
        managementUrl: STORE_URL,
      });
      assert.equal(h.stripe.calls.portalSessions.length, 0);
    } finally {
      await h.close();
    }
  });

  it("portal: a Stripe row is unchanged — it gets the Portal", async () => {
    const h = await spinUp({ status: "active", source: "stripe", stripeCustomerId: "cus_web" });
    try {
      const res = await post(h, "/billing/portal-session");
      assert.equal(res.status, 200);
    } finally {
      await h.close();
    }
  });
});

// ── the customer ────────────────────────────────────────────────────────

describe("POST /billing/checkout-session — the Stripe customer", () => {
  it("creates one with metadata.userId and the account email, and PERSISTS it", async () => {
    const h = await spinUp({ status: "none", stripeCustomerId: null }, { email: "hans@example.com" });
    try {
      await post(h, "/billing/checkout-session", { plan: "monthly" });
      assert.equal(h.stripe.calls.customersCreate.length, 1);
      assert.deepEqual(h.stripe.calls.customersCreate[0], {
        email: "hans@example.com",
        // The back-reference the webhook's fallback path reads.
        metadata: { userId: USER_ID },
      });
      // Persisted, and persisted BEFORE the session call — so a failed session
      // does not leave the customer unrecorded and mint a second one next time.
      assert.equal(h.prisma._updates.length, 1);
      assert.deepEqual(h.prisma._updates[0].data, { stripeCustomerId: "cus_fake" });
      assert.equal(session(h).customer, "cus_fake");
    } finally {
      await h.close();
    }
  });

  it("REUSES an existing customer — one customer per user, ever", async () => {
    const h = await spinUp({ status: "none", stripeCustomerId: "cus_existing" });
    try {
      await post(h, "/billing/checkout-session", { plan: "monthly" });
      assert.equal(h.stripe.calls.customersCreate.length, 0, "must not mint a second customer");
      assert.equal(session(h).customer, "cus_existing");
      assert.equal(h.prisma._updates.length, 0, "nothing to persist");
    } finally {
      await h.close();
    }
  });

  it("two checkouts in a row create ONE customer, not two", async () => {
    const h = await spinUp({ status: "none", stripeCustomerId: null });
    try {
      await post(h, "/billing/checkout-session", { plan: "monthly" });
      await post(h, "/billing/checkout-session", { plan: "annual" });
      assert.equal(h.stripe.calls.customersCreate.length, 1);
      assert.equal(h.stripe.calls.checkoutSessions.length, 2);
    } finally {
      await h.close();
    }
  });

  it("a Stripe failure answers 502 with a code, and writes no subscription state", async () => {
    const h = await spinUp(
      { status: "none", stripeCustomerId: "cus_existing" },
      { stripe: { throwOn: { checkoutSessionsCreate: new Error("stripe is down") } } },
    );
    try {
      const res = await post(h, "/billing/checkout-session", { plan: "monthly" });
      assert.equal(res.status, 502);
      assert.equal(((await res.json()) as { code: string }).code, "billing_session_failed");
      assert.equal(h.prisma._updates.length, 0);
    } finally {
      await h.close();
    }
  });

  it("a session with a null url is a 502, not a 200 with nothing to open", async () => {
    const h = await spinUp(
      { status: "none", stripeCustomerId: "cus_existing" },
      { stripe: { checkoutSession: { url: null } } },
    );
    try {
      const res = await post(h, "/billing/checkout-session", { plan: "monthly" });
      assert.equal(res.status, 502);
    } finally {
      await h.close();
    }
  });
});

// ── already subscribed ──────────────────────────────────────────────────

describe("POST /billing/checkout-session — already subscribed", () => {
  for (const status of ["active", "past_due"] as SubscriptionStatus[]) {
    it(`${status} answers 409 already_subscribed and never touches Stripe`, async () => {
      const h = await spinUp({ status, stripeCustomerId: "cus_existing" });
      try {
        const res = await post(h, "/billing/checkout-session", { plan: "monthly" });
        assert.equal(res.status, 409);
        assert.equal(((await res.json()) as { code: string }).code, "already_subscribed");
        assert.equal(h.stripe.calls.checkoutSessions.length, 0);
      } finally {
        await h.close();
      }
    });
  }

  it("trialing, none and canceled all proceed — each is a state you can pay from", async () => {
    for (const row of [
      { status: "trialing" as SubscriptionStatus, trialEndsAt: new Date(NOW.getTime() + DAY) },
      { status: "none" as SubscriptionStatus },
      { status: "canceled" as SubscriptionStatus },
    ]) {
      const h = await spinUp({ ...row, stripeCustomerId: "cus_existing" });
      try {
        const res = await post(h, "/billing/checkout-session", { plan: "monthly" });
        assert.equal(res.status, 200, row.status);
      } finally {
        await h.close();
      }
    }
  });
});

// ── the OFF state ───────────────────────────────────────────────────────

describe("the billing routes with Stripe unconfigured", () => {
  it("checkout answers 503 billing_unavailable and never constructs a client", async () => {
    const h = await spinUp({ status: "none" }, { env: {} });
    try {
      const res = await post(h, "/billing/checkout-session", { plan: "monthly" });
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as { code: string }).code, "billing_unavailable");
      assert.equal(h.stripe.calls.checkoutSessions.length, 0);
    } finally {
      await h.close();
    }
  });

  it("portal answers 503 too", async () => {
    const h = await spinUp({ status: "active", stripeCustomerId: "cus_existing" }, { env: {} });
    try {
      const res = await post(h, "/billing/portal-session");
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as { code: string }).code, "billing_unavailable");
    } finally {
      await h.close();
    }
  });

  it("ONE missing variable is enough — a half-configured deploy is not configured", async () => {
    const env = { ...CONFIGURED };
    delete env.STRIPE_PRICE_ANNUAL;
    const h = await spinUp({ status: "none" }, { env });
    try {
      assert.equal((await post(h, "/billing/checkout-session", { plan: "monthly" })).status, 503);
    } finally {
      await h.close();
    }
  });
});

// ── the portal ──────────────────────────────────────────────────────────

describe("POST /billing/portal-session", () => {
  it("returns { url } for a customer, with the return_url on the base", async () => {
    const h = await spinUp({ status: "active", stripeCustomerId: "cus_existing" });
    try {
      const res = await post(h, "/billing/portal-session");
      assert.equal(res.status, 200);
      assert.equal(
        ((await res.json()) as { url: string }).url,
        "https://portal.stripe.test/session",
      );
      assert.deepEqual(h.stripe.calls.portalSessions[0], {
        customer: "cus_existing",
        return_url: "https://app.kitchenwizard.ai/billing/return",
      });
    } finally {
      await h.close();
    }
  });

  it("NO customer answers 409 no_billing_account — the account exists, the billing relationship does not", async () => {
    const h = await spinUp({ status: "trialing", stripeCustomerId: null });
    try {
      const res = await post(h, "/billing/portal-session");
      assert.equal(res.status, 409);
      assert.equal(((await res.json()) as { code: string }).code, "no_billing_account");
      assert.equal(h.stripe.calls.portalSessions.length, 0);
    } finally {
      await h.close();
    }
  });

  it("a user with NO subscription row also answers 409, not a 500", async () => {
    const h = await spinUp(null);
    try {
      assert.equal((await post(h, "/billing/portal-session")).status, 409);
    } finally {
      await h.close();
    }
  });

  it("a Stripe failure answers 502", async () => {
    const h = await spinUp(
      { status: "active", stripeCustomerId: "cus_existing" },
      { stripe: { throwOn: { portalSessionsCreate: new Error("nope") } } },
    );
    try {
      assert.equal((await post(h, "/billing/portal-session")).status, 502);
    } finally {
      await h.close();
    }
  });

  it("requires auth", async () => {
    const h = await spinUp({ status: "active", stripeCustomerId: "cus_existing" });
    try {
      const res = await fetch(`${h.baseUrl}/billing/portal-session`, { method: "POST" });
      assert.equal(res.status, 401);
    } finally {
      await h.close();
    }
  });
});

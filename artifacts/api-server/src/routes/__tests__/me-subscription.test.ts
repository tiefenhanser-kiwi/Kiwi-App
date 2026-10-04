// Row 9 (1.1) · Stripe S1 Part C — GET /me/subscription.
//
// This is the ONE shape the paywall sheet, the trial banner and the Settings
// row all read, so the tests are mostly about the fields being right for states
// that look similar from the client's side and are not:
//
//   · trialing                      vs  none (trial over)
//   · enforced + available         vs  available but not enforced (today)
//   · not available                — the state in which the client must NOT
//     render a button, because the button leads to a 503.
//
// Resubmission B1: the pay-early bonus is gone, so `earlyPayBonusDays` is
// always 0 and `firstChargeDateIfSubscribedNow` always null (still SENT — the
// shipped client schema requires both). The body gained `source`,
// `managementUrl` and `storeBillingAvailable`, and a store row more than three
// days past its period is re-read from RevenueCat before the answer.
//
// Same lightweight harness as me-ui-state.test.ts / me-preferences.test.ts
// (real JWT, prisma stubbed at the factory deps boundary, no DB).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";
import type { SubscriptionStatus } from "@prisma/client";

import { signToken } from "../../lib/auth";
import { readBillingConfig } from "../../lib/billing/config";
import { createMeRouter } from "../me";
import type { FetchLike } from "../../lib/billing/revenuecat";
import {
  APPLE_MANAGEMENT_URL,
  makeFakeRevenueCat,
  RC_CONFIGURED,
  storeSubscriber,
} from "./fixtures/fakeRevenueCat";

/** The default seam: a test that reaches RevenueCat without asking to fails loudly. */
const fetchMustNotBeCalled: FetchLike = async () => {
  throw new Error("GET /me/subscription called RevenueCat in a test that did not expect it");
};
import { withSessionUser } from "./fixtures/sessionUserStub";

const USER_ID = "test-user-subscription";
const NOW = new Date("2026-09-27T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const CONFIGURED = {
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_x",
  STRIPE_PRICE_MONTHLY: "price_m",
  STRIPE_PRICE_ANNUAL: "price_a",
  BILLING_RETURN_URL_BASE: "https://app.example",
};

interface RowFixture {
  status: SubscriptionStatus;
  planCode?: string;
  trialEndsAt?: Date | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  /** Row 9 (1.1) Stripe S2 Part C -- what hasBillingAccount is derived from. */
  stripeCustomerId?: string | null;
  /** Resubmission B1. */
  source?: "stripe" | "apple" | "google" | null;
  storeManagementUrl?: string | null;
}

function stubPrisma(row: RowFixture | null) {
  // Mutable, so the stale-store-row re-read (Resubmission B1) is visible to the
  // read that follows it, exactly as the database would make it.
  const state = row === null ? null : { ...row };
  const updates: Array<Record<string, unknown>> = [];
  return {
    subscription: {
      findUnique: async () =>
        state === null
          ? null
          : {
              status: state.status,
              planCode: state.planCode ?? "free",
              trialEndsAt: state.trialEndsAt ?? null,
              currentPeriodEnd: state.currentPeriodEnd ?? null,
              cancelAtPeriodEnd: state.cancelAtPeriodEnd ?? false,
              stripeCustomerId: state.stripeCustomerId ?? null,
              stripeSubscriptionId: null,
              source: state.source ?? null,
              storeManagementUrl: state.storeManagementUrl ?? null,
            },
      update: async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        if (state !== null) Object.assign(state, args.data);
        return {};
      },
    },
    _updates: updates,
  };
}

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function spinUp(
  row: RowFixture | null,
  env: Record<string, string> = CONFIGURED,
  storeFetch: FetchLike = fetchMustNotBeCalled,
): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use(
    createMeRouter({
      prisma: withSessionUser(stubPrisma(row)) as never,
      billingConfig: readBillingConfig(env),
      now: () => NOW,
      storeFetch,
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
        close: () =>
          new Promise<void>((r, j) => server.close((err) => (err ? j(err) : r()))),
      });
    });
  });
}

interface Body {
  status: string;
  planCode: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  billingAvailable: boolean;
  enforced: boolean;
  earlyPayBonusDays: number;
  firstChargeDateIfSubscribedNow: string | null;
  hasBillingAccount: boolean;
  source: string | null;
  managementUrl: string | null;
  storeBillingAvailable: boolean;
}

async function get(h: Harness): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${h.baseUrl}/me/subscription`, {
    headers: { Authorization: `Bearer ${signToken(USER_ID)}` },
  });
  return { status: res.status, body: (await res.json()) as Body };
}

describe("GET /me/subscription", () => {
  it("a live trial reports trialing and its end — and, with the bonus gone, 0 days and no first-charge date", async () => {
    const trialEndsAt = new Date(NOW.getTime() + 10 * DAY);
    const h = await spinUp({ status: "trialing", trialEndsAt });
    try {
      const { status, body } = await get(h);
      assert.equal(status, 200);
      assert.equal(body.status, "trialing");
      assert.equal(body.planCode, "free", "the trial row keeps planCode free (D-WS9-143)");
      assert.equal(body.trialEndsAt, trialEndsAt.toISOString());
      // Resubmission B1 — still present (the shipped client schema requires
      // both), at their retired values.
      assert.equal(body.earlyPayBonusDays, 0);
      assert.equal(body.firstChargeDateIfSubscribedNow, null);
      assert.equal(body.source, null, "a trial has no paid source");
      assert.equal(body.managementUrl, null);
    } finally {
      await h.close();
    }
  });

  it("a leftover BILLING_EARLY_PAY_BONUS_DAYS changes nothing", async () => {
    const h = await spinUp(
      { status: "trialing", trialEndsAt: new Date(NOW.getTime() + 3 * DAY) },
      { ...CONFIGURED, BILLING_EARLY_PAY_BONUS_DAYS: "30" },
    );
    try {
      const { body } = await get(h);
      assert.equal(body.earlyPayBonusDays, 0);
      assert.equal(body.firstChargeDateIfSubscribedNow, null);
    } finally {
      await h.close();
    }
  });

  it("an EXPIRED trial reports none — derived, with no write and no scheduler", async () => {
    const h = await spinUp({
      status: "trialing",
      trialEndsAt: new Date(NOW.getTime() - DAY),
    });
    try {
      const { body } = await get(h);
      assert.equal(body.status, "none", "the stored value still says trialing; this is derived");
      // No bonus after the trial: checkout charges today, so there is no future
      // first-charge date to advertise.
      assert.equal(body.firstChargeDateIfSubscribedNow, null);
      // The timestamp is still reported — the banner says when it ended.
      assert.notEqual(body.trialEndsAt, null);
    } finally {
      await h.close();
    }
  });

  it("an active subscription reports its plan, period end and cancelAtPeriodEnd", async () => {
    const periodEnd = new Date(NOW.getTime() + 20 * DAY);
    const h = await spinUp({
      status: "active",
      planCode: "premium_annual",
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: true,
    });
    try {
      const { body } = await get(h);
      assert.equal(body.status, "active");
      assert.equal(body.planCode, "premium_annual");
      assert.equal(body.currentPeriodEnd, periodEnd.toISOString());
      // "Cancelling" is not "cancelled": the user keeps access until the date.
      assert.equal(body.cancelAtPeriodEnd, true);
      assert.equal(body.firstChargeDateIfSubscribedNow, null);
    } finally {
      await h.close();
    }
  });

  it("past_due is reported as past_due, not smoothed into active or canceled", async () => {
    const h = await spinUp({ status: "past_due", planCode: "premium_monthly" });
    try {
      assert.equal((await get(h)).body.status, "past_due");
    } finally {
      await h.close();
    }
  });

  it("Stripe unconfigured → billingAvailable false, so the client renders no button", async () => {
    const h = await spinUp({ status: "trialing", trialEndsAt: new Date(NOW.getTime() + DAY) }, {});
    try {
      const { body } = await get(h);
      assert.equal(body.billingAvailable, false);
      assert.equal(body.enforced, false);
      // The trial itself is unaffected — it is Kiwi's, not Stripe's.
      assert.equal(body.status, "trialing");
    } finally {
      await h.close();
    }
  });

  it("configured reports billingAvailable true, and `enforced` tracks the flag independently", async () => {
    const row: RowFixture = { status: "trialing", trialEndsAt: new Date(NOW.getTime() + DAY) };
    const off = await spinUp(row, CONFIGURED);
    try {
      const { body } = await get(off);
      assert.equal(body.billingAvailable, true);
      assert.equal(body.enforced, false, "today: payable, not enforced");
    } finally {
      await off.close();
    }
    const on = await spinUp(row, { ...CONFIGURED, BILLING_ENFORCED: "true" });
    try {
      const { body } = await get(on);
      assert.equal(body.billingAvailable, true);
      assert.equal(body.enforced, true);
    } finally {
      await on.close();
    }
  });

  it("NO Subscription row answers 200 with none — a renderable answer, not a spinner", async () => {
    const h = await spinUp(null);
    try {
      const { status, body } = await get(h);
      assert.equal(status, 200);
      assert.equal(body.status, "none");
      assert.equal(body.planCode, "free");
      assert.equal(body.trialEndsAt, null);
      assert.equal(body.cancelAtPeriodEnd, false);
    } finally {
      await h.close();
    }
  });

  it("requires auth", async () => {
    const h = await spinUp({ status: "active" });
    try {
      const res = await fetch(`${h.baseUrl}/me/subscription`);
      assert.equal(res.status, 401);
    } finally {
      await h.close();
    }
  });
});

// ── Row 9 (1.1) · Stripe S2 Part C — `hasBillingAccount` ─────────────────
//
// 🔴 ADDED BECAUSE §2.8 RULED A FACT THE S1 CONTRACT DID NOT CARRY. The Settings
// row must show "Manage subscription" "when a Stripe subscription exists", and
// this body had no field saying so. Inferring it from the status is wrong in BOTH
// directions, which is why it is a field rather than a client-side guess:
//
//   · `canceled` would infer NO, yet the Portal is exactly where a cancelled
//     subscriber finds their invoices and the resubscribe button;
//   · `active` would infer YES, and an active row read before its first
//     `customer.subscription.updated` webhook has no customer id — the button
//     would open a 409.
//
// Keyed on `stripeCustomerId`, not `stripeSubscriptionId`: the Portal is scoped to
// the CUSTOMER, and that is also what POST /billing/portal-session 409s
// `no_billing_account` on. routes/billing.ts persists the customer BEFORE creating
// a checkout session, so an abandoned checkout still leaves a reachable portal.
describe("GET /me/subscription — hasBillingAccount (S2 Part C)", () => {
  it("false for a trial that has never touched Stripe", async () => {
    const h = await spinUp({
      status: "trialing",
      trialEndsAt: new Date(NOW.getTime() + 10 * DAY),
    });
    try {
      const { body } = await get(h);
      assert.equal(body.hasBillingAccount, false);
    } finally {
      await h.close();
    }
  });

  it("🔴 TRUE for a CANCELED account — the portal is where its invoices live", async () => {
    const h = await spinUp({ status: "canceled", stripeCustomerId: "cus_123" });
    try {
      const { body } = await get(h);
      assert.equal(body.status, "canceled");
      assert.equal(body.hasBillingAccount, true, "a status inference would say no here");
    } finally {
      await h.close();
    }
  });

  it("🔴 FALSE for an ACTIVE row with no customer id — the button would open a 409", async () => {
    const h = await spinUp({
      status: "active",
      planCode: "monthly",
      currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY),
      stripeCustomerId: null,
    });
    try {
      const { body } = await get(h);
      assert.equal(body.status, "active");
      assert.equal(body.hasBillingAccount, false, "a status inference would say yes here");
    } finally {
      await h.close();
    }
  });

  it("true once a customer exists, whatever the status — a checkout begun is enough", async () => {
    for (const status of ["trialing", "active", "past_due", "canceled"] as const) {
      const h = await spinUp({ status, stripeCustomerId: "cus_abandoned_checkout" });
      try {
        assert.equal((await get(h)).body.hasBillingAccount, true, status);
      } finally {
        await h.close();
      }
    }
  });

  it("false when there is no Subscription row at all", async () => {
    const h = await spinUp(null);
    try {
      const { body } = await get(h);
      assert.equal(body.status, "none");
      assert.equal(body.hasBillingAccount, false);
    } finally {
      await h.close();
    }
  });
});

// ── Resubmission B1 — store rows ─────────────────────────────────────────

describe("GET /me/subscription — store rows (Resubmission B1)", () => {
  const STORE_ENV = { ...CONFIGURED, ...RC_CONFIGURED };

  it("an Apple row reports source apple and RevenueCat's management url", async () => {
    const h = await spinUp(
      {
        status: "active",
        planCode: "premium_monthly",
        source: "apple",
        currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY),
        storeManagementUrl: APPLE_MANAGEMENT_URL,
      },
      STORE_ENV,
    );
    try {
      const { body } = await get(h);
      assert.equal(body.status, "active");
      assert.equal(body.source, "apple");
      assert.equal(body.managementUrl, APPLE_MANAGEMENT_URL);
      assert.equal(body.storeBillingAvailable, true);
    } finally {
      await h.close();
    }
  });

  it("a Stripe row reports source stripe and NO management url (the Portal is its manager)", async () => {
    const h = await spinUp(
      { status: "active", source: "stripe", stripeCustomerId: "cus_1", storeManagementUrl: "https://stale.example" },
      STORE_ENV,
    );
    try {
      const { body } = await get(h);
      assert.equal(body.source, "stripe");
      assert.equal(body.managementUrl, null);
      assert.equal(body.hasBillingAccount, true);
    } finally {
      await h.close();
    }
  });

  it("RevenueCat unconfigured → storeBillingAvailable false", async () => {
    const h = await spinUp({ status: "trialing" }, CONFIGURED);
    try {
      assert.equal((await get(h)).body.storeBillingAvailable, false);
    } finally {
      await h.close();
    }
  });

  // ── 🔴 the period guard ──

  it("a store row WITHIN 3 days past its period is still trusted, and RevenueCat is not called", async () => {
    const h = await spinUp(
      { status: "active", source: "apple", currentPeriodEnd: new Date(NOW.getTime() - 2 * DAY) },
      STORE_ENV,
      // fetchMustNotBeCalled is the default seam
    );
    try {
      assert.equal((await get(h)).body.status, "active");
    } finally {
      await h.close();
    }
  });

  it("a store row >3 days past its period is RE-READ: a renewal whose webhook was lost shows active again", async () => {
    const rc = makeFakeRevenueCat({
      [USER_ID]: storeSubscriber({ expires: new Date(NOW.getTime() + 25 * DAY) }),
    });
    const h = await spinUp(
      { status: "active", source: "apple", currentPeriodEnd: new Date(NOW.getTime() - 5 * DAY) },
      STORE_ENV,
      rc.fetchImpl,
    );
    try {
      const { body } = await get(h);
      assert.deepEqual(rc.reads, [USER_ID], "RevenueCat was asked, once, for this user");
      assert.equal(body.status, "active");
      assert.equal(body.currentPeriodEnd, new Date(NOW.getTime() + 25 * DAY).toISOString());
    } finally {
      await h.close();
    }
  });

  it("a store row >3 days past its period whose re-read FAILS reads canceled — a missed webhook never entitles forever", async () => {
    const rc = makeFakeRevenueCat({ [USER_ID]: 503 });
    const h = await spinUp(
      { status: "active", source: "google", currentPeriodEnd: new Date(NOW.getTime() - 4 * DAY) },
      STORE_ENV,
      rc.fetchImpl,
    );
    try {
      const { status, body } = await get(h);
      assert.equal(status, 200, "a failed re-read never 500s the screen");
      assert.equal(body.status, "canceled");
    } finally {
      await h.close();
    }
  });

  it("the guard is store-only: a Stripe row long past currentPeriodEnd keeps its stored status (S1 unchanged)", async () => {
    const h = await spinUp(
      { status: "active", source: "stripe", currentPeriodEnd: new Date(NOW.getTime() - 30 * DAY) },
      STORE_ENV,
    );
    try {
      assert.equal((await get(h)).body.status, "active");
    } finally {
      await h.close();
    }
  });
});

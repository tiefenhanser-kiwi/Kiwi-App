// Row 9 (1.1) · Stripe S1 Part C — GET /me/subscription.
//
// This is the ONE shape the paywall sheet, the trial banner and the Settings
// row all read, so the tests are mostly about the fields being right for states
// that look similar from the client's side and are not:
//
//   · trialing (bonus offer live)  vs  none (subscribe now, charged today)
//   · enforced + available         vs  available but not enforced (today)
//   · not available                — the state in which the client must NOT
//     render a button, because the button leads to a 503.
//
// `firstChargeDateIfSubscribedNow` is computed on the server precisely so three
// clients do not each do date arithmetic against a bonus they would have to be
// told about separately; the tests pin the arithmetic and pin that it is null
// once the trial is over.
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
}

function stubPrisma(row: RowFixture | null) {
  return {
    subscription: {
      findUnique: async () =>
        row === null
          ? null
          : {
              status: row.status,
              planCode: row.planCode ?? "free",
              trialEndsAt: row.trialEndsAt ?? null,
              currentPeriodEnd: row.currentPeriodEnd ?? null,
              cancelAtPeriodEnd: row.cancelAtPeriodEnd ?? false,
              stripeCustomerId: null,
              stripeSubscriptionId: null,
              earlyPayBonusApplied: false,
            },
      update: async () => ({}),
    },
  };
}

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function spinUp(
  row: RowFixture | null,
  env: Record<string, string> = CONFIGURED,
): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use(
    createMeRouter({
      prisma: withSessionUser(stubPrisma(row)) as never,
      billingConfig: readBillingConfig(env),
      now: () => NOW,
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
}

async function get(h: Harness): Promise<{ status: number; body: Body }> {
  const res = await fetch(`${h.baseUrl}/me/subscription`, {
    headers: { Authorization: `Bearer ${signToken(USER_ID)}` },
  });
  return { status: res.status, body: (await res.json()) as Body };
}

describe("GET /me/subscription", () => {
  it("a live trial reports trialing, its end, and the first-charge date = end + bonus", async () => {
    const trialEndsAt = new Date(NOW.getTime() + 10 * DAY);
    const h = await spinUp({ status: "trialing", trialEndsAt });
    try {
      const { status, body } = await get(h);
      assert.equal(status, 200);
      assert.equal(body.status, "trialing");
      assert.equal(body.planCode, "free", "the trial row keeps planCode free (D-WS9-143)");
      assert.equal(body.trialEndsAt, trialEndsAt.toISOString());
      assert.equal(body.earlyPayBonusDays, 14, "the default bonus");
      // THE POINT OF THE FIELD: trialEndsAt + 14 d, computed once, server-side.
      assert.equal(
        body.firstChargeDateIfSubscribedNow,
        new Date(trialEndsAt.getTime() + 14 * DAY).toISOString(),
      );
    } finally {
      await h.close();
    }
  });

  it("the bonus is read from the env, so Hans can vary the experiment without a deploy of code", async () => {
    const trialEndsAt = new Date(NOW.getTime() + 3 * DAY);
    const h = await spinUp(
      { status: "trialing", trialEndsAt },
      { ...CONFIGURED, BILLING_EARLY_PAY_BONUS_DAYS: "30" },
    );
    try {
      const { body } = await get(h);
      assert.equal(body.earlyPayBonusDays, 30);
      assert.equal(
        body.firstChargeDateIfSubscribedNow,
        new Date(trialEndsAt.getTime() + 30 * DAY).toISOString(),
      );
    } finally {
      await h.close();
    }
  });

  it("bonus 0 means the first charge lands exactly on trialEndsAt — a valid end to the experiment", async () => {
    const trialEndsAt = new Date(NOW.getTime() + 3 * DAY);
    const h = await spinUp(
      { status: "trialing", trialEndsAt },
      { ...CONFIGURED, BILLING_EARLY_PAY_BONUS_DAYS: "0" },
    );
    try {
      const { body } = await get(h);
      assert.equal(body.earlyPayBonusDays, 0);
      assert.equal(body.firstChargeDateIfSubscribedNow, trialEndsAt.toISOString());
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

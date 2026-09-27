// Row 9 (1.1) · Stripe S1 Part E — lib/billing/cancelOnDelete.ts.
//
// The route-level tests (me-delete-account.test.ts) prove the deletion survives
// this helper failing. These prove the helper itself does the right thing, and
// the emphasis is on ORDER and on NOT CALLING STRIPE WHEN THERE IS NOTHING TO
// CANCEL — because the overwhelmingly common deletion, for as long as enforcement
// is off, is a trial account that never paid, and making an outbound call for
// every one of those would be both wasteful and a new way for deletions to be
// slow.
//
// The cancel-then-delete-customer order is asserted explicitly: deleting a Stripe
// customer cancels its subscriptions as a side effect, so this could have been
// one call, and the reason it is two is that the explicit cancel is the one that
// stops money moving. If a future edit collapses them, this test says why not.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readBillingConfig } from "../billing/config";
import { cancelStripeForUser } from "../billing/cancelOnDelete";
import { makeFakeStripe } from "../../routes/__tests__/fixtures/fakeStripe";

const USER_ID = "cancel-user";
const CONFIGURED: Record<string, string> = {
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_x",
  STRIPE_PRICE_MONTHLY: "price_m",
  STRIPE_PRICE_ANNUAL: "price_a",
  BILLING_RETURN_URL_BASE: "https://app.example",
};

function stubPrisma(row: {
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  status?: string;
} | null) {
  return {
    subscription: {
      findUnique: async () =>
        row === null ? null : { status: "active", ...row },
    },
  };
}

describe("cancelStripeForUser", () => {
  it("cancels the subscription and THEN deletes the customer, in that order", async () => {
    const order: string[] = [];
    const stripe = makeFakeStripe();
    const wrapped = {
      ...stripe,
      subscriptions: {
        ...stripe.subscriptions,
        cancel: async (id: string) => {
          order.push(`cancel:${id}`);
          return stripe.subscriptions.cancel(id);
        },
      },
      customers: {
        ...stripe.customers,
        del: async (id: string) => {
          order.push(`del:${id}`);
          return stripe.customers.del(id);
        },
      },
    };
    const res = await cancelStripeForUser({
      prisma: stubPrisma({ stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" }) as never,
      userId: USER_ID,
      config: readBillingConfig(CONFIGURED),
      stripe: wrapped as never,
    });
    assert.deepEqual(order, ["cancel:sub_1", "del:cus_1"]);
    assert.deepEqual(res, {
      hadCustomer: true,
      cancelled: true,
      customerDeleted: true,
      skipped: [],
    });
  });

  it("a trial account that never paid makes NO outbound call at all", async () => {
    const stripe = makeFakeStripe();
    const res = await cancelStripeForUser({
      prisma: stubPrisma({ stripeCustomerId: null, stripeSubscriptionId: null }) as never,
      userId: USER_ID,
      config: readBillingConfig(CONFIGURED),
      stripe,
    });
    // This is most deletions while enforcement is off. Not a single round trip.
    assert.equal(stripe.calls.subscriptionsCancel.length, 0);
    assert.equal(stripe.calls.customersDel.length, 0);
    assert.deepEqual(res.skipped, []);
    assert.equal(res.hadCustomer, false);
  });

  it("no Subscription row is also a no-op", async () => {
    const stripe = makeFakeStripe();
    const res = await cancelStripeForUser({
      prisma: stubPrisma(null) as never,
      userId: USER_ID,
      config: readBillingConfig(CONFIGURED),
      stripe,
    });
    assert.equal(stripe.calls.customersDel.length, 0);
    assert.equal(res.hadCustomer, false);
  });

  it("an ALREADY-canceled subscription is not re-cancelled, but the customer is still deleted", async () => {
    const stripe = makeFakeStripe();
    const res = await cancelStripeForUser({
      prisma: stubPrisma({
        stripeCustomerId: "cus_1",
        stripeSubscriptionId: "sub_1",
        status: "canceled",
      }) as never,
      userId: USER_ID,
      config: readBillingConfig(CONFIGURED),
      stripe,
    });
    // Asking Stripe to cancel one it has already cancelled is a 400 that reads
    // like a real failure.
    assert.equal(stripe.calls.subscriptionsCancel.length, 0);
    assert.deepEqual(res.skipped, ["already_canceled"]);
    assert.equal(res.customerDeleted, true);
  });

  it("a FAILED cancel is recorded and does NOT throw — and the customer delete still runs", async () => {
    const stripe = makeFakeStripe({
      throwOn: { subscriptionsCancel: new Error("stripe said no") },
    });
    const res = await cancelStripeForUser({
      prisma: stubPrisma({ stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" }) as never,
      userId: USER_ID,
      config: readBillingConfig(CONFIGURED),
      stripe,
    });
    assert.equal(res.cancelled, false);
    assert.deepEqual(res.skipped, ["cancel_failed"]);
    // The customer delete cancels subscriptions as a side effect, so it is the
    // second chance at the thing that matters.
    assert.equal(res.customerDeleted, true);
  });

  it("a FAILED customer delete is recorded and does not throw either", async () => {
    const stripe = makeFakeStripe({
      throwOn: { customersDel: new Error("nope") },
    });
    const res = await cancelStripeForUser({
      prisma: stubPrisma({ stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" }) as never,
      userId: USER_ID,
      config: readBillingConfig(CONFIGURED),
      stripe,
    });
    assert.equal(res.cancelled, true, "the part that stops the charging succeeded");
    assert.deepEqual(res.skipped, ["customer_delete_failed"]);
  });

  it("an UNCONFIGURED deploy skips without throwing, and without building a client", async () => {
    // No `stripe` is injected, so if this tried to build the real one it would
    // throw StripeNotConfiguredError and the test would fail.
    const res = await cancelStripeForUser({
      prisma: stubPrisma({ stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" }) as never,
      userId: USER_ID,
      config: readBillingConfig({}),
    });
    assert.deepEqual(res.skipped, ["not_configured"]);
    assert.equal(res.cancelled, false);
  });

  it("a customer with no recorded subscription still gets deleted", async () => {
    // Reachable: checkout created the customer, the user abandoned the page, and
    // no subscription event ever arrived.
    const stripe = makeFakeStripe();
    const res = await cancelStripeForUser({
      prisma: stubPrisma({ stripeCustomerId: "cus_1", stripeSubscriptionId: null }) as never,
      userId: USER_ID,
      config: readBillingConfig(CONFIGURED),
      stripe,
    });
    assert.equal(stripe.calls.subscriptionsCancel.length, 0);
    assert.deepEqual(stripe.calls.customersDel, ["cus_1"]);
    assert.equal(res.customerDeleted, true);
  });
});

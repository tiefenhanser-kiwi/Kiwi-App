// Resubmission B1 — POST /api/webhooks/revenuecat and POST /api/billing/store-sync.
//
// Apple In-App Purchase and Google Play Billing reach the one billing mirror
// through these two routes, and both do the same thing at their core: RE-READ
// the customer from RevenueCat and write the row under the one-row rule. So
// the tests are weighted the same way the Stripe webhook's are — towards the
// ways a store purchase silently corrupts the row or silently fails to land:
//
//   1. WRONG AUTH IS NOT PROCESSED — 401, no claim, no RevenueCat read.
//   2. A REPLAY IS A NO-OP — RevenueCat reuses `event.id` on its retries.
//   3. TRANSFER RE-READS BOTH SIDES — a Restore on another account moves the
//      purchase, so the old owner must lose it and the new one gain it.
//   4. 🔴 SANDBOX IS WRITTEN IN PRODUCTION — App Review buys with sandbox
//      accounts against the production server.
//   5. ONE ROW, TWO SOURCES — a store purchase never overwrites a longer-lived
//      Stripe subscription, and RevenueCat "none" never cancels a Stripe
//      subscriber or ends a trial.
//   6. STORE-SYNC answers with the GET /me/subscription body.
//
// RevenueCat itself is the fake in fixtures/fakeRevenueCat.ts — never the
// network (`pnpm test` loads .env).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";
import type { SubscriptionStatus } from "@prisma/client";

import { signToken } from "../../lib/auth";
import { readBillingConfig } from "../../lib/billing/config";
import type { RevenueCatSubscriber } from "../../lib/billing/revenuecat";
import { createBillingRouter } from "../billing";
import {
  affectedAppUserIds,
  createWebhooksRouter,
  REVENUECAT_WEBHOOK_PATH,
} from "../webhooks";
import {
  APPLE_MANAGEMENT_URL,
  emptySubscriber,
  makeFakeRevenueCat,
  RC_CONFIGURED,
  storeSubscriber,
  type FakeRevenueCat,
} from "./fixtures/fakeRevenueCat";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const AUTH = RC_CONFIGURED.REVENUECAT_WEBHOOK_AUTH;

const STRIPE_CONFIGURED: Record<string, string> = {
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_x",
  STRIPE_PRICE_MONTHLY: "price_m",
  STRIPE_PRICE_ANNUAL: "price_a",
  BILLING_RETURN_URL_BASE: "https://app.example",
};
/** Production-shaped: both rails configured, enforcement ON. */
const PRODUCTION_ENV = { ...STRIPE_CONFIGURED, ...RC_CONFIGURED, BILLING_ENFORCED: "true", NODE_ENV: "production" };

interface Row {
  userId: string;
  status: SubscriptionStatus;
  planCode: string;
  trialEndsAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  source: "stripe" | "apple" | "google" | null;
  storeOriginalTransactionId: string | null;
  storeProductId: string | null;
  storeManagementUrl: string | null;
  sourceUpdatedAt: Date | null;
}

function trialRow(userId: string, over: Partial<Row> = {}): Row {
  return {
    userId,
    status: "trialing",
    planCode: "free",
    trialEndsAt: new Date(NOW.getTime() + 10 * DAY),
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    source: null,
    storeOriginalTransactionId: null,
    storeProductId: null,
    storeManagementUrl: null,
    sourceUpdatedAt: null,
    ...over,
  };
}

/** Multi-user stub. The ledger models the (provider, id) primary key. */
function stubPrisma(rows: Row[]) {
  const byUser = new Map(rows.map((r) => [r.userId, r]));
  const events = new Map<string, { provider: string; id: string; type: string }>();
  const updates: Array<{ userId: string; data: Record<string, unknown> }> = [];
  return {
    subscription: {
      findUnique: async ({ where }: { where: { userId: string } }) => {
        const r = byUser.get(where.userId);
        return r ? { ...r } : null;
      },
      update: async ({ where, data }: { where: { userId: string }; data: Record<string, unknown> }) => {
        const r = byUser.get(where.userId);
        if (!r) throw Object.assign(new Error("not found"), { code: "P2025" });
        updates.push({ userId: where.userId, data });
        Object.assign(r, data);
        return { ...r };
      },
    },
    user: {
      findUnique: async () => ({ tokensValidFrom: null }),
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => byUser.has(id)).map((id) => ({ id })),
    },
    billingEvent: {
      create: async ({ data }: { data: { provider: string; id: string; type: string } }) => {
        const key = `${data.provider}:${data.id}`;
        if (events.has(key)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        events.set(key, data);
        return data;
      },
      delete: async ({ where }: { where: { provider_id: { provider: string; id: string } } }) => {
        events.delete(`${where.provider_id.provider}:${where.provider_id.id}`);
        return where.provider_id;
      },
    },
    _row: (userId: string) => byUser.get(userId)!,
    _events: events,
    _updates: updates,
  };
}

interface Harness {
  baseUrl: string;
  prisma: ReturnType<typeof stubPrisma>;
  rc: FakeRevenueCat;
  close: () => Promise<void>;
}

async function spinUp(
  rows: Row[],
  subscribers: Record<string, RevenueCatSubscriber | number>,
  env: Record<string, string> = PRODUCTION_ENV,
): Promise<Harness> {
  const prisma = stubPrisma(rows);
  const rc = makeFakeRevenueCat(subscribers);
  const config = readBillingConfig(env);
  const app: Express = express();
  // The RevenueCat webhook is parsed by the GLOBAL JSON parser in app.ts (it
  // signs nothing), so the harness mounts one too — the opposite of Stripe's.
  app.use(express.json());
  app.use(
    "/api",
    createWebhooksRouter({
      prisma: prisma as never,
      billingConfig: config,
      fetchImpl: rc.fetchImpl,
      now: () => NOW,
    }),
  );
  app.use(
    "/api",
    createBillingRouter({
      prisma: prisma as never,
      billingConfig: config,
      storeFetch: rc.fetchImpl,
      now: () => NOW,
      storeSyncLimiterOpts: { capacity: 1_000_000, refillPerSec: 0 },
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
        rc,
        close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

function rcEvent(over: Record<string, unknown> = {}) {
  return {
    api_version: "1.0",
    event: {
      id: "rc_evt_1",
      type: "INITIAL_PURCHASE",
      app_user_id: ALICE,
      environment: "PRODUCTION",
      store: "APP_STORE",
      product_id: "kiwi_premium_monthly",
      original_transaction_id: "2000000123456789",
      event_timestamp_ms: NOW.getTime(),
      ...over,
    },
  };
}

function send(h: Harness, body: unknown, auth: string | null = AUTH) {
  return fetch(`${h.baseUrl}${REVENUECAT_WEBHOOK_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth === null ? {} : { Authorization: auth }),
    },
    body: JSON.stringify(body),
  });
}

function storeSync(h: Harness, userId: string | null = ALICE) {
  return fetch(`${h.baseUrl}/billing/store-sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(userId === null ? {} : { Authorization: `Bearer ${signToken(userId)}` }),
    },
    body: "{}",
  });
}

const LIVE = () => storeSubscriber({ expires: new Date(NOW.getTime() + 30 * DAY) });

// ── 1. authentication ────────────────────────────────────────────────────

describe("POST /webhooks/revenuecat — the Authorization header is the authentication", () => {
  it("a WRONG header is 401, claims nothing, reads nothing, writes nothing", async () => {
    const h = await spinUp([trialRow(ALICE)], { [ALICE]: LIVE() });
    try {
      const res = await send(h, rcEvent(), "Bearer not-the-secret");
      assert.equal(res.status, 401);
      assert.equal(h.prisma._events.size, 0, "no claim");
      assert.deepEqual(h.rc.reads, [], "RevenueCat was not asked");
      assert.equal(h.prisma._updates.length, 0);
    } finally {
      await h.close();
    }
  });

  it("a MISSING header is 401 too", async () => {
    const h = await spinUp([trialRow(ALICE)], { [ALICE]: LIVE() });
    try {
      assert.equal((await send(h, rcEvent(), null)).status, 401);
      assert.equal(h.prisma._events.size, 0);
    } finally {
      await h.close();
    }
  });

  it("the WHOLE header is compared — the secret without its 'Bearer ' prefix is wrong", async () => {
    const h = await spinUp([trialRow(ALICE)], { [ALICE]: LIVE() });
    try {
      assert.equal((await send(h, rcEvent(), AUTH.replace(/^Bearer /, ""))).status, 401);
    } finally {
      await h.close();
    }
  });

  it("RevenueCat unconfigured → 503, before anything else", async () => {
    const h = await spinUp([trialRow(ALICE)], {}, STRIPE_CONFIGURED);
    try {
      assert.equal((await send(h, rcEvent())).status, 503);
      assert.equal(h.prisma._events.size, 0);
    } finally {
      await h.close();
    }
  });

  it("a body with no event id is 400 and claims nothing", async () => {
    const h = await spinUp([trialRow(ALICE)], {});
    try {
      assert.equal((await send(h, { api_version: "1.0", event: { type: "RENEWAL" } })).status, 400);
      assert.equal(h.prisma._events.size, 0);
    } finally {
      await h.close();
    }
  });
});

// ── 2. the re-read, and idempotency ──────────────────────────────────────

describe("POST /webhooks/revenuecat — the payload is never written; the customer is re-read", () => {
  it("INITIAL_PURCHASE on a trial: re-reads ALICE and writes an active Apple row", async () => {
    const h = await spinUp([trialRow(ALICE)], { [ALICE]: LIVE() });
    try {
      const res = await send(h, rcEvent());
      assert.equal(res.status, 200);
      assert.deepEqual(h.rc.reads, [ALICE]);
      assert.equal(h.rc.authHeaders[0], `Bearer ${RC_CONFIGURED.REVENUECAT_SECRET_API_KEY}`);
      const row = h.prisma._row(ALICE);
      assert.equal(row.source, "apple");
      assert.equal(row.status, "active");
      assert.equal(row.planCode, "premium_monthly");
      assert.equal(row.storeProductId, "kiwi_premium_monthly");
      assert.equal(row.currentPeriodEnd?.getTime(), NOW.getTime() + 30 * DAY);
      assert.equal(row.storeManagementUrl, APPLE_MANAGEMENT_URL);
      assert.equal(row.storeOriginalTransactionId, "2000000123456789", "the identity comes from the event");
      assert.equal(row.cancelAtPeriodEnd, false);
      // The trial clock is Kiwi's and a purchase does not touch it.
      assert.equal(row.trialEndsAt?.getTime(), NOW.getTime() + 10 * DAY);
    } finally {
      await h.close();
    }
  });

  it("a DUPLICATE delivery (same event.id) is one write — the second is a 200 no-op", async () => {
    const h = await spinUp([trialRow(ALICE)], { [ALICE]: LIVE() });
    try {
      assert.equal((await send(h, rcEvent())).status, 200);
      const second = await send(h, rcEvent());
      assert.equal(second.status, 200);
      assert.deepEqual(await second.json(), { received: true, duplicate: true });
      assert.equal(h.prisma._updates.length, 1, "ONE write");
      assert.deepEqual(h.rc.reads, [ALICE], "ONE re-read");
    } finally {
      await h.close();
    }
  });

  it("the event's own fields are ignored — RENEWAL with a stale payload still writes what RevenueCat says NOW", async () => {
    // The customer is lapsed; the event claims a renewal. The re-read wins.
    const h = await spinUp(
      [trialRow(ALICE, { status: "active", source: "apple", currentPeriodEnd: new Date(NOW.getTime() + DAY) })],
      { [ALICE]: storeSubscriber({ expires: new Date(NOW.getTime() - DAY) }) },
    );
    try {
      await send(h, rcEvent({ type: "RENEWAL", expiration_at_ms: NOW.getTime() + 300 * DAY }));
      assert.equal(h.prisma._row(ALICE).status, "canceled");
    } finally {
      await h.close();
    }
  });

  it("a failed re-read answers 500 and RELEASES the claim, so RevenueCat's retry lands", async () => {
    const subscribers: Record<string, RevenueCatSubscriber | number> = { [ALICE]: 500 };
    const h = await spinUp([trialRow(ALICE)], subscribers);
    try {
      assert.equal((await send(h, rcEvent())).status, 500);
      assert.equal(h.prisma._events.size, 0, "claim released");
      subscribers[ALICE] = LIVE();
      assert.equal((await send(h, rcEvent())).status, 200, "the retry is processed, not discarded");
      assert.equal(h.prisma._row(ALICE).status, "active");
    } finally {
      await h.close();
    }
  });

  it("TEST and types that say nothing about entitlement are 200, logged, and never re-read", async () => {
    const h = await spinUp([trialRow(ALICE)], { [ALICE]: LIVE() });
    try {
      for (const [i, type] of ["TEST", "SUBSCRIBER_ALIAS", "EXPERIMENT_ENROLLMENT", "SOMETHING_NEW"].entries()) {
        const res = await send(h, rcEvent({ id: `rc_ign_${i}`, type }));
        assert.equal(res.status, 200, type);
      }
      assert.deepEqual(h.rc.reads, []);
      assert.equal(h.prisma._updates.length, 0);
    } finally {
      await h.close();
    }
  });
});

// ── 3. who is affected ───────────────────────────────────────────────────

describe("POST /webhooks/revenuecat — affected users", () => {
  it("TRANSFER re-reads BOTH users: the purchase leaves ALICE and lands on BOB", async () => {
    const h = await spinUp(
      [
        trialRow(ALICE, { status: "active", source: "apple", currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY) }),
        trialRow(BOB),
      ],
      { [ALICE]: emptySubscriber(), [BOB]: LIVE() },
    );
    try {
      const res = await send(
        h,
        rcEvent({ type: "TRANSFER", app_user_id: undefined, transferred_from: [ALICE], transferred_to: [BOB] }),
      );
      assert.equal(res.status, 200);
      assert.deepEqual([...h.rc.reads].sort(), [ALICE, BOB].sort());
      assert.equal(h.prisma._row(ALICE).status, "canceled", "the old owner lost it");
      assert.equal(h.prisma._row(BOB).status, "active", "the new owner has it");
      assert.equal(h.prisma._row(BOB).source, "apple");
    } finally {
      await h.close();
    }
  });

  it("an anonymous $RCAnonymousID is never read or written, and the event is still a 200", async () => {
    const h = await spinUp([trialRow(ALICE)], {});
    try {
      const res = await send(h, rcEvent({ app_user_id: "$RCAnonymousID:abc123" }));
      assert.equal(res.status, 200);
      assert.deepEqual(h.rc.reads, []);
    } finally {
      await h.close();
    }
  });

  it("an app user id that is not a Kiwi user is skipped", async () => {
    const h = await spinUp([trialRow(ALICE)], {});
    try {
      assert.equal((await send(h, rcEvent({ app_user_id: "someone-else" }))).status, 200);
      assert.deepEqual(h.rc.reads, []);
    } finally {
      await h.close();
    }
  });

  it("affectedAppUserIds: TRANSFER is the union, deduplicated; every other type is app_user_id", () => {
    assert.deepEqual(
      affectedAppUserIds({ id: "e", type: "TRANSFER", transferred_from: [ALICE, BOB], transferred_to: [BOB] }),
      [ALICE, BOB],
    );
    assert.deepEqual(affectedAppUserIds({ id: "e", type: "RENEWAL", app_user_id: ALICE }), [ALICE]);
    assert.deepEqual(affectedAppUserIds({ id: "e", type: "RENEWAL" }), []);
  });
});

// ── 4. sandbox ───────────────────────────────────────────────────────────

describe("🔴 POST /webhooks/revenuecat — SANDBOX is written in a production config", () => {
  it("environment SANDBOX + is_sandbox, NODE_ENV production, enforcement on → the row is written", async () => {
    const h = await spinUp(
      [trialRow(ALICE)],
      { [ALICE]: storeSubscriber({ expires: new Date(NOW.getTime() + 5 * 60 * 1000), sandbox: true }) },
    );
    try {
      const res = await send(h, rcEvent({ environment: "SANDBOX" }));
      assert.equal(res.status, 200);
      assert.equal(h.prisma._row(ALICE).status, "active", "App Review's purchase unlocks the account");
      assert.equal(h.prisma._row(ALICE).source, "apple");
    } finally {
      await h.close();
    }
  });
});

// ── 5. one row, two sources ──────────────────────────────────────────────

describe("one row, two sources — the store side of the rule", () => {
  it("an Apple purchase does NOT overwrite a Stripe subscription that runs longer", async () => {
    const h = await spinUp(
      [trialRow(ALICE, { status: "active", source: "stripe", stripeSubscriptionId: "sub_web", currentPeriodEnd: new Date(NOW.getTime() + 300 * DAY) })],
      { [ALICE]: LIVE() },
    );
    try {
      assert.equal((await send(h, rcEvent())).status, 200);
      assert.equal(h.prisma._updates.length, 0);
      assert.equal(h.prisma._row(ALICE).source, "stripe");
    } finally {
      await h.close();
    }
  });

  it("an Apple purchase that runs LONGER than a live Stripe subscription takes the row", async () => {
    const h = await spinUp(
      [trialRow(ALICE, { status: "active", source: "stripe", currentPeriodEnd: new Date(NOW.getTime() + 5 * DAY) })],
      { [ALICE]: LIVE() },
    );
    try {
      await send(h, rcEvent());
      assert.equal(h.prisma._row(ALICE).source, "apple");
    } finally {
      await h.close();
    }
  });

  it("an Apple purchase takes a row whose Stripe subscription has ENDED", async () => {
    const h = await spinUp(
      [trialRow(ALICE, { status: "canceled", source: "stripe", currentPeriodEnd: new Date(NOW.getTime() - 40 * DAY) })],
      { [ALICE]: LIVE() },
    );
    try {
      await send(h, rcEvent());
      assert.equal(h.prisma._row(ALICE).source, "apple");
      assert.equal(h.prisma._row(ALICE).status, "active");
    } finally {
      await h.close();
    }
  });

  it("🔴 RevenueCat 'none' leaves a STRIPE subscriber untouched", async () => {
    const h = await spinUp(
      [trialRow(ALICE, { status: "active", source: "stripe", currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY) })],
      { [ALICE]: emptySubscriber() },
    );
    try {
      assert.equal((await send(h, rcEvent({ type: "EXPIRATION" }))).status, 200);
      assert.equal(h.prisma._updates.length, 0);
      assert.equal(h.prisma._row(ALICE).status, "active");
    } finally {
      await h.close();
    }
  });

  it("🔴 RevenueCat 'none' never ends a TRIAL", async () => {
    const h = await spinUp([trialRow(ALICE)], { [ALICE]: emptySubscriber() });
    try {
      await send(h, rcEvent({ type: "CANCELLATION" }));
      assert.equal(h.prisma._updates.length, 0);
      assert.equal(h.prisma._row(ALICE).status, "trialing");
      assert.equal(h.prisma._row(ALICE).source, null);
    } finally {
      await h.close();
    }
  });

  it("an EXPIRED store entitlement restored onto a trial does not end it either", async () => {
    const h = await spinUp(
      [trialRow(ALICE)],
      { [ALICE]: storeSubscriber({ expires: new Date(NOW.getTime() - 200 * DAY) }) },
    );
    try {
      await send(h, rcEvent({ type: "TRANSFER", transferred_from: [], transferred_to: [ALICE] }));
      assert.equal(h.prisma._row(ALICE).status, "trialing");
    } finally {
      await h.close();
    }
  });

  it("RevenueCat 'none' on an APPLE row is the end of it — canceled (expired or refunded)", async () => {
    const h = await spinUp(
      [trialRow(ALICE, { status: "active", source: "apple", currentPeriodEnd: new Date(NOW.getTime() + 2 * DAY) })],
      { [ALICE]: emptySubscriber() },
    );
    try {
      await send(h, rcEvent({ type: "EXPIRATION" }));
      assert.equal(h.prisma._row(ALICE).status, "canceled");
      assert.equal(h.prisma._row(ALICE).source, "apple", "the row still says which rail it was");
    } finally {
      await h.close();
    }
  });
});

// ── the mapping ──────────────────────────────────────────────────────────

describe("the row derived from one subscriber", () => {
  async function derived(sub: RevenueCatSubscriber, start: Row = trialRow(ALICE)) {
    const h = await spinUp([start], { [ALICE]: sub });
    try {
      await send(h, rcEvent());
      return { ...h.prisma._row(ALICE) };
    } finally {
      await h.close();
    }
  }

  it("billing issue while still inside the store's grace → past_due (still entitled)", async () => {
    const row = await derived(
      storeSubscriber({
        expires: new Date(NOW.getTime() - DAY),
        grace: new Date(NOW.getTime() + 6 * DAY),
        billingIssue: new Date(NOW.getTime() - DAY),
      }),
    );
    assert.equal(row.status, "past_due");
    assert.equal(row.currentPeriodEnd?.getTime(), NOW.getTime() + 6 * DAY, "the period runs to the grace end");
  });

  it("unsubscribe detected → cancelAtPeriodEnd, still active", async () => {
    const row = await derived(
      storeSubscriber({ expires: new Date(NOW.getTime() + 9 * DAY), unsubscribed: new Date(NOW.getTime() - DAY) }),
    );
    assert.equal(row.status, "active");
    assert.equal(row.cancelAtPeriodEnd, true);
  });

  it("Google Play: play_store → google; the product's part before ':' picks the plan", async () => {
    const row = await derived(
      storeSubscriber({
        store: "play_store",
        productId: "kiwi_premium_annual:annual-autorenew",
        expires: new Date(NOW.getTime() + 300 * DAY),
        managementUrl: "https://play.google.com/store/account/subscriptions",
      }),
    );
    assert.equal(row.source, "google");
    assert.equal(row.planCode, "premium_annual");
    assert.equal(row.storeProductId, "kiwi_premium_annual:annual-autorenew");
  });

  it("an unknown product leaves planCode alone but still mirrors the status", async () => {
    const row = await derived(storeSubscriber({ productId: "kiwi_lifetime_beta", expires: new Date(NOW.getTime() + DAY) }));
    assert.equal(row.status, "active");
    assert.equal(row.planCode, "free");
  });

  it("a store Kiwi does not sell through (promotional) is ignored — no write", async () => {
    const row = await derived(storeSubscriber({ store: "promotional", expires: new Date(NOW.getTime() + DAY) }));
    assert.equal(row.status, "trialing");
    assert.equal(row.source, null);
  });

  it("the entitlement id comes from the env — another id is 'none'", async () => {
    const row = await derived(
      storeSubscriber({ entitlementId: "something_else", expires: new Date(NOW.getTime() + DAY) }),
      trialRow(ALICE, { status: "active", source: "apple", currentPeriodEnd: new Date(NOW.getTime() + DAY) }),
    );
    assert.equal(row.status, "canceled");
  });
});

// ── 6. store-sync ───────────────────────────────────────────────────────

describe("POST /billing/store-sync", () => {
  it("re-reads the signed-in user and answers with the GET /me/subscription body", async () => {
    const h = await spinUp([trialRow(ALICE)], { [ALICE]: LIVE() });
    try {
      const res = await storeSync(h);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.deepEqual(h.rc.reads, [ALICE]);
      assert.deepEqual(body, {
        status: "active",
        planCode: "premium_monthly",
        trialEndsAt: new Date(NOW.getTime() + 10 * DAY).toISOString(),
        currentPeriodEnd: new Date(NOW.getTime() + 30 * DAY).toISOString(),
        cancelAtPeriodEnd: false,
        billingAvailable: true,
        enforced: true,
        earlyPayBonusDays: 0,
        firstChargeDateIfSubscribedNow: null,
        hasBillingAccount: false,
        source: "apple",
        managementUrl: APPLE_MANAGEMENT_URL,
        storeBillingAvailable: true,
      });
    } finally {
      await h.close();
    }
  });

  it("nothing in the store → the row is untouched and the body says trialing", async () => {
    const h = await spinUp([trialRow(ALICE)], { [ALICE]: emptySubscriber() });
    try {
      const body = (await (await storeSync(h)).json()) as { status: string; source: unknown };
      assert.equal(body.status, "trialing");
      assert.equal(body.source, null);
      assert.equal(h.prisma._updates.length, 0);
    } finally {
      await h.close();
    }
  });

  it("RevenueCat failing → 502 store_sync_failed, row untouched", async () => {
    const h = await spinUp([trialRow(ALICE)], { [ALICE]: 503 });
    try {
      const res = await storeSync(h);
      assert.equal(res.status, 502);
      assert.deepEqual(await res.json(), { code: "store_sync_failed" });
      assert.equal(h.prisma._updates.length, 0);
    } finally {
      await h.close();
    }
  });

  it("RevenueCat unconfigured → 503 billing_unavailable, never a read", async () => {
    const h = await spinUp([trialRow(ALICE)], { [ALICE]: LIVE() }, STRIPE_CONFIGURED);
    try {
      const res = await storeSync(h);
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { code: "billing_unavailable" });
      assert.deepEqual(h.rc.reads, []);
    } finally {
      await h.close();
    }
  });

  it("requires auth — the user is the token's, never something the client says", async () => {
    const h = await spinUp([trialRow(ALICE)], { [ALICE]: LIVE() });
    try {
      assert.equal((await storeSync(h, null)).status, 401);
      assert.deepEqual(h.rc.reads, []);
    } finally {
      await h.close();
    }
  });
});

// Resub C2 — "the store took the money; does Kiwi know?" (lib/billing/storeConfirm.ts)

import assert from "node:assert/strict";
import { test } from "node:test";

import type { StoreSyncResult } from "../api";
import { confirmStorePurchase, STORE_SYNC_BACKOFF_MS } from "../storeConfirm";
import type { SubscriptionPayload } from "../subscriptionView";

function sub(status: SubscriptionPayload["status"]): SubscriptionPayload {
  return {
    status,
    planCode: "monthly",
    trialEndsAt: null,
    currentPeriodEnd: "2026-11-05T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    billingAvailable: true,
    enforced: true,
    source: "apple",
    managementUrl: null,
    storeBillingAvailable: true,
  };
}

/** A sync that answers from a script, recording how often it was asked. */
function scripted(answers: StoreSyncResult[]) {
  let i = 0;
  const sync = async () => answers[Math.min(i++, answers.length - 1)];
  return { sync, count: () => i };
}

const failed: StoreSyncResult = { success: false, error: "store_sync_failed" };
const noSleep = async () => {};

test("🔴 a 502 is retried with backoff until store-sync answers", async () => {
  const waits: number[] = [];
  const s = scripted([failed, failed, { success: true, subscription: sub("active") }]);
  const out = await confirmStorePurchase({
    sync: s.sync,
    sleep: async (ms) => {
      waits.push(ms);
    },
    expectPaying: true,
  });
  assert.equal(out.kind, "confirmed");
  assert.equal(s.count(), 3);
  assert.deepEqual(waits, [STORE_SYNC_BACKOFF_MS[0], STORE_SYNC_BACKOFF_MS[1]]);
});

test("retries are bounded: five tries, then stalled — never an endless spinner", async () => {
  const s = scripted([failed]);
  const out = await confirmStorePurchase({ sync: s.sync, sleep: noSleep, expectPaying: true });
  assert.deepEqual(out, { kind: "stalled" });
  assert.equal(s.count(), STORE_SYNC_BACKOFF_MS.length + 1);
});

test("a 429 is retried like a 502", async () => {
  const s = scripted([{ success: false, error: "rate_limited" }, { success: true, subscription: sub("active") }]);
  const out = await confirmStorePurchase({ sync: s.sync, sleep: noSleep, expectPaying: true });
  assert.equal(out.kind, "confirmed");
});

test("a 503 is not retried: no RevenueCat on the deploy will not change by waiting", async () => {
  const s = scripted([{ success: false, error: "billing_unavailable" }]);
  assert.deepEqual(
    await confirmStorePurchase({ sync: s.sync, sleep: noSleep, expectPaying: true }),
    { kind: "unavailable" },
  );
  assert.equal(s.count(), 1);
});

test("after a PURCHASE, an answer that does not yet say paying is retried", async () => {
  const s = scripted([
    { success: true, subscription: sub("trialing") },
    { success: true, subscription: sub("active") },
  ]);
  const out = await confirmStorePurchase({ sync: s.sync, sleep: noSleep, expectPaying: true });
  assert.equal(out.kind === "confirmed" && out.subscription.status, "active");
  assert.equal(s.count(), 2);
});

test("after a RESTORE, any answer is final — 'nothing to restore' is a real result", async () => {
  const s = scripted([{ success: true, subscription: sub("trialing") }]);
  const out = await confirmStorePurchase({ sync: s.sync, sleep: noSleep, expectPaying: false });
  assert.equal(out.kind === "confirmed" && out.subscription.status, "trialing");
  assert.equal(s.count(), 1);
});

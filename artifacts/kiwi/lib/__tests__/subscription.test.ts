// WS9-2 Block 2a (BUG-072 + trial-length) — the pure subscription mapping that
// Profile / Manage Account render and TrialBadge shares the day computation with.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatSubscriptionState,
  subscriptionInfoFromAuth,
  trialDaysRemaining,
} from "../domain";

const DAY = 1000 * 60 * 60 * 24;

test("trialDaysRemaining: null/undefined trialEndsAt -> 0", () => {
  assert.equal(trialDaysRemaining(null), 0);
  assert.equal(trialDaysRemaining(undefined), 0);
});

test("trialDaysRemaining: a past end date floors at 0", () => {
  assert.equal(trialDaysRemaining(new Date(Date.now() - 3 * DAY).toISOString()), 0);
});

test("trialDaysRemaining: ceils partial days remaining", () => {
  // ~5 days minus a sliver -> ceil to 5.
  const iso = new Date(Date.now() + 5 * DAY - 1000).toISOString();
  assert.equal(trialDaysRemaining(iso), 5);
});

test("subscriptionInfoFromAuth: null subscription -> tier none", () => {
  assert.deepEqual(subscriptionInfoFromAuth(null), { tier: "none" });
  assert.deepEqual(subscriptionInfoFromAuth(undefined), { tier: "none" });
});

test("subscriptionInfoFromAuth: trialing maps status->trial with a computed day count", () => {
  const info = subscriptionInfoFromAuth({
    status: "trialing",
    planCode: "free",
    trialEndsAt: new Date(Date.now() + 14 * DAY - 1000).toISOString(),
    currentPeriodEnd: null,
  });
  assert.equal(info.tier, "trial");
  assert.equal(info.trialDaysRemaining, 14);
  assert.equal(info.nextRenewalDate, undefined);
  // The state string surfaces the computed count, not a hardcoded one.
  assert.equal(formatSubscriptionState(info), "Trial · 14 days remaining");
});

test("subscriptionInfoFromAuth: active maps renewal date, no trial count", () => {
  const info = subscriptionInfoFromAuth({
    status: "active",
    planCode: "premium_monthly",
    trialEndsAt: null,
    currentPeriodEnd: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(info.tier, "active");
  assert.equal(info.trialDaysRemaining, undefined);
  assert.ok(info.nextRenewalDate && info.nextRenewalDate.includes("2026"));
});

test("subscriptionInfoFromAuth: past_due / canceled / unknown map through", () => {
  const base = { planCode: "free" as const, trialEndsAt: null, currentPeriodEnd: null };
  assert.equal(subscriptionInfoFromAuth({ ...base, status: "past_due" }).tier, "past_due");
  assert.equal(subscriptionInfoFromAuth({ ...base, status: "canceled" }).tier, "canceled");
  assert.equal(subscriptionInfoFromAuth({ ...base, status: "none" }).tier, "none");
});

// SERVER-9 A (D-WS9-356) — Kiwi is free during launch. While BILLING_ENFORCED
// is off, no lifecycle email about free time ending is ever due, and the
// emails that can still go (welcome, Day 1–5, the event nudges) say nothing
// about trials or prices. Pure: no database, no sender.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LIFECYCLE_COPY } from "../lifecycle/copy";
import {
  FREE_TIME_KINDS,
  LIFECYCLE_KINDS,
  dueKinds,
  type LifecycleFacts,
  type LifecycleKind,
} from "../lifecycle/schedule";
import { billingModeFor, buildSubscriptionPayload } from "../billing/subscriptionPayload";
import { readBillingConfig } from "../billing/config";

const H = 60 * 60 * 1000;
const D = 24 * H;
const t = (iso: string) => new Date(iso);

// Production's free-time end (LIFE-1: subscriptions.trialEndsAt, Nov 2 23:59:59 New York).
const ENDS = t("2026-11-03T04:59:59Z");

/** A trialing account that would get every free-time kind somewhere in the sweep. */
function facts(billingEnforced: boolean): LifecycleFacts {
  return {
    createdAt: t("2026-10-01T15:00:00Z"),
    timezone: "America/New_York",
    optedOut: false,
    hasPlan: true,
    freeTimeEndsAt: ENDS,
    paying: false,
    billingEnforced,
    sent: new Set(["welcome", "day1", "day3", "day5"]),
    capClaims: [],
    firstPlanAt: null,
    secondPlanAt: null,
    datedPlans: [],
    firstListAt: null,
    secondListAt: null,
    sentToInstacart: false,
    firstPrepAt: null,
    firstCookFinishedAt: null,
    hasPlaylist: false,
    // Idle from Oct 24: still_here's window (Oct 31 – Nov 2) sits inside the free time.
    lastActiveAt: t("2026-10-24T16:00:00Z"),
  };
}

/** Every hour from Oct 20 to Dec 1: before, across and well after the free-time end. */
function sweep(f: LifecycleFacts): Set<LifecycleKind> {
  const seen = new Set<LifecycleKind>();
  for (let ms = t("2026-10-20T00:00:00Z").getTime(); ms < t("2026-12-01T00:00:00Z").getTime(); ms += H) {
    for (const k of dueKinds(f, new Date(ms))) seen.add(k);
  }
  return seen;
}

describe("SERVER-9 A — free-time lifecycle emails while billing is not enforced", () => {
  it("the free-time kinds are LIFE-1's ending + ended and LIFE-2's #13 still_here + #14 come_back", () => {
    assert.deepEqual([...FREE_TIME_KINDS].sort(), ["come_back", "still_here", "trial_ended", "trial_ending"]);
  });

  it("enforced: every free-time kind falls due somewhere in the sweep (the sweep can see them)", () => {
    const seen = sweep(facts(true));
    for (const k of FREE_TIME_KINDS) assert.ok(seen.has(k), `${k} due when enforced`);
  });

  it("free_launch: none of them is ever due, hour by hour over six weeks", () => {
    const seen = sweep(facts(false));
    for (const k of FREE_TIME_KINDS) assert.equal(seen.has(k), false, `${k} never due in free_launch`);
  });

  it("free_launch: a paying account, an empty send log and an earlier idle stretch change nothing", () => {
    for (const over of [{ paying: true }, { sent: new Set<string>() }, { lastActiveAt: t("2026-10-21T16:00:00Z") }]) {
      const seen = sweep({ ...facts(false), ...over });
      for (const k of FREE_TIME_KINDS) assert.equal(seen.has(k), false, `${k} with ${JSON.stringify(over)}`);
    }
  });

  it("free_launch: the other kinds still go (the gate is only the free-time four)", () => {
    const f: LifecycleFacts = { ...facts(false), sent: new Set(), createdAt: t("2026-10-20T15:00:00Z"), hasPlan: false };
    const seen = sweep(f);
    for (const k of ["welcome", "day1", "day3", "day5"] as const) assert.ok(seen.has(k), k);
  });
});

describe("SERVER-9 A — the emails that still go name no trial or price", () => {
  const STILL_SENT = LIFECYCLE_KINDS.filter((k) => !FREE_TIME_KINDS.includes(k));

  it("ten kinds still send: welcome, day1/3/5 and the event nudges", () => {
    assert.deepEqual(STILL_SENT, [
      "welcome",
      "day1",
      "day3",
      "day5",
      "list_nudge",
      "prep_nudge",
      "first_cook",
      "next_week",
      "playlist_nudge",
      "instacart_nudge",
    ]);
  });

  for (const kind of LIFECYCLE_KINDS.filter((k) => !FREE_TIME_KINDS.includes(k))) {
    it(`${kind}: no "14", "trial", "$9.99", "$99.99", "subscribe", price or end date`, () => {
      const c = LIFECYCLE_COPY[kind];
      const words = [c.subject, c.greeting, ...c.body, c.button.label, ...c.after].join("\n");
      assert.doesNotMatch(words, /\b14\b|trial|\$9\.99|\$99\.99|subscrib|\$\d|\bfree (time|access|period)\b|\{endDate\}/i);
    });
  }
});

describe("SERVER-9 A — billing mode", () => {
  it("free_launch exactly when BILLING_ENFORCED is off", () => {
    assert.deepEqual(billingModeFor(readBillingConfig({})), { mode: "free_launch" });
    assert.deepEqual(billingModeFor(readBillingConfig({ BILLING_ENFORCED: "false" })), { mode: "free_launch" });
    assert.deepEqual(billingModeFor(readBillingConfig({ BILLING_ENFORCED: "ture" })), { mode: "free_launch" });
    assert.deepEqual(billingModeFor(readBillingConfig({ BILLING_ENFORCED: "true" })), { mode: "enforced" });
  });

  const snapshot = {
    status: "none",
    planCode: "free",
    trialEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    source: null,
    storeManagementUrl: null,
    trialDeniedReason: "trial_already_used",
  };

  it("the payload: free_launch sends billing and no trialDeniedReason key at all", () => {
    const body = buildSubscriptionPayload(snapshot as never, readBillingConfig({}), new Date());
    assert.deepEqual(body.billing, { mode: "free_launch" });
    assert.equal("trialDeniedReason" in body, false);
    assert.equal(body.enforced, false);
  });

  it("the payload: enforced sends billing and the reason as before", () => {
    const body = buildSubscriptionPayload(snapshot as never, readBillingConfig({ BILLING_ENFORCED: "true" }), new Date());
    assert.deepEqual(body.billing, { mode: "enforced" });
    assert.equal(body.trialDeniedReason, "trial_already_used");
  });

  it("the payload: free_launch keeps both purchase rails' availability (nothing turns purchases off)", () => {
    const env = {
      STRIPE_SECRET_KEY: "sk",
      STRIPE_WEBHOOK_SECRET: "wh",
      STRIPE_PRICE_MONTHLY: "pm",
      STRIPE_PRICE_ANNUAL: "pa",
      BILLING_RETURN_URL_BASE: "https://x",
      REVENUECAT_WEBHOOK_AUTH: "a",
      REVENUECAT_SECRET_API_KEY: "k",
    };
    const body = buildSubscriptionPayload(snapshot as never, readBillingConfig(env), new Date(Date.now() + D));
    assert.equal(body.billing.mode, "free_launch");
    assert.equal(body.billingAvailable, true);
    assert.equal(body.storeBillingAvailable, true);
  });
});

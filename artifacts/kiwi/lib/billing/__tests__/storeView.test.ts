// Resub C2 — the store-rail decisions in lib/billing/subscriptionView.ts:
// the manage action by source (§3), the Kiwi Premium row (§2), the
// delete-account notice (BUG-356), and whether a build may take money.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  STORE_SUBSCRIPTIONS_URL,
  deleteAccountNoticeFor,
  manageActionFor,
  premiumRowFor,
  storeBillingReady,
  subscriptionCardFor,
  type SubscriptionPayload,
} from "../subscriptionView";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const IN_12_DAYS = "2026-10-17T11:00:00.000Z";

function sub(over: Partial<SubscriptionPayload> = {}): SubscriptionPayload {
  return {
    status: "trialing",
    planCode: "free",
    trialEndsAt: IN_12_DAYS,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    billingAvailable: true,
    enforced: false,
    hasBillingAccount: false,
    source: null,
    managementUrl: null,
    storeBillingAvailable: true,
    ...over,
  };
}

const APPLE_ACTIVE = sub({
  status: "active",
  planCode: "monthly",
  currentPeriodEnd: "2026-11-05T00:00:00.000Z",
  source: "apple",
  managementUrl: "https://apps.apple.com/account/subscriptions?rc=1",
});
const GOOGLE_ACTIVE = sub({
  status: "active",
  planCode: "annual",
  currentPeriodEnd: "2027-10-05T00:00:00.000Z",
  source: "google",
  managementUrl: null,
});
const STRIPE_ACTIVE = sub({
  status: "active",
  planCode: "monthly",
  currentPeriodEnd: "2026-11-05T00:00:00.000Z",
  source: "stripe",
  hasBillingAccount: true,
});
const TRIAL = sub();

// ── §3: the manage action, all four rows × both sides ─────────────────────

test("🔴 §3 apple / google · native → open managementUrl, else the store's subscriptions page", () => {
  for (const os of ["ios", "android"]) {
    assert.deepEqual(manageActionFor(os, APPLE_ACTIVE), {
      kind: "store_link",
      url: "https://apps.apple.com/account/subscriptions?rc=1",
      label: "Manage subscription",
    });
    assert.deepEqual(manageActionFor(os, GOOGLE_ACTIVE), {
      kind: "store_link",
      url: STORE_SUBSCRIPTIONS_URL.google,
      label: "Manage subscription",
    });
  }
  assert.equal(STORE_SUBSCRIPTIONS_URL.apple, "https://apps.apple.com/account/subscriptions");
  assert.equal(STORE_SUBSCRIPTIONS_URL.google, "https://play.google.com/store/account/subscriptions");
});

test("🔴 §3 apple / google · web → a sentence: manage it in the store", () => {
  assert.deepEqual(manageActionFor("web", APPLE_ACTIVE), {
    kind: "store_text",
    text: "You're subscribed through the App Store — manage it there.",
  });
  assert.deepEqual(manageActionFor("web", GOOGLE_ACTIVE), {
    kind: "store_text",
    text: "You're subscribed through Google Play — manage it there.",
  });
});

test("🔴 §3 stripe · native → plain text, NO link; web → the existing Portal", () => {
  for (const os of ["ios", "android"]) {
    assert.deepEqual(manageActionFor(os, STRIPE_ACTIVE), {
      kind: "stripe_text",
      text: "Manage your subscription at kitchenwizard.ai",
    });
  }
  assert.deepEqual(manageActionFor("web", STRIPE_ACTIVE), {
    kind: "stripe_portal",
    label: "Manage subscription",
  });
});

test("🔴 §3 null source · native → the Kiwi Premium row; web → as today", () => {
  for (const os of ["ios", "android"]) {
    assert.equal(manageActionFor(os, TRIAL), null);
    const card = subscriptionCardFor(os, TRIAL, NOW);
    assert.ok(card?.premium, `${os}: a trial account has the Kiwi Premium row`);
    assert.equal(card?.subscribe, false, `${os}: no Stripe Subscribe button`);
  }
  // Web, as today: the Subscribe button (Stripe configured, unsubscribed), no row.
  const web = subscriptionCardFor("web", TRIAL, NOW);
  assert.equal(web?.premium, null);
  assert.equal(web?.subscribe, true);
  assert.equal(web?.manage, null);
});

test("an unknown source reads as none, not as a crash", () => {
  assert.equal(manageActionFor("ios", sub({ source: "amazon" })), null);
});

// ── §2: the Kiwi Premium row ──────────────────────────────────────────────

test("🔴 §2 the Kiwi Premium row shows DURING THE TRIAL, with the days left, and opens the trial sheet", () => {
  assert.deepEqual(premiumRowFor("ios", TRIAL, NOW), {
    line: "12 days left in your free trial",
    sheet: "trialing",
  });
  assert.equal(premiumRowFor("ios", sub({ trialEndsAt: "2026-10-06T10:00:00.000Z" }), NOW)?.line, "1 day left in your free trial");
});

test("the row ignores the `enforced` blackout — buying must be possible before enforcement", () => {
  assert.equal(TRIAL.enforced, false);
  assert.ok(premiumRowFor("ios", TRIAL, NOW));
  assert.ok(premiumRowFor("android", sub({ enforced: false, billingAvailable: false }), NOW));
});

test("the row: an unbounded trial, a lapsed account, and no row for a paying one or on the web", () => {
  assert.equal(premiumRowFor("ios", sub({ trialEndsAt: null }), NOW)?.line, "You're on your free trial");
  assert.deepEqual(premiumRowFor("ios", sub({ status: "none" }), NOW), {
    line: "Your free trial has ended",
    sheet: "lapsed",
  });
  assert.equal(premiumRowFor("ios", APPLE_ACTIVE, NOW), null);
  assert.equal(premiumRowFor("ios", sub({ status: "past_due", source: "stripe" }), NOW), null);
  assert.equal(premiumRowFor("web", TRIAL, NOW), null);
});

test("native: the card always renders for a signed-in account — the row must be reachable", () => {
  const card = subscriptionCardFor("ios", sub({ billingAvailable: false, enforced: false }), NOW);
  assert.ok(card, "even with no Stripe and no enforcement");
  assert.equal(card?.statusLine, "Free trial · ends Oct 17, 2026");
});

// ── BUG-356: deleting the account does not stop a store subscription ─────

test("🔴 BUG-356 apple: the notice names the App Store, before confirming, with the manage action", () => {
  const n = deleteAccountNoticeFor("ios", APPLE_ACTIVE);
  assert.equal(
    n?.text,
    "Your Kiwi Premium subscription is billed by the App Store and keeps renewing until you cancel it there.",
  );
  assert.equal(n?.manage.kind, "store_link");
});

test("🔴 BUG-356 google: the notice names Google Play", () => {
  const n = deleteAccountNoticeFor("android", GOOGLE_ACTIVE);
  assert.equal(
    n?.text,
    "Your Kiwi Premium subscription is billed by Google Play and keeps renewing until you cancel it there.",
  );
  assert.equal(n?.manage.kind, "store_link");
  // Keyed on the SOURCE: an Android-bought subscription deleted from the web still says Google Play.
  assert.equal(deleteAccountNoticeFor("web", GOOGLE_ACTIVE)?.manage.kind, "store_text");
});

test("🔴 BUG-356 stripe: no extra copy — DELETE /me cancels Stripe itself", () => {
  for (const os of ["ios", "android", "web"]) {
    assert.equal(deleteAccountNoticeFor(os, STRIPE_ACTIVE), null, os);
  }
});

test("no notice for a trial, a lapsed store account, or one already set to end", () => {
  assert.equal(deleteAccountNoticeFor("ios", TRIAL), null);
  assert.equal(deleteAccountNoticeFor("ios", { ...APPLE_ACTIVE, status: "canceled" }), null);
  assert.equal(deleteAccountNoticeFor("ios", { ...APPLE_ACTIVE, cancelAtPeriodEnd: true }), null);
  assert.ok(deleteAccountNoticeFor("ios", { ...APPLE_ACTIVE, status: "past_due" }), "still renewing");
});

// ── may this build take money? ─────────────────────────────────────────────

test("🔴 the store sells only with a key AND RevenueCat on the server — never on the web", () => {
  assert.equal(storeBillingReady({ platform: "ios", keyPresent: true, sub: TRIAL }), true);
  assert.equal(storeBillingReady({ platform: "ios", keyPresent: false, sub: TRIAL }), false);
  assert.equal(
    storeBillingReady({ platform: "android", keyPresent: true, sub: sub({ storeBillingAvailable: false }) }),
    false,
  );
  const { storeBillingAvailable: _omit, ...preB1 } = TRIAL;
  assert.equal(storeBillingReady({ platform: "ios", keyPresent: true, sub: preB1 }), false, "absent reads as no");
  assert.equal(storeBillingReady({ platform: "web", keyPresent: true, sub: TRIAL }), false);
});

// CLIENT-7 A (D-WS9-356) — free during launch. SERVER-9 A sends
// `billing: { mode: "free_launch" | "enforced" }` on GET /me/subscription and on
// every user shape. In free_launch no trial, price or upgrade surface shows,
// whatever `enforced` says; the 402 still opens the paywall; a paying account
// keeps its line and its manage action; no `billing` field is exactly today.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import AsyncStorage from "@react-native-async-storage/async-storage";

import { FREE_LAUNCH_BODY, FREE_LAUNCH_TITLE, settingsMonthly } from "../copy";
import {
  BILLING_MODE_DEVICE_KEY,
  billingModeOf,
  loadRememberedBillingMode,
  preAuthFreeLaunch,
  rememberBillingMode,
} from "../mode";
import {
  bannerFor,
  isFreeLaunch,
  macrosNoticeFor,
  paysForKiwi,
  premiumRowFor,
  settingsRowFor,
  sheetCopyFor,
  sheetStateFor,
  subscribeSheetFor,
  subscriptionCardFor,
  type SubscriptionPayload,
  type SubscriptionStatus,
} from "../subscriptionView";
import { allUpsellMoments, shouldFireUpsellMoment } from "../upsellMoments";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const STATUSES: SubscriptionStatus[] = ["trialing", "active", "past_due", "none", "canceled"];
const PLATFORMS = ["ios", "android", "web"];
const FREE = { mode: "free_launch" };
const ENFORCED = { mode: "enforced" };

function sub(over: Partial<SubscriptionPayload> = {}): SubscriptionPayload {
  return {
    status: "trialing",
    planCode: "free",
    // Two days left: inside the banner's window, so a banner would show if anything let it.
    trialEndsAt: "2026-11-03T11:00:00.000Z",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    billingAvailable: true,
    enforced: true,
    hasBillingAccount: false,
    source: null,
    managementUrl: null,
    storeBillingAvailable: true,
    ...over,
  };
}

/** Every surface a status read can produce, for one payload. */
function surfaces(s: SubscriptionPayload, platform: string) {
  return {
    banner: bannerFor({ sub: s, now: NOW, dismissed: new Set() }),
    sheet: sheetStateFor(s),
    sheet402: sheetStateFor(s, { ignoreEnforcement: true }),
    subscribe: subscribeSheetFor(s),
    row: settingsRowFor(s),
    macros: macrosNoticeFor(s),
    premium: premiumRowFor(platform, s, NOW),
    card: subscriptionCardFor(platform, s, NOW, { storeReady: true }),
    upsell: allUpsellMoments().map((moment) => shouldFireUpsellMoment({ moment, sub: s, seen: new Set() })),
  };
}

/** The text a card renders (subscribeLabel is drawn only when `subscribe`). */
function cardText(card: ReturnType<typeof subscriptionCardFor>): string {
  if (card === null) return "";
  const manage = card.manage && ("label" in card.manage ? card.manage.label : card.manage.text);
  return [card.statusLine, card.freeLaunchBody, card.premium?.line, card.subscribe ? card.subscribeLabel : null, manage]
    .filter(Boolean)
    .join(" | ");
}

const FORBIDDEN = /trial|14 days|14-day|\$9\.99|\$99\.99|subscribe|upgrade/i;

test("billingModeOf / isFreeLaunch: only free_launch is free; absent, null, enforced and anything else are not", () => {
  assert.equal(billingModeOf(FREE), "free_launch");
  assert.equal(billingModeOf(ENFORCED), "enforced");
  for (const x of [undefined, null, {}, { mode: null }, { mode: "FREE_LAUNCH" }, { mode: "free" }, "free_launch", 1]) {
    assert.equal(billingModeOf(x), null, JSON.stringify(x));
    assert.equal(isFreeLaunch(sub({ billing: x })), false, JSON.stringify(x));
  }
  assert.equal(isFreeLaunch(sub({ billing: FREE })), true);
  assert.equal(isFreeLaunch(null), false);
});

test("🔴 free_launch: no banner, status sheet, Subscribe, Premium row, macros notice or upsell — every status, either enforced, every platform", () => {
  for (const status of STATUSES) {
    for (const enforced of [true, false]) {
      for (const platform of PLATFORMS) {
        const s = sub({ status, enforced, billing: FREE, planCode: status === "active" ? "monthly" : "free", currentPeriodEnd: status === "active" ? "2026-12-01T00:00:00.000Z" : null });
        const v = surfaces(s, platform);
        const at = `${status} enforced=${enforced} ${platform}`;
        assert.equal(v.banner, null, at);
        assert.equal(v.sheet, null, at);
        assert.equal(v.subscribe, null, at);
        assert.equal(v.row?.subscribe ?? false, false, at);
        assert.equal(v.macros, null, at);
        assert.equal(v.premium, null, at);
        assert.deepEqual(v.upsell, v.upsell.map(() => false), at);
        assert.equal(v.card?.subscribe, false, at);
        assert.equal(v.card?.premium, null, at);
        assert.equal(cardText(v.card).match(FORBIDDEN)?.[0] ?? null, null, `${at}: ${cardText(v.card)}`);
      }
    }
  }
});

test("free_launch: a 402 still opens the paywall, exactly as without the field", () => {
  for (const status of STATUSES) {
    for (const enforced of [true, false]) {
      const free = sheetStateFor(sub({ status, enforced, billing: FREE }), { ignoreEnforcement: true });
      const today = sheetStateFor(sub({ status, enforced }), { ignoreEnforcement: true });
      assert.equal(free, today, `${status} enforced=${enforced}`);
      assert.notEqual(free, null);
    }
  }
  assert.equal(sheetStateFor(null, { ignoreEnforcement: true }), "lapsed");
  // No trialDeniedReason in free_launch (SERVER-9 A), so a 402's sheet is the ordinary lapse.
  assert.equal(sheetCopyFor("lapsed", sub({ status: "none", billing: FREE })).title, "Your free trial has ended");
});

test("🔴 no billing field, or enforced: every surface answers exactly as before", () => {
  for (const status of STATUSES) {
    for (const enforced of [true, false]) {
      for (const platform of PLATFORMS) {
        const over = { status, enforced, planCode: status === "active" ? "annual" : "free", currentPeriodEnd: status === "active" ? "2026-12-01T00:00:00.000Z" : null };
        const today = surfaces(sub(over), platform);
        assert.deepEqual(surfaces(sub({ ...over, billing: ENFORCED }), platform), today, `${status} ${enforced} ${platform}`);
        assert.deepEqual(surfaces(sub({ ...over, billing: { mode: "something_new" } }), platform), today);
        assert.equal(today.card?.freeLaunchBody ?? null, null);
        assert.equal(today.card?.restore ?? false, false);
      }
    }
  }
  // Today's trial surfaces are still there without the field (the S2 / C2 tests walk the rest).
  assert.equal(bannerFor({ sub: sub(), now: NOW, dismissed: new Set() })?.kind, "trial_ending");
  assert.equal(premiumRowFor("ios", sub({ enforced: false }), NOW)?.line, "2 days left in your free trial");
});

test("free_launch: Profile's card reads free for an account nobody pays for, with Restore Purchases on iOS / Android", () => {
  for (const status of ["trialing", "none", "canceled"] as const) {
    for (const platform of PLATFORMS) {
      const card = subscriptionCardFor(platform, sub({ status, billing: FREE, source: status === "canceled" ? "stripe" : null }), NOW, { storeReady: true });
      assert.deepEqual(card, {
        statusLine: FREE_LAUNCH_TITLE,
        freeLaunchBody: FREE_LAUNCH_BODY,
        premium: null,
        manage: null,
        subscribe: false,
        subscribeLabel: "Subscribe",
        restore: platform !== "web",
      }, `${status} ${platform}`);
    }
  }
  assert.equal(FREE_LAUNCH_TITLE, "Kiwi is free during launch.");
  assert.equal(FREE_LAUNCH_BODY, "Every feature is included. No card, nothing to cancel.");
  // A store that cannot take a restore offers none.
  assert.equal(subscriptionCardFor("ios", sub({ billing: FREE }), NOW, { storeReady: false })?.restore, false);
  assert.equal(subscriptionCardFor("ios", sub({ billing: FREE }), NOW)?.restore, false);
});

test("free_launch: a paying account keeps its own line and its manage action — 'nothing to cancel' would be false", () => {
  const monthly = { status: "active" as const, planCode: "monthly", currentPeriodEnd: "2026-12-01T00:00:00.000Z", hasBillingAccount: true };
  const web = subscriptionCardFor("web", sub({ ...monthly, source: "stripe", billing: FREE, enforced: false }), NOW, { storeReady: true });
  assert.equal(web?.statusLine, settingsMonthly(monthly.currentPeriodEnd));
  assert.deepEqual(web?.manage, { kind: "stripe_portal", label: "Manage subscription" });
  assert.equal(web?.freeLaunchBody, null);
  assert.equal(web?.restore, false);
  const ios = subscriptionCardFor("ios", sub({ ...monthly, source: "apple", billing: FREE }), NOW, { storeReady: true });
  assert.equal(ios?.manage?.kind, "store_link");
  assert.equal(ios?.premium, null);
  // A store subscription in its introductory period is paid for too.
  const intro = sub({ status: "trialing", source: "google", billing: FREE });
  assert.equal(paysForKiwi(intro), true);
  assert.equal(subscriptionCardFor("android", intro, NOW, { storeReady: true })?.manage?.kind, "store_link");
  assert.equal(subscriptionCardFor("android", intro, NOW, { storeReady: true })?.premium, null);
  // past_due keeps its line; cancelling at period end keeps "Cancels …".
  assert.equal(subscriptionCardFor("web", sub({ status: "past_due", source: "stripe", hasBillingAccount: true, billing: FREE }), NOW)?.statusLine, "Payment problem");
  assert.match(subscriptionCardFor("web", sub({ ...monthly, source: "stripe", cancelAtPeriodEnd: true, billing: FREE }), NOW)!.statusLine, /^Cancels /);
  assert.equal(paysForKiwi(sub({ status: "trialing", source: null })), false);
});

test("Welcome / Sign-up before sign-in: free unless a server last said enforced; a fresh install is free", async () => {
  assert.equal(preAuthFreeLaunch(null), true);
  assert.equal(preAuthFreeLaunch("free_launch"), true);
  assert.equal(preAuthFreeLaunch("enforced"), false);
  const key = "kiwi:" + BILLING_MODE_DEVICE_KEY;
  await AsyncStorage.removeItem(key);
  assert.equal(await loadRememberedBillingMode(), null);
  await rememberBillingMode(ENFORCED);
  assert.equal(await loadRememberedBillingMode(), "enforced");
  // An answer with no mode (an older server) stores nothing: the last real answer stands.
  await rememberBillingMode(undefined);
  await rememberBillingMode({ mode: "weird" });
  assert.equal(await loadRememberedBillingMode(), "enforced");
  await rememberBillingMode(FREE);
  assert.equal(await loadRememberedBillingMode(), "free_launch");
  await AsyncStorage.setItem(key, "not json");
  assert.equal(await loadRememberedBillingMode(), null, "garbage reads as nothing stored");
  await AsyncStorage.removeItem(key);
});

const here = dirname(fileURLToPath(import.meta.url));
const app = (p: string) => readFileSync(resolve(here, "../../../app", p), "utf8");

test("the screens' wiring: Sign-up's free line, Profile's restore, both contexts store the mode", () => {
  const signUp = app("(auth)/sign-up.tsx");
  assert.match(signUp, /export const SIGN_UP_FREE_LINE = "Free · no card needed";/);
  assert.match(signUp, /const free = useRememberedFreeLaunch\(\);/);
  assert.match(signUp, /\{free && \(\s*<Text style=\{styles\.freeLine\} testID="sign-up-free-line">\s*\{SIGN_UP_FREE_LINE\}/);
  const profile = app("(tabs)/profile.tsx");
  assert.match(profile, /subscriptionCardFor\(Platform\.OS, subscription, new Date\(\), \{ storeReady \}\)/);
  assert.match(profile, /onRestore=\{\(\) => void restorePurchases\(\)\}/);
  const ctx = (p: string) => readFileSync(resolve(here, "../../../contexts", p), "utf8");
  assert.match(ctx("AuthContext.ts"), /rememberBillingMode\(\{ mode: billingMode \}\)/);
  assert.match(ctx("BillingContext.tsx"), /rememberBillingMode\(\{ mode: billingMode \}\)/);
  assert.match(ctx("BillingContext.tsx"), /takeTrialDenied\(\) && !isFreeLaunch\(subscriptionRef\.current\)/);
});

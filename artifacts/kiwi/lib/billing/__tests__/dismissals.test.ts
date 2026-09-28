// Row 9 (1.1) · Stripe S2 Part E — the per-device banner dismissals.
//
// The one property worth a file: `past_due` CANNOT BE DISMISSED, and it cannot be
// dismissed by two independent mechanisms — `bannerFor` never consults the set for
// it, and `dismissBanner` refuses to write it. Either alone would be enough; both
// is deliberate, because this is the banner that tells someone their card failed.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BANNER_DISMISSED_DEVICE_KEY,
  dismissBanner,
  loadDismissedBanners,
  parseDismissed,
} from "../dismissals";
import { bannerFor, type BannerKind, type SubscriptionPayload } from "../subscriptionView";

function sub(over: Partial<SubscriptionPayload> = {}): SubscriptionPayload {
  return {
    status: "past_due",
    planCode: "monthly",
    trialEndsAt: null,
    currentPeriodEnd: "2026-10-27T12:00:00.000Z",
    cancelAtPeriodEnd: false,
    billingAvailable: true,
    enforced: true,
    earlyPayBonusDays: 14,
    firstChargeDateIfSubscribedNow: null,
    ...over,
  };
}

test("the two offer banners are dismissible and round-trip through storage", async () => {
  let set: ReadonlySet<BannerKind> = new Set();
  set = await dismissBanner("trial_ending", set);
  assert.deepEqual([...set], ["trial_ending"]);
  set = await dismissBanner("lapsed", set);
  assert.deepEqual([...set].sort(), ["lapsed", "trial_ending"]);
  // What was written is what comes back.
  assert.deepEqual(await loadDismissedBanners(), new Set(["lapsed", "trial_ending"]));
});

test("🔴 dismissBanner REFUSES past_due — the write never happens", async () => {
  const before = await loadDismissedBanners();
  const after = await dismissBanner("past_due", before);
  assert.equal(after.has("past_due"), false);
  // And storage is unchanged: a refused dismissal must not persist as one.
  assert.equal((await loadDismissedBanners()).has("past_due"), false);
});

test("🔴 and even a hand-written storage key cannot silence past_due", async () => {
  // Belt and braces. parseDismissed drops it on the way IN, and bannerFor does not
  // consult the set for past_due on the way OUT — so all three of a forged key, a
  // forged in-memory set and a future bug in one of the two still leave the banner.
  assert.deepEqual(parseDismissed(["past_due"]), new Set());
  const forged = new Set<BannerKind>(["past_due"]);
  const b = bannerFor({ sub: sub({ status: "past_due" }), now: new Date(), dismissed: forged });
  assert.ok(b, "a failed payment stays on screen");
  assert.equal(b.kind, "past_due");
  assert.equal(b.dismissible, false);
});

test("every malformed stored shape reads as nothing dismissed", () => {
  for (const raw of [null, undefined, 0, "", "lapsed", {}, true]) {
    assert.deepEqual(parseDismissed(raw), new Set(), JSON.stringify(raw ?? null));
  }
  // Unknown kinds are dropped rather than carried into a typed set.
  assert.deepEqual(
    parseDismissed(["lapsed", "some_future_banner", 3, null]),
    new Set(["lapsed"]),
  );
});

test("dismissBanner does not mutate the set it was given", async () => {
  const before: ReadonlySet<BannerKind> = new Set(["lapsed"]);
  const after = await dismissBanner("trial_ending", before);
  assert.deepEqual([...before], ["lapsed"]);
  assert.equal(after.size, 2);
});

test("the device key is the BARE key — lib/storage.ts owns the prefix", () => {
  assert.equal(BANNER_DISMISSED_DEVICE_KEY, "billingBannersDismissed");
  assert.ok(!BANNER_DISMISSED_DEVICE_KEY.startsWith("kiwi:"));
});

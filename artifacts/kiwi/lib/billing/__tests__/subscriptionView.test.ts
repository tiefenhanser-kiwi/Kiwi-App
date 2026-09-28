// Row 9 (1.1) · Stripe S2 Part B — the decision table, walked rather than sampled.
//
// The three properties worth more than any individual assertion below, each
// proved over the WHOLE product of inputs instead of at a chosen point:
//
//   1. `enforced: false` blacks out every billing surface but the Settings row.
//      Deliberate break (1) removes that line from bannerFor and this goes red.
//   2. The banner window is 1..4 days INCLUSIVE, and both edges are asserted
//      from the same helper the product uses.
//   3. The pay-early line is absent at bonus 0 — a value Hans can set, not a
//      defensive case.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NOTICE_FIND_SIMILAR,
  NOTICE_GROCERY_STALE,
  NOTICE_MACROS,
  SETTINGS_ACTIVE_NO_DATE,
  SETTINGS_MANAGE,
  SETTINGS_PAST_DUE,
  SETTINGS_SUBSCRIBE,
  SETTINGS_TRIAL_ENDED,
  SETTINGS_TRIAL_NO_DATE,
} from "../copy";
import {
  TRIAL_BANNER_DAYS,
  bannerFor,
  canManageBilling,
  findSimilarNotice,
  groceryStaleNotice,
  macrosNoticeFor,
  payEarlyLine,
  settingsRowFor,
  sheetStateFor,
  trialDaysLeft,
  type BannerKind,
  type SubscriptionPayload,
  type SubscriptionStatus,
} from "../subscriptionView";

const NOW = new Date("2026-09-27T12:00:00.000Z");
const ALL_STATUSES: SubscriptionStatus[] = [
  "trialing",
  "active",
  "past_due",
  "none",
  "canceled",
];
const NONE_DISMISSED: ReadonlySet<BannerKind> = new Set();

/** `enforced` and `billingAvailable` both ON — the post-cutover deploy. */
function sub(over: Partial<SubscriptionPayload> = {}): SubscriptionPayload {
  return {
    status: "trialing",
    planCode: "free",
    trialEndsAt: "2026-10-11T12:00:00.000Z",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    billingAvailable: true,
    enforced: true,
    earlyPayBonusDays: 14,
    firstChargeDateIfSubscribedNow: "2026-10-25T12:00:00.000Z",
    ...over,
  };
}

/** A trial ending exactly `days` from NOW. */
function trialEndingIn(days: number): string {
  return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

// ── 1. the blackout ─────────────────────────────────────────────────────

test("🔴 enforced:false blacks out the banner for EVERY status — the state 1.1 ships in", () => {
  for (const status of ALL_STATUSES) {
    for (const days of [0.5, 1, 3, 4, 20]) {
      const s = sub({ status, enforced: false, trialEndsAt: trialEndingIn(days) });
      assert.equal(
        bannerFor({ sub: s, now: NOW, dismissed: NONE_DISMISSED }),
        null,
        `${status} @ ${days}d`,
      );
    }
  }
});

test("🔴 enforced:false blacks out the sheet for every status too", () => {
  for (const status of ALL_STATUSES) {
    assert.equal(sheetStateFor(sub({ status, enforced: false })), null, status);
  }
});

test("enforced:false still shows the Settings row when Stripe is configured — the one exception", () => {
  const row = settingsRowFor(sub({ enforced: false, billingAvailable: true }));
  assert.ok(row, "the row is the carve-out from the blackout");
  assert.equal(row.statusLine, "Free trial · ends Oct 11, 2026");
});

test("no Stripe AND no enforcement hides the Settings row entirely — nothing to say yet", () => {
  for (const status of ALL_STATUSES) {
    assert.equal(
      settingsRowFor(sub({ status, enforced: false, billingAvailable: false })),
      null,
      status,
    );
  }
});

test("a null payload (the request has not answered) renders nothing anywhere", () => {
  assert.equal(bannerFor({ sub: null, now: NOW, dismissed: NONE_DISMISSED }), null);
  assert.equal(sheetStateFor(null), null);
  assert.equal(settingsRowFor(null), null);
  assert.equal(payEarlyLine(null), null);
});

// ── 2. the trial clock and the banner window ───────────────────────────

test("trialDaysLeft rounds UP, so the last partial day reads as a whole one", () => {
  assert.equal(trialDaysLeft({ trialEndsAt: trialEndingIn(0.1) }, NOW), 1);
  assert.equal(trialDaysLeft({ trialEndsAt: trialEndingIn(1) }, NOW), 1);
  assert.equal(trialDaysLeft({ trialEndsAt: trialEndingIn(3.4) }, NOW), 4);
  assert.equal(trialDaysLeft({ trialEndsAt: trialEndingIn(13.5) }, NOW), 14);
});

test("⚠️ a NULL trialEndsAt is the unbounded trial — no number, and no banner", () => {
  // effectiveStatus keeps such a row `trialing` (the server's open finding). A
  // trial with no end cannot have "3 days left"; inventing one is the only thing
  // worse than silence.
  assert.equal(trialDaysLeft({ trialEndsAt: null }, NOW), null);
  assert.equal(
    bannerFor({
      sub: sub({ status: "trialing", trialEndsAt: null }),
      now: NOW,
      dismissed: NONE_DISMISSED,
    }),
    null,
  );
});

test("an unparseable date is null, not NaN days", () => {
  assert.equal(trialDaysLeft({ trialEndsAt: "not-a-date" }, NOW), null);
});

test("the banner window is 1..4 days INCLUSIVE — both edges, off both edges", () => {
  const at = (days: number) =>
    bannerFor({
      sub: sub({ status: "trialing", trialEndsAt: trialEndingIn(days) }),
      now: NOW,
      dismissed: NONE_DISMISSED,
    });
  assert.equal(at(0.5)?.kind, "trial_ending", "the last few hours still counts as 1 day");
  assert.equal(at(1)?.kind, "trial_ending");
  assert.equal(at(TRIAL_BANNER_DAYS)?.kind, "trial_ending", "4 days is inside");
  assert.equal(at(4.5), null, "5 days up is too early");
  assert.equal(at(10), null);
  // Already past: the server will report `none` on the next read, and the client
  // does not second-guess the status it was given.
  assert.equal(at(-1), null);
});

test("the trial banner carries the days-left number and the bonus, from copy.ts", () => {
  const b = bannerFor({
    sub: sub({ status: "trialing", trialEndsAt: trialEndingIn(3), earlyPayBonusDays: 14 }),
    now: NOW,
    dismissed: NONE_DISMISSED,
  });
  assert.equal(
    b?.text,
    "3 days left in your trial — subscribe now and get 14 extra days free.",
  );
  assert.equal(b?.ctaLabel, "Subscribe");
  assert.equal(b?.dismissible, true);
});

// ── 3. banner choice per status ────────────────────────────────────────

test("every status maps to exactly one banner (or none) — a mapping, not a priority list", () => {
  const kindFor = (status: SubscriptionStatus) =>
    bannerFor({
      sub: sub({ status, trialEndsAt: trialEndingIn(2) }),
      now: NOW,
      dismissed: NONE_DISMISSED,
    })?.kind ?? null;
  assert.equal(kindFor("trialing"), "trial_ending");
  assert.equal(kindFor("active"), null);
  assert.equal(kindFor("past_due"), "past_due");
  assert.equal(kindFor("none"), "lapsed");
  assert.equal(kindFor("canceled"), "lapsed");
});

test("past_due is the ONE non-dismissible banner, and ignores the dismissed set", () => {
  const dismissed = new Set<BannerKind>(["past_due", "lapsed", "trial_ending"]);
  const b = bannerFor({ sub: sub({ status: "past_due" }), now: NOW, dismissed });
  assert.ok(b, "a dismissal cannot silence a failed payment");
  assert.equal(b.kind, "past_due");
  assert.equal(b.dismissible, false);
  assert.equal(b.ctaLabel, "Manage payment");
  // The other two ARE silenced by the same set.
  assert.equal(bannerFor({ sub: sub({ status: "none" }), now: NOW, dismissed }), null);
  assert.equal(
    bannerFor({
      sub: sub({ status: "trialing", trialEndsAt: trialEndingIn(2) }),
      now: NOW,
      dismissed,
    }),
    null,
  );
});

test("a dismissal is per-KIND: dismissing the trial offer does not hide the lapsed one", () => {
  const dismissed = new Set<BannerKind>(["trial_ending"]);
  assert.equal(
    bannerFor({ sub: sub({ status: "none" }), now: NOW, dismissed })?.kind,
    "lapsed",
  );
});

// ── 4. the sheet ───────────────────────────────────────────────────────

test("sheet state: trialing → the upsell, lapsed → the paywall, paying → nothing", () => {
  assert.equal(sheetStateFor(sub({ status: "trialing" })), "trialing");
  assert.equal(sheetStateFor(sub({ status: "none" })), "lapsed");
  assert.equal(sheetStateFor(sub({ status: "canceled" })), "lapsed");
  assert.equal(sheetStateFor(sub({ status: "active" })), null);
  assert.equal(sheetStateFor(sub({ status: "past_due" })), null, "past_due is a banner, not a sheet");
});

test("🔴 a 402 opens the sheet even under the blackout — the server is the authority (§2.7)", () => {
  const opts = { ignoreEnforcement: true };
  // The unenforced deploy: a 402 cannot occur, but if one arrives it is told.
  assert.equal(sheetStateFor(sub({ status: "trialing", enforced: false }), opts), "trialing");
  assert.equal(sheetStateFor(sub({ status: "none", enforced: false }), opts), "lapsed");
  // A refusal with no payload at all is still a refusal to explain.
  assert.equal(sheetStateFor(null, opts), "lapsed");
  // And a 402 for an account OUR snapshot calls entitled means our snapshot is
  // stale, not that the server is wrong.
  assert.equal(sheetStateFor(sub({ status: "active" }), opts), "lapsed");
  assert.equal(sheetStateFor(sub({ status: "past_due" }), opts), "lapsed");
});

// ── 5. the pay-early line ──────────────────────────────────────────────

test("the pay-early line names the first-charge date and the bonus", () => {
  assert.equal(
    payEarlyLine(sub({ status: "trialing", earlyPayBonusDays: 14 })),
    "Subscribe now and your first charge is Oct 25, 2026 — the rest of your trial plus 14 more days free.",
  );
});

test("🔴 bonus 0 HIDES the line — not 'plus 0 more days free'", () => {
  assert.equal(payEarlyLine(sub({ status: "trialing", earlyPayBonusDays: 0 })), null);
  // And a negative, which no config should produce but which must not render.
  assert.equal(payEarlyLine(sub({ status: "trialing", earlyPayBonusDays: -3 })), null);
});

test("the line is trialing-only, and needs the server's date", () => {
  for (const status of ALL_STATUSES.filter((s) => s !== "trialing")) {
    assert.equal(payEarlyLine(sub({ status })), null, status);
  }
  assert.equal(
    payEarlyLine(sub({ status: "trialing", firstChargeDateIfSubscribedNow: null })),
    null,
  );
});

// ── 6. the Settings row ────────────────────────────────────────────────

test("the status line, per status", () => {
  const line = (over: Partial<SubscriptionPayload>) => settingsRowFor(sub(over))?.statusLine;
  assert.equal(line({ status: "trialing" }), "Free trial · ends Oct 11, 2026");
  assert.equal(
    line({ status: "active", planCode: "monthly", currentPeriodEnd: "2026-10-27T12:00:00.000Z" }),
    "Kiwi Monthly · renews Oct 27, 2026",
  );
  assert.equal(
    line({ status: "active", planCode: "annual", currentPeriodEnd: "2027-09-27T12:00:00.000Z" }),
    "Kiwi Annual · renews Sep 27, 2027",
  );
  assert.equal(line({ status: "past_due" }), SETTINGS_PAST_DUE);
  assert.equal(line({ status: "none" }), SETTINGS_TRIAL_ENDED);
  assert.equal(line({ status: "canceled" }), SETTINGS_TRIAL_ENDED);
});

test("cancelAtPeriodEnd outranks the plan line — same date, opposite facts", () => {
  assert.equal(
    settingsRowFor(
      sub({
        status: "active",
        planCode: "monthly",
        currentPeriodEnd: "2026-11-01T12:00:00.000Z",
        cancelAtPeriodEnd: true,
      }),
    )?.statusLine,
    "Cancels Nov 1, 2026",
  );
});

test("a missing date never renders 'ends undefined'", () => {
  assert.equal(
    settingsRowFor(sub({ status: "trialing", trialEndsAt: null }))?.statusLine,
    SETTINGS_TRIAL_NO_DATE,
  );
  // active read before the first customer.subscription.updated webhook.
  assert.equal(
    settingsRowFor(sub({ status: "active", planCode: "monthly", currentPeriodEnd: null }))
      ?.statusLine,
    SETTINGS_ACTIVE_NO_DATE,
  );
  // cancelAtPeriodEnd with no date falls through rather than saying "Cancels undefined".
  assert.equal(
    settingsRowFor(
      sub({ status: "active", planCode: "annual", currentPeriodEnd: null, cancelAtPeriodEnd: true }),
    )?.statusLine,
    SETTINGS_ACTIVE_NO_DATE,
  );
  // An unrecognised planCode (including the `free` default) gets the agnostic line.
  assert.equal(
    settingsRowFor(
      sub({ status: "active", planCode: "free", currentPeriodEnd: "2026-10-27T12:00:00.000Z" }),
    )?.statusLine,
    SETTINGS_ACTIVE_NO_DATE,
  );
});

test("Subscribe shows while unsubscribed; Manage shows when a billing account exists", () => {
  const row = (over: Partial<SubscriptionPayload>) => settingsRowFor(sub(over));
  assert.equal(row({ status: "trialing" })?.subscribe, true);
  assert.equal(row({ status: "none" })?.subscribe, true);
  assert.equal(row({ status: "canceled" })?.subscribe, true);
  assert.equal(row({ status: "active" })?.subscribe, false);
  assert.equal(row({ status: "past_due" })?.subscribe, false);
  assert.equal(row({ status: "active" })?.manage, true);
  assert.equal(row({ status: "past_due" })?.manage, true);
  // A trial that has never paid has no portal to open.
  assert.equal(row({ status: "trialing" })?.manage, false);
  assert.equal(row({ status: "trialing" })?.subscribeLabel, SETTINGS_SUBSCRIBE);
  assert.equal(row({ status: "active" })?.manageLabel, SETTINGS_MANAGE);
});

test("🔴 no Stripe configured renders NO BUTTON — a button whose only outcome is a 503", () => {
  for (const status of ALL_STATUSES) {
    // enforced true keeps the row visible; billingAvailable false silences both buttons.
    const row = settingsRowFor(sub({ status, billingAvailable: false, enforced: true }));
    assert.ok(row, status);
    assert.equal(row.subscribe, false, status);
    assert.equal(row.manage, false, status);
    assert.ok(row.statusLine.length > 0, status);
  }
});

test("hasBillingAccount, when the server sends it, beats the status inference", () => {
  // The case the inference gets wrong in each direction.
  assert.equal(canManageBilling(sub({ status: "active", hasBillingAccount: false })), false);
  assert.equal(canManageBilling(sub({ status: "trialing", hasBillingAccount: true })), true);
  // Absent → the documented fallback.
  assert.equal(canManageBilling(sub({ status: "canceled" })), true);
  assert.equal(canManageBilling(sub({ status: "none" })), false);
});

// ── 7. the notices ────────────────────────────────────────────────────

test("🔴 the grocery notice fires for the ENTITLEMENT skip and for nothing else", () => {
  assert.equal(groceryStaleNotice("subscription_required"), NOTICE_GROCERY_STALE);
  // A reconcile that FAILED leaves the same stale list and is NOT the user's to
  // fix. Deliberate break (5) makes the server send "error" here.
  assert.equal(groceryStaleNotice("error"), null);
  assert.equal(groceryStaleNotice(undefined), null, "a reconcile that ran carries nothing");
  assert.equal(groceryStaleNotice(null), null);
  assert.equal(groceryStaleNotice(""), null);
  assert.equal(groceryStaleNotice("Subscription_Required"), null, "exact value, not a fuzzy match");
});

test("the find-similar notice fires only for the entitlement skip", () => {
  assert.equal(findSimilarNotice("subscription_required"), NOTICE_FIND_SIMILAR);
  assert.equal(findSimilarNotice(undefined), null);
  assert.equal(findSimilarNotice("error"), null);
});

test("all three notices end with the same upgrade sentence, written out three times", () => {
  for (const n of [NOTICE_GROCERY_STALE, NOTICE_MACROS, NOTICE_FIND_SIMILAR]) {
    assert.ok(
      n.endsWith("Upgrade to get unlimited access to all features."),
      n,
    );
  }
});

// ── 8. the macros notice (§2.6), the one with no response field ──────────
//
// 🔴 IT IS DERIVED FROM THE STATUS, AND THAT IS A DEPARTURE WORTH PINNING. The
// other two notices answer "did THIS response's work get skipped?", which a server
// field can say. This one answers a question about a FIGURE ALREADY ON SCREEN — a
// plan's daily averages, a meal's macro strip — rendered from stored columns with
// no request behind them to carry a flag. `macrosSkipped` covers the SAVE moment;
// it cannot cover a screen opened a week later.
//
// So it claims the narrower thing: not "this figure is wrong" but "a refresh of it
// is a premium feature". A wrong answer is a redundant sentence, never a lie, and
// the stored figures stay on screen either way.

test("the macros notice appears for a LAPSED account and for nothing else", () => {
  assert.equal(macrosNoticeFor(sub({ status: "none" })), NOTICE_MACROS);
  assert.equal(macrosNoticeFor(sub({ status: "canceled" })), NOTICE_MACROS);
  // The three statuses the SERVER's isEntitled allows to spend
  // (ENTITLED_STATUSES in api-server/src/lib/subscriptionService.ts). A refresh
  // would succeed for these, so there is nothing to explain.
  assert.equal(macrosNoticeFor(sub({ status: "trialing" })), null);
  assert.equal(macrosNoticeFor(sub({ status: "active" })), null);
  assert.equal(
    macrosNoticeFor(sub({ status: "past_due" })),
    null,
    "past_due still spends — the server's set says so",
  );
});

test("🔴 the macros notice is blacked out with everything else while enforced is false", () => {
  for (const status of ALL_STATUSES) {
    assert.equal(macrosNoticeFor(sub({ status, enforced: false })), null, status);
  }
});

test("no payload means no notice — not a notice over a loading screen", () => {
  assert.equal(macrosNoticeFor(null), null);
});

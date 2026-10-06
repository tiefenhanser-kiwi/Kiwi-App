// Row 9 (1.1) · Stripe S2 Part B — the copy, pinned where a ruling produced it.
//
// This file does not re-assert every string (the copy table in the report is that
// list, and a test that restates a constant proves only that assignment works).
// It pins the THREE things about the copy that are decisions rather than words:
//
//   1. the six benefits' relationship to the Test Kitchen door sheet — five
//      quoted, one pluralised — so an edit to either list surfaces as a failure
//      rather than as drift;
//   2. the two lines that carry a number or a date are FUNCTIONS, and their
//      output reads correctly with the real values;
//   3. no billing string promises a price the sheet does not also show, which is
//      the mistake D-WS9-258 removed from this app once already.

import assert from "node:assert/strict";
import { test } from "node:test";

import { DOOR_UNLOCKS } from "@/lib/guest/doors";

import {
  BANNER_LAPSED,
  BANNER_PAST_DUE,
  CANCELLED_BODY,
  RETURN_BODY,
  SHEET_BENEFITS,
  SHEET_LAPSED_BODY,
  SHEET_LAPSED_TITLE,
  SHEET_PRICE_ANNUAL,
  SHEET_PRICE_MONTHLY,
  SHEET_SECONDARY,
  SHEET_TRIALING_TITLE,
  bannerTrialEnding,
  settingsCancels,
  settingsMonthly,
  settingsTrialing,
} from "../copy";

// ── 1. the benefits, against the door sheet they came from ─────────────

test("🔴 five of the six benefits are BYTE-IDENTICAL to the Test Kitchen door sheet", () => {
  assert.equal(SHEET_BENEFITS.length, 6);
  assert.equal(DOOR_UNLOCKS.length, 6);
  // Lines 2..6 are quoted exactly. If either list is edited, this fails, and the
  // failure is the question "did you mean to change both?".
  assert.deepEqual(SHEET_BENEFITS.slice(1), DOOR_UNLOCKS.slice(1));
});

test("the ONE that differs is the first, and it differs only by having a referent", () => {
  // The door says "this plan" to a visitor looking at one. This sheet opens from
  // Home, from a 402 and from three upsell moments, where "this plan" points at
  // nothing.
  assert.equal(DOOR_UNLOCKS[0], "Save, edit and re-use this plan");
  assert.equal(SHEET_BENEFITS[0], "Save, edit and re-use your plans");
  assert.notEqual(SHEET_BENEFITS[0], DOOR_UNLOCKS[0]);
});

// ── 2. the composed lines ──────────────────────────────────────────────

// Resub C2 — the pay-early bonus is gone (Hans, October 4), and with it the
// pay-early line and the banner's "get N extra days free" clause, which would
// have printed "get 0 extra days free".

test("the trial banner reads as a sentence with the real value in it — and no bonus", () => {
  assert.equal(
    bannerTrialEnding(2),
    "2 days left in your trial — subscribe to keep planning with Kiwi.",
  );
  assert.equal(
    bannerTrialEnding(1),
    "1 day left in your trial — subscribe to keep planning with Kiwi.",
  );
  assert.doesNotMatch(bannerTrialEnding(3), /extra days|free\./);
});

test("no composed line can emit a raw ISO timestamp or an 'undefined'", () => {
  // Was the pay-early line (removed in C2); these are the lines that still carry a date.
  for (const line of [
    settingsTrialing("2026-10-25T12:00:00.000Z"),
    settingsMonthly("2026-10-25T12:00:00.000Z"),
    settingsCancels("2026-10-25T12:00:00.000Z"),
  ]) {
    assert.ok(!line.includes("T12:00:00"), line);
    assert.ok(!line.includes("undefined"), line);
  }
});

// ── 3. the price appears where the ruling put it, and nowhere else ─────

test("the two price buttons carry the ruled prices", () => {
  assert.equal(SHEET_PRICE_MONTHLY, "$9.99 / month");
  assert.equal(SHEET_PRICE_ANNUAL, "$99.99 / year — 2 months free");
});

test("no banner, notice or return page names a price — the sheet is where money is discussed", () => {
  for (const s of [BANNER_LAPSED, BANNER_PAST_DUE, RETURN_BODY, CANCELLED_BODY]) {
    assert.ok(!s.includes("$"), s);
  }
});

test("the sheet never traps: both states carry the same secondary way out", () => {
  // "the sheet never traps — read-only is a ruling" (§2.2). The secondary exists
  // for BOTH states, which is what makes the paywall dismissible.
  assert.equal(SHEET_SECONDARY, "Not now");
  assert.ok(SHEET_TRIALING_TITLE.length > 0);
  assert.ok(SHEET_LAPSED_TITLE.length > 0);
  assert.ok(SHEET_LAPSED_BODY.includes("still here"), SHEET_LAPSED_BODY);
});

test("the lapsed copy says the data is SAFE — the read-only ruling, in words", () => {
  // D-WS9-270 §4: the post-trial state is read-only, not locked. Both the sheet
  // body and the Home banner have to say so, because a user who thinks their
  // recipes are gone does not come back to read the paywall again.
  assert.ok(SHEET_LAPSED_BODY.includes("Everything you saved is still here."));
  assert.ok(BANNER_LAPSED.includes("saved"));
});

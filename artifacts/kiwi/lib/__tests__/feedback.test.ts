// LIFE-1 — Profile's "Send feedback" and "Rate Kiwi" helpers.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ANDROID_PACKAGE,
  FEEDBACK_MAX_CHARS,
  IOS_APP_STORE_ID,
  canSendFeedback,
  feedbackErrorText,
  feedbackPlatform,
  storeReviewUrl,
  storeWebUrl,
} from "../feedback";

test("🔴 Rate Kiwi is hidden on web", () => {
  assert.equal(storeReviewUrl("web"), null);
  assert.equal(storeWebUrl("web"), null);
});

test("Rate Kiwi on Android opens the Play listing, with an https fallback", () => {
  assert.equal(ANDROID_PACKAGE, "com.kitchenwizard.kiwi");
  assert.equal(storeReviewUrl("android"), "market://details?id=com.kitchenwizard.kiwi");
  assert.equal(storeWebUrl("android"), "https://play.google.com/store/apps/details?id=com.kitchenwizard.kiwi");
});

test("Rate Kiwi on iOS is hidden until the App Store id is filled in, then opens the review sheet", () => {
  assert.equal(storeReviewUrl("ios", ""), null);
  assert.equal(storeReviewUrl("ios", "1234567890"), "itms-apps://apps.apple.com/app/id1234567890?action=write-review");
  assert.equal(storeWebUrl("ios", "1234567890"), "https://apps.apple.com/app/id1234567890");
});

test("FIX-7 — Kiwi's own App Store id is filled in, so the iOS row shows", () => {
  assert.equal(IOS_APP_STORE_ID, "6816201328");
  assert.equal(storeReviewUrl("ios"), "itms-apps://apps.apple.com/app/id6816201328?action=write-review");
  assert.equal(storeWebUrl("ios"), "https://apps.apple.com/app/id6816201328");
});

test("Send is enabled for 1..4000 non-blank characters", () => {
  assert.equal(canSendFeedback(""), false);
  assert.equal(canSendFeedback("   \n "), false);
  assert.equal(canSendFeedback("hi"), true);
  assert.equal(canSendFeedback("x".repeat(FEEDBACK_MAX_CHARS)), true);
  assert.equal(canSendFeedback("x".repeat(FEEDBACK_MAX_CHARS + 1)), false);
});

test("the platform sent is one the server accepts, or nothing", () => {
  assert.equal(feedbackPlatform("android"), "android");
  assert.equal(feedbackPlatform("web"), "web");
  assert.equal(feedbackPlatform("windows"), undefined);
});

test("each failure says something different and useful", () => {
  const texts = new Set([429, 503, null, 500].map((s) => feedbackErrorText(s)));
  assert.equal(texts.size, 4);
  assert.match(feedbackErrorText(503), /support@kitchenwizard\.ai/);
});

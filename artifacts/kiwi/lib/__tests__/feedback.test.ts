// LIFE-1 — Profile's "Send feedback" and "Rate Kiwi" helpers.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ANDROID_PACKAGE,
  FEEDBACK_DEVICE_MAX_CHARS,
  FEEDBACK_MAX_CHARS,
  FEEDBACK_MESSAGE_MAX_CHARS,
  IOS_APP_STORE_ID,
  canSendFeedback,
  feedbackErrorText,
  feedbackPlatform,
  osLine,
  storeReviewUrl,
  storeWebUrl,
  withDeviceLines,
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

// SEC-3 E — the member's share is 4000 less the device lines' room.
test("Send is enabled for 1..3700 non-blank characters", () => {
  assert.equal(FEEDBACK_MESSAGE_MAX_CHARS, FEEDBACK_MAX_CHARS - FEEDBACK_DEVICE_MAX_CHARS);
  assert.equal(FEEDBACK_MESSAGE_MAX_CHARS, 3700);
  assert.equal(canSendFeedback(""), false);
  assert.equal(canSendFeedback("   \n "), false);
  assert.equal(canSendFeedback("hi"), true);
  assert.equal(canSendFeedback("x".repeat(FEEDBACK_MESSAGE_MAX_CHARS)), true);
  assert.equal(canSendFeedback("x".repeat(FEEDBACK_MESSAGE_MAX_CHARS + 1)), false);
});

// ── SEC-3 E — the version line rides along, untyped ─────────────────────────
test("the OS line names the platform and its version", () => {
  assert.equal(osLine({ os: "android", version: 34, release: "14" }), "Android 14 (API 34)");
  assert.equal(osLine({ os: "android", version: null, release: null }), "Android unknown");
  assert.equal(osLine({ os: "ios", version: "17.4" }), "iOS 17.4");
  assert.equal(osLine({ os: "web", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }), "web · Mozilla/5.0 (X11; Linux x86_64)");
  assert.equal(osLine({ os: "web", userAgent: null }), "web");
});

test("the message carries Profile's footer line and the OS line under a rule", () => {
  const sent = withDeviceLines("The list is wrong", "Version 1.1.0 · runtime 1.1.0 · update 0193b2c4", "Android 14 (API 34)");
  assert.equal(sent, "The list is wrong\n\n—\nVersion 1.1.0 · runtime 1.1.0 · update 0193b2c4\nAndroid 14 (API 34)");
});

test("🔴 a full message plus a long user agent still fits the server's 4000", () => {
  const sent = withDeviceLines("x".repeat(FEEDBACK_MESSAGE_MAX_CHARS), "Version 1.1.0 · web", `web · ${"U".repeat(1000)}`);
  assert.ok(sent.length <= FEEDBACK_MAX_CHARS, `length ${sent.length}`);
  assert.ok(sent.endsWith("…"), "the long line is cut, visibly");
  assert.ok(sent.includes("\n—\nVersion 1.1.0 · web\n"), "the version line survives the cut");
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

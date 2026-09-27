// Row 13 "Test Kitchen" · Block 2 Part B (R12) — the Turnstile gate's decision.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  turnstileEnabled,
  turnstileRequestFields,
  turnstileSiteKey,
} from "../turnstile";

test("no key → disabled, and the request carries NO turnstileToken field", () => {
  const env = {};
  assert.equal(turnstileSiteKey(env), null);
  assert.equal(turnstileEnabled(env), false);
  assert.deepEqual(turnstileRequestFields(null, env), {});
  // 🔴 Even holding a token: while the key is unset the server's check passes
  // through, and sending a field nobody asked for is a field it may later reject.
  assert.deepEqual(turnstileRequestFields("stale-token", env), {});
});

test("a whitespace-only key is not a key", () => {
  assert.equal(turnstileSiteKey({ EXPO_PUBLIC_TURNSTILE_SITE_KEY: "   " }), null);
  assert.equal(turnstileEnabled({ EXPO_PUBLIC_TURNSTILE_SITE_KEY: "" }), false);
});

test("a key set → enabled, and a solved token rides the body", () => {
  const env = { EXPO_PUBLIC_TURNSTILE_SITE_KEY: "0xSITEKEY" };
  assert.equal(turnstileSiteKey(env), "0xSITEKEY");
  assert.equal(turnstileEnabled(env), true);
  assert.deepEqual(turnstileRequestFields("solved", env), { turnstileToken: "solved" });
});

test("a key set but nothing solved yet sends nothing — never an empty string", () => {
  const env = { EXPO_PUBLIC_TURNSTILE_SITE_KEY: "0xSITEKEY" };
  assert.deepEqual(turnstileRequestFields(null, env), {});
});

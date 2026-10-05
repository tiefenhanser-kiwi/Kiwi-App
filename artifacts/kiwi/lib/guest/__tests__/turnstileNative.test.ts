// Resub C1 — the native Turnstile gate's decisions (lib/guest/turnstile.ts),
// and the env read that made the site key invisible to every build.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  parseTurnstileMessage,
  turnstileAllowsNavigation,
  turnstileEnabled,
  turnstileGateReducer,
  turnstileHtml,
  turnstileSiteKey,
  TURNSTILE_NATIVE_BASE_URL,
  TURNSTILE_NATIVE_TIMEOUT_MS,
} from "../turnstile";

const KEY = "EXPO_PUBLIC_TURNSTILE_SITE_KEY";
const realKey = process.env[KEY];

afterEach(() => {
  if (realKey === undefined) delete process.env[KEY];
  else process.env[KEY] = realKey;
});

// ── the env read ─────────────────────────────────────────────────────────

test("🔴 the site key is read as a LITERAL process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY", () => {
  // babel-preset-expo inlines only that exact member expression. An alias
  // (`env = process.env; env.KEY`) is left as a runtime read of a process.env
  // with no EXPO_PUBLIC_ values in it — the key reads as unset in every build.
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "turnstile.ts"),
    "utf8",
  );
  assert.match(src, /process\.env\.EXPO_PUBLIC_TURNSTILE_SITE_KEY/);
  assert.doesNotMatch(src, /=\s*process\.env\s*[,)]/, "no `env = process.env` default left");
});

test("the default env is read at call time", () => {
  process.env[KEY] = "0xLIVE";
  assert.equal(turnstileSiteKey(), "0xLIVE");
  assert.equal(turnstileEnabled(), true);
  delete process.env[KEY];
  assert.equal(turnstileSiteKey(), null);
  assert.equal(turnstileEnabled(), false);
});

// ── the page ─────────────────────────────────────────────────────────────

test("the page loads Cloudflare's api.js and renders with the site key", () => {
  const html = turnstileHtml("0xSITEKEY");
  assert.ok(html.includes("https://challenges.cloudflare.com/turnstile/v0/api.js"));
  assert.ok(html.includes('sitekey: "0xSITEKEY"'));
  // All three callbacks post back through the bridge, in the agreed shape.
  assert.ok(html.includes("window.ReactNativeWebView.postMessage"));
  assert.ok(html.includes('type: "turnstile", token: token'));
  assert.ok(html.includes('type: "error"'));
  assert.ok(html.includes('type: "expired"'));
  // The callbacks exist before the script that calls them.
  assert.ok(html.indexOf("kiwiTurnstileLoad = function") < html.indexOf("api.js"));
});

test("a key cannot break out of the script it is embedded in", () => {
  const html = turnstileHtml("</script><script>alert(1)</script>");
  assert.ok(!html.includes("</script><script>alert(1)"));
});

test("the base URL is an https origin and the timeout is 20 s", () => {
  assert.match(TURNSTILE_NATIVE_BASE_URL, /^https:\/\/[^/]+\/$/);
  assert.equal(TURNSTILE_NATIVE_TIMEOUT_MS, 20_000);
});

// ── the messages ─────────────────────────────────────────────────────────

test("the three page messages parse; anything else is ignored", () => {
  assert.deepEqual(parseTurnstileMessage(JSON.stringify({ type: "turnstile", token: "t" })), {
    type: "turnstile",
    token: "t",
  });
  assert.deepEqual(parseTurnstileMessage('{"type":"error"}'), { type: "error" });
  assert.deepEqual(parseTurnstileMessage('{"type":"expired"}'), { type: "expired" });
  assert.equal(parseTurnstileMessage('{"type":"turnstile","token":""}'), null);
  assert.equal(parseTurnstileMessage('{"type":"turnstile"}'), null);
  assert.equal(parseTurnstileMessage('{"type":"other"}'), null);
  assert.equal(parseTurnstileMessage("not json"), null);
  assert.equal(parseTurnstileMessage(42), null);
});

// ── the state machine ────────────────────────────────────────────────────

test("a token solves; a timeout or an error while waiting fails; retry waits again", () => {
  assert.equal(turnstileGateReducer("waiting", { type: "turnstile", token: "t" }), "solved");
  assert.equal(turnstileGateReducer("waiting", { type: "timeout" }), "failed");
  assert.equal(turnstileGateReducer("waiting", { type: "error" }), "failed");
  assert.equal(turnstileGateReducer("failed", { type: "retry" }), "waiting");
});

test("a late timeout or error never undoes a solved gate", () => {
  assert.equal(turnstileGateReducer("solved", { type: "timeout" }), "solved");
  assert.equal(turnstileGateReducer("solved", { type: "error" }), "solved");
});

test("an expired token goes back to waiting for the widget's own re-solve", () => {
  assert.equal(turnstileGateReducer("solved", { type: "expired" }), "waiting");
});

// ── navigation ───────────────────────────────────────────────────────────

test("the widget's frames load; a top-frame link out does not", () => {
  assert.equal(turnstileAllowsNavigation("about:blank", true), true);
  assert.equal(turnstileAllowsNavigation("about:srcdoc", true), true);
  assert.equal(turnstileAllowsNavigation(TURNSTILE_NATIVE_BASE_URL, true), true);
  assert.equal(
    turnstileAllowsNavigation("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x", true),
    true,
  );
  assert.equal(turnstileAllowsNavigation("https://anything.example/frame", false), true);
  assert.equal(turnstileAllowsNavigation("https://www.cloudflare.com/privacypolicy/", true), false);
});

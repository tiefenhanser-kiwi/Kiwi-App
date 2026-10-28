// CLIENT-3 D (ATTR) — "How did you hear about Kiwi?": a new account's one
// optional question, its route in, its PATCH, and the never-again marker.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  HOW_HEARD_OPTIONS,
  howHeardBody,
  howHeardNext,
  landingAfterAuth,
  markHowHeardAsked,
  sendHowHeard,
  wasHowHeardAsked,
} from "../howHeard";

test("D: the eight answers, in order, with SERVER-6's values", () => {
  assert.deepEqual(
    HOW_HEARD_OPTIONS.map((o) => [o.value, o.label]),
    [
      ["friend", "Friend or family"],
      ["instagram", "Instagram"],
      ["tiktok", "TikTok"],
      ["reddit", "Reddit"],
      ["google", "Google search"],
      ["app_store", "App Store / Play Store search"],
      ["creator", "A creator"],
      ["other", "Other"],
    ],
  );
});

test("D: only a NEW account goes through the question, carrying where it was going", () => {
  assert.deepEqual(landingAfterAuth({ onboardingRequired: true }, true), {
    pathname: "/how-heard",
    params: { next: "/onboarding-prefs" },
  });
  assert.deepEqual(landingAfterAuth({ onboardingRequired: false }, true), {
    pathname: "/how-heard",
    params: { next: "/(tabs)" },
  });
  // A returning member (OAuth isNewUser false) lands exactly as before.
  assert.equal(landingAfterAuth({ onboardingRequired: false }, false), "/(tabs)");
  assert.equal(landingAfterAuth({}, false), "/onboarding-prefs");
});

test("D: the onward route is one of the two landings, else index's gate", () => {
  assert.equal(howHeardNext("/(tabs)"), "/(tabs)");
  assert.equal(howHeardNext("/onboarding-prefs"), "/onboarding-prefs");
  assert.equal(howHeardNext("https://evil.example"), "/");
  assert.equal(howHeardNext(undefined), "/");
  assert.equal(howHeardNext(["/(tabs)"]), "/");
});

test("D: the PATCH body — the detail only for 'A creator', trimmed, cut to 80, dropped when blank", () => {
  assert.deepEqual(howHeardBody("tiktok"), { howHeard: "tiktok" });
  assert.deepEqual(howHeardBody("tiktok", "someone"), { howHeard: "tiktok" });
  assert.deepEqual(howHeardBody("creator", "  @kenji  "), { howHeard: "creator", howHeardDetail: "@kenji" });
  assert.deepEqual(howHeardBody("creator", "   "), { howHeard: "creator" });
  assert.equal(howHeardBody("creator", "x".repeat(200)).howHeardDetail?.length, 80);
});

test("D: sent unawaited in a request of its own; a refusal (an old server's 400) is dropped", async () => {
  const sent: unknown[] = [];
  const ret = sendHowHeard({ howHeard: "reddit" }, async (body) => {
    sent.push(body);
    throw new Error("400 invalid body");
  });
  assert.equal(ret, undefined);
  assert.deepEqual(sent, [{ howHeard: "reddit" }]);
  await new Promise((r) => setTimeout(r, 0));
});

test("D: asked once per account on this device", async () => {
  assert.equal(await wasHowHeardAsked("u-hh-1"), false);
  await markHowHeardAsked("u-hh-1");
  assert.equal(await wasHowHeardAsked("u-hh-1"), true);
  assert.equal(await wasHowHeardAsked("u-hh-2"), false);
});

test("D: every sign-in landing goes through landingAfterAuth; a password sign-up is always new", () => {
  const up = readFileSync(new URL("../../app/(auth)/sign-up.tsx", import.meta.url), "utf8");
  const inn = readFileSync(new URL("../../app/(auth)/sign-in.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(up + inn, /router\.replace\(authLanding\(/);
  assert.match(up, /router\.replace\(landingAfterAuth\(res, true\)\);/);
  assert.match(up, /router\.replace\(landingAfterAuth\(res, res\.isNewUser === true\)\);/);
  assert.match(inn, /router\.replace\(landingAfterAuth\(res, res\.isNewUser === true\)\);/);
  const screen = readFileSync(new URL("../../app/how-heard.tsx", import.meta.url), "utf8");
  assert.match(screen, /await markHowHeardAsked\(userId\);/);
  assert.match(screen, /sendHowHeard\(howHeardBody\(value, detail\)\);\s*router\.replace\(next\);/);
});

// CLIENT-4 C (BUG-561) — the paywall sheet waits while the question is on screen.
test("CLIENT-4 C: only the question's own route holds the paywall sheet", async () => {
  const { HOW_HEARD_PATH, holdsPaywallSheet } = await import("../howHeard");
  // The route a new account is sent to is the one that holds it.
  assert.equal((landingAfterAuth({ onboardingRequired: true }, true) as { pathname: string }).pathname, HOW_HEARD_PATH);
  assert.equal(holdsPaywallSheet("/how-heard"), true);
  for (const p of ["/", "/onboarding-prefs", "/(tabs)", "/sign-up", "/how-heard-else", null, undefined]) {
    assert.equal(holdsPaywallSheet(p), false, String(p));
  }
  const sheet = readFileSync(new URL("../../components/PaywallSheet.tsx", import.meta.url), "utf8");
  assert.match(sheet, /const held = holdsPaywallSheet\(usePathname\(\)\);\s*const visible = sheet !== null && !held;/);
});

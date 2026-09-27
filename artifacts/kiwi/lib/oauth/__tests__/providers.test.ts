// Row 9 (1.1) · OAuth Block 2 Part B — which buttons exist (§2.2, §2.3).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  anyProviderVisible,
  appleWebConfigured,
  googleConfigured,
  providerButtons,
  readOAuthClientConfig,
} from "../providers";

const FULL = {
  EXPO_PUBLIC_APPLE_SERVICES_ID: "ai.kitchenwizard.signin",
  EXPO_PUBLIC_APPLE_WEB_REDIRECT_URI: "https://app.kitchenwizard.ai/auth/apple",
  EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: "111-web.apps.googleusercontent.com",
  EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: "111-ios.apps.googleusercontent.com",
};

// ── reading the env ──────────────────────────────────────────────────────

test("an unset variable reads as null, not as an empty string", () => {
  const cfg = readOAuthClientConfig({});
  assert.deepEqual(cfg, {
    appleServicesId: null,
    appleWebRedirectUri: null,
    googleWebClientId: null,
    googleIosClientId: null,
  });
});

test("a blank or whitespace-only variable reads as null", () => {
  // A deploy that sets a variable to "" has not configured anything, and a
  // button that renders on "" would send an empty client id to Google.
  const cfg = readOAuthClientConfig({
    EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: "",
    EXPO_PUBLIC_APPLE_SERVICES_ID: "   ",
  });
  assert.equal(cfg.googleWebClientId, null);
  assert.equal(cfg.appleServicesId, null);
});

test("values are trimmed — a trailing newline from a secret store is not part of the id", () => {
  const cfg = readOAuthClientConfig({ EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: " abc \n" });
  assert.equal(cfg.googleWebClientId, "abc");
});

// ── 🔴 break (2): a Google button must NEVER render without a client id ───

test("🔴 googleConfigured is FALSE on all three platforms with no client id", () => {
  for (const p of ["ios", "android", "web"] as const) {
    assert.equal(googleConfigured(p, {}), false, p);
  }
});

test("🔴 providerButtons hides Google on all three platforms with no env at all", () => {
  for (const p of ["ios", "android", "web"] as const) {
    const b = providerButtons(p, { appleNativeAvailable: true }, {});
    assert.equal(b.google, false, `${p} google`);
  }
});

test("web and android need only the WEB client id", () => {
  const env = { EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: FULL.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID };
  assert.equal(googleConfigured("web", env), true);
  assert.equal(googleConfigured("android", env), true);
});

test("iOS needs BOTH Google ids — the web one for the token's audience, the iOS one to run the flow", () => {
  assert.equal(
    googleConfigured("ios", {
      EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: FULL.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
    }),
    false,
  );
  assert.equal(
    googleConfigured("ios", {
      EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: FULL.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
    }),
    false,
  );
  assert.equal(googleConfigured("ios", FULL), true);
});

// ── Apple ────────────────────────────────────────────────────────────────

test("Apple's web flow needs BOTH halves — half a pair is a guaranteed failure", () => {
  assert.equal(appleWebConfigured({}), false);
  assert.equal(
    appleWebConfigured({ EXPO_PUBLIC_APPLE_SERVICES_ID: FULL.EXPO_PUBLIC_APPLE_SERVICES_ID }),
    false,
  );
  assert.equal(
    appleWebConfigured({
      EXPO_PUBLIC_APPLE_WEB_REDIRECT_URI: FULL.EXPO_PUBLIC_APPLE_WEB_REDIRECT_URI,
    }),
    false,
  );
  assert.equal(appleWebConfigured(FULL), true);
});

test("§2.2 — ANDROID NEVER SHOWS APPLE, fully configured or not", () => {
  // Not a configuration question: Apple's guideline requires Sign in with
  // Apple only on Apple platforms, and an Apple web flow on Android is not
  // in 1.1.
  assert.equal(providerButtons("android", { appleNativeAvailable: true }, FULL).apple, false);
});

test("iOS Apple is gated on isAvailableAsync, NOT on env", () => {
  // The native flow's client id is the bundle id and its configuration is the
  // entitlement, compiled in. There is no EXPO_PUBLIC pair to read — §2.8's
  // own list names only the two web variables.
  assert.equal(providerButtons("ios", { appleNativeAvailable: true }, {}).apple, true);
  assert.equal(providerButtons("ios", { appleNativeAvailable: false }, FULL).apple, false);
});

test("web Apple is gated on env, NOT on isAvailableAsync", () => {
  assert.equal(providerButtons("web", { appleNativeAvailable: false }, FULL).apple, true);
  assert.equal(providerButtons("web", { appleNativeAvailable: true }, {}).apple, false);
});

// ── §2.2's three platforms, fully configured ──────────────────────────────

test("fully configured: iOS = Apple + Google · Android = Google · web = Apple + Google", () => {
  assert.deepEqual(providerButtons("ios", { appleNativeAvailable: true }, FULL), {
    apple: true,
    google: true,
  });
  assert.deepEqual(providerButtons("android", { appleNativeAvailable: true }, FULL), {
    apple: false,
    google: true,
  });
  assert.deepEqual(providerButtons("web", { appleNativeAvailable: false }, FULL), {
    apple: true,
    google: true,
  });
});

// ── the 503 hide (§2.6) ───────────────────────────────────────────────────

test("a provider hidden for the session drops out even when configured", () => {
  const b = providerButtons(
    "web",
    { appleNativeAvailable: false, hidden: ["google"] },
    FULL,
  );
  assert.equal(b.apple, true);
  assert.equal(b.google, false);
});

test("both hidden leaves the screen exactly as it was before this block", () => {
  const b = providerButtons(
    "web",
    { appleNativeAvailable: false, hidden: ["apple", "google"] },
    FULL,
  );
  assert.equal(anyProviderVisible(b), false);
});

// ── the divider (§2.3: no stranded 'or' over an empty row) ────────────────

test("anyProviderVisible is false with nothing configured and true with either", () => {
  assert.equal(
    anyProviderVisible(providerButtons("android", { appleNativeAvailable: false }, {})),
    false,
  );
  assert.equal(
    anyProviderVisible(providerButtons("ios", { appleNativeAvailable: true }, {})),
    true,
  );
  assert.equal(
    anyProviderVisible(
      providerButtons("android", { appleNativeAvailable: false }, {
        EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: FULL.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
      }),
    ),
    true,
  );
});

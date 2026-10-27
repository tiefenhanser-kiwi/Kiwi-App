// CLIENT-3 D (ATTR) — the web landing link: kept on first load, sent once on
// every account-creating body (password sign-up, both OAuth routes).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ATTRIBUTION_STORAGE_KEY,
  attributionFromUrl,
  captureAttribution,
  readAttribution,
  type AttributionEnv,
} from "../attribution";
import { appleRequestBody, googleRequestBody, oauthSharedBody } from "../oauth/request";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
}

function env(search: string, pathname: string, storage = memoryStorage()): AttributionEnv & { storage: ReturnType<typeof memoryStorage> } {
  return { storage, location: { search, pathname } };
}

test("D: ref, the three utm tags and the landing path, camelCased; others ignored", () => {
  assert.deepEqual(
    attributionFromUrl("?ref=sam&utm_source=ig&utm_medium=social&utm_campaign=thx&utm_term=x&foo=1", "/cookbook"),
    { ref: "sam", utmSource: "ig", utmMedium: "social", utmCampaign: "thx", landingPath: "/cookbook" },
  );
  assert.deepEqual(attributionFromUrl("", "/"), { landingPath: "/" });
  // Trimmed, empty dropped, cut to 120 (SERVER-6's ATTRIBUTION_VALUE_MAX).
  const long = attributionFromUrl(`?ref=%20%20&utm_source=${"a".repeat(200)}`, "/x");
  assert.equal(long.ref, undefined);
  assert.equal(long.utmSource?.length, 120);
});

test("D: the FIRST load wins — a later page (or the app's own redirect) does not overwrite it", () => {
  const storage = memoryStorage();
  captureAttribution(env("?ref=sam&utm_source=tiktok", "/", storage));
  captureAttribution(env("", "/welcome", storage));
  assert.deepEqual(readAttribution({ storage, location: null }), { ref: "sam", utmSource: "tiktok", landingPath: "/" });
});

test("D: blocked storage, no window, or a corrupt value → no link, never a throw", () => {
  const throwing = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("SecurityError");
    },
  };
  assert.doesNotThrow(() => captureAttribution({ storage: throwing, location: { search: "?ref=a", pathname: "/" } }));
  assert.equal(readAttribution({ storage: throwing, location: null }), undefined);
  assert.equal(readAttribution({ storage: null, location: null }), undefined);
  captureAttribution({ storage: null, location: { search: "?ref=a", pathname: "/" } });
  const bad = memoryStorage({ [ATTRIBUTION_STORAGE_KEY]: "{not json" });
  assert.equal(readAttribution({ storage: bad, location: null }), undefined);
  const arr = memoryStorage({ [ATTRIBUTION_STORAGE_KEY]: "[1]" });
  assert.equal(readAttribution({ storage: arr, location: null }), undefined);
});

test("D: native has no landing URL — the default env keeps and sends nothing", () => {
  // The test runtime's Platform.OS is not "web".
  captureAttribution();
  assert.equal(readAttribution(), undefined);
});

test("D: both OAuth bodies carry it, on sign-up AND sign-in (a first sign-in is a sign-up); absent when there is none", () => {
  const attribution = { ref: "sam", landingPath: "/" };
  for (const mode of ["signup", "signin"] as const) {
    assert.deepEqual(oauthSharedBody({ mode, platform: "web", attribution }).attribution, attribution);
    assert.deepEqual(googleRequestBody({ idToken: "t" }, { mode, platform: "web", attribution }).attribution, attribution);
    assert.deepEqual(
      appleRequestBody({ identityToken: "t", rawNonce: "n" }, { mode, platform: "web", attribution }).attribution,
      attribution,
    );
  }
  assert.equal("attribution" in oauthSharedBody({ mode: "signup", platform: "web" }), false);
  assert.equal("attribution" in oauthSharedBody({ mode: "signup", platform: "web", attribution: {} }), false);
});

test("D: the password sign-up and the OAuth context read it; the web capture runs at module load of the root layout", () => {
  const ctx = readFileSync(new URL("../../contexts/AuthContext.ts", import.meta.url), "utf8");
  assert.equal(ctx.split("attribution: readAttribution(),").length - 1, 2, "signup base + oauthSignIn ctx");
  const layout = readFileSync(new URL("../../app/_layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /^captureAttribution\(\);$/m);
});

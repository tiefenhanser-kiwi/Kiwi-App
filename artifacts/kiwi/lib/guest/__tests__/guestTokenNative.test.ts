// Resub C1 — the guest token trio on a PHONE: expo-secure-store behind an
// in-memory copy that is hydrated at boot.
//
// A "restart" here is a FRESH INSTANCE of lib/guest/guestToken.ts (imported
// with a unique query string, the same trick lib/api/__tests__/base.test.ts
// uses), sharing the one SecureStore stub — exactly what a cold start is: the
// module's memory is gone, the Keychain is not.

import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

type GuestTokenModule = typeof import("../guestToken");

const store = SecureStore as unknown as {
  __resetForTests(): void;
  __setForTests(k: string, v: string): void;
  getItemAsync(k: string): Promise<string | null>;
};
const platform = Platform as unknown as { OS: string };
const realOS = platform.OS;

let run = 0;
/** A cold start: a new module instance, the same Keychain. */
async function boot(): Promise<GuestTokenModule> {
  run += 1;
  return (await import(`../guestToken.ts?run=${run}-${Math.random()}`)) as GuestTokenModule;
}

const KEYS = ["kiwi_guestToken", "kiwi_guestSessionId", "kiwi_guestExpiresAt"] as const;

async function keychain(): Promise<Array<string | null>> {
  return Promise.all(KEYS.map((k) => store.getItemAsync(k)));
}

const LIVE = {
  guestSessionId: "gs_live",
  token: "guest-jwt-live",
  expiresAt: new Date(Date.now() + 12 * 3_600_000).toISOString(),
};

before(() => {
  platform.OS = "ios";
});

after(() => {
  platform.OS = realOS;
});

afterEach(() => {
  store.__resetForTests();
});

test("🔴 the trio survives a restart: written to SecureStore, hydrated back on the next boot", async () => {
  const first = await boot();
  first.storeGuestSession(LIVE);
  await first.guestStoreSettled();
  assert.deepEqual(await keychain(), [LIVE.token, LIVE.guestSessionId, LIVE.expiresAt]);

  const second = await boot();
  // Before hydration the new run knows nothing — memory really is per-run.
  assert.equal(second.guestStoreHydrated(), false);
  assert.equal(second.readGuestSession(), null);

  const hydrated = await second.hydrateGuestSession();
  assert.deepEqual(hydrated, LIVE);
  assert.equal(second.guestStoreHydrated(), true);
  // …and the synchronous reads apiClient and GuestContext make now see it.
  assert.deepEqual(second.readGuestSession(), LIVE);
  assert.equal(second.readGuestToken(), LIVE.token);
  assert.equal(second.readGuestSessionId(), LIVE.guestSessionId);
});

test("🔴 expiry is respected after a restart — an expired trio is dropped and deleted", async () => {
  store.__setForTests("kiwi_guestToken", "guest-jwt-old");
  store.__setForTests("kiwi_guestSessionId", "gs_old");
  store.__setForTests("kiwi_guestExpiresAt", new Date(Date.now() - 60_000).toISOString());

  const mod = await boot();
  assert.equal(await mod.hydrateGuestSession(), null);
  assert.equal(mod.readGuestToken(), null);
  await mod.guestStoreSettled();
  assert.deepEqual(await keychain(), [null, null, null], "the dead keys are gone");
});

test("a session inside the expiry margin is dropped too (guestSessionUsable's rule)", async () => {
  store.__setForTests("kiwi_guestToken", "guest-jwt-edge");
  store.__setForTests("kiwi_guestSessionId", "gs_edge");
  store.__setForTests("kiwi_guestExpiresAt", new Date(Date.now() + 30_000).toISOString());
  const mod = await boot();
  assert.equal(await mod.hydrateGuestSession(), null);
});

test("a half-written trio hydrates as nothing and is cleaned up", async () => {
  store.__setForTests("kiwi_guestToken", "guest-jwt-half");
  const mod = await boot();
  assert.equal(await mod.hydrateGuestSession(), null);
  await mod.guestStoreSettled();
  assert.deepEqual(await keychain(), [null, null, null]);
});

test("clear empties memory at once and SecureStore in order — store-then-clear never resurrects", async () => {
  const mod = await boot();
  await mod.hydrateGuestSession();
  mod.storeGuestSession(LIVE);
  mod.clearGuestSession();
  assert.equal(mod.readGuestSession(), null, "memory is cleared synchronously");
  await mod.guestStoreSettled();
  assert.deepEqual(await keychain(), [null, null, null]);

  const next = await boot();
  assert.equal(await next.hydrateGuestSession(), null);
});

test("a session minted while the boot read is in flight wins over what the read finds", async () => {
  store.__setForTests("kiwi_guestToken", "guest-jwt-stale");
  store.__setForTests("kiwi_guestSessionId", "gs_stale");
  store.__setForTests("kiwi_guestExpiresAt", LIVE.expiresAt);
  const mod = await boot();
  const pending = mod.hydrateGuestSession();
  const fresh = { ...LIVE, guestSessionId: "gs_fresh", token: "guest-jwt-fresh" };
  mod.storeGuestSession(fresh);
  assert.deepEqual(await pending, fresh);
  assert.deepEqual(mod.readGuestSession(), fresh);
});

test("hydration is one read, shared by every caller", async () => {
  const mod = await boot();
  assert.equal(mod.hydrateGuestSession(), mod.hydrateGuestSession());
});

test("web is unchanged: no SecureStore write, and no hydration wait", async () => {
  platform.OS = "web";
  try {
    const mod = await boot();
    assert.equal(mod.guestStoreHydrated(), true, "web never waits on a boot read");
    mod.storeGuestSession(LIVE);
    await mod.guestStoreSettled();
    assert.deepEqual(await keychain(), [null, null, null], "nothing reached SecureStore");
    // Node has no sessionStorage, so this is web's memory fallback — as before.
    assert.deepEqual(mod.readGuestSession(), LIVE);
  } finally {
    platform.OS = "ios";
  }
});

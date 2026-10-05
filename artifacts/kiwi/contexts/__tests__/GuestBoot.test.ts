// Resub C1 — a cold start with a guest session already in the Keychain.
//
// The guest store's reads are synchronous (GuestProvider seeds its state from
// readGuestSession() on its FIRST render; lib/api/client.ts reads the Bearer
// with readGuestToken()), and SecureStore is not. app/_layout.tsx closes that
// gap by not mounting GuestProvider until useGuestStoreReady() is true. This
// mounts the same arrangement and asserts the first render already has the
// session — and that the first guest request carries its token.
//
// Its own file on purpose: node --test runs each file in its own process, so
// this module graph has never hydrated before the test starts — a real cold
// start, not a second call to a cached promise.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import { GuestProvider, useGuest, useGuestStoreReady } from "../GuestContext";
import { readGuestToken } from "../../lib/guest/guestToken";
import { apiClient } from "../../lib/api/client";

const store = SecureStore as unknown as {
  __resetForTests(): void;
  __setForTests(k: string, v: string): void;
};
const platform = Platform as unknown as { OS: string };
const realOS = platform.OS;
const realFetch = globalThis.fetch;

const STORED = {
  token: "guest-jwt-from-last-run",
  guestSessionId: "gs_last_run",
  expiresAt: new Date(Date.now() + 6 * 3_600_000).toISOString(),
};

before(() => {
  platform.OS = "ios";
  // What the previous run left in the Keychain.
  store.__setForTests("kiwi_guestToken", STORED.token);
  store.__setForTests("kiwi_guestSessionId", STORED.guestSessionId);
  store.__setForTests("kiwi_guestExpiresAt", STORED.expiresAt);
});

after(() => {
  platform.OS = realOS;
  globalThis.fetch = realFetch;
  store.__resetForTests();
});

test("🔴 the guest store is hydrated before the first read — GuestProvider's first render has the session", async () => {
  // Nothing is readable synchronously until the boot read lands.
  assert.equal(readGuestToken(), null);

  const firstRenders: Array<{ session: unknown; token: string | null }> = [];
  function Probe() {
    const { session } = useGuest();
    firstRenders.push({ session, token: readGuestToken() });
    return null;
  }
  // app/_layout.tsx's arrangement, minus the fonts.
  function Boot() {
    const ready = useGuestStoreReady();
    if (!ready) return null;
    return React.createElement(GuestProvider, null, React.createElement(Probe));
  }

  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(React.createElement(Boot));
  });

  assert.ok(firstRenders.length > 0, "the provider mounted once the store was ready");
  assert.deepEqual(firstRenders[0], {
    session: STORED,
    token: STORED.token,
  });

  await act(async () => {
    r.unmount();
  });
});

test("…and the first guest request carries the restored token", async () => {
  let auth: string | null = null;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  await apiClient("/guest/session", { principal: "guest" });
  assert.equal(auth, `Bearer ${STORED.token}`);
});

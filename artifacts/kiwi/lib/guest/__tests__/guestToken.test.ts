// Row 13 "Test Kitchen" · Block 2 Part B — the guest token store's ONE
// load-bearing promise: readToken() can never return it.
//
// Runs in node with no DOM, so these exercise the memory-fallback branch — the
// same branch a private-mode browser with blocked site data takes.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import * as SecureStore from "expo-secure-store";

import { readToken, storeToken } from "../../auth";
import {
  clearGuestSession,
  readGuestSession,
  readGuestSessionId,
  readGuestToken,
  storeGuestSession,
} from "../guestToken";

const creds = {
  guestSessionId: "gs_abc",
  token: "guest-jwt",
  expiresAt: "2026-09-28T12:00:00.000Z",
};

afterEach(() => {
  clearGuestSession();
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
});

test("a stored guest session reads back whole", () => {
  storeGuestSession(creds);
  assert.deepEqual(readGuestSession(), creds);
  assert.equal(readGuestToken(), "guest-jwt");
  assert.equal(readGuestSessionId(), "gs_abc");
});

test("no session → null everywhere, never a throw", () => {
  assert.equal(readGuestSession(), null);
  assert.equal(readGuestToken(), null);
  assert.equal(readGuestSessionId(), null);
});

test("🔴 readToken() never returns the guest token", async () => {
  storeGuestSession(creds);
  assert.equal(await readToken(), null);
});

test("🔴 the user token and the guest token coexist without either leaking", async () => {
  await storeToken("user-jwt");
  storeGuestSession(creds);
  assert.equal(await readToken(), "user-jwt");
  assert.equal(readGuestToken(), "guest-jwt");
});

test("clearing the guest session leaves the user token alone", async () => {
  await storeToken("user-jwt");
  storeGuestSession(creds);
  clearGuestSession();
  assert.equal(readGuestToken(), null);
  assert.equal(await readToken(), "user-jwt");
});

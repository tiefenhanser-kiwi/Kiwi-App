// D-WS9-241 E — token storage branches on Platform.OS.
//
// web  → sessionStorage, every access wrapped so a throwing / blocked /
//        empty storage reads as "no token" and never as an exception.
// native → expo-secure-store, byte-unchanged from before E.
//
// The react-native stub's Platform is a mutable object, so each test sets
// Platform.OS directly and restores it in afterEach. The SecureStore stub
// (lib/api/__tests__/_stubs.mjs) records what the native branch does.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import { clearToken, readToken, storeToken } from "../auth";

const TOKEN_KEY = "kiwi_authToken";

type SecureStoreStub = {
  __resetForTests(): void;
  __setForTests(k: string, v: string): void;
  getItemAsync(k: string): Promise<string | null>;
};
const store = SecureStore as unknown as SecureStoreStub;
const platform = Platform as unknown as { OS: string };

const g = globalThis as unknown as { sessionStorage?: unknown };

// A minimal in-memory Storage. `throwOn` makes the named method throw,
// standing in for QuotaExceededError / SecurityError on a real browser.
function fakeStorage(throwOn: "getItem" | "setItem" | "removeItem" | null = null) {
  const m = new Map<string, string>();
  return {
    getItem(k: string) {
      if (throwOn === "getItem") throw new Error("SecurityError: blocked");
      return m.has(k) ? m.get(k)! : null;
    },
    setItem(k: string, v: string) {
      if (throwOn === "setItem") throw new Error("QuotaExceededError");
      m.set(k, v);
    },
    removeItem(k: string) {
      if (throwOn === "removeItem") throw new Error("SecurityError: blocked");
      m.delete(k);
    },
    __map: m,
  };
}

function setSessionStorage(value: unknown) {
  Object.defineProperty(g, "sessionStorage", {
    value,
    configurable: true,
    writable: true,
  });
}

// Private-mode Safari: the PROPERTY READ throws, not the method call.
function setThrowingSessionStorage() {
  Object.defineProperty(g, "sessionStorage", {
    get() {
      throw new Error("SecurityError: The operation is insecure.");
    },
    configurable: true,
  });
}

const originalOS = platform.OS;
const hadSessionStorage = Object.prototype.hasOwnProperty.call(g, "sessionStorage");
const originalDescriptor = hadSessionStorage
  ? Object.getOwnPropertyDescriptor(g, "sessionStorage")
  : undefined;

beforeEach(() => {
  store.__resetForTests();
});

afterEach(() => {
  platform.OS = originalOS;
  store.__resetForTests();
  if (originalDescriptor) {
    Object.defineProperty(g, "sessionStorage", originalDescriptor);
  } else {
    delete g.sessionStorage;
  }
});

// ── web ────────────────────────────────────────────────────────────────

test("web: store → read round-trips through sessionStorage under the unchanged key", async () => {
  platform.OS = "web";
  const ss = fakeStorage();
  setSessionStorage(ss);

  await storeToken("tok-web-1");
  assert.equal(ss.__map.get(TOKEN_KEY), "tok-web-1", "written under kiwi_authToken");
  assert.equal(await readToken(), "tok-web-1");

  await clearToken();
  assert.equal(ss.__map.has(TOKEN_KEY), false);
  assert.equal(await readToken(), null);

  // The native store was never touched on web.
  assert.equal(await store.getItemAsync(TOKEN_KEY), null);
});

test("web: read with storage.getItem throwing → null, no throw", async () => {
  platform.OS = "web";
  setSessionStorage(fakeStorage("getItem"));
  assert.equal(await readToken(), null);
});

test("web: read when the sessionStorage property itself throws → null, no throw", async () => {
  platform.OS = "web";
  setThrowingSessionStorage();
  assert.equal(await readToken(), null);
});

test("web: read with no sessionStorage at all → null, no throw", async () => {
  platform.OS = "web";
  delete g.sessionStorage;
  assert.equal(await readToken(), null);
});

test("web: write with storage.setItem throwing → resolves, no throw", async () => {
  platform.OS = "web";
  setSessionStorage(fakeStorage("setItem"));
  await assert.doesNotReject(() => storeToken("tok-web-2"));
});

test("web: write when the sessionStorage property throws → resolves, no throw", async () => {
  platform.OS = "web";
  setThrowingSessionStorage();
  await assert.doesNotReject(() => storeToken("tok-web-3"));
});

test("web: clear with storage.removeItem throwing → resolves, no throw", async () => {
  platform.OS = "web";
  setSessionStorage(fakeStorage("removeItem"));
  await assert.doesNotReject(() => clearToken());
});

test("web: clear when the sessionStorage property throws → resolves, no throw", async () => {
  platform.OS = "web";
  setThrowingSessionStorage();
  await assert.doesNotReject(() => clearToken());
});

// ── native ─────────────────────────────────────────────────────────────

test("native: store / read / clear still go through SecureStore (sessionStorage untouched)", async () => {
  platform.OS = "ios";
  const ss = fakeStorage();
  setSessionStorage(ss);

  await storeToken("tok-native-1");
  assert.equal(await store.getItemAsync(TOKEN_KEY), "tok-native-1", "SecureStore holds it");
  assert.equal(ss.__map.size, 0, "sessionStorage never written on native");

  assert.equal(await readToken(), "tok-native-1");

  await clearToken();
  assert.equal(await store.getItemAsync(TOKEN_KEY), null);
  assert.equal(await readToken(), null);
});

test("native: a SecureStore rejection still propagates (native path is byte-unchanged)", async () => {
  platform.OS = "android";
  (store as unknown as { __setThrowOn(m: string): void }).__setThrowOn("getItemAsync");
  await assert.rejects(() => readToken(), /getItemAsync forced failure/);
});

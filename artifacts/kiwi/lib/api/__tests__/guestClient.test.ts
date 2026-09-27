// Row 13 "Test Kitchen" · Block 2 Part B — `principal: "guest"` in apiClient.
//
// Three promises, and the third is the one that would have broken the flow:
//   1. the GUEST token is the Bearer, never readToken()'s;
//   2. a path off the allowlist is refused before it is sent;
//   3. a guest 401 NEVER fires the session-expired cascade.
//
// (3) matters because a guest token on a requireAuth route is a measured 401
// (not 403 — middleware/auth.ts has no 403 branch), and the cascade's job is to
// evict a dead session to /(auth)/sign-in. Fired for a guest it would throw a
// visitor off the Test Kitchen for reading a page.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import * as SecureStore from "expo-secure-store";

import { apiClient } from "../client";
import { UnauthenticatedError } from "../errors";
import { __resetForTests, subscribeSessionEvents } from "../auth-bridge";
import { clearGuestSession, storeGuestSession } from "../../guest/guestToken";

const TOKEN_KEY = "kiwi_authToken";

interface CallRecord {
  url: string;
  init?: RequestInit;
}
let calls: CallRecord[];
let nextResponse: () => Response;

function mockResponse(body: unknown, status = 200): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return new Response(text, { status, headers: { "Content-Type": "application/json" } });
}

function authHeader(init?: RequestInit): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.["Authorization"];
}

beforeEach(() => {
  calls = [];
  nextResponse = () => mockResponse({ ok: true });
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    url: string,
    init?: RequestInit,
  ) => {
    calls.push({ url, init });
    return nextResponse();
  }) as unknown as typeof fetch;
  (SecureStore as unknown as { __setForTests(k: string, v: string): void }).__setForTests(
    TOKEN_KEY,
    "user-token",
  );
  storeGuestSession({
    guestSessionId: "gs_1",
    token: "guest-token",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  __resetForTests();
});

afterEach(() => {
  clearGuestSession();
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
});

test("a guest call sends the GUEST token even with a user token in the store", async () => {
  await apiClient("/guest/session", { principal: "guest" });
  assert.equal(calls.length, 1);
  assert.equal(authHeader(calls[0].init), "Bearer guest-token");
});

test("the default principal is unchanged — the user token", async () => {
  await apiClient("/guest/session");
  assert.equal(authHeader(calls[0].init), "Bearer user-token");
});

test("🔴 a path off the allowlist is a programmer error, and nothing is sent", async () => {
  await assert.rejects(
    () => apiClient("/me/preferences", { principal: "guest" }),
    /not a guest-allowed route/,
  );
  assert.equal(calls.length, 0);
});

test("the allowlist refusal fires in envelope mode too", async () => {
  await assert.rejects(
    () => apiClient("/home", { principal: "guest", errorMode: "envelope" }),
    /not a guest-allowed route/,
  );
  assert.equal(calls.length, 0);
});

test("🔴 a guest 401 does NOT fire the session-expired cascade", async () => {
  let cascades = 0;
  subscribeSessionEvents(() => {
    cascades += 1;
  });
  nextResponse = () => mockResponse({ error: "invalid or expired guest session" }, 401);
  await assert.rejects(
    () => apiClient("/guest/draft", { principal: "guest" }),
    UnauthenticatedError,
  );
  await new Promise<void>((r) => queueMicrotask(r));
  assert.equal(cascades, 0);
});

test("a USER 401 on the same shape still fires the cascade (the guard is narrow)", async () => {
  let cascades = 0;
  subscribeSessionEvents(() => {
    cascades += 1;
  });
  nextResponse = () => mockResponse({ error: "invalid or expired token" }, 401);
  await assert.rejects(() => apiClient("/auth/me"), UnauthenticatedError);
  await new Promise<void>((r) => queueMicrotask(r));
  assert.equal(cascades, 1);
});

test("🔴 no guest token → no cascade either; the visitor is not a dead session", async () => {
  clearGuestSession();
  let cascades = 0;
  subscribeSessionEvents(() => {
    cascades += 1;
  });
  await assert.rejects(
    () => apiClient("/guest/draft", { principal: "guest" }),
    UnauthenticatedError,
  );
  await new Promise<void>((r) => queueMicrotask(r));
  assert.equal(cascades, 0);
  assert.equal(calls.length, 0);
});

test("a guest 409 (catalog_only_gap / generation used) is an ordinary envelope error", async () => {
  nextResponse = () => mockResponse({ code: "catalog_only_gap", liveSlotTitles: ["Pho"] }, 409);
  const result = await apiClient("/wizard/expand", {
    method: "POST",
    principal: "guest",
    body: {},
    errorMode: "envelope",
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.deepEqual((result.error as { body: unknown }).body, {
      code: "catalog_only_gap",
      liveSlotTitles: ["Pho"],
    });
  }
});

// D-WS9-241 B (BUG-258) — AuthContext's bootstrap outcomes, end to end
// through the real useAuthMe / fetchMeWithDeadline / apiClient / auth-bridge
// stack with only fetch and SecureStore stubbed.
//
//   401                      → cascade: token cleared, expired message, "ok"
//   timeout / network / 5xx  → "failed", token KEPT (in state and in storage)
//   readToken() throws       → "ok" with no token (Welcome), never blank
//   retryBootstrap()         → re-runs under the deadline; recovers to "ok"
//   abandonBootstrap()       → token cleared, no server call, no message
//   retry bound              → exactly ONE /auth/me attempt per bootstrap
//
// Harness mirrors AuthContext.test.ts (react-test-renderer, no JSX). The
// deadline is shortened through AuthProvider's test-only prop.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import * as SecureStore from "expo-secure-store";

import { AuthProvider, useAuth } from "../AuthContext";
import { __resetForTests as resetAuthBridge } from "@/lib/api/auth-bridge";
import type { User } from "@/lib/types";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

type AuthValue = ReturnType<typeof useAuth>;
type FetchImpl = (url: string, init?: RequestInit) => Response | Promise<Response>;
type Stub = {
  __resetForTests(): void;
  __setForTests(k: string, v: string): void;
  __setThrowOn(method: string | null): void;
  getItemAsync(k: string): Promise<string | null>;
};
const store = SecureStore as unknown as Stub;

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "u1",
    email: "a@b.c",
    firstName: "A",
    lastName: "B",
    phone: null,
    zipCode: null,
    timezone: "UTC",
    accountStatus: "active",
    subscriptionStatus: "free",
    defaultHouseholdSize: 2,
    lastPlanDiscoveryFilters: [],
    lastPlansFilters: [],
    lastMealsFilters: [],
    marketingConsentEmail: false,
    marketingConsentSms: false,
    onboardingComplete: true,
    firstRunChoiceMade: false,
    subscription: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function mockJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Never resolves; rejects with AbortError when the deadline fires. */
function hang(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      reject(err);
    });
  });
}

let fetchImpl: FetchImpl;
let fetchUrls: string[];
let captured: AuthValue | null;
let activeRenderer: TestRenderer.ReactTestRenderer | null;

beforeEach(() => {
  captured = null;
  fetchUrls = [];
  activeRenderer = null;
  fetchImpl = () => mockJson({}, 200);
  (globalThis as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) => {
    fetchUrls.push(url);
    return Promise.resolve(fetchImpl(url, init));
  }) as unknown as typeof fetch;
  store.__resetForTests();
  resetAuthBridge();
});

afterEach(() => {
  if (activeRenderer) {
    try {
      activeRenderer.unmount();
    } catch {
      // already unmounted
    }
    activeRenderer = null;
  }
  store.__resetForTests();
  resetAuthBridge();
});

function Probe(): null {
  captured = useAuth();
  return null;
}

async function mount(opts: { initialToken?: string | null; deadlineMs?: number } = {}) {
  if (opts.initialToken) store.__setForTests(TOKEN_KEY, opts.initialToken);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(
          AuthProvider,
          { bootstrapDeadlineMs: opts.deadlineMs },
          React.createElement(Probe),
        ),
      ),
    );
  });
  activeRenderer = renderer;
  return qc;
}

/** Drain microtasks + react-query until nothing is fetching, or `maxMs`. */
async function settle(qc: QueryClient, maxMs = 200): Promise<void> {
  const until = Date.now() + maxMs;
  await act(async () => {
    while (Date.now() < until) {
      await new Promise<void>((r) => setTimeout(r, 5));
      if (qc.isFetching() === 0) {
        // one more tick so the observer's render lands
        await new Promise<void>((r) => setTimeout(r, 0));
        return;
      }
    }
  });
}

const ME_URLS = () => fetchUrls.filter((u) => u.endsWith("/auth/me"));

// ── 401 → the existing cascade, unchanged ─────────────────────────────

test("401 at bootstrap → token cleared, expired message, bootstrapStatus ok (NOT failed)", async () => {
  fetchImpl = () => mockJson({ error: "expired" }, 401);
  const qc = await mount({ initialToken: "t-401" });
  await settle(qc);

  assert.equal(captured!.bootstrapStatus, "ok");
  assert.equal(captured!.isLoading, false);
  assert.equal(captured!.token, null, "cascade cleared the token from state");
  assert.equal(await store.getItemAsync(TOKEN_KEY), null, "…and from storage");
  assert.equal(captured!.user, null);
  assert.equal(captured!.error, "Your session expired. Please sign in again.");
});

// ── timeout / network / 5xx → failed, token kept ──────────────────────

test("timeout: /auth/me hangs past the deadline → failed, token KEPT, one attempt only", async () => {
  fetchImpl = hang;
  const qc = await mount({ initialToken: "t-hang", deadlineMs: 40 });
  assert.equal(captured!.bootstrapStatus, "pending", "pending while in flight");

  await settle(qc, 1500);

  assert.equal(captured!.bootstrapStatus, "failed");
  assert.equal(captured!.isLoading, false);
  assert.equal(captured!.user, null);
  assert.equal(captured!.token, "t-hang", "token kept in state");
  assert.equal(await store.getItemAsync(TOKEN_KEY), "t-hang", "token kept in storage");
  assert.equal(captured!.error, null, "no 'session expired' message on a failure");
  assert.equal(ME_URLS().length, 1, "retry bound: exactly one /auth/me attempt");
});

test("network error: fetch rejects → failed, token KEPT", async () => {
  fetchImpl = () => {
    throw new TypeError("Network request failed");
  };
  const qc = await mount({ initialToken: "t-net" });
  await settle(qc);

  assert.equal(captured!.bootstrapStatus, "failed");
  assert.equal(captured!.token, "t-net");
  assert.equal(await store.getItemAsync(TOKEN_KEY), "t-net");
  assert.equal(captured!.user, null);
  assert.equal(ME_URLS().length, 1);
});

test("5xx: /auth/me 503 → failed, token KEPT, no cascade", async () => {
  fetchImpl = () => mockJson({ error: "down" }, 503);
  const qc = await mount({ initialToken: "t-5xx" });
  await settle(qc);

  assert.equal(captured!.bootstrapStatus, "failed");
  assert.equal(captured!.token, "t-5xx");
  assert.equal(await store.getItemAsync(TOKEN_KEY), "t-5xx");
  assert.equal(captured!.error, null);
  assert.equal(ME_URLS().length, 1);
});

// ── readToken() throws → Welcome, not blank ───────────────────────────

test("readToken() rejecting at bootstrap → ok with no token (Welcome), never stuck pending", async () => {
  store.__setForTests(TOKEN_KEY, "t-unreadable");
  store.__setThrowOn("getItemAsync");
  const warn = console.warn;
  console.warn = () => {};
  try {
    const qc = await mount();
    await settle(qc);
  } finally {
    console.warn = warn;
    store.__setThrowOn(null);
  }

  assert.equal(captured!.bootstrapStatus, "ok");
  assert.equal(captured!.isLoading, false, "storageRead was set on the throw path");
  assert.equal(captured!.token, null);
  assert.equal(captured!.user, null);
  assert.equal(ME_URLS().length, 0, "no /auth/me without a token");
});

// ── the failure screen's two actions ──────────────────────────────────

test("retryBootstrap: after a failure, a recovered server → ok with the user", async () => {
  fetchImpl = () => mockJson({ error: "down" }, 503);
  const qc = await mount({ initialToken: "t-retry" });
  await settle(qc);
  assert.equal(captured!.bootstrapStatus, "failed");

  const user = makeUser({ id: "u-recovered" });
  fetchImpl = () => mockJson({ user }, 200);
  await act(async () => {
    await captured!.retryBootstrap();
  });
  await settle(qc);

  assert.equal(captured!.bootstrapStatus, "ok");
  assert.equal(captured!.isAuthenticated, true);
  assert.equal(captured!.user?.id, "u-recovered");
  assert.equal(captured!.token, "t-retry");
  assert.equal(ME_URLS().length, 2, "one bootstrap attempt + one retry");
});

test("retryBootstrap: a second failure stays failed (no spinner-forever, no sign-out)", async () => {
  fetchImpl = () => mockJson({ error: "down" }, 503);
  const qc = await mount({ initialToken: "t-retry-2" });
  await settle(qc);
  assert.equal(captured!.bootstrapStatus, "failed");

  await act(async () => {
    await captured!.retryBootstrap();
  });
  await settle(qc);

  assert.equal(captured!.bootstrapStatus, "failed");
  assert.equal(captured!.token, "t-retry-2");
  assert.equal(await store.getItemAsync(TOKEN_KEY), "t-retry-2");
  assert.equal(ME_URLS().length, 2);
});

test("abandonBootstrap: clears the token with NO server call and no message → Welcome", async () => {
  fetchImpl = hang;
  const qc = await mount({ initialToken: "t-abandon", deadlineMs: 40 });
  await settle(qc, 1500);
  assert.equal(captured!.bootstrapStatus, "failed");
  const before = fetchUrls.length;

  await act(async () => {
    await captured!.abandonBootstrap();
  });
  await settle(qc);

  assert.equal(captured!.bootstrapStatus, "ok");
  assert.equal(captured!.token, null);
  assert.equal(await store.getItemAsync(TOKEN_KEY), null);
  assert.equal(captured!.user, null);
  assert.equal(captured!.error, null, "Welcome renders no error; none is set");
  assert.equal(captured!.isAuthenticated, false);
  assert.equal(fetchUrls.length, before, "no /auth/logout or other request was made");
  assert.equal(qc.getQueryData(["auth", "me"]), undefined);
});

// ── happy path still happy ────────────────────────────────────────────

test("success: stored token + 200 → ok, authenticated, one attempt", async () => {
  const user = makeUser({ id: "u-ok" });
  fetchImpl = () => mockJson({ user }, 200);
  const qc = await mount({ initialToken: "t-ok" });
  await settle(qc);

  assert.equal(captured!.bootstrapStatus, "ok");
  assert.equal(captured!.isAuthenticated, true);
  assert.equal(captured!.user?.id, "u-ok");
  assert.equal(ME_URLS().length, 1);
});

// ── D-WS9-241 A (BUG-261): signup passes phone + consents through ─────

function signupResponse(overrides: Partial<User> = {}) {
  return mockJson({ user: makeUser({ id: "u-new", ...overrides }), authToken: "tok-new" }, 201);
}

function lastSignupBody(): Record<string, unknown> {
  const i = fetchUrls.findIndex((u) => u.endsWith("/auth/signup"));
  assert.notEqual(i, -1, "a /auth/signup request was made");
  return signupBodies[i];
}

let signupBodies: Record<string, unknown>[];

test("signup(options) puts phone + both consents on the wire, one request, then stores the token", async () => {
  signupBodies = [];
  fetchImpl = (url, init) => {
    if (url.endsWith("/auth/signup")) {
      signupBodies.push(JSON.parse(init?.body as string));
      return signupResponse({ phone: "(555) 123-4567", marketingConsentSms: true });
    }
    return mockJson({}, 200);
  };
  const qc = await mount();
  await settle(qc);

  await act(async () => {
    await captured!.signup({
      email: "n@example.com",
      password: "password123",
      firstName: "New",
      lastName: "User",
      phone: " (555) 123-4567 ",
      marketingConsentEmail: true,
      marketingConsentSms: true,
    });
  });

  const body = lastSignupBody();
  assert.equal(body.phone, "(555) 123-4567", "trimmed");
  assert.equal(body.marketingConsentEmail, true);
  assert.equal(body.marketingConsentSms, true);
  assert.equal(typeof body.timezone, "string", "timezone still auto-detected");
  assert.equal(fetchUrls.filter((u) => u.endsWith("/auth/signup")).length, 1);
  assert.equal(fetchUrls.some((u) => u.endsWith("/me/profile")), false, "no follow-up PATCH");
  assert.equal(captured!.token, "tok-new");
  assert.equal(await store.getItemAsync(TOKEN_KEY), "tok-new");
  assert.equal(captured!.user?.id, "u-new");
});

test("signup(options) with an empty phone sends no phone and never sends SMS consent", async () => {
  signupBodies = [];
  fetchImpl = (url, init) => {
    if (url.endsWith("/auth/signup")) {
      signupBodies.push(JSON.parse(init?.body as string));
      return signupResponse();
    }
    return mockJson({}, 200);
  };
  const qc = await mount();
  await settle(qc);

  await act(async () => {
    await captured!.signup({
      email: "n@example.com",
      password: "password123",
      firstName: "New",
      lastName: "User",
      phone: "   ",
      marketingConsentEmail: false,
      // A stale true (the form clears this, but the context is the wire guarantee).
      marketingConsentSms: true,
    });
  });

  const body = lastSignupBody();
  assert.equal("phone" in body, false);
  assert.equal("marketingConsentSms" in body, false);
  assert.equal(body.marketingConsentEmail, false);
});

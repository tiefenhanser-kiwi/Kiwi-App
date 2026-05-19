// AuthContext render unit tests via react-test-renderer.
//
// Companion to the auth-bridge / client unit tests in lib/api/__tests__/.
// Those tests cover the wrapper-side mechanics of the 401 cascade;
// these tests cover the AuthContext-side behavior: what the cascade
// handler actually does to local state + cache, plus bootstrap-time
// race ordering, plus the action-path methods (login is unit-tested
// via lib/auth's loginRequest; logout + setUiState are tested here
// at the context boundary).
//
// Why react-test-renderer rather than @testing-library/react-native:
// every assertion here is on context VALUES (token, error, cached user,
// isBootstrapping), not on visual output or user events. r-t-r is the
// minimum dep tree that makes hooks runnable under node:test without
// pulling in jsdom or Jest globals.
//
// Why .ts and not .tsx: the file uses React.createElement to construct
// the test tree. node --experimental-strip-types handles .ts but not
// JSX; staying in .ts keeps the test infra unchanged (no tsx / no
// esbuild loader). AuthContext.ts itself is .ts for the same reason.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

// React 19's act() requires IS_REACT_ACT_ENVIRONMENT=true to commit renders
// synchronously and suppress the "not wrapped in act" warning. Test runners
// that ship with first-party React support (Jest, Vitest) set this for you;
// under bare node:test we set it explicitly BEFORE importing react.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import * as SecureStore from "expo-secure-store";

import { AuthProvider, useAuth } from "../AuthContext";
import {
  __resetForTests as resetAuthBridge,
  emitSessionExpired,
  subscribeSessionEvents,
} from "@/lib/api/auth-bridge";
import type { User } from "@/lib/types";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

type AuthValue = ReturnType<typeof useAuth>;
type FetchImpl = (url: string, init?: RequestInit) => Response | Promise<Response>;

// ── Fixtures ──────────────────────────────────────────────────────────────

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
    subscription: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function mockJson(body: unknown, status = 200): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return new Response(text, { status, headers: JSON_HEADERS });
}

// ── Test harness ──────────────────────────────────────────────────────────

let fetchImpl: FetchImpl;
let captured: AuthValue | null;
let renders: AuthValue[];
let activeRenderer: TestRenderer.ReactTestRenderer | null;

beforeEach(() => {
  captured = null;
  renders = [];
  activeRenderer = null;
  fetchImpl = () => mockJson({}, 200);
  (globalThis as { fetch: typeof fetch }).fetch = ((url: string, init?: RequestInit) =>
    Promise.resolve(fetchImpl(url, init))) as unknown as typeof fetch;
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
  resetAuthBridge();
});

afterEach(() => {
  // Unmount any tree left active by the test so its AuthProvider's
  // cascade subscription doesn't leak into subsequent tests' state.
  if (activeRenderer) {
    try {
      activeRenderer.unmount();
    } catch {
      // tree was already unmounted by the test — fine
    }
    activeRenderer = null;
  }
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
  resetAuthBridge();
});

function Probe(): null {
  const v = useAuth();
  captured = v;
  renders.push(v);
  return null;
}

interface MountResult {
  qc: QueryClient;
  unmount: () => void;
}

async function mount(opts: { initialToken?: string | null } = {}): Promise<MountResult> {
  if (opts.initialToken) {
    (SecureStore as unknown as { __setForTests(k: string, v: string): void }).__setForTests(
      TOKEN_KEY,
      opts.initialToken,
    );
  }

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });

  // TestRenderer.create commits the initial render synchronously. We wrap
  // the WHOLE setup in act so React 19's effects-after-commit phase flushes
  // before the test inspects state. Capture the renderer reference into
  // the outer scope for afterEach unmount + the returned handle.
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(AuthProvider, null, React.createElement(Probe)),
      ),
    );
  });
  activeRenderer = renderer;

  return {
    qc,
    unmount: () => {
      try {
        renderer.unmount();
      } catch {
        // already unmounted
      }
      if (activeRenderer === renderer) activeRenderer = null;
    },
  };
}

// Lets pending promises (storage read, useAuthMe query, cascade microtasks)
// settle. Polls up to ~50ms for any in-flight React Query fetches to land
// before returning — fixed-tick draining was a race (the mocked /auth/me
// fetch sometimes completed AFTER settle returned, then overwrote later
// setQueryData writes when the query's pending promise resolved). When qc
// is provided we exit as soon as `isFetching()` reports zero.
async function settle(qc?: QueryClient): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 25; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
      if (qc && qc.isFetching() === 0) return;
    }
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

test("1 — try/finally: resetCascade fires even when handler body throws", async () => {
  // Seed token + happy /auth/me so we reach the steady "authenticated" state
  // before injecting the failure.
  const user = makeUser();
  fetchImpl = () => mockJson({ user }, 200);
  const { qc } = await mount({ initialToken: "t-1" });
  await settle(qc);

  // Sanity: we are authenticated.
  assert.equal(captured!.isAuthenticated, true);

  // Inject a failure: cascade handler awaits clearToken → SecureStore.deleteItemAsync.
  // With __setThrowOn("deleteItemAsync"), the handler body rejects after the
  // first await. The finally block must still call resetCascade().
  (SecureStore as unknown as { __setThrowOn(method: string): void }).__setThrowOn(
    "deleteItemAsync",
  );

  // Swallow the resulting unhandledRejection so it doesn't fail the test
  // runner. (The handler is invoked async via queueMicrotask and isn't awaited
  // by auth-bridge, so the throw becomes an unhandled rejection.)
  const onUnhandled = (err: unknown) => {
    if (err instanceof Error && /deleteItemAsync forced failure/.test(err.message)) return;
    throw err;
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    await act(async () => {
      emitSessionExpired();
      await settle();
    });

    // Heal the stub so a second cascade can succeed.
    (SecureStore as unknown as { __setThrowOn(method: string | null): void }).__setThrowOn(
      null as unknown as string,
    );

    // Subscribe a fresh probe AFTER the first cascade so we can observe the
    // SECOND delivery in isolation.
    const seen: string[] = [];
    const unsub = subscribeSessionEvents((e) => seen.push(e));

    await act(async () => {
      emitSessionExpired();
      await settle();
    });
    unsub();

    // If resetCascade hadn't fired in the finally, this second emit would be
    // dropped by the in-flight flag. Seeing "expired" confirms the guarantee.
    assert.deepEqual(seen, ["expired"]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("2 — cascade clears every [\"auth\", *] key, not just [\"auth\", \"me\"]", async () => {
  // No fetch needed: we seed the cache directly with the keys we want to
  // assert get cleared. Mount with no token so useAuthMe stays disabled
  // (otherwise the cache write would race with the query's own writes).
  const { qc } = await mount({ initialToken: null });
  await settle(qc);

  await act(async () => {
    qc.setQueryData(["auth", "me"], makeUser());
    qc.setQueryData(["auth", "future-feature"], { stub: true });
    qc.setQueryData(["other", "domain"], { stub: true });
  });

  assert.notEqual(qc.getQueryData(["auth", "me"]), undefined);
  assert.notEqual(qc.getQueryData(["auth", "future-feature"]), undefined);

  await act(async () => {
    emitSessionExpired();
    await settle();
  });

  // Prefix-broadening — both ["auth", *] entries removed.
  assert.equal(qc.getQueryData(["auth", "me"]), undefined);
  assert.equal(qc.getQueryData(["auth", "future-feature"]), undefined);
  // Unrelated keys are untouched.
  assert.deepEqual(qc.getQueryData(["other", "domain"]), { stub: true });
});

test("3 — isBootstrapping derivation: storageRead + token + meQuery race", async () => {
  // Sub-case A: no stored token → settles to isBootstrapping=false, unauth.
  fetchImpl = () => {
    throw new Error("fetch should not run when token is null");
  };
  const a = await mount({ initialToken: null });
  await settle(a.qc);
  assert.equal(captured!.isLoading, false);
  assert.equal(captured!.isAuthenticated, false);
  assert.equal(captured!.user, null);
  assert.equal(captured!.token, null);
  a.unmount();

  // Sub-case B: stored token + /auth/me success → at least one intermediate
  // render with isBootstrapping=true (post-storage-read, pre-query-settled),
  // and final state is authenticated.
  const user = makeUser({ id: "u2" });
  fetchImpl = () => mockJson({ user }, 200);
  const b = await mount({ initialToken: "t-2" });

  // The Probe's FIRST render fires synchronously during mount, before the
  // storage-read useEffect's async body has resolved → storageRead=false →
  // isBootstrapping=true. r-t-r captures this via the `renders` array.
  assert.equal(renders[0].isLoading, true, "first render is bootstrapping");

  await settle(b.qc);

  assert.equal(captured!.isLoading, false, "final isLoading false");
  assert.equal(captured!.isAuthenticated, true);
  assert.equal(captured!.user?.id, "u2");
  assert.equal(captured!.token, "t-2");
  b.unmount();
});

test("4 — logout removes [\"auth\"] queries from cache (action-path coverage)", async () => {
  const user = makeUser();
  fetchImpl = () => mockJson({ user }, 200);
  const { qc } = await mount({ initialToken: "t-3" });
  await settle(qc);
  assert.equal(captured!.isAuthenticated, true);

  // Seed an additional ["auth", *] entry so the prefix-broadening covers more
  // than the one entry useAuthMe owns.
  await act(async () => {
    qc.setQueryData(["auth", "other-resource"], { stub: true });
  });
  assert.notEqual(qc.getQueryData(["auth", "other-resource"]), undefined);

  // logout's network call: stub /auth/logout returning 200 (its real wire is
  // a no-op in WS2). loginRequest's logoutRequest swallows any failure;
  // we keep this clean so test assertions stay focused on cache + state.
  fetchImpl = (url) => {
    if (typeof url === "string" && url.endsWith("/auth/logout")) {
      return new Response("", { status: 200 });
    }
    return mockJson({}, 200);
  };

  await act(async () => {
    await captured!.logout();
  });

  assert.equal(qc.getQueryData(["auth", "me"]), undefined);
  assert.equal(qc.getQueryData(["auth", "other-resource"]), undefined);
  assert.equal(captured!.token, null);
  assert.equal(captured!.user, null);
  assert.equal(captured!.error, null);
  assert.equal(captured!.isAuthenticated, false);
});

test("5 — setUiState writes through React Query cache (no setUser setter)", async () => {
  const user = makeUser({ lastMealsFilters: [] });
  fetchImpl = () => mockJson({ user }, 200);
  const { qc } = await mount({ initialToken: "t-4" });
  await settle(qc);
  assert.equal(captured!.isAuthenticated, true);
  assert.deepEqual(captured!.user?.lastMealsFilters, []);

  await act(async () => {
    captured!.setUiState({ lastMealsFilters: ["my_meals"] });
  });

  // Cache reflects the update — this is the contract setUiState upholds
  // (Execution Decision #8: writes via setQueryData, no deleted setUser).
  // We intentionally do NOT assert captured.user here: React Query's
  // notifyManager flushes observer-driven re-renders asynchronously, and
  // a captured.user check would race against that flush. The cache write
  // is the deterministic surface; the observer's downstream render is
  // React Query's responsibility, covered by their own tests.
  const cached = qc.getQueryData<User>(["auth", "me"]);
  assert.deepEqual(cached?.lastMealsFilters, ["my_meals"]);
  // Sanity: the rest of the user shape is preserved through the spread.
  assert.equal(cached?.id, user.id);

  // The debounced PATCH (400ms) is NOT drained — that path is lib/auth.ts's
  // patchUiState, unit-tested separately. We only assert the cache-side
  // optimistic write here.
});

test("6 — bootstrap-time 401 fires cascade and clears the stale token", async () => {
  // Cold-start scenario: SecureStore has a token left over from a prior
  // session, but the server has since invalidated it. /auth/me returns 401.
  fetchImpl = () =>
    mockJson({ error: "Token expired", userFacingMessage: "Token expired" }, 401);

  const { qc } = await mount({ initialToken: "t-stale" });
  await settle(qc);

  // Cascade clears state.
  assert.equal(captured!.token, null);
  assert.equal(captured!.isAuthenticated, false);
  assert.equal(
    captured!.error,
    "Your session expired. Please sign in again.",
    "cascade-set error message lands",
  );

  // Token storage cleared too.
  const stored = await SecureStore.getItemAsync(TOKEN_KEY);
  assert.equal(stored, null, "SecureStore token was deleted by cascade handler");
});

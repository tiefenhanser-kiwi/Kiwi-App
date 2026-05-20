// WS7-2 Block B Commit 4 — favorites migrated from AsyncStorage to React Query.
//
// toggleFavorite now writes the ['me','favorites'] cache optimistically, then
// POSTs/DELETEs, rolling the cache back on failure. These tests drive the
// public AppContext facade (favorites / toggleFavorite) through a mocked
// `fetch`, asserting the optimistic add / remove / rollback behavior on the
// React Query cache. Harness mirrors AppContext.mutators.test.ts.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { AppProvider, useApp } from "../AppContext";
import { AuthProvider } from "../AuthContext";
import { __resetForTests as resetAuthBridge } from "@/lib/api/auth-bridge";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;
const FAV_KEY = ["me", "favorites"] as const;

type AppValue = ReturnType<typeof useApp>;

function makeUser() {
  return {
    id: "u1",
    email: "hans@example.com",
    firstName: "Hans",
    lastName: "T",
    phone: null,
    zipCode: null,
    timezone: "UTC",
    accountStatus: "active",
    subscriptionStatus: "trialing",
    defaultHouseholdSize: 2,
    lastPlanDiscoveryFilters: [],
    lastPlansFilters: [],
    lastMealsFilters: [],
    marketingConsentEmail: false,
    marketingConsentSms: false,
    onboardingComplete: true,
    firstRunChoiceMade: true,
    subscription: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function mockJson(body: unknown, status = 200): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return new Response(text, { status, headers: JSON_HEADERS });
}

// ── Harness ───────────────────────────────────────────────────────────────

let routeTable: Map<string, () => Response>;
let app: AppValue | null;
let activeRenderer: TestRenderer.ReactTestRenderer | null;

function route(method: string, suffix: string, make: () => Response): void {
  routeTable.set(`${method} ${suffix}`, make);
}

beforeEach(() => {
  routeTable = new Map();
  app = null;
  activeRenderer = null;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const u = String(url);
    for (const [key, make] of routeTable) {
      const sep = key.indexOf(" ");
      if (key.slice(0, sep) === method && u.endsWith(key.slice(sep + 1))) {
        return Promise.resolve(make());
      }
    }
    return Promise.resolve(mockJson({}, 200));
  }) as unknown as typeof fetch;
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
  (AsyncStorage as unknown as { __resetForTests(): void }).__resetForTests();
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
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
  (AsyncStorage as unknown as { __resetForTests(): void }).__resetForTests();
  resetAuthBridge();
});

function Probe(): null {
  app = useApp();
  return null;
}

async function settle(qc: QueryClient): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 25; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
      if (qc.isFetching() === 0) return;
    }
  });
}

// Mounts an authenticated tree with the given initial server favorites.
// Settles twice: pass 1 drains GET /auth/me, pass 2 drains the favorites
// query that authUser then enables.
async function mountAuthed(initialFavorites: string[]): Promise<QueryClient> {
  (SecureStore as unknown as { __setForTests(k: string, v: string): void }).__setForTests(
    TOKEN_KEY,
    "test-token",
  );
  route("GET", "/auth/me", () => mockJson({ user: makeUser() }));
  route("GET", "/me/favorites", () =>
    mockJson({ favorites: initialFavorites }),
  );

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
          null,
          React.createElement(AppProvider, null, React.createElement(Probe)),
        ),
      ),
    );
  });
  activeRenderer = renderer;
  await settle(qc);
  await settle(qc);
  return qc;
}

// ── Tests ─────────────────────────────────────────────────────────────────

test("toggleFavorite optimistically adds and POSTs the new favorite", async () => {
  const qc = await mountAuthed([]);
  assert.deepEqual(qc.getQueryData(FAV_KEY), []);

  route("POST", "/me/favorites", () =>
    mockJson(
      { favorite: { id: "f1", mealId: "meal-1", createdAt: "2026-01-01" } },
      201,
    ),
  );

  await act(async () => {
    await app!.toggleFavorite("meal-1");
  });

  assert.deepEqual(qc.getQueryData(FAV_KEY), ["meal-1"]);
});

test("toggleFavorite optimistically removes and DELETEs an existing favorite", async () => {
  const qc = await mountAuthed(["meal-1"]);
  assert.deepEqual(qc.getQueryData(FAV_KEY), ["meal-1"]);

  route("DELETE", "/me/favorites/meal-1", () => mockJson({ success: true }));

  await act(async () => {
    await app!.toggleFavorite("meal-1");
  });

  assert.deepEqual(qc.getQueryData(FAV_KEY), []);
});

test("toggleFavorite rolls the cache back when the API call fails", async () => {
  const qc = await mountAuthed([]);
  assert.deepEqual(qc.getQueryData(FAV_KEY), []);

  route("POST", "/me/favorites", () =>
    mockJson({ error: "server_error" }, 500),
  );

  await act(async () => {
    await assert.rejects(() => app!.toggleFavorite("meal-1"));
  });

  // Optimistic add was rolled back — cache is empty again.
  assert.deepEqual(qc.getQueryData(FAV_KEY), []);
});

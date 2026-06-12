// WS7-7-A Block 3 — AppContext grocery item-mutation wire-ups.
//
// Covers toggleGroceryItemCompleted / toggleGroceryStapleSelection /
// updateGroceryItemQuantity / removeGroceryItem / restoreGroceryItem /
// markGroceryShoppingDone now that they call the real PATCH/DELETE/restore
// endpoints. Mounts the full QueryClient → AuthProvider → AppProvider tree
// and drives the mutators through a mocked `fetch` (same harness style as
// AppContext.mutators.test.ts — exercises apiClient + Zod end to end).

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
import { AuthProvider, useAuth } from "../AuthContext";
import { __resetForTests as resetAuthBridge } from "@/lib/api/auth-bridge";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

type AppValue = ReturnType<typeof useApp>;
type AuthValue = ReturnType<typeof useAuth>;

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeUser(overrides: Record<string, unknown> = {}) {
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
    subscription: {
      status: "trialing",
      planCode: "free",
      trialEndsAt: null,
      currentPeriodEnd: null,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function wireItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    displayName: "Tomato",
    quantity: 2,
    unit: "lb",
    storeSection: "produce",
    isChecked: false,
    isOptional: false,
    isAmbiguous: false,
    isUniversalStaple: false,
    isUserPantryStaple: false,
    isRecurringItem: false,
    stapleOptedIn: false,
    ambiguityOptions: [],
    userResolvedTo: null,
    notes: null,
    ...overrides,
  };
}

function mockJson(body: unknown, status = 200): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return new Response(text, { status, headers: JSON_HEADERS });
}

// ── Harness ───────────────────────────────────────────────────────────────

let routeTable: Map<string, (init?: RequestInit) => Response>;
let captured: { url: string; method: string; body: Record<string, unknown> | null } | null;
let app: AppValue | null;
let auth: AuthValue | null;
let activeRenderer: TestRenderer.ReactTestRenderer | null;

function route(
  method: string,
  suffix: string,
  make: (init?: RequestInit) => Response,
): void {
  routeTable.set(`${method} ${suffix}`, make);
}

beforeEach(() => {
  routeTable = new Map();
  captured = null;
  app = null;
  auth = null;
  activeRenderer = null;
  (globalThis as { fetch: typeof fetch }).fetch = ((
    url: string,
    init?: RequestInit,
  ) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const u = String(url);
    for (const [key, make] of routeTable) {
      const sep = key.indexOf(" ");
      const m = key.slice(0, sep);
      const suffix = key.slice(sep + 1);
      if (m === method && u.endsWith(suffix)) {
        captured = {
          url: u,
          method,
          body: init?.body
            ? (JSON.parse(String(init.body)) as Record<string, unknown>)
            : null,
        };
        return Promise.resolve(make(init));
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
  auth = useAuth();
  return null;
}

async function settle(qc?: QueryClient): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 25; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
      if (qc && qc.isFetching() === 0) return;
    }
  });
}

async function mountAuthed(): Promise<QueryClient> {
  (
    SecureStore as unknown as { __setForTests(k: string, v: string): void }
  ).__setForTests(TOKEN_KEY, "test-token");
  route("GET", "/auth/me", () => mockJson({ user: makeUser() }));

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
  return qc;
}

// ── toggleGroceryItemCompleted ──────────────────────────────────────────────

test("toggleGroceryItemCompleted PATCHes the item with { isChecked } and invalidates the lists cache", async () => {
  const qc = await mountAuthed();
  qc.setQueryData(["groceries", "list", null], []);

  route("PATCH", "/grocery-lists/list-1/items/item-1", () =>
    mockJson({ item: wireItem({ isChecked: true }) }),
  );

  let result: { isCompleted: boolean } | null = null;
  await act(async () => {
    result = await app!.toggleGroceryItemCompleted("list-1", "item-1", true);
  });

  assert.equal(captured?.method, "PATCH");
  assert.deepEqual(captured?.body, { isChecked: true });
  assert.equal(result!.isCompleted, true);
  // Groceries-tab list cache marked stale so itemCount/status refresh.
  const after = qc.getQueryState(["groceries", "list", null]);
  assert.equal(after?.isInvalidated, true);
});

test("toggleGroceryItemCompleted rejects on a server error (no silent swallow)", async () => {
  await mountAuthed();
  route("PATCH", "/grocery-lists/list-1/items/item-1", () =>
    mockJson({ error: "item_not_found" }, 404),
  );

  let caught: unknown = null;
  await act(async () => {
    try {
      await app!.toggleGroceryItemCompleted("list-1", "item-1", true);
    } catch (err) {
      caught = err;
    }
  });
  assert.ok(caught, "expected a throw the screen can catch to revert + alert");
});

// ── toggleGroceryStapleSelection ────────────────────────────────────────────

test("toggleGroceryStapleSelection PATCHes { stapleOptedIn } (opt-in and opt-out)", async () => {
  await mountAuthed();

  route("PATCH", "/grocery-lists/list-1/items/item-1", () =>
    mockJson({ item: wireItem({ stapleOptedIn: true }) }),
  );
  await act(async () => {
    await app!.toggleGroceryStapleSelection("list-1", "item-1", true);
  });
  assert.deepEqual(captured?.body, { stapleOptedIn: true });

  route("PATCH", "/grocery-lists/list-1/items/item-1", () =>
    mockJson({ item: wireItem({ stapleOptedIn: false }) }),
  );
  await act(async () => {
    await app!.toggleGroceryStapleSelection("list-1", "item-1", false);
  });
  assert.deepEqual(captured?.body, { stapleOptedIn: false });
});

// ── updateGroceryItemQuantity ───────────────────────────────────────────────

test("updateGroceryItemQuantity PATCHes { quantity, unit }", async () => {
  await mountAuthed();
  route("PATCH", "/grocery-lists/list-1/items/item-1", () =>
    mockJson({ item: wireItem({ quantity: 3, unit: "kg" }) }),
  );

  let result: { quantityAmount?: string; quantityUnit?: string } | null = null;
  await act(async () => {
    result = await app!.updateGroceryItemQuantity("list-1", "item-1", 3, "kg");
  });

  assert.deepEqual(captured?.body, { quantity: 3, unit: "kg" });
  assert.equal(result!.quantityAmount, "3");
  assert.equal(result!.quantityUnit, "kg");
});

// ── markGroceryShoppingDone ─────────────────────────────────────────────────

test("markGroceryShoppingDone PATCHes the list { status } both directions", async () => {
  await mountAuthed();

  route("PATCH", "/grocery-lists/list-1", () =>
    mockJson({ list: { id: "list-1", status: "completed" } }),
  );
  let done: string | null = null;
  await act(async () => {
    done = await app!.markGroceryShoppingDone("list-1", true);
  });
  assert.equal(captured?.method, "PATCH");
  assert.deepEqual(captured?.body, { status: "completed" });
  assert.equal(done, "completed");

  route("PATCH", "/grocery-lists/list-1", () =>
    mockJson({ list: { id: "list-1", status: "active" } }),
  );
  await act(async () => {
    done = await app!.markGroceryShoppingDone("list-1", false);
  });
  assert.deepEqual(captured?.body, { status: "active" });
  assert.equal(done, "active");
});

// ── remove → restore (undo flow, same id) ────────────────────────────────────

test("removeGroceryItem DELETEs the item; restoreGroceryItem POSTs /restore for the SAME id", async () => {
  const qc = await mountAuthed();
  qc.setQueryData(["groceries", "list", null], []);

  route("DELETE", "/grocery-lists/list-1/items/item-7", () =>
    mockJson({ item: wireItem({ id: "item-7" }) }),
  );
  await act(async () => {
    await app!.removeGroceryItem("list-1", "item-7");
  });
  assert.equal(captured?.method, "DELETE");
  assert.ok(captured?.url.endsWith("/grocery-lists/list-1/items/item-7"));
  // Invalidates the lists cache (itemCount drops).
  assert.equal(
    qc.getQueryState(["groceries", "list", null])?.isInvalidated,
    true,
  );

  route("POST", "/grocery-lists/list-1/items/item-7/restore", () =>
    mockJson({ item: wireItem({ id: "item-7" }) }),
  );
  let restored: { id: string } | null = null;
  await act(async () => {
    restored = await app!.restoreGroceryItem("list-1", "item-7");
  });
  assert.equal(captured?.method, "POST");
  assert.ok(
    captured?.url.endsWith("/grocery-lists/list-1/items/item-7/restore"),
  );
  assert.equal(restored!.id, "item-7"); // same row id, not a fresh one
});

test("removeGroceryItem rejects on a server error so the screen can re-insert the row", async () => {
  await mountAuthed();
  route("DELETE", "/grocery-lists/list-1/items/item-7", () =>
    mockJson({ error: "item_not_found" }, 404),
  );

  let caught: unknown = null;
  await act(async () => {
    try {
      await app!.removeGroceryItem("list-1", "item-7");
    } catch (err) {
      caught = err;
    }
  });
  assert.ok(caught, "expected removeGroceryItem to throw on 404");
});

// Pin authentication actually mounted (guards against a silent harness break
// that would make every assertion above vacuous).
test("harness sanity: the mounted tree is authenticated", async () => {
  await mountAuthed();
  assert.equal(auth!.isAuthenticated, true);
});

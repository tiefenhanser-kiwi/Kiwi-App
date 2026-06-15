// WS7-3 Block C1 — tests for lib/api/groceries.ts.
// Covers the getter + schema (getGroceryLists fetch-mocked round-trips, the
// ?filter= query construction, 401 / schema-mismatch propagation) and the
// useGroceryLists React Query hook (loading→data).

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import * as SecureStore from "expo-secure-store";

import {
  chipLabel,
  getGroceryLists,
  GroceryListListItemSchema,
  planLinkTarget,
} from "../groceries";
import { ApiSchemaError, UnauthenticatedError } from "../errors";
import { __resetForTests as resetAuthBridge } from "../auth-bridge";
import { useGroceryLists } from "@/hooks/useGroceryLists";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

// ── Fixtures ────────────────────────────────────────────────────────────────

const PLAN_LIST = {
  id: "gl-1",
  title: "Spice It Up — Groceries",
  status: "active",
  sourceType: "plan",
  mealPlanInstanceId: "plan-1",
  isActiveThisWeek: true,
  itemCount: 24,
  lastGeneratedAt: "2026-05-20T12:00:00.000Z",
  createdAt: "2026-05-20T12:00:00.000Z",
};

// A list not derived from a plan — mealPlanInstanceId is null.
const STANDALONE_LIST = {
  id: "gl-2",
  title: "Quick Trip",
  status: "draft",
  sourceType: "manual",
  mealPlanInstanceId: null,
  isActiveThisWeek: false,
  itemCount: 3,
  lastGeneratedAt: null,
  createdAt: "2026-05-21T09:00:00.000Z",
};

const GROCERY_LISTS_RESPONSE = { groceryLists: [PLAN_LIST, STANDALONE_LIST] };

// ── Harness ─────────────────────────────────────────────────────────────────

function mockJson(body: unknown, status = 200): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return new Response(text, { status, headers: JSON_HEADERS });
}

let nextResponse: () => Response;
let lastUrl: string | null;

beforeEach(() => {
  lastUrl = null;
  nextResponse = () => mockJson(GROCERY_LISTS_RESPONSE);
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: string) => {
    lastUrl = url;
    return nextResponse();
  }) as unknown as typeof fetch;
  (
    SecureStore as unknown as { __setForTests(k: string, v: string): void }
  ).__setForTests(TOKEN_KEY, "test-token");
  resetAuthBridge();
});

afterEach(() => {
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
  resetAuthBridge();
});

// ── Schema ──────────────────────────────────────────────────────────────────

test("GroceryListListItemSchema parses plan-derived and standalone rows", () => {
  assert.equal(
    GroceryListListItemSchema.parse(PLAN_LIST).mealPlanInstanceId,
    "plan-1",
  );
  assert.equal(
    GroceryListListItemSchema.parse(STANDALONE_LIST).mealPlanInstanceId,
    null,
  );
});

// ── chipLabel (WS7-7-A B6 item 5 — chip whitelist) ───────────────────────────

test("chipLabel: isActiveThisWeek wins the slot regardless of status", () => {
  // Even when the underlying status is completed/ordered, This Week wins.
  assert.equal(chipLabel({ isActiveThisWeek: true, status: "active" }), "This Week");
  assert.equal(chipLabel({ isActiveThisWeek: true, status: "completed" }), "This Week");
  assert.equal(chipLabel({ isActiveThisWeek: true, status: "ordered" }), "This Week");
});

test("chipLabel: completed and ordered surface their own chip", () => {
  assert.equal(chipLabel({ isActiveThisWeek: false, status: "completed" }), "Completed");
  assert.equal(chipLabel({ isActiveThisWeek: false, status: "ordered" }), "Ordered");
});

test("chipLabel: draft / active / archived render no chip", () => {
  assert.equal(chipLabel({ isActiveThisWeek: false, status: "draft" }), null);
  assert.equal(chipLabel({ isActiveThisWeek: false, status: "active" }), null);
  assert.equal(chipLabel({ isActiveThisWeek: false, status: "archived" }), null);
});

// ── planLinkTarget (WS7-7-A B6 item 6 — View Meal Plan link) ──────────────────

test("planLinkTarget: builds the /plan/[id] descriptor for a plan-derived list", () => {
  const target = planLinkTarget({ mealPlanInstanceId: "plan-42" });
  assert.deepEqual(target, {
    pathname: "/plan/[id]",
    params: { id: "plan-42" },
  });
});

test("planLinkTarget: returns null when the list has no linked plan (no link rendered)", () => {
  assert.equal(planLinkTarget({ mealPlanInstanceId: null }), null);
});

// ── getGroceryLists ─────────────────────────────────────────────────────────

test("getGroceryLists returns the unwrapped list array", async () => {
  const lists = await getGroceryLists();
  assert.equal(lists.length, 2);
  assert.equal(lists[0].itemCount, 24);
});

test("getGroceryLists with no filter omits the query param", async () => {
  await getGroceryLists();
  assert.ok(lastUrl?.endsWith("/grocery-lists"), `unexpected url: ${lastUrl}`);
});

test("getGroceryLists appends the active/past filter", async () => {
  await getGroceryLists("past");
  assert.ok(
    lastUrl?.endsWith("/grocery-lists?filter=past"),
    `unexpected url: ${lastUrl}`,
  );
});

test("getGroceryLists propagates a 401 as an UnauthenticatedError", async () => {
  nextResponse = () => mockJson({ error: "unauthenticated" }, 401);
  await assert.rejects(
    () => getGroceryLists(),
    (err: unknown) => err instanceof UnauthenticatedError,
  );
});

test("getGroceryLists rejects a malformed response body", async () => {
  // itemCount as a string — fails GroceryListListItemSchema validation.
  nextResponse = () =>
    mockJson({ groceryLists: [{ ...PLAN_LIST, itemCount: "lots" }] });
  await assert.rejects(
    () => getGroceryLists(),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});

// ── useGroceryLists ─────────────────────────────────────────────────────────

// Drains in-flight React Query fetches inside an act() pass.
async function settle(qc: QueryClient): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 25; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
      if (qc.isFetching() === 0) return;
    }
  });
}

test("useGroceryLists transitions from loading to data", async () => {
  nextResponse = () => mockJson(GROCERY_LISTS_RESPONSE);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let latest: ReturnType<typeof useGroceryLists> | null = null;
  let sawLoading = false;
  function Probe(): null {
    const q = useGroceryLists("active");
    if (q.isLoading) sawLoading = true;
    latest = q;
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Probe),
      ),
    );
  });

  assert.equal(sawLoading, true);
  await settle(qc);

  assert.equal(latest!.isLoading, false);
  assert.equal(latest!.data?.length, 2);
  renderer.unmount();
});

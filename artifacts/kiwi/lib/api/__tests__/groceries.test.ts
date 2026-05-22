// WS7-3 Block C1 — tests for lib/api/groceries.ts.
// C1.1 covers the getter + schema: getGroceryLists fetch-mocked round-trips,
// the ?filter= query construction, and 401 / schema-mismatch propagation. The
// useGroceryLists hook test is appended in C1.2.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import * as SecureStore from "expo-secure-store";

import { getGroceryLists, GroceryListListItemSchema } from "../groceries";
import { ApiSchemaError, UnauthenticatedError } from "../errors";
import { __resetForTests as resetAuthBridge } from "../auth-bridge";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

// ── Fixtures ────────────────────────────────────────────────────────────────

const PLAN_LIST = {
  id: "gl-1",
  title: "Spice It Up — Groceries",
  status: "active",
  sourceType: "plan",
  mealPlanInstanceId: "plan-1",
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

// CLIENT-9 D (BUG-472) — lib/api/staples.ts against SERVER-13 A's contract, and
// the grocery wire's ingredientId (which a staple is keyed by). Same fetch-mock
// harness as grocery.test.ts.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import * as SecureStore from "expo-secure-store";

import { addStaple, getStaples, removeStaple } from "../staples";
import { getGroceryList } from "../grocery";
import { ApiError } from "../errors";
import { __resetForTests as resetAuthBridge } from "../auth-bridge";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

const STAPLE = { id: "st-1", ingredientId: "ing-garlic-powder", name: "garlic powder", createdAt: "2026-10-30T12:00:00.000Z" };

function mockJson(body: unknown, status = 200): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return new Response(text, { status, headers: JSON_HEADERS });
}

let nextResponse: () => Response;
let lastUrl: string | null;
let lastMethod: string | null;
let lastBody: Record<string, unknown> | null;

beforeEach(() => {
  lastUrl = null;
  lastMethod = null;
  lastBody = null;
  nextResponse = () => mockJson({ items: [STAPLE] });
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: string, init?: RequestInit) => {
    lastUrl = String(url);
    lastMethod = (init?.method ?? "GET").toUpperCase();
    lastBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    return nextResponse();
  }) as unknown as typeof fetch;
  (SecureStore as unknown as { __setForTests(k: string, v: string): void }).__setForTests(TOKEN_KEY, "test-token");
  resetAuthBridge();
});

afterEach(() => {
  (SecureStore as unknown as { __resetForTests(): void }).__resetForTests();
  resetAuthBridge();
});

test("getStaples: GET /me/staples → the items, as sent", async () => {
  nextResponse = () => mockJson({ items: [STAPLE, { ...STAPLE, id: "st-2", ingredientId: null, name: "olive oil" }] });
  const items = await getStaples();
  assert.equal(lastMethod, "GET");
  assert.match(lastUrl!, /\/me\/staples$/);
  assert.deepEqual(items.map((s) => s.name), ["garlic powder", "olive oil"]);
  assert.equal(items[1].ingredientId, null);
});

test("addStaple: POST /me/staples { groceryItemId } → the 201 staple", async () => {
  nextResponse = () => mockJson(STAPLE, 201);
  const staple = await addStaple("gi-7");
  assert.equal(lastMethod, "POST");
  assert.match(lastUrl!, /\/me\/staples$/);
  assert.deepEqual(lastBody, { groceryItemId: "gi-7" });
  assert.deepEqual(staple, STAPLE);
});

test("addStaple: a 409 (already a staple) resolves with the staple the server names", async () => {
  nextResponse = () => mockJson({ error: "already a staple", reason: "staple_exists", staple: STAPLE }, 409);
  assert.deepEqual(await addStaple("gi-7"), STAPLE);
});

test("addStaple: a 422 (no catalog ingredient) and a 404 throw", async () => {
  nextResponse = () => mockJson({ error: "This item can't be a staple.", reason: "no_catalog_ingredient" }, 422);
  await assert.rejects(addStaple("gi-typed"), (e) => e instanceof ApiError && e.status === 422);
  nextResponse = () => mockJson({ error: "grocery item not found" }, 404);
  await assert.rejects(addStaple("gi-other"), (e) => e instanceof ApiError && e.status === 404);
});

test("removeStaple: DELETE /me/staples/:id → 204; a 404 is already the outcome", async () => {
  nextResponse = () => new Response(null, { status: 204 });
  await removeStaple("st 1");
  assert.equal(lastMethod, "DELETE");
  assert.match(lastUrl!, /\/me\/staples\/st%201$/);
  nextResponse = () => mockJson({ error: "staple not found" }, 404);
  await removeStaple("st-gone");
  nextResponse = () => mockJson({ error: "failed to remove staple" }, 500);
  await assert.rejects(removeStaple("st-1"), (e) => e instanceof ApiError && e.status === 500);
});

test("the grocery wire keeps a row's ingredientId (null for a typed-in item; absent stays absent)", async () => {
  const row = (o: Record<string, unknown>) => ({
    id: "gi-1", displayName: "Garlic powder", quantity: 1, unit: "tsp", storeSection: "pantry",
    isChecked: false, isOptional: false, isAmbiguous: false, isUniversalStaple: false, isUserPantryStaple: false,
    isRecurringItem: false, stapleOptedIn: false, ambiguityOptions: [], userResolvedTo: null, notes: null, ...o,
  });
  nextResponse = () =>
    mockJson({
      list: {
        id: "list-1", title: "G", mealPlanInstanceId: "plan-1", status: "active", createdAt: "2026-10-30T00:00:00.000Z",
        planInstance: { id: "plan-1", isActiveThisWeek: true },
        items: [row({ ingredientId: "ing-gp" }), row({ id: "gi-2", ingredientId: null }), row({ id: "gi-3" }), row({ id: "gi-4", isUserPantryStaple: true, ingredientId: "ing-oil" })],
      },
    });
  const { list } = await getGroceryList("list-1");
  assert.equal(list.items[0].ingredientId, "ing-gp");
  assert.equal(list.items[1].ingredientId, null);
  assert.equal("ingredientId" in list.items[2], false);
  // A user staple reads as a staple (the fold this lane relies on).
  assert.equal(list.items[3].isUniversalStaple, true);
});

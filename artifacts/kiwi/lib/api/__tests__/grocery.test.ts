// WS7-7-A Block 3 — tests for the lib/api/grocery.ts item-mutation clients
// and the wire-shape fix (status enum gained `completed`). Same fetch-mock
// harness as groceries.test.ts: a stubbed global.fetch captures the request
// (method + url + body) and serves a canned response; SecureStore seeds a
// token so apiClient attaches Authorization.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import * as SecureStore from "expo-secure-store";

import {
  getGroceryList,
  lookupGroceryItemCandidates,
  updateGroceryListStatus,
  updateGroceryListItem,
  deleteGroceryListItem,
  restoreGroceryListItem,
} from "../grocery";
import { ApiNetworkError, ApiSchemaError } from "../errors";
import { __resetForTests as resetAuthBridge } from "../auth-bridge";

const TOKEN_KEY = "kiwi_authToken";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

// ── Fixtures ────────────────────────────────────────────────────────────────

// A full GroceryListItem wire row (mirrors the server Prisma row the GET /
// PATCH / DELETE / restore endpoints return). stapleOptedIn is the B3 field.
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

function wireList(overrides: Record<string, unknown> = {}) {
  return {
    id: "list-1",
    title: "Groceries: Family Dinners",
    mealPlanInstanceId: "plan-1",
    status: "active",
    createdAt: "2026-06-01T00:00:00.000Z",
    items: [wireItem()],
    planInstance: { id: "plan-1", isActiveThisWeek: true },
    ...overrides,
  };
}

function mockJson(body: unknown, status = 200): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return new Response(text, { status, headers: JSON_HEADERS });
}

// ── Harness ─────────────────────────────────────────────────────────────────

let nextResponse: () => Response;
let lastUrl: string | null;
let lastMethod: string | null;
let lastBody: Record<string, unknown> | null;
let lastSignal: AbortSignal | null;

beforeEach(() => {
  lastUrl = null;
  lastMethod = null;
  lastBody = null;
  lastSignal = null;
  nextResponse = () => mockJson({ item: wireItem() });
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    url: string,
    init?: RequestInit,
  ) => {
    lastUrl = String(url);
    lastMethod = (init?.method ?? "GET").toUpperCase();
    lastBody = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : null;
    lastSignal = init?.signal ?? null;
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

// ── Wire-shape regression — `completed` status must parse ─────────────────────

test("getGroceryList parses a completed-status list WITHOUT error (B3 wire-shape fix)", async () => {
  nextResponse = () => mockJson({ list: wireList({ status: "completed" }) });
  const { list } = await getGroceryList("list-1");
  // The pre-fix enum (draft/active/ordered/archived) would have thrown
  // ApiSchemaError here; `completed` now round-trips to the mobile union.
  assert.equal(list.status, "completed");
});

test("getGroceryList maps the server stapleOptedIn flag onto each item", async () => {
  nextResponse = () =>
    mockJson({
      list: wireList({ items: [wireItem({ stapleOptedIn: true })] }),
    });
  const { list } = await getGroceryList("list-1");
  assert.equal(list.items[0].stapleOptedIn, true);
});

test("getGroceryList maps per-item mealNames provenance (1-to-many) — WS9 3e Part 2.2", async () => {
  nextResponse = () =>
    mockJson({
      list: wireList({
        items: [
          wireItem({
            id: "gi-1",
            mealNames: ["Chicken Biryani", "Garlic Naan"],
          }),
        ],
      }),
    });
  const { list } = await getGroceryList("list-1");
  assert.deepEqual(list.items[0].mealNames, ["Chicken Biryani", "Garlic Naan"]);
});

test("getGroceryList leaves mealNames undefined for a zero-source item (no label) — WS9 3e Part 2.2", async () => {
  // Server sends [] (or omits) for merged/AI-tail rows; the client maps that to
  // undefined so the row renders no provenance label (graceful absence).
  nextResponse = () =>
    mockJson({ list: wireList({ items: [wireItem({ mealNames: [] })] }) });
  const { list } = await getGroceryList("list-1");
  assert.equal(list.items[0].mealNames, undefined);
});

test("getGroceryList surfaces the server reconciled flag (B5)", async () => {
  nextResponse = () => mockJson({ list: wireList({}), reconciled: true });
  const { reconciled } = await getGroceryList("list-1");
  assert.equal(reconciled, true);
});

test("getGroceryList defaults reconciled to false when the server omits it", async () => {
  nextResponse = () => mockJson({ list: wireList({}) });
  const { reconciled } = await getGroceryList("list-1");
  assert.equal(reconciled, false);
});

test("getGroceryList still rejects an unknown status value (enum stays strict)", async () => {
  nextResponse = () => mockJson({ list: wireList({ status: "weird" }) });
  await assert.rejects(
    () => getGroceryList("list-1"),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});

// ── updateGroceryListStatus ───────────────────────────────────────────────────

test("updateGroceryListStatus PATCHes /grocery-lists/:id with { status } and returns it", async () => {
  nextResponse = () =>
    mockJson({ list: { id: "list-1", status: "completed" } });
  const status = await updateGroceryListStatus("list-1", "completed");
  assert.equal(lastMethod, "PATCH");
  assert.ok(lastUrl?.endsWith("/grocery-lists/list-1"), `url: ${lastUrl}`);
  assert.deepEqual(lastBody, { status: "completed" });
  assert.equal(status, "completed");
});

test("updateGroceryListStatus can set status back to active (reversible)", async () => {
  nextResponse = () => mockJson({ list: { id: "list-1", status: "active" } });
  const status = await updateGroceryListStatus("list-1", "active");
  assert.deepEqual(lastBody, { status: "active" });
  assert.equal(status, "active");
});

// ── updateGroceryListItem ─────────────────────────────────────────────────────

test("updateGroceryListItem PATCHes the item with the patch body and returns the normalized row", async () => {
  nextResponse = () => mockJson({ item: wireItem({ isChecked: true }) });
  const item = await updateGroceryListItem("list-1", "item-1", {
    isChecked: true,
  });
  assert.equal(lastMethod, "PATCH");
  assert.ok(
    lastUrl?.endsWith("/grocery-lists/list-1/items/item-1"),
    `url: ${lastUrl}`,
  );
  assert.deepEqual(lastBody, { isChecked: true });
  // normalizeListItem folds isChecked → isCompleted.
  assert.equal(item.isCompleted, true);
});

test("updateGroceryListItem forwards a quantity+unit patch and a stapleOptedIn patch", async () => {
  nextResponse = () =>
    mockJson({ item: wireItem({ quantity: 3, unit: "kg" }) });
  const item = await updateGroceryListItem("list-1", "item-1", {
    quantity: 3,
    unit: "kg",
  });
  assert.deepEqual(lastBody, { quantity: 3, unit: "kg" });
  assert.equal(item.quantityAmount, "3");
  assert.equal(item.quantityUnit, "kg");

  nextResponse = () => mockJson({ item: wireItem({ stapleOptedIn: true }) });
  const staple = await updateGroceryListItem("list-1", "item-1", {
    stapleOptedIn: true,
  });
  assert.deepEqual(lastBody, { stapleOptedIn: true });
  assert.equal(staple.stapleOptedIn, true);
});

// ── deleteGroceryListItem / restoreGroceryListItem (undo round-trip) ───────────

test("deleteGroceryListItem DELETEs and returns the deleted item shape", async () => {
  nextResponse = () => mockJson({ item: wireItem({ id: "item-9" }) });
  const item = await deleteGroceryListItem("list-1", "item-9");
  assert.equal(lastMethod, "DELETE");
  assert.ok(
    lastUrl?.endsWith("/grocery-lists/list-1/items/item-9"),
    `url: ${lastUrl}`,
  );
  assert.equal(item.id, "item-9");
});

test("restoreGroceryListItem POSTs /restore and returns the item with the SAME id", async () => {
  nextResponse = () => mockJson({ item: wireItem({ id: "item-9" }) });
  const item = await restoreGroceryListItem("list-1", "item-9");
  assert.equal(lastMethod, "POST");
  assert.ok(
    lastUrl?.endsWith("/grocery-lists/list-1/items/item-9/restore"),
    `url: ${lastUrl}`,
  );
  assert.equal(item.id, "item-9"); // restore preserves the row id (D-WS6-082)
});

test("updateGroceryListItem rejects a malformed item response (schema guard)", async () => {
  // quantity as a string fails GroceryListItemWireSchema.
  nextResponse = () =>
    mockJson({ item: wireItem({ quantity: "lots" }) });
  await assert.rejects(
    () => updateGroceryListItem("list-1", "item-1", { isChecked: true }),
    (err: unknown) => err instanceof ApiSchemaError,
  );
});

// ── lookupGroceryItemCandidates — BUG-027 client-timeout/abort ────────────────
// The add-item predictive search could spin forever because the debounced
// effect never aborted a hung zero-hit AI fallback (apiClient imposes no
// client-side timeout). The fix threads an AbortSignal so the screen can wrap
// the call in an AbortController + short timeout; on abort the promise SETTLES
// (rejects) so the effect's .finally clears candidatesLoading. These pin (1)
// the signal reaches fetch and (2) an abort surfaces as a settled rejection.

test("lookupGroceryItemCandidates forwards an AbortSignal to fetch (BUG-027)", async () => {
  nextResponse = () => mockJson({ source: "lookup", candidates: [] });
  const controller = new AbortController();
  await lookupGroceryItemCandidates("tomato", { signal: controller.signal });
  assert.equal(lastMethod, "GET");
  assert.ok(
    lastUrl?.includes("/grocery-items/lookup?q=tomato"),
    `unexpected url: ${lastUrl}`,
  );
  assert.equal(lastSignal, controller.signal);
});

test("lookupGroceryItemCandidates surfaces a timeout-abort as a settled rejection (BUG-027)", async () => {
  // A fetch that rejects with a real AbortError when the signal is already
  // aborted — same shape RN/Node fetch produces when the client timeout fires.
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    _url: string,
    init?: { signal?: AbortSignal },
  ) => {
    if (init?.signal?.aborted) {
      const e = new Error("The operation was aborted.");
      e.name = "AbortError";
      throw e;
    }
    return mockJson({ source: "lookup", candidates: [] });
  }) as unknown as typeof fetch;

  const controller = new AbortController();
  controller.abort();
  // The promise must SETTLE (reject) rather than hang — that is what lets the
  // effect's .catch/.finally clear the spinner. apiClient wraps the AbortError
  // in ApiNetworkError with the AbortError as its cause.
  await assert.rejects(
    () => lookupGroceryItemCandidates("tomato", { signal: controller.signal }),
    (err: unknown) => {
      if (!(err instanceof ApiNetworkError)) return false;
      const cause = (err as { cause?: unknown }).cause;
      return cause instanceof Error && cause.name === "AbortError";
    },
  );
});

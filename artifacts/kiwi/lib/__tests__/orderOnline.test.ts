// Row 8 Block 3 — "Order Online" is the entry to ordering, not a stub.
// Has-list → navigate, no generate. No-list → the confirmation with the exact
// ruled copy; "Not now" calls nothing; "Create list" runs the existing
// generate flow exactly once. The list-existence read is Home first, then the
// cached Groceries index.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ORDER_ONLINE_CONFIRM_BODY,
  ORDER_ONLINE_CONFIRM_CANCEL,
  ORDER_ONLINE_CONFIRM_CREATE,
  ORDER_ONLINE_CONFIRM_TITLE,
  decideOrderOnline,
  dispatchOrderOnline,
  resolveKnownGroceryListId,
  type OrderOnlineConfirmSpec,
} from "../orderOnline";

function sinks() {
  const calls = { navigate: [] as string[], generate: 0, confirm: [] as OrderOnlineConfirmSpec[] };
  return {
    calls,
    sinks: {
      navigate: (id: string) => void calls.navigate.push(id),
      confirm: (spec: OrderOnlineConfirmSpec) => void calls.confirm.push(spec),
      generate: () => void calls.generate++,
    },
  };
}

const NONE = { home: undefined, groceryIndex: [] };

test("has-list (Home pointer): navigate straight to the list, no confirm, no generate", () => {
  const { calls, sinks: s } = sinks();
  const action = dispatchOrderOnline(
    "plan-1",
    { home: { activePlan: { id: "plan-1", groceryListId: "gl-9" } }, groceryIndex: [] },
    s,
  );
  assert.deepEqual(action, { kind: "navigate", listId: "gl-9" });
  assert.deepEqual(calls.navigate, ["gl-9"]);
  assert.equal(calls.confirm.length, 0);
  assert.equal(calls.generate, 0);
});

test("has-list (Groceries index): matched on mealPlanInstanceId, no generate", () => {
  const { calls, sinks: s } = sinks();
  const action = dispatchOrderOnline(
    "plan-2",
    {
      home: { activePlan: { id: "plan-1", groceryListId: "gl-9" } },
      groceryIndex: [
        { id: "gl-a", mealPlanInstanceId: "plan-x" },
        { id: "gl-b", mealPlanInstanceId: "plan-2" },
        { id: "gl-c", mealPlanInstanceId: null },
      ],
    },
    s,
  );
  assert.deepEqual(action, { kind: "navigate", listId: "gl-b" });
  assert.deepEqual(calls.navigate, ["gl-b"]);
  assert.equal(calls.generate, 0);
});

test("no-list: the confirmation renders with the exact copy; nothing else fires", () => {
  const { calls, sinks: s } = sinks();
  const action = dispatchOrderOnline("plan-3", NONE, s);
  assert.deepEqual(action, { kind: "confirm" });
  assert.equal(calls.navigate.length, 0);
  assert.equal(calls.generate, 0, "a curious tap must not start generation");
  assert.equal(calls.confirm.length, 1);
  const spec = calls.confirm[0];
  assert.equal(spec.title, "Create your grocery list?");
  assert.equal(
    spec.body,
    "Kiwi builds it from this plan's meals. You'll review it before anything is sent to a store.",
  );
  assert.equal(spec.cancelLabel, "Not now");
  assert.equal(spec.confirmLabel, "Create list");
  // No time estimate in the copy (§27: nothing measures generation end to end).
  assert.doesNotMatch(spec.title + spec.body, /\d|second|minute|moment/i);
});

test("no-list: 'Not now' calls nothing; 'Create list' runs the existing generate flow once", () => {
  const { calls, sinks: s } = sinks();
  dispatchOrderOnline("plan-3", NONE, s);
  // "Not now" is a cancel button with no handler — the spec carries none.
  assert.equal(calls.generate, 0);
  assert.equal(calls.navigate.length, 0);
  calls.confirm[0].onConfirm();
  assert.equal(calls.generate, 1);
  assert.equal(calls.navigate.length, 0, "navigation is the generate flow's, not ours");
});

test("resolveKnownGroceryListId: Home pointer only counts for THIS plan and only when non-null", () => {
  assert.equal(
    resolveKnownGroceryListId("plan-1", {
      home: { activePlan: { id: "other", groceryListId: "gl-9" } },
      groceryIndex: [],
    }),
    null,
  );
  assert.equal(
    resolveKnownGroceryListId("plan-1", {
      home: { activePlan: { id: "plan-1", groceryListId: null } },
      groceryIndex: [],
    }),
    null,
  );
  assert.equal(
    resolveKnownGroceryListId("plan-1", { home: { activePlan: null }, groceryIndex: [] }),
    null,
  );
  // Home's null pointer is not a veto — the index can still know.
  assert.equal(
    resolveKnownGroceryListId("plan-1", {
      home: { activePlan: { id: "plan-1", groceryListId: null } },
      groceryIndex: [{ id: "gl-z", mealPlanInstanceId: "plan-1" }],
    }),
    "gl-z",
  );
});

test("decideOrderOnline: the pure decision", () => {
  assert.deepEqual(decideOrderOnline("gl-1"), { kind: "navigate", listId: "gl-1" });
  assert.deepEqual(decideOrderOnline(null), { kind: "confirm" });
});

test("copy constants are what the screens render", () => {
  assert.equal(ORDER_ONLINE_CONFIRM_TITLE, "Create your grocery list?");
  assert.equal(
    ORDER_ONLINE_CONFIRM_BODY,
    "Kiwi builds it from this plan's meals. You'll review it before anything is sent to a store.",
  );
  assert.equal(ORDER_ONLINE_CONFIRM_CANCEL, "Not now");
  assert.equal(ORDER_ONLINE_CONFIRM_CREATE, "Create list");
});

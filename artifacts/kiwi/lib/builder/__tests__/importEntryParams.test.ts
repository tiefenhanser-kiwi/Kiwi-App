// WS9 3f-3 (D-WS9-005) — the SEND side of the import-entry contract. Pins that
// each completion context threads exactly the route params its matching
// resolvePostSaveNav outcome consumes (the two must stay symmetric).

import assert from "node:assert/strict";
import { test } from "node:test";

import { importEntryParams } from "../importEntryParams";
import { resolvePostSaveNav } from "../postSaveNav";

test("library context threads NO plan params → resolver lands on meal-detail", () => {
  const params = importEntryParams({ kind: "library" });
  assert.deepEqual(params, {});
  const nav = resolvePostSaveNav({ newMealId: "m", ...params });
  assert.equal(nav.kind, "meal-detail");
});

test("append context threads addToPlanId → resolver lands on plan-back", () => {
  const params = importEntryParams({ kind: "append", planId: "plan-7" });
  assert.deepEqual(params, { addToPlanId: "plan-7" });
  const nav = resolvePostSaveNav({ newMealId: "m", ...params });
  assert.deepEqual(nav, { kind: "plan-back", planId: "plan-7" });
});

test("replace context threads planId + planItemId → resolver lands on plan-replace", () => {
  const params = importEntryParams({
    kind: "replace",
    planId: "plan-7",
    planItemId: "item-42",
  });
  assert.deepEqual(params, { planId: "plan-7", planItemId: "item-42" });
  const nav = resolvePostSaveNav({ newMealId: "m", ...params });
  assert.deepEqual(nav, {
    kind: "plan-replace",
    planId: "plan-7",
    planItemId: "item-42",
  });
});

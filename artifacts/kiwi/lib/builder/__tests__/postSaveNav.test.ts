// WS7-6 G2 scope (i) — post-save nav contract. The Meal Builder save handler
// can't render in the node harness (it pulls react-native-draggable-flatlist),
// so the destination decision lives in a pure helper that's tested directly.

import assert from "node:assert/strict";
import { test } from "node:test";

import { resolvePostSaveNav } from "../postSaveNav";

test("non-plan save lands on the new meal's Meal Detail page", () => {
  const nav = resolvePostSaveNav({ newMealId: "meal-123" });
  assert.deepEqual(nav, { kind: "meal-detail", mealId: "meal-123" });
});

test("non-plan save with undefined addToPlanId still lands on Meal Detail", () => {
  const nav = resolvePostSaveNav({ newMealId: "meal-9", addToPlanId: undefined });
  assert.deepEqual(nav, { kind: "meal-detail", mealId: "meal-9" });
});

test("plan-context save keeps its contextual return to the plan", () => {
  const nav = resolvePostSaveNav({ newMealId: "meal-123", addToPlanId: "plan-7" });
  assert.deepEqual(nav, { kind: "plan-back" });
});

test("the new meal id threads through to the Meal Detail target", () => {
  const nav = resolvePostSaveNav({ newMealId: "abc-xyz" });
  assert.equal(nav.kind === "meal-detail" ? nav.mealId : null, "abc-xyz");
});

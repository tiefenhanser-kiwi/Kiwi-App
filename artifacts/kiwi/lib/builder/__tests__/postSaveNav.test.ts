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

test("plan-context save returns to the plan, carrying the planId for dismissTo", () => {
  const nav = resolvePostSaveNav({ newMealId: "meal-123", addToPlanId: "plan-7" });
  assert.deepEqual(nav, { kind: "plan-back", planId: "plan-7" });
});

test("plan-back threads the addToPlanId through as the dismissTo target", () => {
  const nav = resolvePostSaveNav({ newMealId: "m1", addToPlanId: "plan-xyz" });
  assert.equal(nav.kind === "plan-back" ? nav.planId : null, "plan-xyz");
});

test("the new meal id threads through to the Meal Detail target", () => {
  const nav = resolvePostSaveNav({ newMealId: "abc-xyz" });
  assert.equal(nav.kind === "meal-detail" ? nav.mealId : null, "abc-xyz");
});

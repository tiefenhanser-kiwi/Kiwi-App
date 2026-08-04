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

// ── WS9 3f-3 (D-WS9-005) — the replace outcome ──────────────────────────────

test("swap-context save (planId + planItemId, no addToPlanId) resolves to plan-replace", () => {
  const nav = resolvePostSaveNav({
    newMealId: "meal-new",
    planId: "plan-7",
    planItemId: "item-42",
  });
  assert.deepEqual(nav, {
    kind: "plan-replace",
    planId: "plan-7",
    planItemId: "item-42",
  });
});

test("plan-replace threads BOTH the planId and the planItemId of the slot", () => {
  const nav = resolvePostSaveNav({
    newMealId: "m",
    planId: "p-abc",
    planItemId: "pi-def",
  });
  assert.equal(nav.kind, "plan-replace");
  if (nav.kind === "plan-replace") {
    assert.equal(nav.planId, "p-abc");
    assert.equal(nav.planItemId, "pi-def");
  }
});

test("a lone planId (no planItemId) is NOT a replace signal — falls through to detail", () => {
  const nav = resolvePostSaveNav({ newMealId: "meal-1", planId: "plan-7" });
  assert.deepEqual(nav, { kind: "meal-detail", mealId: "meal-1" });
});

test("a lone planItemId (no planId) is NOT a replace signal — falls through to detail", () => {
  const nav = resolvePostSaveNav({ newMealId: "meal-1", planItemId: "item-9" });
  assert.deepEqual(nav, { kind: "meal-detail", mealId: "meal-1" });
});

test("a lone planId with addToPlanId still appends (planId alone never overrides append)", () => {
  const nav = resolvePostSaveNav({
    newMealId: "meal-1",
    addToPlanId: "plan-append",
    planId: "plan-7",
  });
  assert.deepEqual(nav, { kind: "plan-back", planId: "plan-append" });
});

test("contradictory case: addToPlanId AND (planId + planItemId) → REPLACE wins (safe against the two-meals bug)", () => {
  const nav = resolvePostSaveNav({
    newMealId: "meal-new",
    addToPlanId: "plan-append",
    planId: "plan-replace",
    planItemId: "item-42",
  });
  assert.deepEqual(nav, {
    kind: "plan-replace",
    planId: "plan-replace",
    planItemId: "item-42",
  });
});

test("all-absent (only newMealId) resolves to meal-detail", () => {
  const nav = resolvePostSaveNav({ newMealId: "only-meal" });
  assert.deepEqual(nav, { kind: "meal-detail", mealId: "only-meal" });
});

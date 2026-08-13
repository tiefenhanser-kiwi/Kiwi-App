// WS9-2 2c Commit 10 — plan → grocery-list generate handoff.
//
// SUCCEEDS lib/__tests__/groceryPicker.test.ts (21 tests). 18 of those covered
// fetchAllPlans / buildPickerList / resolveGroceryRoute / decideGroceryEntry,
// all of which died with app/grocery-plan-picker.tsx this commit. The 3
// resolveGenerateResult tests survive below, VERBATIM in intent, plus new
// coverage for the dispatch path Plan Review now uses.
//
// ⛔ THE POINT OF THIS FILE. resolveGenerateResult is the only tested error
// mapping for grocery generation in the app. Plan Review used to hand-inline
// the same six outcomes with NO coverage and two divergent strings. Closing
// D-WS7-144 moved Plan Review onto this mapper — so these tests are now the
// only thing standing between a copy edit and a silent behaviour change on a
// live screen.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { GenerateGroceryListResult } from "@/lib/api/grocery";
import {
  dispatchGenerateResult,
  resolveGenerateResult,
  type HandoffAction,
} from "../groceryHandoff";

// ── resolveGenerateResult (carried over from groceryPicker.test.ts) ─────────

test("resolveGenerateResult: success → navigate to the new list", () => {
  assert.deepEqual(
    resolveGenerateResult({ success: true, groceryListId: "gl-9" }),
    { kind: "navigate", listId: "gl-9" },
  );
});

test("resolveGenerateResult: list_exists (409) → navigate to the existing list", () => {
  // The 409 is NOT an error from the user's point of view — they asked for the
  // plan's list and they get the plan's list. Same destination as a 200.
  assert.deepEqual(
    resolveGenerateResult({
      success: false,
      error: "list_exists",
      existingListId: "gl-1",
    }),
    { kind: "navigate", listId: "gl-1" },
  );
});

test("resolveGenerateResult: errors map to alerts (no navigation)", () => {
  const errors: GenerateGroceryListResult[] = [
    { success: false, error: "ai_failed" },
    { success: false, error: "plan_not_found" },
    { success: false, error: "unauthenticated" },
    { success: false, error: "unknown" },
  ];
  for (const result of errors) {
    const action = resolveGenerateResult(result);
    assert.equal(action.kind, "alert");
    if (action.kind === "alert") {
      assert.ok(action.title.length > 0);
      assert.ok(action.message.length > 0);
    }
  }
});

// ── the canonical copy, pinned string-for-string ────────────────────────────
// After Commit 10 these are the ONLY copies of these strings in the app. Plan
// Review's divergent versions were retired, so a change here is a change to
// what every user sees — it should have to break a test first.

test("copy: ai_failed", () => {
  assert.deepEqual(resolveGenerateResult({ success: false, error: "ai_failed" }), {
    kind: "alert",
    title: "Could not generate list",
    message: "Our AI hit a hiccup. Please try again in a moment.",
  });
});

test("copy: plan_not_found", () => {
  assert.deepEqual(
    resolveGenerateResult({ success: false, error: "plan_not_found" }),
    {
      kind: "alert",
      title: "Plan not found",
      message: "We couldn't find this plan. Try reloading.",
    },
  );
});

test("copy: unauthenticated matches AuthContext's canonical 401 vocabulary", () => {
  // AuthContext.ts:90 says "Your session expired. Please sign in again." A 401
  // here is an EXPIRY, not a missing sign-in — Plan Review is unreachable while
  // signed out. Plan Review's retired "Sign-in required" implied otherwise.
  assert.deepEqual(
    resolveGenerateResult({ success: false, error: "unauthenticated" }),
    {
      kind: "alert",
      title: "Session expired",
      message: "Please sign in again to keep going.",
    },
  );
});

test("copy: unknown stays generic — it must not claim generation failed", () => {
  // We do not know that generation failed; the list may well exist. Plan
  // Review's retired "Could not generate list" asserted more than we know.
  assert.deepEqual(resolveGenerateResult({ success: false, error: "unknown" }), {
    kind: "alert",
    title: "Something went wrong",
    message: "Please try again in a moment.",
  });
});

// ── dispatchGenerateResult — the path Plan Review runs ──────────────────────
// Plan Review's handleGroceryListPress is now a thin wrapper over this: it
// supplies router.push and Alert.alert as the sinks. `app/` is outside the test
// glob, so this is where that screen's six outcomes actually get covered.

function spy() {
  const navigated: string[] = [];
  const alerted: Array<[string, string]> = [];
  const sinks = {
    navigate: (listId: string) => navigated.push(listId),
    alert: (title: string, message: string) => alerted.push([title, message]),
  };
  return { navigated, alerted, sinks };
}

test("dispatch: success → navigates to the new list, no alert", () => {
  const { navigated, alerted, sinks } = spy();
  dispatchGenerateResult({ success: true, groceryListId: "gl-9" }, sinks);
  assert.deepEqual(navigated, ["gl-9"]);
  assert.deepEqual(alerted, []);
});

test("dispatch: list_exists (409) → navigates to the EXISTING list, no alert", () => {
  // ⚠️ The 409 is the outcome most likely to break in a mapper swap and the
  // least likely to be hit by accident on device: it only fires on a plan that
  // already has a list. If this ever alerts instead of navigating, tapping
  // Grocery List on an already-generated plan dead-ends.
  const { navigated, alerted, sinks } = spy();
  dispatchGenerateResult(
    { success: false, error: "list_exists", existingListId: "gl-1" },
    sinks,
  );
  assert.deepEqual(navigated, ["gl-1"]);
  assert.deepEqual(alerted, []);
});

test("dispatch: ai_failed → alerts, does NOT navigate", () => {
  const { navigated, alerted, sinks } = spy();
  dispatchGenerateResult({ success: false, error: "ai_failed" }, sinks);
  assert.deepEqual(navigated, []);
  assert.deepEqual(alerted, [
    ["Could not generate list", "Our AI hit a hiccup. Please try again in a moment."],
  ]);
});

test("dispatch: plan_not_found → alerts, does NOT navigate", () => {
  const { navigated, alerted, sinks } = spy();
  dispatchGenerateResult({ success: false, error: "plan_not_found" }, sinks);
  assert.deepEqual(navigated, []);
  assert.deepEqual(alerted, [
    ["Plan not found", "We couldn't find this plan. Try reloading."],
  ]);
});

test("dispatch: unauthenticated → alerts, does NOT navigate", () => {
  const { navigated, alerted, sinks } = spy();
  dispatchGenerateResult({ success: false, error: "unauthenticated" }, sinks);
  assert.deepEqual(navigated, []);
  assert.deepEqual(alerted, [
    ["Session expired", "Please sign in again to keep going."],
  ]);
});

test("dispatch: unknown → alerts, does NOT navigate", () => {
  const { navigated, alerted, sinks } = spy();
  dispatchGenerateResult({ success: false, error: "unknown", status: 500 }, sinks);
  assert.deepEqual(navigated, []);
  assert.deepEqual(alerted, [
    ["Something went wrong", "Please try again in a moment."],
  ]);
});

test("dispatch: returns the resolved action so a caller can branch on it", () => {
  const { sinks } = spy();
  const action: HandoffAction = dispatchGenerateResult(
    { success: true, groceryListId: "gl-3" },
    sinks,
  );
  assert.deepEqual(action, { kind: "navigate", listId: "gl-3" });
});

test("dispatch: EXACTLY ONE sink fires per outcome — never both, never neither", () => {
  // Guards the shape of the dispatch itself: a future edit that alerts AND
  // navigates (or silently does neither on an unhandled case) fails here.
  const cases: GenerateGroceryListResult[] = [
    { success: true, groceryListId: "gl-1" },
    { success: false, error: "list_exists", existingListId: "gl-2" },
    { success: false, error: "ai_failed" },
    { success: false, error: "plan_not_found" },
    { success: false, error: "unauthenticated" },
    { success: false, error: "unknown" },
  ];
  for (const result of cases) {
    const { navigated, alerted, sinks } = spy();
    dispatchGenerateResult(result, sinks);
    assert.equal(
      navigated.length + alerted.length,
      1,
      `outcome ${JSON.stringify(result)} fired ${navigated.length + alerted.length} sinks`,
    );
  }
});

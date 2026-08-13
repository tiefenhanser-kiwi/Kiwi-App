// Plan → grocery-list generate handoff (result mapping + dispatch).
//
// WS9-2 2c Commit 10 — RELOCATED from lib/groceryPicker.ts, which was named
// after app/grocery-plan-picker.tsx. That screen was deleted this commit
// (orphaned: zero navigation call sites anywhere in the app after the Home
// utility row came off in Commit 7), and keeping a module named for a screen
// that no longer exists is the same orphaned-name problem Commit 8 just swept
// out of the rail. Everything else in that file — fetchAllPlans,
// buildPickerList, resolveGroceryRoute, decideGroceryEntry — died with the
// picker. This is what survived, and it survived on purpose.
//
// ⛔ WHY THIS FILE STILL EXISTS. `resolveGenerateResult` is the ONLY TESTED
// error mapping for grocery generation in the app. Plan Review used to
// hand-inline the same six outcomes, untested. Deleting this alongside the
// picker would have left the app with only the untested ladder — a quality
// regression hiding inside a cleanup. Instead Plan Review now routes through
// here, which CLOSES D-WS7-144 (open since 2026-06-15).
//
// ── ONE request path, ONE mapping (D-WS7-144, verified) ────────────────────
// There is exactly ONE way to ask the server to build a list:
// `generateGroceryListForPlan` (lib/api/grocery.ts). There is now exactly ONE
// way to turn its result into UI: `resolveGenerateResult` below. No parallel
// generate flow exists, and none should be introduced — a second error ladder
// is how the copy drifted apart in the first place (see the 2c Commit 10
// report for the six-outcome diff).

import type { GenerateGroceryListResult } from "@/lib/api/grocery";

// The UI action a generate result resolves to. BOTH the 200-new and the
// 409-exists cases navigate to the same list screen — the user cannot tell the
// difference and should not have to.
export type HandoffAction =
  | { kind: "navigate"; listId: string }
  | { kind: "alert"; title: string; message: string };

/**
 * Pure mapping from a generate result to a UI action. Six outcomes.
 *
 * ⚠️ COPY IS CANONICAL HERE. After 2c Commit 10 this is the only place these
 * strings exist; Plan Review's divergent copies were retired. The
 * `unauthenticated` wording deliberately matches AuthContext's canonical 401
 * message ("Your session expired. Please sign in again.", AuthContext.ts:90) —
 * a 401 on this screen is an EXPIRY, not a missing sign-in, because the screen
 * is unreachable while signed out.
 */
export function resolveGenerateResult(
  result: GenerateGroceryListResult,
): HandoffAction {
  if (result.success) return { kind: "navigate", listId: result.groceryListId };
  if (result.error === "list_exists")
    return { kind: "navigate", listId: result.existingListId };
  if (result.error === "ai_failed")
    return {
      kind: "alert",
      title: "Could not generate list",
      message: "Our AI hit a hiccup. Please try again in a moment.",
    };
  if (result.error === "plan_not_found")
    return {
      kind: "alert",
      title: "Plan not found",
      message: "We couldn't find this plan. Try reloading.",
    };
  if (result.error === "unauthenticated")
    return {
      kind: "alert",
      title: "Session expired",
      message: "Please sign in again to keep going.",
    };
  // Unknown / unrecognised error shape. Deliberately generic: we do not know
  // that generation failed (the list may exist), so claiming "Could not
  // generate list" would assert more than we know.
  return {
    kind: "alert",
    title: "Something went wrong",
    message: "Please try again in a moment.",
  };
}

/** Where a resolved action is delivered. Injected so the caller owns routing
 *  and alerting, and so all six outcomes are unit-testable without a screen. */
export interface GenerateHandoffSinks {
  navigate: (listId: string) => void;
  alert: (title: string, message: string) => void;
}

/**
 * Resolve a generate result and deliver it. Returns the action so a caller (or
 * a test) can assert on what happened.
 *
 * This exists because the screens that consume it live under `app/`, which is
 * OUTSIDE the mobile test glob — so a handler written inline in a screen can
 * never be covered. Routing the dispatch through here makes Plan Review's
 * handler a thin wrapper over tested code instead of an untested ladder.
 */
export function dispatchGenerateResult(
  result: GenerateGroceryListResult,
  sinks: GenerateHandoffSinks,
): HandoffAction {
  const action = resolveGenerateResult(result);
  if (action.kind === "navigate") {
    sinks.navigate(action.listId);
  } else {
    sinks.alert(action.title, action.message);
  }
  return action;
}

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
import { NOTICE_GROCERY_STALE } from "@/lib/billing/copy";

// The UI action a generate result resolves to. BOTH the 200-new and the
// 409-exists cases navigate to the same list screen — the user cannot tell the
// difference and should not have to.
export type HandoffAction =
  | { kind: "navigate"; listId: string }
  | { kind: "alert"; title: string; message: string }
  /**
   * Row 9 (1.1) · Stripe S2 Part E — the entitlement gate refused (§2.6).
   *
   * 🔴 NOT AN ALERT, and that is the ruling rather than a taste call. D-WS9-272:
   * "keep what exists · do not pretend the call ran · say why in place · offer the
   * upgrade." An Alert is a modal that must be dismissed before the user can look
   * at the list they already have, and it disappears the moment they do — so it is
   * neither "in place" nor "keep what exists". The notice renders BESIDE the
   * existing list and stays there.
   *
   * The paywall sheet is opened independently, by the fetch layer, for every 402
   * in the app (§2.7). So a gated generate produces both: the sheet as the offer,
   * and this notice as the explanation that survives "Not now". Two surfaces, one
   * of which is transient by design.
   */
  | { kind: "notice"; text: string };

/**
 * Pure mapping from a generate result to a UI action. Seven outcomes.
 *
 * ⚠️ COPY IS CANONICAL HERE. After 2c Commit 10 this is the only place these
 * strings exist; Plan Review's divergent copies were retired. The
 * `unauthenticated` wording deliberately matches AuthContext's canonical 401
 * message ("Your session expired. Please sign in again.", AuthContext.ts:90) —
 * a 401 on this screen is an EXPIRY, not a missing sign-in, because the screen
 * is unreachable while signed out.
 *
 * The ONE exception to "canonical here" is `spend_guard` (D-WS9-241 D): the
 * server refused the AI call and its `message` says why ("today's planning
 * limit", "Kiwi is taking a short break"). That copy is rendered VERBATIM —
 * only the title is ours. "Our AI hit a hiccup" would be a lie there.
 */
export function resolveGenerateResult(
  result: GenerateGroceryListResult,
): HandoffAction {
  if (result.success) return { kind: "navigate", listId: result.groceryListId };
  if (result.error === "list_exists")
    return { kind: "navigate", listId: result.existingListId };
  // S2 Part E — the gate. Checked before every other failure branch because it is
  // the only one that is not a failure: nothing broke, the account is not entitled,
  // and the list the user already has is untouched.
  if (result.error === "upgrade_required")
    return { kind: "notice", text: NOTICE_GROCERY_STALE };
  if (result.error === "spend_guard")
    return {
      kind: "alert",
      title: "Could not generate list",
      message: result.message,
    };
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
  /**
   * S2 Part E -- where a `notice` action is delivered. OPTIONAL so the two
   * existing callers compile unchanged; a caller that omits it falls back to the
   * alert sink, which is worse than a notice but much better than silence.
   */
  notice?: (text: string) => void;
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
  } else if (action.kind === "notice") {
    if (sinks.notice) {
      sinks.notice(action.text);
    } else {
      // No notice sink wired. The copy is still the RIGHT copy -- it says why and
      // offers the upgrade -- so it is delivered through the alert rather than
      // dropped. A caller in this state is a caller that has not yet been given a
      // place to put an in-place notice.
      sinks.alert("Upgrade to continue", action.text);
    }
  } else {
    sinks.alert(action.title, action.message);
  }
  return action;
}

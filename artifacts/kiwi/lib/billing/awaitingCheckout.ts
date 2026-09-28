// Row 9 (1.1) · Stripe S2 Part D — the window between "the browser came back"
// and "the webhook landed".
//
// 🔴 THE WEBHOOK IS THE TRUTH; THE RETURN URL PROVES NOTHING. routes/billing.ts
// says it at length and means it: a user can open the return URL by hand,
// bookmark it, or never reach it at all because they closed the tab after paying.
// So the client cannot treat "we are back" as "we are subscribed" — it has to ASK,
// and it has to keep asking for a bounded while, and then it has to stop and hand
// the decision back to the user rather than spin forever.
//
// This is that bounded while, as a pure function of (when we left, what time it is
// now, what the last read said). It is in lib/ because the alternative — a
// setInterval and two booleans inside a component — is a state machine that
// app/** cannot test (D-WS9-164).
//
// ── WHY 3 SECONDS AND 20, AND WHY STOPPING IS A FEATURE ──────────────────
//
// The normal case is well under a second: Stripe fires
// `checkout.session.completed` while the browser is still redirecting. 20 seconds
// covers a slow webhook or a cold Cloud Run revision; past that, something is
// wrong that more polling will not fix, and a spinner that never resolves reads
// as "my payment failed" to the person who just paid. "I've paid — check again"
// says the true thing instead: we have not seen it yet, and here is the button.

import type { SubscriptionStatus } from "./subscriptionView";

export const POLL_INTERVAL_MS = 3_000;
export const POLL_WINDOW_MS = 20_000;

/**
 * - `idle`    — no checkout was launched, or one was and the status is now paying.
 *               Nothing to wait for; the sheet renders its normal state (or closes).
 * - `polling` — inside the window, still not paying. "Finishing up…".
 * - `stalled` — past the window, still not paying. Offer "I've paid — check again".
 */
export type AwaitingPhase = "idle" | "polling" | "stalled";

export interface AwaitingInput {
  /**
   * `Date.now()` at the moment the checkout URL was handed to the browser, or
   * null if no checkout has been launched in this session.
   *
   * Cleared — not merely ignored — when the status turns paying, so a SECOND
   * checkout later in the same session (a resubscribe after a cancel) starts its
   * own window rather than inheriting an already-expired one.
   */
  launchedAt: number | null;
  now: number;
  /** The latest `GET /me/subscription` status, or null if none has landed. */
  status: SubscriptionStatus | null;
}

/**
 * ⚠️ `past_due` COUNTS AS ARRIVED. It is not the outcome anyone wanted, but it
 * means the webhook DID land and Stripe has a subscription for this user — so
 * there is nothing left to poll for, and the `past_due` banner is the right
 * surface for what happened. Treating it as "still finishing" would poll for 20
 * seconds and then ask a paying user whether they had paid.
 */
export function awaitingPhase(input: AwaitingInput): AwaitingPhase {
  const { launchedAt, now, status } = input;
  if (launchedAt === null) return "idle";
  if (status === "active" || status === "past_due") return "idle";
  // A clock that went backwards (a device time change mid-checkout) must not
  // produce a negative elapsed that polls forever: anything not strictly inside
  // the window is stalled.
  const elapsed = now - launchedAt;
  return elapsed >= 0 && elapsed < POLL_WINDOW_MS ? "polling" : "stalled";
}

/** Whether the periodic refetch should still be scheduled. */
export function shouldPoll(input: AwaitingInput): boolean {
  return awaitingPhase(input) === "polling";
}

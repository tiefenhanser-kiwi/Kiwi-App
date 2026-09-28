// Row 9 (1.1) · Stripe S2 Part D — the window between "we came back" and "the
// webhook landed".
//
// The property this file exists to hold: THE CLIENT NEVER CONCLUDES IT IS PAID.
// Every phase below is a function of what the SERVER last said, and there is no
// input representing "the user visited the return URL" — because that is not
// evidence, and a state machine that accepted it as evidence would be the bug.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  POLL_INTERVAL_MS,
  POLL_WINDOW_MS,
  awaitingPhase,
  shouldPoll,
} from "../awaitingCheckout";
import type { SubscriptionStatus } from "../subscriptionView";

const T0 = 1_000_000;

test("no checkout launched → idle, whatever the status", () => {
  for (const status of [
    "trialing",
    "active",
    "past_due",
    "none",
    "canceled",
    null,
  ] as (SubscriptionStatus | null)[]) {
    assert.equal(
      awaitingPhase({ launchedAt: null, now: T0, status }),
      "idle",
      String(status),
    );
  }
});

test("inside the window and not yet paying → polling", () => {
  for (const elapsed of [0, 1, POLL_INTERVAL_MS, POLL_WINDOW_MS - 1]) {
    assert.equal(
      awaitingPhase({ launchedAt: T0, now: T0 + elapsed, status: "trialing" }),
      "polling",
      String(elapsed),
    );
  }
});

test("the window's far edge is EXCLUSIVE — 20s exactly is already stalled", () => {
  assert.equal(
    awaitingPhase({ launchedAt: T0, now: T0 + POLL_WINDOW_MS, status: "none" }),
    "stalled",
  );
  assert.equal(
    awaitingPhase({ launchedAt: T0, now: T0 + POLL_WINDOW_MS + 60_000, status: "none" }),
    "stalled",
  );
});

test("🔴 `active` ends the wait immediately — the webhook landed", () => {
  assert.equal(
    awaitingPhase({ launchedAt: T0, now: T0 + 100, status: "active" }),
    "idle",
  );
});

test("🔴 `past_due` ALSO ends the wait — it is not the wanted outcome, but it arrived", () => {
  // Polling for 20 seconds and then asking a paying user whether they had paid is
  // what treating past_due as "still finishing" would do. The past_due BANNER is
  // the right surface for what actually happened.
  assert.equal(
    awaitingPhase({ launchedAt: T0, now: T0 + 100, status: "past_due" }),
    "idle",
  );
  assert.equal(
    awaitingPhase({ launchedAt: T0, now: T0 + POLL_WINDOW_MS * 5, status: "past_due" }),
    "idle",
  );
});

test("trialing / none / canceled all keep waiting — none of them is a landed webhook", () => {
  for (const status of ["trialing", "none", "canceled", null] as (SubscriptionStatus | null)[]) {
    assert.equal(
      awaitingPhase({ launchedAt: T0, now: T0 + 500, status }),
      "polling",
      String(status),
    );
  }
});

test("a clock that went BACKWARDS stalls rather than polling forever", () => {
  // A device time change mid-checkout gives a negative elapsed. Without the
  // explicit `elapsed >= 0`, `-5000 < POLL_WINDOW_MS` is true and the poll never
  // ends.
  assert.equal(
    awaitingPhase({ launchedAt: T0, now: T0 - 5_000, status: "none" }),
    "stalled",
  );
});

test("shouldPoll is exactly the polling phase — the timer and the copy cannot disagree", () => {
  const cases = [
    { launchedAt: null, now: T0, status: "none" as const },
    { launchedAt: T0, now: T0 + 1, status: "none" as const },
    { launchedAt: T0, now: T0 + POLL_WINDOW_MS, status: "none" as const },
    { launchedAt: T0, now: T0 + 1, status: "active" as const },
  ];
  for (const c of cases) {
    assert.equal(shouldPoll(c), awaitingPhase(c) === "polling", JSON.stringify(c));
  }
});

test("the window fits a whole number of polls, so the last one lands before it closes", () => {
  // 20_000 / 3_000 = 6 full intervals with 2s to spare. Not an invariant the
  // product depends on, but a mismatch here (an interval longer than the window)
  // would mean the user waits the whole window and is never refetched once.
  assert.ok(POLL_INTERVAL_MS < POLL_WINDOW_MS);
  assert.ok(Math.floor(POLL_WINDOW_MS / POLL_INTERVAL_MS) >= 2);
});

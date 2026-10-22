// SEC-3 D / SEC-3b (SEC-2 #16) — the sign-up answer "no trial: this inbox already
// had one" (user.subscription.trialDeniedReason), carried from AuthContext to
// BillingContext (lib/billing/trialDenied.ts).
import assert from "node:assert/strict";
import { test } from "node:test";

import { TRIAL_ALREADY_USED } from "../subscriptionView";
import {
  noteTrialDenied,
  subscribeTrialDenied,
  takeTrialDenied,
} from "../trialDenied";

test("a trial_already_used note is taken exactly once", () => {
  takeTrialDenied();
  assert.equal(TRIAL_ALREADY_USED, "trial_already_used");
  noteTrialDenied(TRIAL_ALREADY_USED);
  assert.equal(takeTrialDenied(), true);
  assert.equal(takeTrialDenied(), false);
});

test("no reason, or one this build has no words for, is no notice", () => {
  takeTrialDenied();
  noteTrialDenied(undefined);
  noteTrialDenied(null);
  noteTrialDenied("some_future_reason");
  noteTrialDenied("duplicate_email"); // SEC-3's assumed value, never sent
  assert.equal(takeTrialDenied(), false);
});

test("a listener hears the note, and stops hearing after unsubscribe", () => {
  takeTrialDenied();
  let heard = 0;
  const off = subscribeTrialDenied(() => (heard += 1));
  noteTrialDenied("trial_already_used");
  assert.equal(heard, 1);
  off();
  noteTrialDenied("trial_already_used");
  assert.equal(heard, 1);
  takeTrialDenied();
});

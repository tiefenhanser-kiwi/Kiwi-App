// SEC-3 D — the sign-up answer "no trial: the email already had one", carried
// from AuthContext to BillingContext (lib/billing/trialDenied.ts).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TRIAL_DENIED_DUPLICATE_EMAIL,
  noteTrialDenied,
  subscribeTrialDenied,
  takeTrialDenied,
} from "../trialDenied";

test("a duplicate_email note is taken exactly once", () => {
  takeTrialDenied();
  noteTrialDenied(TRIAL_DENIED_DUPLICATE_EMAIL);
  assert.equal(takeTrialDenied(), true);
  assert.equal(takeTrialDenied(), false);
});

test("no reason, or one this build has no words for, is no notice", () => {
  takeTrialDenied();
  noteTrialDenied(undefined);
  noteTrialDenied(null);
  noteTrialDenied("some_future_reason");
  assert.equal(takeTrialDenied(), false);
});

test("a listener hears the note, and stops hearing after unsubscribe", () => {
  takeTrialDenied();
  let heard = 0;
  const off = subscribeTrialDenied(() => (heard += 1));
  noteTrialDenied("duplicate_email");
  assert.equal(heard, 1);
  off();
  noteTrialDenied("duplicate_email");
  assert.equal(heard, 1);
  takeTrialDenied();
});

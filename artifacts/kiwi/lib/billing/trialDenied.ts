// SEC-3 D / SEC-3b (SEC-2 #16) — a NEW account that got no free trial, because
// its inbox already had one: the sign-up answer's `user.subscription.
// trialDeniedReason` is "trial_already_used". The answer arrives in
// AuthContext; the sheet that says so is BillingContext's, which cannot be
// reached from there (the provider sits inside it), so the moment crosses here:
// AuthContext notes it, BillingContext takes it once the member's subscription
// has loaded and opens the lapsed sheet. What the sheet SAYS is not carried
// here — sheetCopyFor reads the same field off GET /me/subscription, so any
// later lapsed sheet for that account says it too. The same shape as
// lib/api/upgrade-bridge.ts, plus a PENDING slot, because the note lands before
// BillingProvider has re-rendered with the new user.

import { TRIAL_ALREADY_USED } from "./subscriptionView";

let pending = false;
const listeners = new Set<() => void>();

/** AuthContext, after a sign-up or an OAuth first sign-in. Any other reason is ignored. */
export function noteTrialDenied(reason: string | null | undefined): void {
  if (reason !== TRIAL_ALREADY_USED) return;
  pending = true;
  for (const l of [...listeners]) l();
}

/** True once per note: the caller opens the sheet. */
export function takeTrialDenied(): boolean {
  const had = pending;
  pending = false;
  return had;
}

export function subscribeTrialDenied(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// SEC-3 D (SEC-2 #16) — a new account that got NO free trial, because the email
// had already had one. The sign-up answer arrives in AuthContext; the sheet that
// says so is BillingContext's. AuthContext cannot reach the billing state (the
// provider sits inside it, contexts/BillingContext.tsx), so the answer crosses
// here: AuthContext notes it, BillingContext takes it once a member is signed
// in. The same shape as lib/api/upgrade-bridge.ts, plus a PENDING slot, because
// the note lands before BillingProvider has re-rendered with the new user.

/** The one reason this build has words for (lib/billing/copy.ts SHEET_TRIAL_USED_*). */
export const TRIAL_DENIED_DUPLICATE_EMAIL = "duplicate_email";

let pending = false;
const listeners = new Set<() => void>();

/** AuthContext, after a sign-up or an OAuth first sign-in. Any other reason is ignored. */
export function noteTrialDenied(reason: string | null | undefined): void {
  if (reason !== TRIAL_DENIED_DUPLICATE_EMAIL) return;
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

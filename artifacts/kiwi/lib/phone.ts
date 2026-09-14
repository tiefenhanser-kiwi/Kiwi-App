// D-WS9-241 A (BUG-261) — the client-side MIRROR of the server's phone rule.
//
// This is not a third rule. It is the same regex and the same length cap as
// artifacts/api-server/src/lib/phoneValidation.ts (which POST /auth/signup
// and PATCH /me/profile both validate with), copied here because the two
// packages share no cheap module. It exists so the sign-up form can refuse
// what the server will refuse before the round-trip, with a message that
// says "phone" instead of "invalid request body".
//
// ⚠️ KEEP IN SYNC with artifacts/api-server/src/lib/phoneValidation.ts.
// Change BOTH together — the same convention as TRIAL_LENGTH_DAYS.
export const PHONE_MAX_LENGTH = 40;
export const PHONE_REGEX = /(?:\D*\d){7,}/;

/** True when the server's phone rule would accept `phone`. */
export function isValidPhone(phone: string): boolean {
  return phone.length <= PHONE_MAX_LENGTH && PHONE_REGEX.test(phone);
}

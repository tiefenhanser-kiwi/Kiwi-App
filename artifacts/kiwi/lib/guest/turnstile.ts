// Row 13 "Test Kitchen" · Block 2 (R12) — the Turnstile gate, as data.
//
// Keys arrive in Block 3. Until then BOTH halves are unset and both sides agree
// on what that means: the server lets the check pass through while
// TURNSTILE_SECRET_KEY is unset, and this client sends nothing. "Send nothing"
// is the ruling's word — not an empty string, which is a token the server would
// be entitled to reject once a secret IS set.

/**
 * The site key, or null. Read through a function rather than as a module const
 * so a test can assert both branches without re-importing the module: Expo
 * inlines `process.env.EXPO_PUBLIC_*` at build time, so the VALUE is fixed per
 * build, but the decision below stays testable.
 */
export function turnstileSiteKey(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const key = env.EXPO_PUBLIC_TURNSTILE_SITE_KEY;
  return key && key.trim().length > 0 ? key.trim() : null;
}

/** R12 — render the widget, and require a token before the door opens. */
export function turnstileEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return turnstileSiteKey(env) !== null;
}

/**
 * The body field for POST /guest/session. `{}` when Turnstile is off — the
 * server's schema has `turnstileToken` optional, and an absent field is the only
 * honest way to say "this client was not asked to prove anything".
 */
export function turnstileRequestFields(
  token: string | null,
  env: Record<string, string | undefined> = process.env,
): { turnstileToken?: string } {
  if (!turnstileEnabled(env)) return {};
  return token ? { turnstileToken: token } : {};
}

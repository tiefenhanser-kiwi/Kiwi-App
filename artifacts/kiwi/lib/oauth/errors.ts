// Row 9 (1.1) · OAuth Block 2 Part B/E — WHAT A FAILED SOCIAL SIGN-IN MEANS.
//
// §2.6, in full: "A dismissed sheet is not an error (Apple
// ERR_REQUEST_CANCELED, Google's cancel) — no toast, no error state. A 401
// shows one generic line; a 503 hides that provider's button for the session
// and says so once."
//
// Three outcomes, not a message string, because the screens do three
// different things with them. Precedent: lib/authErrorCopy.ts and
// spendGuardRefusalFromError — key on the typed error, hand the screen a
// DECISION, never a status code.
//
// ── ON THE 401 BEING GENERIC ─────────────────────────────────────────────
//
// It has to be. The server answers 401 with no reason on the wire by
// design (routes/auth.ts §2.8: an expired token, a wrong audience, a
// mismatched nonce and a revoked key are all one answer), so there is
// nothing here to be specific WITH. The copy says the one useful thing —
// try again, or use your email — instead of inventing a cause.
//
// ── ON THE CANCEL NOT BEING AN ERROR ─────────────────────────────────────
//
// Dismissing Apple's sheet is the most ordinary thing a person can do with
// it. A red line under a form they did not fill in reads as "you broke
// something", and on the sign-up screen it sits directly above the email
// form they are about to use instead.
//
// The shapes differ by provider and are listed where they are matched:
// Apple native rejects, Apple web rejects with a plain object, Google native
// v16 RESOLVES with `{ type: "cancelled" }` (handled at the call site, not
// here), and Google Identity Services on web reports nothing at all.

import { ApiError } from "@/lib/api/errors";

import type { OAuthProvider } from "./providers";

export type OAuthFailure =
  /** Say and do nothing. */
  | { kind: "cancelled" }
  /** 503 — hide this provider for the session and say so once. */
  | { kind: "unavailable"; provider: OAuthProvider; message: string }
  /** Everything else, including the generic 401. */
  | { kind: "message"; message: string };

export const OAUTH_REFUSED_COPY =
  "That sign-in didn't go through. Try again, or use your email and password.";

export const OAUTH_FAILED_COPY =
  "Couldn't finish that sign-in. Try again in a moment, or use your email and password.";

/** §2.6 — said ONCE, when the provider first answers 503. */
export function oauthUnavailableCopy(provider: OAuthProvider): string {
  const name = provider === "apple" ? "Apple" : "Google";
  return `${name} sign-in isn't available right now — use your email and password for now.`;
}

/**
 * The 503 body the server sends when a provider is not configured on the
 * deploy: `{ code: "oauth_unavailable" }`. Keyed on the CODE, not on the
 * status, for the reason signupRetryWithoutClaim gives: a 503 from anything
 * else (a cold start, a proxy) is not a statement about this provider, and
 * hiding the button for the session over one would be unrecoverable without
 * a relaunch.
 */
export function isProviderUnavailable(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.status !== 503) return false;
  const code = (err.body as { code?: unknown } | null | undefined)?.code;
  return code === "oauth_unavailable";
}

function codeOf(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { code?: unknown; error?: unknown };
  if (typeof e.code === "string") return e.code;
  // Apple's web JS rejects with a bare `{ error: "popup_closed_by_user" }` —
  // not an Error, and the reason is under a different key.
  if (typeof e.error === "string") return e.error;
  return null;
}

const CANCEL_CODES: ReadonlySet<string> = new Set([
  // expo-apple-authentication, every operation (AppleAuthentication.ts).
  "ERR_REQUEST_CANCELED",
  // Sign in with Apple JS: the popup was closed, or the user backed out of
  // the authorize step, or started a fresh flow over the top of this one.
  "popup_closed_by_user",
  "user_cancelled_authorize",
  "user_trigger_new_signin_flow",
  // @react-native-google-signin, on the paths that still reject rather than
  // resolving `{ type: "cancelled" }` — statusCodes.SIGN_IN_CANCELLED.
  "SIGN_IN_CANCELLED",
  "-5",
]);

export function isOAuthCancel(err: unknown): boolean {
  const code = codeOf(err);
  return code !== null && CANCEL_CODES.has(code);
}

/**
 * The one call the screens make. `provider` is needed because the 503 answer
 * names the provider it is hiding.
 */
export function oauthFailure(err: unknown, provider: OAuthProvider): OAuthFailure {
  if (isOAuthCancel(err)) return { kind: "cancelled" };
  if (isProviderUnavailable(err)) {
    return { kind: "unavailable", provider, message: oauthUnavailableCopy(provider) };
  }
  if (err instanceof ApiError && err.status === 401) {
    return { kind: "message", message: OAUTH_REFUSED_COPY };
  }
  // 429 and the 400 email-shape case belong to the email form, not here; a
  // social sign-in cannot produce either from this client. Everything left —
  // a 500, a network drop, a malformed credential from the provider — reads
  // as "try again", because it is.
  return { kind: "message", message: OAUTH_FAILED_COPY };
}

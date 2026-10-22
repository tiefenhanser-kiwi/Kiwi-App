// SEC-3 B (SEC-1 #6) — re-auth for the two account actions that cannot be
// undone by the person whose phone was borrowed: changing the sign-in email and
// deleting the account. SEC-2 makes POST /me/email/request-change and
// DELETE /me require the current password, or a recent sign-in for an account
// with no password (Google / Apple only).
//
// The contract, read from SEC-2's e8c10293 (api-server/src/lib/reauth.ts):
//   • body field `currentPassword` — required for an account with a password,
//     ignored for one without;
//   • 403 `{ code: "reauth_required", method: "password" }` — none was sent;
//   • 403 `{ code: "reauth_required", method: "sign_in" }` — a Google/Apple-only
//     account whose sign-in is older than 10 minutes (the token's auth_time);
//   • 403 `{ code: "password_incorrect" }`.
// `method` is how the client learns which kind of account this is: the user
// payload does not say. SEC-2 answers 403, never 401, precisely so the client
// does not sign the person out; lib/api/client.ts also keeps a 401 carrying
// either code out of the cascade (REAUTH_CODES), in case one ever does.
//
// Pure: the screens and hooks/useReauthAction.ts hold the state; every decision
// and every string is here, and tested in lib/__tests__/reauth.test.ts.

import { ApiError } from "./api/errors";

export const REAUTH_REQUIRED = "reauth_required";
export const PASSWORD_INCORRECT = "password_incorrect";

/** The codes that refuse one action and must never sign the member out. */
export const REAUTH_CODES: ReadonlySet<string> = new Set([REAUTH_REQUIRED, PASSWORD_INCORRECT]);

export type ReauthFailure = typeof REAUTH_REQUIRED | typeof PASSWORD_INCORRECT;

/** The body's `code`, when the server sent one. */
export function errorCode(body: unknown): string | null {
  const code = (body as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : null;
}

/** Which re-auth refusal this is, or null for any other failure. By code, not status. */
export function reauthFailure(err: unknown): ReauthFailure | null {
  if (!(err instanceof ApiError)) return null;
  const code = errorCode(err.body);
  return code === REAUTH_REQUIRED || code === PASSWORD_INCORRECT ? code : null;
}

export type ReauthMethod = "password" | "sign_in";

/** What a `reauth_required` asks for, or null. */
export function reauthMethod(err: unknown): ReauthMethod | null {
  if (!(err instanceof ApiError)) return null;
  const m = (err.body as { method?: unknown } | null | undefined)?.method;
  return m === "password" || m === "sign_in" ? m : null;
}

/**
 * What a refusal says about the account: a password one (asked for a password,
 * or told the one sent was wrong), a Google/Apple-only one (asked to sign in
 * again), or nothing new.
 */
export function learnedHasPassword(failure: ReauthFailure, method: ReauthMethod | null): boolean | null {
  if (failure === PASSWORD_INCORRECT) return true;
  if (method === "password") return true;
  if (method === "sign_in") return false;
  return null;
}

/**
 * Whether the account has a password: true / false when the user payload says
 * (`hasPassword` — SEC-2 did not add one; a later server lane may), null when
 * it does not. MeUserSchema is `.passthrough()`, so the field would arrive
 * without a schema change. Until then a refusal's `method` teaches it
 * (learnedHasPassword, hooks/useReauthAction.ts).
 */
export function accountHasPassword(user: unknown): boolean | null {
  const v = (user as { hasPassword?: unknown } | null | undefined)?.hasPassword;
  return typeof v === "boolean" ? v : null;
}

/** Whether to draw the password field. Only a known Google/Apple-only account goes without. */
export function showsPasswordField(hasPassword: boolean | null): boolean {
  return hasPassword !== false;
}

/** Whether the action's button may be pressed yet, as far as re-auth goes. */
export function reauthReady(hasPassword: boolean | null, password: string): boolean {
  return hasPassword === true ? password.length > 0 : true;
}

/** The body fragment: the password when one was typed, nothing otherwise. */
export function reauthBody(password: string): { currentPassword?: string } {
  return password.length > 0 ? { currentPassword: password } : {};
}

// ── copy ────────────────────────────────────────────────────────────────

export const REAUTH_HEADING = "Confirm it's you";
export const REAUTH_PASSWORD_LABEL = "Current password";
/** Under the field while we cannot tell whether this account has a password. */
export const REAUTH_PASSWORD_HINT = "Signed up with Google or Apple? Leave this empty.";
export const REAUTH_SIGN_IN_AGAIN = "Sign in again to confirm";
export const REAUTH_SIGN_IN_AGAIN_FALLBACK =
  "Can't use these? Log out, sign back in, and try again.";

export const REAUTH_COPY = {
  passwordIncorrect: "That password isn't right. Please try again.",
  /** A Google/Apple-only account whose sign-in is too old. */
  signInTooOld: "It's been a while since you signed in. Sign in again to confirm.",
  /** A password account that sent none. */
  passwordNeeded: "Enter your current password to confirm.",
  /** We cannot tell which kind of account this is. */
  passwordOrSignIn: "Enter your current password, or sign in again to confirm.",
  /** The provider sign-in came back as someone else. */
  wrongAccount: "That's a different account. Sign in with the one you're using here.",
} as const;

/** What to say for a refusal, given what we know about the account. */
export function reauthMessage(failure: ReauthFailure, hasPassword: boolean | null): string {
  if (failure === PASSWORD_INCORRECT) return REAUTH_COPY.passwordIncorrect;
  if (hasPassword === false) return REAUTH_COPY.signInTooOld;
  if (hasPassword === true) return REAUTH_COPY.passwordNeeded;
  return REAUTH_COPY.passwordOrSignIn;
}

/** Whether a refusal offers "Sign in again" (the provider buttons). A password account never needs it. */
export function offersSignInAgain(failure: ReauthFailure, hasPassword: boolean | null): boolean {
  return failure === REAUTH_REQUIRED && hasPassword !== true;
}

/** Thrown by AuthContext.reauthenticate when the provider signed in someone else. */
export class ReauthMismatchError extends Error {
  constructor() {
    super(REAUTH_COPY.wrongAccount);
    this.name = "ReauthMismatchError";
  }
}

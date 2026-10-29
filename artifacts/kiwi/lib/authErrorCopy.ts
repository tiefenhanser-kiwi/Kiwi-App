// BUG-296 — what the sign-in / sign-up screens SAY about a failed auth call.
//
// The screens used to render `err.message` verbatim, and for the two failures
// that matter that message is the server's own terse copy:
//
//   • 429 from `authLimiter` → `{ error: "Too many requests, slow down." }`
//     plus a `Retry-After` header. Honest, but it names no remedy and the
//     screen kept its button live, so the user kept spending the bucket.
//   • 400 from `loginSchema` / `signupSchema` → `{ error: "invalid request body" }`.
//     This is the copy Hans paraphrased as "malformed request or invalid
//     shape" on the first device pass (September 18, 2026). From THIS client
//     the only field that can fail those schemas is the email — the screens
//     already gate the password length, the names and the phone — so the
//     wording tells the user what to fix.
//
// Precedent: spendGuardRefusalFromError (lib/api/errors.ts) — key on an
// ApiError's status/body, hand the screen a decision, never a status code.
// Every other failure keeps the message it already carried.

import { ApiError } from "@/lib/api/errors";

/** Retry-After to assume when a 429 arrives without the header. */
export const RATE_LIMIT_FALLBACK_SEC = 30;

export const TOO_MANY_ATTEMPTS_COPY =
  "Too many attempts — give it a minute and try again.";

export const INVALID_EMAIL_SHAPE_COPY =
  "That doesn't look like a valid email address — check it and try again.";

/** The server's 400 body on a schema-rejected auth request (routes/auth.ts). */
const INVALID_REQUEST_BODY = "invalid request body";

export interface AuthErrorPresentation {
  /** What the screen renders. */
  message: string;
  /**
   * Seconds the submit should stay disabled, or null when the failure is not
   * a rate limit. On a 429 this is the server's Retry-After when present,
   * else RATE_LIMIT_FALLBACK_SEC.
   */
  retryAfterSec: number | null;
}

// ── CLIENT-7 B (BUG-603) — a password on the server's common list ──────────
//
// SERVER-9 refuses a common password on sign-up, reset and change with
// 400 { error: "password_too_common", userFacingMessage: <copy> }
// (api-server lib/commonPasswords.ts passwordTooCommonBody). It is a fact about
// the password field, so the three screens say it under that field rather than
// as a generic failure; on the reset screen any other 400 means a dead link, and
// this one must not. An older server never sends that error, so nothing changes
// there.

/** SERVER-9's 400 `error` for a common password. */
export const PASSWORD_TOO_COMMON = "password_too_common";

/** Said when the 400 carries no words of its own (the server's own line). */
export const PASSWORD_TOO_COMMON_COPY =
  "That password is too common. Try a longer phrase only you would use.";

/**
 * The line to show under the password field, or null when `err` is not the
 * common-password 400. The server's userFacingMessage wins, else
 * PASSWORD_TOO_COMMON_COPY.
 */
export function passwordTooCommonMessage(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 400) return null;
  const body = err.body as { error?: unknown } | null | undefined;
  if (!body || typeof body !== "object" || body.error !== PASSWORD_TOO_COMMON) return null;
  const said = err.userFacingMessage?.trim();
  return said && said !== PASSWORD_TOO_COMMON ? said : PASSWORD_TOO_COMMON_COPY;
}

export function authErrorPresentation(
  err: unknown,
  fallback: string,
): AuthErrorPresentation {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      return {
        message: TOO_MANY_ATTEMPTS_COPY,
        retryAfterSec: err.retryAfterSec ?? RATE_LIMIT_FALLBACK_SEC,
      };
    }
    if (err.status === 400 && err.userFacingMessage === INVALID_REQUEST_BODY) {
      return { message: INVALID_EMAIL_SHAPE_COPY, retryAfterSec: null };
    }
  }
  return {
    message: err instanceof Error ? err.message : fallback,
    retryAfterSec: null,
  };
}

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

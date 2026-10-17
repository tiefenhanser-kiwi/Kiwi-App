// FIX-3 / BUG-395 + BUG-103 (client side) — a small retry for the two reads a
// cold start depends on: GET /home and GET /auth/me.
//
// The QueryClient default is `retry: false` (app/_layout.tsx), and both reads
// inherited it, so one transient failure — a Cloud Run cold start, a Neon wake
// answered with 503 + Retry-After (errorHandler.ts / middleware/auth.ts) — was
// the user's answer: "We couldn't reach Kiwi" until they tapped Retry, sometimes
// three times. This retries that class, at most twice, and nothing else.
//
// WHAT IS TRANSIENT: a 5xx, and a fetch that failed outright (offline, DNS,
// reset). WHAT IS NOT: any 4xx (a 404 on a hidden template is an answer, a 401
// is the session cascade's), a schema error (the same body will fail the same
// way), and an ABORT — the abort is our own deadline or an unmount, and
// retrying past a deadline is how BOOTSTRAP_DEADLINE_MS would stop being true.
//
// The delay honours the server's Retry-After (seconds) when it sent one, capped
// so a large value cannot stall the screen; otherwise 1 s, then 2 s.

import { ApiError, ApiNetworkError } from "./errors";

/** Retries after the first failure. Two, per the ruling ("1–2 retries"). */
export const TRANSIENT_MAX_RETRIES = 2;

/** The most a Retry-After may hold the screen for one wait. */
const RETRY_AFTER_CAP_MS = 5_000;

function isAbort(err: ApiNetworkError): boolean {
  const cause = err.cause as { name?: unknown } | undefined;
  return cause?.name === "AbortError";
}

export function isTransientError(err: unknown): boolean {
  if (err instanceof ApiError) return err.status >= 500 && err.status <= 599;
  if (err instanceof ApiNetworkError) return !isAbort(err);
  return false;
}

/**
 * React Query's `retry` signature. `failureCount` is 0 on the first failure
 * (query-core retryer), so `< TRANSIENT_MAX_RETRIES` is exactly two retries.
 */
export function shouldRetryTransient(failureCount: number, err: unknown): boolean {
  return failureCount < TRANSIENT_MAX_RETRIES && isTransientError(err);
}

/** React Query's `retryDelay` signature: Retry-After when sent, else 1 s · 2 s. */
export function transientRetryDelayMs(failureCount: number, err: unknown): number {
  if (err instanceof ApiError && err.retryAfterSec !== undefined) {
    return Math.min(err.retryAfterSec * 1000, RETRY_AFTER_CAP_MS);
  }
  return 1000 * 2 ** failureCount;
}

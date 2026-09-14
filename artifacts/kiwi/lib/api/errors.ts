/**
 * Typed error classes thrown by `apiClient` (lib/api/client.ts).
 *
 * Throw mode and envelope mode produce equivalent information: throw mode
 * throws one of these classes; envelope mode wraps the same instance under
 * `{ success: false, error }`.
 *
 * `userFacingMessage` is the server-supplied product-spec field (e.g.
 * recipeImport's typed envelope). Extraction precedence in the wrapper:
 *   body.userFacingMessage > body.error > body.message > undefined
 */

export interface ApiErrorDetails {
  status: number;
  body: unknown;
  userFacingMessage?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly userFacingMessage?: string;

  constructor(message: string, details: ApiErrorDetails) {
    super(message);
    this.name = "ApiError";
    this.status = details.status;
    this.body = details.body;
    this.userFacingMessage = details.userFacingMessage;
  }
}

/**
 * 401 — server rejected the bearer token (missing, expired, or revoked).
 * Triggers the session-expired cascade via auth-bridge.emitSessionExpired().
 * Also thrown synthetically when the wrapper is called with auth required
 * but `readToken()` returned null.
 */
export class UnauthenticatedError extends ApiError {
  constructor(details: ApiErrorDetails) {
    super(details.userFacingMessage ?? "Unauthenticated", details);
    this.name = "UnauthenticatedError";
  }
}

/**
 * 402 — entitlement gate. Per-call signal (no session cascade); consumers
 * catch this and route to the upgrade modal.
 */
export class UpgradeRequiredError extends ApiError {
  constructor(details: ApiErrorDetails) {
    super(details.userFacingMessage ?? "Upgrade required", details);
    this.name = "UpgradeRequiredError";
  }
}

/**
 * Thrown when fetch itself rejected (offline, DNS failure, TLS error,
 * AbortError). Distinct from ApiError — there's no `status` or `body`.
 */
export class ApiNetworkError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ApiNetworkError";
    this.cause = cause;
  }
}

/**
 * Thrown when a response was received and parsed, but failed Zod
 * validation against the `opts.schema` supplied by the caller. `issues`
 * holds the raw `ZodError.issues` array for debugging / logging.
 */
export class ApiSchemaError extends Error {
  readonly issues: unknown;
  readonly received: unknown;

  constructor(message: string, issues: unknown, received: unknown) {
    super(message);
    this.name = "ApiSchemaError";
    this.issues = issues;
    this.received = received;
  }
}

/**
 * Extract `userFacingMessage` from a parsed JSON error body using the
 * precedence body.userFacingMessage > body.error > body.message.
 * Returns undefined if none are usable strings.
 */
export function extractUserFacingMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.userFacingMessage === "string") return b.userFacingMessage;
  if (typeof b.error === "string") return b.error;
  if (typeof b.message === "string") return b.message;
  return undefined;
}

// ── Spend-guard refusals (D-WS9-241 D) ──────────────────────────────────
//
// The server's spend guard (D-WS9-240) refuses an AI call for one of three
// reasons and answers 429 (per-user cap) or 503 (global ceiling / kill
// switch) — NOT 502 — with a body carrying `reason` and its own copy. That
// copy tells the user WHAT happened ("today's planning limit", "Kiwi is
// taking a short break"); a client's canned "something went wrong" is the one
// message a spend refusal must not send. Ruling: where a body carries one of
// these reasons, every client surface renders the server's message VERBATIM
// and keys on `reason`, not on status. Every other 4xx/5xx keeps its local
// canonical copy — this does not open the copy question generally.
//
// Body shapes differ by route: most send `{ error: <copy>, reason }`; the
// grocery routes send `{ error: "ai_failed", message: <copy>, reason }`; the
// recipe-import envelope sends `{ userFacingMessage: <copy>, reason }`. So
// the copy precedence here is userFacingMessage > message > error — the
// REVERSE of extractUserFacingMessage's error > message, because on a guard
// body `error` may be a code. A guard reason with no usable copy is NOT a
// refusal (null) — the caller falls through to its local copy.

export type SpendGuardReason =
  | "spend_cap_user"
  | "spend_cap_global"
  | "ai_disabled";

const SPEND_GUARD_REASONS: ReadonlySet<string> = new Set<SpendGuardReason>([
  "spend_cap_user",
  "spend_cap_global",
  "ai_disabled",
]);

export interface SpendGuardRefusal {
  reason: SpendGuardReason;
  /** The server's copy, verbatim. */
  message: string;
}

export function isSpendGuardReason(reason: unknown): reason is SpendGuardReason {
  return typeof reason === "string" && SPEND_GUARD_REASONS.has(reason);
}

/** Read a spend-guard refusal off a parsed response body, or null. */
export function spendGuardRefusal(body: unknown): SpendGuardRefusal | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!isSpendGuardReason(b.reason)) return null;
  for (const key of ["userFacingMessage", "message", "error"] as const) {
    const v = b[key];
    if (typeof v === "string" && v.trim().length > 0) {
      return { reason: b.reason, message: v };
    }
  }
  return null;
}

/** Same, off a thrown/enveloped error: only an ApiError carries a body. */
export function spendGuardRefusalFromError(err: unknown): SpendGuardRefusal | null {
  if (!(err instanceof ApiError)) return null;
  return spendGuardRefusal(err.body);
}

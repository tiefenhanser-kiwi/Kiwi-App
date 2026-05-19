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

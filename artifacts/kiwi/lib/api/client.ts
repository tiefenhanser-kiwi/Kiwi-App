/**
 * `apiClient` — single network wrapper for the mobile app.
 *
 * Consolidates the seven historical apiBase + readToken + Authorization +
 * status-handling sites into one function. Throw mode (default) returns
 * `Promise<T>`; envelope mode returns `Promise<ApiResult<T>>` for callers
 * that want a typed discriminated-union (grocery POST, recipe import).
 *
 * Path convention: leading-slash REQUIRED. `apiBase` already includes
 * `/api`, so endpoint paths look like "/auth/login", "/wizard/build-plans".
 * Inputs without a leading "/" are rejected at the wrapper boundary.
 *
 * 401 handling: triggers the session-expired cascade via auth-bridge.
 * Throws `UnauthenticatedError` (throw mode) or returns it in the envelope
 * (envelope mode). The cascade is fired in BOTH modes so the user lands
 * on welcome even if the consumer is type-checking against ApiResult.
 *
 * 402 handling: throws `UpgradeRequiredError` (throw mode) / envelope.
 * No cascade — 402 is per-call (upgrade flow), not session-level.
 *
 * Schema: if `opts.schema` is supplied, the parsed JSON is validated with
 * `schema.safeParse()`. Validation failure throws `ApiSchemaError` /
 * envelope. Universal adoption per Decision 4 — every wrapper call site
 * in commits 3, 4, 6 passes a schema.
 *
 * React Query convention (documented in lib/api/README.md):
 *   queryKey shape: ["<domain>", "<resource>", id?, filters?]
 *   staleTime tiers:
 *     - auth          → Infinity        (e.g. ["auth", "me"])
 *     - catalog       → 5 * 60_000      (e.g. ["catalog", "cuisines"])
 *     - personal      → 60_000          (e.g. ["plans", "list"])
 *     - hot-volatile  → 0               (e.g. ["wizard", "candidates"])
 */

import type { z } from "zod";

import { readToken } from "../auth";
import { readGuestToken } from "../guest/guestToken";
import { isGuestAllowedPath } from "../guest/guestRoutes";
import { apiBase } from "./base";
import { emitSessionExpired } from "./auth-bridge";
import {
  ApiError,
  ApiNetworkError,
  ApiSchemaError,
  UnauthenticatedError,
  UpgradeRequiredError,
  extractUserFacingMessage,
  parseRetryAfterSec,
} from "./errors";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ApiResult<T> =
  | { success: true; data: T }
  | {
      success: false;
      error:
        | ApiError
        | UnauthenticatedError
        | UpgradeRequiredError
        | ApiNetworkError
        | ApiSchemaError;
    };

export interface ApiClientOptions<T> {
  /** HTTP method. Defaults to "GET". */
  method?: Method;
  /**
   * Request body. If an object, JSON.stringified and Content-Type
   * application/json is set. If a string, sent as-is (caller controls
   * Content-Type via `headers`). If undefined, no body.
   */
  body?: unknown;
  /** Zod schema to validate the response payload against. */
  schema?: z.ZodType<T>;
  /**
   * "throw" (default) returns `Promise<T>` and throws typed errors.
   * "envelope" returns `Promise<ApiResult<T>>`; never throws for HTTP
   * errors (still throws for programmer errors like missing leading "/").
   */
  errorMode?: "throw" | "envelope";
  /** Defaults to true. Set false for unauthenticated routes (signup, login). */
  auth?: boolean;
  /**
   * Row 13 "Test Kitchen" · Block 2 — WHICH token to attach.
   *
   * "user" (the default) is every pre-existing call site, byte-unchanged:
   * `readToken()`, and a 401 means the session died.
   *
   * "guest" attaches the Test Kitchen guest token from lib/guest/guestToken.ts
   * and changes two things, both deliberate:
   *   1. the path must be on the guest allowlist (lib/guest/guestRoutes.ts) or
   *      this throws a programmer error rather than sending it — a guest token
   *      on a requireAuth route is a measured 401, and a 401 is a cascade;
   *   2. NO session-expired cascade, ever. A guest has no session to expire; a
   *      401 here means the guest session is spent (expired / claimed) and the
   *      Test Kitchen screens handle it by starting a new one.
   */
  principal?: "user" | "guest";
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /**
   * Response parser. Defaults to "json". "text" returns string; "none"
   * skips body parsing and resolves with the validated `undefined` (or
   * whatever the schema produces).
   */
  parseAs?: "json" | "text" | "none";
}

// ── Overloads ───────────────────────────────────────────────────────────

export async function apiClient<T = unknown>(
  path: string,
  opts?: Omit<ApiClientOptions<T>, "errorMode"> & { errorMode?: "throw" },
): Promise<T>;
export async function apiClient<T = unknown>(
  path: string,
  opts: Omit<ApiClientOptions<T>, "errorMode"> & { errorMode: "envelope" },
): Promise<ApiResult<T>>;
export async function apiClient<T = unknown>(
  path: string,
  opts: ApiClientOptions<T> = {},
): Promise<T | ApiResult<T>> {
  if (!path.startsWith("/")) {
    // Programmer error — surface loudly regardless of errorMode.
    throw new Error(
      `apiClient: path must start with "/" — got ${JSON.stringify(path)}`,
    );
  }

  const envelope = opts.errorMode === "envelope";
  const parseAs = opts.parseAs ?? "json";
  const method = opts.method ?? "GET";
  const wantsAuth = opts.auth !== false;
  // Row 13 Block 2 — a guest principal never participates in the cascade.
  const isGuest = opts.principal === "guest";
  if (isGuest && !isGuestAllowedPath(path)) {
    // Programmer error, and the one the allowlist exists to make impossible:
    // sending a guest token at a requireAuth route 401s, and an authenticated
    // 401 evicts the visitor to sign-in. Surface it loudly, both error modes.
    throw new Error(
      `apiClient: ${JSON.stringify(path)} is not a guest-allowed route — a guest action is a door, not a call`,
    );
  }

  // ── Token gate ─────────────────────────────────────────────────────
  let token: string | null = null;
  if (wantsAuth) {
    token = isGuest ? readGuestToken() : await readToken();
    if (!token) {
      if (!isGuest) emitSessionExpired();
      const err = new UnauthenticatedError({
        status: 401,
        body: null,
        userFacingMessage: isGuest
          ? "This Test Kitchen session has ended."
          : "You need to be signed in.",
      });
      if (envelope) return { success: false, error: err };
      throw err;
    }
  }

  // ── Headers ────────────────────────────────────────────────────────
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    if (typeof opts.body === "string") {
      body = opts.body;
    } else {
      body = JSON.stringify(opts.body);
      if (!headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
    }
  }

  // ── Fetch ──────────────────────────────────────────────────────────
  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, {
      method,
      headers,
      body,
      signal: opts.signal,
    });
  } catch (cause) {
    const err = new ApiNetworkError(
      cause instanceof Error ? cause.message : "Network request failed",
      cause,
    );
    if (envelope) return { success: false, error: err };
    throw err;
  }

  // ── Body parsing ──────────────────────────────────────────────────
  let rawBody: unknown = undefined;
  if (parseAs !== "none") {
    try {
      if (parseAs === "json") {
        // Allow 204/empty responses to parse as undefined for schemas
        // that expect z.void()/z.undefined().
        const text = await res.text();
        rawBody = text.length === 0 ? undefined : JSON.parse(text);
      } else {
        rawBody = await res.text();
      }
    } catch (cause) {
      // Body declared as JSON but unparseable — treat as schema/transport
      // problem. If the status was already non-2xx we still want to
      // surface an ApiError with raw text, not an ApiSchemaError, so
      // branch on res.ok.
      if (res.ok) {
        const err = new ApiSchemaError(
          "Response body was not valid JSON",
          cause instanceof Error ? cause.message : String(cause),
          undefined,
        );
        if (envelope) return { success: false, error: err };
        throw err;
      }
      rawBody = undefined;
    }
  }

  // ── Status routing ────────────────────────────────────────────────
  if (!res.ok) {
    const userFacingMessage = extractUserFacingMessage(rawBody);
    // BUG-296 — carry Retry-After so a 429's consumer can hold its submit
    // for the server's stated wait instead of guessing.
    const retryAfterSec = parseRetryAfterSec(res.headers.get("Retry-After"));
    const details = { status: res.status, body: rawBody, userFacingMessage, retryAfterSec };

    if (res.status === 401) {
      // Row 13 Block 2 — a GUEST 401 is never the cascade. It means the guest
      // session is spent (expired, or claimed by a sign-up that already handed
      // the visitor a real token); the Test Kitchen screens read the typed
      // UnauthenticatedError and start a fresh session. Firing the cascade here
      // would clear a user token this visitor does not have and evict them to
      // sign-in from a page they reached without ever signing in.
      //
      // WS9 BUG-239 — only an AUTHENTICATED request's 401 means "your session
      // died". On an `auth: false` route (login, signup) a 401 is the endpoint
      // rejecting the credentials in the body — a wrong password — and there
      // is no session to expire. Firing the cascade there clears a token that
      // was never sent and, worse, races AuthContext.login's own catch: the
      // handler's setError("Your session expired. Please sign in again.")
      // lands in a microtask AFTER login sets "Invalid email or password",
      // so the user got told their session expired for a typo.
      // The token gate above already made this distinction; the response path
      // did not.
      if (wantsAuth && !isGuest) emitSessionExpired();
      const err = new UnauthenticatedError(details);
      if (envelope) return { success: false, error: err };
      throw err;
    }
    if (res.status === 402) {
      const err = new UpgradeRequiredError(details);
      if (envelope) return { success: false, error: err };
      throw err;
    }
    const err = new ApiError(
      userFacingMessage ?? `Request failed (${res.status})`,
      details,
    );
    if (envelope) return { success: false, error: err };
    throw err;
  }

  // ── Schema validation ─────────────────────────────────────────────
  let value: unknown = rawBody;
  if (opts.schema) {
    const parsed = opts.schema.safeParse(rawBody);
    if (!parsed.success) {
      const err = new ApiSchemaError(
        "Response did not match schema",
        parsed.error.issues,
        rawBody,
      );
      if (envelope) return { success: false, error: err };
      throw err;
    }
    value = parsed.data;
  }

  if (envelope) return { success: true, data: value as T };
  return value as T;
}

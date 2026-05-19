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
import { apiBase } from "./base";
import { emitSessionExpired } from "./auth-bridge";
import {
  ApiError,
  ApiNetworkError,
  ApiSchemaError,
  UnauthenticatedError,
  UpgradeRequiredError,
  extractUserFacingMessage,
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

  // ── Token gate ─────────────────────────────────────────────────────
  let token: string | null = null;
  if (wantsAuth) {
    token = await readToken();
    if (!token) {
      emitSessionExpired();
      const err = new UnauthenticatedError({
        status: 401,
        body: null,
        userFacingMessage: "You need to be signed in.",
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
    const details = { status: res.status, body: rawBody, userFacingMessage };

    if (res.status === 401) {
      emitSessionExpired();
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

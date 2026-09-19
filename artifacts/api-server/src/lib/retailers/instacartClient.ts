// Row 8 · Block 1 — Instacart Developer Platform client: ONE call, "Create
// Shopping List Page" (POST /idp/v1/products/products_link). Kiwi sends a
// list, gets a URL back, the app opens it, the shopper shops on Instacart's
// page. Kiwi never sees the cart.
//
// Native fetch + AbortController, no SDK — the lib/email/sendEmail.ts
// reasoning applies unchanged: one endpoint, one JSON body, and a new package
// would change the deploy surface (build.mjs externals + the Dockerfile
// runtime tree; BUG-299 fails the container at BOOT).
//
// The key and host are read from env AT CALL TIME through `deps`, never at
// import — so tests inject fakes, Cloud Run keeps booting without the
// variables (neither is required at boot), and a route can only reach this
// through its deps seam. No retry in v1: a duplicate list page is harmless,
// a retry storm on a 5xx is not.
//
// Hosts: dev https://connect.dev.instacart.tools · prod
// https://connect.instacart.com — ENV-CONFIGURED, NEVER HARDCODED, NO
// DEFAULT. A missing host means "not configured", never "prod".
//
// 🔴 Nothing in this file logs the key, the Authorization header, the
// request body, or the returned URL's query string (affiliate parameters are
// auto-appended by Instacart; the URL is the user's to open, not the log's).

import { logger } from "../logger";
import type { InstacartShoppingListPayload } from "./instacartPayload";

export const ENV_INSTACART_API_KEY = "INSTACART_API_KEY";
export const ENV_INSTACART_API_BASE_URL = "INSTACART_API_BASE_URL";

export const PRODUCTS_LINK_PATH = "/idp/v1/products/products_link";
export const INSTACART_TIMEOUT_MS = 10_000;
const BODY_EXCERPT_MAX = 300;

export interface InstacartConfig {
  apiKey: string;
  /** Scheme + host, no trailing slash. */
  baseUrl: string;
}

/** The variable NAMES that are unset or blank. Empty when configured. */
export function missingInstacartEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = [];
  if (!(env[ENV_INSTACART_API_KEY] ?? "").trim()) missing.push(ENV_INSTACART_API_KEY);
  if (!(env[ENV_INSTACART_API_BASE_URL] ?? "").trim()) missing.push(ENV_INSTACART_API_BASE_URL);
  return missing;
}

/** Null when either variable is missing. Trailing slashes on the host are dropped. */
export function readInstacartConfig(env: NodeJS.ProcessEnv = process.env): InstacartConfig | null {
  if (missingInstacartEnv(env).length > 0) return null;
  return {
    apiKey: (env[ENV_INSTACART_API_KEY] ?? "").trim(),
    baseUrl: (env[ENV_INSTACART_API_BASE_URL] ?? "").trim().replace(/\/+$/, ""),
  };
}

interface BootLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
}

export interface InstacartBootReport {
  configured: boolean;
  missing: string[];
}

/**
 * BUG-263 style: ONE info line per boot naming the effective state and, when
 * unconfigured, the variable NAMES that are missing. Never a value. The
 * object carries only `event`, `configured`, `missing` and the host's origin
 * (not a secret; it tells dev from prod in the log), so the secret-hygiene
 * test can pin the key set.
 */
export function logInstacartConfig(
  env: NodeJS.ProcessEnv = process.env,
  log: BootLogger = logger,
): InstacartBootReport {
  const missing = missingInstacartEnv(env);
  const configured = missing.length === 0;
  const host = configured ? safeOrigin(readInstacartConfig(env)!.baseUrl) : null;
  log.info(
    { event: "instacart_config", configured, missing, host },
    configured
      ? `instacart: configured (${host})`
      : `instacart: not configured (missing ${missing.join(", ")})`,
  );
  return { configured, missing };
}

function safeOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return "invalid-url";
  }
}

// ── errors ──────────────────────────────────────────────────────────────

/** Non-2xx, a malformed 2xx, or a network failure (status 0). */
export class InstacartApiError extends Error {
  readonly status: number;
  readonly bodyExcerpt: string;
  constructor(status: number, bodyExcerpt: string) {
    super(`Instacart request failed (status ${status})`);
    this.name = "InstacartApiError";
    this.status = status;
    this.bodyExcerpt = bodyExcerpt;
  }
}

export class InstacartTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Instacart request timed out after ${timeoutMs}ms`);
    this.name = "InstacartTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

// ── the call ────────────────────────────────────────────────────────────

export interface InstacartClientDeps {
  config: InstacartConfig;
  fetch?: typeof fetch;
  timeoutMs?: number;
  log?: { info: BootLogger["info"]; warn: BootLogger["info"] };
}

export interface CreateShoppingListLinkResult {
  url: string;
}

export type CreateShoppingListLink = (
  payload: InstacartShoppingListPayload,
  deps: InstacartClientDeps,
) => Promise<CreateShoppingListLinkResult>;

function excerpt(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > BODY_EXCERPT_MAX ? `${oneLine.slice(0, BODY_EXCERPT_MAX)}…` : oneLine;
}

export const createShoppingListLink: CreateShoppingListLink = async (payload, deps) => {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? INSTACART_TIMEOUT_MS;
  const log = deps.log ?? logger;
  const endpoint = `${deps.config.baseUrl}${PRODUCTS_LINK_PATH}`;
  const itemCount = payload.line_items.length;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let status = 0;
  let succeeded = false;
  try {
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${deps.config.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new InstacartTimeoutError(timeoutMs);
      // Network-level failure: DNS, refused, reset. No status to report.
      const message = err instanceof Error ? err.message : String(err);
      throw new InstacartApiError(0, excerpt(message));
    }
    status = res.status;
    const text = await res.text();
    if (!res.ok) {
      throw new InstacartApiError(status, excerpt(text));
    }
    let parsed: { products_link_url?: unknown };
    try {
      parsed = JSON.parse(text) as { products_link_url?: unknown };
    } catch {
      throw new InstacartApiError(status, `non-JSON 2xx body: ${excerpt(text)}`);
    }
    const url = parsed.products_link_url;
    if (typeof url !== "string" || !/^https:\/\//.test(url)) {
      throw new InstacartApiError(status, "2xx without products_link_url");
    }
    succeeded = true;
    return { url };
  } finally {
    clearTimeout(timer);
    // One structured line per call, success or failure. The endpoint is
    // host + path only; the key, the body and the returned URL never appear.
    const latencyMs = Date.now() - startedAt;
    const line = {
      event: "instacart_products_link",
      retailer: "instacart",
      endpoint,
      status,
      latencyMs,
      itemCount,
    };
    if (succeeded) {
      log.info(line, "Instacart products_link call");
    } else {
      log.warn(line, "Instacart products_link call failed");
    }
  }
};

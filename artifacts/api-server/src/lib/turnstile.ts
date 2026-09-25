// Row 13 "Test Kitchen" · Block 1 (D-WS9-262) — Cloudflare Turnstile.
//
// MOUNTED ON POST /guest/session AND NOWHERE ELSE. The tempting second mount
// is signup, and Phase 0 ruled it out for a concrete reason: the native app
// signs up too and cannot solve a web widget, so a signup-side check would
// need a native exemption, and any exemption a client can claim is an
// exemption an attacker can claim. Signup hardening stays BUG-222's product
// half. Here the check guards exactly one thing — the door through which
// anonymous traffic starts spending Anthropic tokens.
//
// ⚠️ UNSET = PASS THROUGH. TURNSTILE_SECRET_KEY is not set on Cloud Run today
// and the funnel must be buildable and testable before it is. One boot-time
// warning names the state; per-request silence.
//
// ⚠️ CONFIGURED = FAIL CLOSED. Once the key is set, anything that is not a
// verified token is a 403: a missing token, a rejected token, a verify call
// that times out, a verify call that throws. A bot check that opens when
// Cloudflare is slow is not a bot check — and the cost of a false 403 is one
// visitor retrying, while the cost of a false pass is unbounded spend.

import { logger } from "./logger";

export const ENV_TURNSTILE_SECRET_KEY = "TURNSTILE_SECRET_KEY";

export const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Ten seconds. Cloudflare's own budget for this call is far under a second. */
export const TURNSTILE_TIMEOUT_MS = 10_000;

export type TurnstileVerdict =
  | { ok: true; disabled?: boolean }
  | { ok: false; reason: "missing_token" | "rejected" | "timeout" | "error" };

/** The outbound seam. Tests inject; production passes globalThis.fetch. */
export type TurnstileFetch = (
  url: string,
  init: { method: string; body: URLSearchParams; signal: AbortSignal },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export function readTurnstileSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env[ENV_TURNSTILE_SECRET_KEY];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

export interface VerifyTurnstileOptions {
  token: string | undefined;
  remoteIp?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: TurnstileFetch;
  timeoutMs?: number;
}

export async function verifyTurnstile(
  opts: VerifyTurnstileOptions,
): Promise<TurnstileVerdict> {
  const secret = readTurnstileSecret(opts.env ?? process.env);
  if (!secret) return { ok: true, disabled: true };

  if (typeof opts.token !== "string" || opts.token.trim() === "") {
    return { ok: false, reason: "missing_token" };
  }

  const fetchImpl: TurnstileFetch =
    opts.fetchImpl ??
    ((url, init) =>
      globalThis.fetch(url, init as unknown as RequestInit) as unknown as ReturnType<
        TurnstileFetch
      >);

  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", opts.token);
  // Only sent when the deploy actually knows the address — behind Cloud Run
  // with TRUST_PROXY_HOPS unset, req.ip is Google's front end, and telling
  // Cloudflare that every visitor shares one address is worse than silence.
  if (opts.remoteIp && opts.remoteIp !== "unknown") {
    body.set("remoteip", opts.remoteIp);
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? TURNSTILE_TIMEOUT_MS,
  );
  try {
    const res = await fetchImpl(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body,
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: "error" };
    const parsed = (await res.json()) as { success?: unknown };
    return parsed?.success === true
      ? { ok: true }
      : { ok: false, reason: "rejected" };
  } catch (err) {
    // AbortError (our timeout) and a transport failure land in the same place
    // and get the same verdict — both mean "we did not verify this visitor".
    const timedOut =
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError");
    logger.warn(
      { event: "turnstile_verify_failed", timedOut, err },
      "Turnstile verification could not complete — refusing (fail closed)",
    );
    return { ok: false, reason: timedOut ? "timeout" : "error" };
  } finally {
    clearTimeout(timer);
  }
}

// One line at boot, beside the spend guard's, so the check's real state is on
// the first page of every revision's logs rather than inferred from silence.
export function logTurnstileConfig(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<typeof logger, "info" | "warn"> = logger,
): boolean {
  const configured = readTurnstileSecret(env) !== null;
  if (configured) {
    log.info(
      { event: "turnstile_config", configured: true },
      "Turnstile: configured — POST /guest/session requires a verified token",
    );
  } else {
    log.warn(
      { event: "turnstile_disabled", vars: [ENV_TURNSTILE_SECRET_KEY] },
      `Turnstile: NOT configured (${ENV_TURNSTILE_SECRET_KEY} unset) — POST /guest/session accepts every caller`,
    );
  }
  return configured;
}

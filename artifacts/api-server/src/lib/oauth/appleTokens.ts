// Row 9 (1.1) · OAuth Block 1 Part E — APPLE'S TOKEN ENDPOINTS.
//
// ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────
//
// App Store Review guideline 5.1.1(v): an app that offers Sign in with Apple
// and lets people delete their account MUST revoke the Apple token as part of
// that deletion. It is not optional and it is not advice — a submission
// without it is rejected.
//
// Revoking needs a refresh token. Apple issues one exactly once, in exchange
// for the one-time `authorizationCode` that comes back beside the identity
// token on the first authorisation. So the flow is:
//
//   sign-in  →  exchange the code  →  store the refresh token (ENCRYPTED)
//   DELETE /me  →  revoke it at Apple  →  delete the account
//
// ── THE CLIENT SECRET IS NOT A SECRET STRING ─────────────────────────────
//
// Apple has no client secret to copy from a console. It wants a short-lived
// JWT that YOU sign with the `.p8` key from the developer portal:
//
//   header   { alg: ES256, kid: APPLE_KEY_ID }
//   payload  { iss: APPLE_TEAM_ID, aud: "https://appleid.apple.com",
//              sub: <the client_id>, iat, exp }
//
// `jsonwebtoken` signs ES256 from the PEM directly — no new dependency, which
// matters here because Block 2 is running in the same working tree and an
// install would rewrite the shared node_modules under it.
//
// `sub` is the CLIENT_ID, and which client id is not a constant:
// APPLE_OAUTH_AUDIENCES is a list (a bundle id for native, a Services ID for
// web) and Apple's /auth/revoke insists on the same client_id the token was
// minted for. That is why `user_identities.appleClientId` exists — it records
// the verified token's own `aud` so deletion does not have to guess.
//
// ── BEST-EFFORT, AND SAID OUT LOUD ───────────────────────────────────────
//
// A failed code exchange NEVER blocks a sign-in: the person is verified, and
// refusing to let them in because a secondary call to Apple timed out would
// trade a real login for a future convenience. It is logged.
//
// A failed REVOKE never blocks a deletion either. A user asking to be deleted
// gets deleted; the alternative is an account that cannot be removed because a
// third party is having an outage, which is worse for them and worse for us
// under GDPR. The failure is logged loudly so it can be chased.
//
// ── THE SEAM ─────────────────────────────────────────────────────────────
//
// `fetch` is injected with NO default. The suite loads `.env`; a default that
// reached appleid.apple.com would put a live POST one forgotten stub away from
// the hermetic tests.

import jwt from "jsonwebtoken";

import type { AppleSigningConfig } from "./config";
import { logger } from "../logger";

export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
export const APPLE_AUD = "https://appleid.apple.com";

/** Ten seconds. Both endpoints answer in well under a second in practice. */
export const APPLE_TIMEOUT_MS = 10_000;

/**
 * Apple's documented maximum for the client secret is six months. Ten minutes
 * is used instead: the JWT is minted per call and never stored, so a long life
 * buys nothing and a captured one would stay usable for half a year.
 */
const CLIENT_SECRET_TTL_SECONDS = 600;

/** The outbound seam. Structural, so a test hands in three fields. */
export type AppleFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: URLSearchParams; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export function buildAppleClientSecret(
  signing: AppleSigningConfig,
  clientId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  return jwt.sign(
    {
      iss: signing.teamId,
      iat: nowSeconds,
      exp: nowSeconds + CLIENT_SECRET_TTL_SECONDS,
      aud: APPLE_AUD,
      sub: clientId,
    },
    signing.privateKey,
    { algorithm: "ES256", keyid: signing.keyId },
  );
}

export interface AppleCodeExchange {
  refreshToken: string | null;
}

interface AppleCallOptions {
  signing: AppleSigningConfig;
  clientId: string;
  fetchImpl: AppleFetch;
  timeoutMs?: number;
}

async function postToApple(
  url: string,
  params: URLSearchParams,
  opts: AppleCallOptions,
): Promise<{ ok: true; body: string } | { ok: false; detail: string }> {
  let clientSecret: string;
  try {
    clientSecret = buildAppleClientSecret(opts.signing, opts.clientId);
  } catch (err) {
    // A malformed `.p8` lands here. The KEY ITSELF NEVER REACHES THE LOG —
    // only the error's own message, which describes the parse failure.
    return { ok: false, detail: `client_secret: ${err instanceof Error ? err.message : "unsignable"}` };
  }
  params.set("client_id", opts.clientId);
  params.set("client_secret", clientSecret);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? APPLE_TIMEOUT_MS);
  try {
    const res = await opts.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params,
      signal: controller.signal,
    });
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      // Apple's error bodies are a small JSON object naming the problem
      // (`invalid_grant`, `invalid_client`). It carries no credential of ours,
      // so it is safe to log and is by far the most useful thing to have.
      return { ok: false, detail: `http ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true, body };
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    return { ok: false, detail: timedOut ? "timeout" : err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Trade the one-time authorization code for a refresh token.
 *
 * Returns `{ refreshToken: null }` on ANY failure rather than throwing: every
 * caller's correct response is the same — log it and carry on with the
 * sign-in — and a throw here would have to be caught at the route anyway, one
 * level further from the reason.
 */
export async function exchangeAppleAuthorizationCode(opts: AppleCallOptions & {
  authorizationCode: string;
}): Promise<AppleCodeExchange> {
  const params = new URLSearchParams();
  params.set("grant_type", "authorization_code");
  params.set("code", opts.authorizationCode);

  const res = await postToApple(APPLE_TOKEN_URL, params, opts);
  if (!res.ok) {
    logger.warn(
      { event: "apple_code_exchange_failed", detail: res.detail },
      "Apple authorization-code exchange failed — sign-in proceeds, but DELETE /me will have no token to revoke",
    );
    return { refreshToken: null };
  }
  try {
    const parsed = JSON.parse(res.body) as { refresh_token?: unknown };
    const token = typeof parsed.refresh_token === "string" ? parsed.refresh_token : null;
    if (!token) {
      logger.warn(
        { event: "apple_code_exchange_no_refresh_token" },
        "Apple accepted the code but returned no refresh_token",
      );
    }
    return { refreshToken: token };
  } catch {
    logger.warn({ event: "apple_code_exchange_unparseable" }, "Apple's token response was not JSON");
    return { refreshToken: null };
  }
}

export type AppleRevokeOutcome = { ok: true } | { ok: false; detail: string };

/**
 * Revoke a refresh token at Apple. Called from DELETE /me BEFORE the account
 * is deleted, once per Apple identity, and its failure NEVER blocks the delete.
 *
 * `token_type_hint=refresh_token` is required by Apple; without it the call is
 * a 400 that reads like a bad token.
 */
export async function revokeAppleToken(
  opts: AppleCallOptions & { refreshToken: string },
): Promise<AppleRevokeOutcome> {
  const params = new URLSearchParams();
  params.set("token", opts.refreshToken);
  params.set("token_type_hint", "refresh_token");

  const res = await postToApple(APPLE_REVOKE_URL, params, opts);
  return res.ok ? { ok: true } : { ok: false, detail: res.detail };
}

/** The real outbound call. Only production passes this. */
export const productionAppleFetch: AppleFetch = (url, init) =>
  globalThis.fetch(url, init as unknown as RequestInit) as unknown as ReturnType<AppleFetch>;

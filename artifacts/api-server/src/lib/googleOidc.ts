// Row 5 · Block 1c (D-WS9-248 step 4) — verifying a Google-issued OIDC ID
// token, the way Cloud Scheduler authenticates to a Cloud Run endpoint
// (`--oidc-service-account-email` + `--oidc-token-audience` on the job).
//
// No new dependency: the signature check is `jsonwebtoken` (already here for
// sessions) over a public key built from Google's JWKS with Node's own
// `crypto.createPublicKey({ format: "jwk" })`. The JWKS fetch is INJECTED
// (the hermetic suite never touches the network) and cached per key id for
// the max-age Google sends; a key id the cache does not know forces one
// refetch (Google rotates keys).
//
// What a token must satisfy, all of it, or the caller is refused:
//   • RS256, signed by a key in Google's current JWKS
//   • iss  = https://accounts.google.com (or the bare host — both are issued)
//   • aud  = the configured audience (the drain URL the job was created with)
//   • exp  in the future (jsonwebtoken checks it)
//   • email in the configured allowlist AND email_verified
//
// ⚠️ No secret is involved: the service-account email and the audience are
// configuration, not credentials. Nothing to put in Secret Manager for this.

import { createPublicKey, type KeyObject } from "node:crypto";
import jwt from "jsonwebtoken";

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"] as const;
const DEFAULT_CACHE_MS = 60 * 60 * 1000;
const MIN_CACHE_MS = 60 * 1000;

export type JwksFetch = (url: string) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface OidcVerifyDeps {
  fetch: JwksFetch;
  now?: () => number;
  jwksUrl?: string;
}

export interface OidcExpectation {
  audience: string;
  // Lower-cased, exact. Empty = nobody is allowed (fail closed).
  emails: readonly string[];
}

export type OidcVerdict =
  | { ok: true; email: string }
  | {
      ok: false;
      reason:
        | "no_token"
        | "malformed"
        | "unknown_kid"
        | "jwks_unavailable"
        | "bad_signature_or_claims"
        | "email_not_allowed"
        | "email_not_verified";
      detail?: string;
    };

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

export class GoogleJwksCache {
  private keys = new Map<string, KeyObject>();
  private expiresAt = 0;
  constructor(private readonly deps: OidcVerifyDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async refresh(): Promise<boolean> {
    const res = await this.deps.fetch(this.deps.jwksUrl ?? GOOGLE_JWKS_URL);
    if (!res.ok) return false;
    const body = (await res.json()) as { keys?: Jwk[] };
    const next = new Map<string, KeyObject>();
    for (const k of body.keys ?? []) {
      if (!k.kid || k.kty !== "RSA" || !k.n || !k.e) continue;
      try {
        next.set(k.kid, createPublicKey({ key: { kty: "RSA", n: k.n, e: k.e }, format: "jwk" }));
      } catch {
        /* a malformed entry is skipped, not fatal */
      }
    }
    const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "");
    const ttl = maxAge ? Math.max(MIN_CACHE_MS, Number(maxAge[1]) * 1000) : DEFAULT_CACHE_MS;
    this.keys = next;
    this.expiresAt = this.now() + ttl;
    return true;
  }

  // The key for `kid`, refetching once if the cache is stale or does not know
  // the id. `undefined` = Google does not (currently) publish that key.
  // Throws only when the JWKS endpoint itself is unreachable.
  async keyFor(kid: string): Promise<KeyObject | undefined> {
    if (this.now() < this.expiresAt && this.keys.has(kid)) return this.keys.get(kid);
    const fetched = await this.refresh();
    if (!fetched) throw new Error("jwks_unavailable");
    return this.keys.get(kid);
  }
}

export async function verifyGoogleIdToken(
  token: string | undefined,
  expect: OidcExpectation,
  cache: GoogleJwksCache,
): Promise<OidcVerdict> {
  if (!token) return { ok: false, reason: "no_token" };
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded === "string" || !decoded.header.kid || decoded.header.alg !== "RS256") {
    return { ok: false, reason: "malformed" };
  }
  let key: KeyObject | undefined;
  try {
    key = await cache.keyFor(decoded.header.kid);
  } catch (err) {
    return { ok: false, reason: "jwks_unavailable", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!key) return { ok: false, reason: "unknown_kid" };

  let payload: jwt.JwtPayload;
  try {
    const verified = jwt.verify(token, key, {
      algorithms: ["RS256"],
      audience: expect.audience,
      issuer: [...GOOGLE_ISSUERS],
    });
    if (typeof verified === "string") return { ok: false, reason: "malformed" };
    payload = verified;
  } catch (err) {
    return { ok: false, reason: "bad_signature_or_claims", detail: err instanceof Error ? err.message : String(err) };
  }
  const email = typeof payload["email"] === "string" ? payload["email"].toLowerCase() : "";
  if (!email || !expect.emails.includes(email)) return { ok: false, reason: "email_not_allowed" };
  if (payload["email_verified"] !== true) return { ok: false, reason: "email_not_verified" };
  return { ok: true, email };
}

// "a@x, B@Y" → ["a@x", "b@y"]. Unset/blank → [] (fail closed).
export function parseEmailAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

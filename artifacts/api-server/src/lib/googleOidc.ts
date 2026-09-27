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

import type { KeyObject } from "node:crypto";
import jwt from "jsonwebtoken";

import { JwksCache, type JwksCacheDeps, type JwksFetch } from "./oauth/jwks";

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"] as const;

// Row 9 (1.1) · OAuth Block 1 Part A — THE CACHE MOVED to lib/oauth/jwks.ts.
// It held nothing that was about Google: a JWKS fetch, RSA JWKs turned into
// KeyObjects, a max-age TTL and a refetch on an unknown kid. Apple publishes
// the same document, so the user-facing OAuth lane needed the same class, and
// a second copy of it would be a second place for the rotation logic to drift.
// Re-exported under both of the names this file used to define, so every
// import in the repo (internal.ts, guestSweep.test.ts,
// internalImageDrain.test.ts, googleOidc.test.ts) is unchanged.
export type { JwksFetch };
export type OidcVerifyDeps = JwksCacheDeps;

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

// The Google-flavoured cache: the shared class plus the one fact that is
// Google's, its key endpoint. Callers that already pass a `jwksUrl` (the
// drain tests do not, but the option survives) keep theirs.
export class GoogleJwksCache extends JwksCache {
  constructor(deps: OidcVerifyDeps) {
    super({ ...deps, jwksUrl: deps.jwksUrl ?? GOOGLE_JWKS_URL });
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

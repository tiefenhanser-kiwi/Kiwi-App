// Row 9 (1.1) · OAuth Block 1 Part C — VERIFYING AN IDENTITY TOKEN.
//
// ── THE ONE RULE ─────────────────────────────────────────────────────────
//
// The server never trusts a claim the client made about itself. A request
// body saying `{ email, appleUserId }` is a request body; a signed identity
// token checked against the provider's published keys is evidence. Everything
// this module does is turn the second into a small, typed fact, and refuse
// everything that is not one.
//
// ── WHAT A TOKEN MUST SATISFY ────────────────────────────────────────────
//
// Both providers:
//   • RS256, `kid` present, signed by a key in the provider's CURRENT JWKS
//   • `iss` exactly the provider's issuer
//   • `aud` ∈ the configured list (the bundle id / Services ID / client ids)
//   • `exp` in the future — enforced by `jsonwebtoken`, not by us
//   • `sub` present and non-empty — it is the identity
//
// Apple additionally:
//   • `nonce` === sha256hex(the raw nonce the client sends up with the token)
//
// Google additionally:
//   • nothing. A nonce is OPTIONAL in Google's native flows and requiring one
//     would refuse correct clients; replay protection there rests on the
//     five-minute-ish `exp` and on the token being useless without TLS to us.
//     Said out loud because the asymmetry looks like an oversight and is not.
//
// ── WHY THE NONCE MATTERS, in one sentence ───────────────────────────────
//
// Without it, an identity token captured from ANY other app that shares this
// Apple team's audience could be replayed here to sign in as its owner. The
// client generates a random `rawNonce`, sends Apple `sha256hex(rawNonce)`,
// Apple echoes that hash inside the signed token, and the client sends us the
// RAW value — which only the party that started this particular sign-in has.
//
// 🔴 HEX, LOWER-CASE, of the UTF-8 bytes. This is the Firebase / Apple-docs
// convention and every major client library does it, but it IS a convention:
// a client that base64s the digest instead will fail this check with a
// perfectly valid token. The mobile block must match this line exactly.
//
// ── THE SEAM ─────────────────────────────────────────────────────────────
//
// `JwksCache` takes an injected fetch and there is no default. `pnpm test`
// runs with `--env-file=.env`, so a module reaching for `globalThis.fetch`
// would leave Apple's and Google's live key endpoints one forgotten stub away
// from the hermetic suite. Tests generate their own RSA pair and serve it.

import { createHash } from "node:crypto";
import type { KeyObject } from "node:crypto";
import jwt from "jsonwebtoken";

import { JwksCache, type JwksCacheDeps } from "./jwks";

export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";

// Google issues both spellings and has for years. Accepting exactly these two
// and nothing else is the same list lib/googleOidc.ts uses for the drain.
export const GOOGLE_USER_ISSUERS = [
  "https://accounts.google.com",
  "accounts.google.com",
] as const;
export const GOOGLE_JWKS_URL_V3 = "https://www.googleapis.com/oauth2/v3/certs";

export type OAuthProviderName = "apple" | "google";

/**
 * Every way a token can be refused. It is a closed set on purpose: the ROUTE
 * answers one generic 401 whatever lands here (§2.8 — no reason on the wire),
 * and this is what goes in the log instead, so a real failure is diagnosable
 * without the response ever saying which check failed.
 */
export type IdentityRefusal =
  | "not_configured"
  | "no_token"
  | "malformed"
  | "unknown_kid"
  | "jwks_unavailable"
  | "bad_signature_or_claims"
  | "no_subject"
  | "nonce_missing"
  | "nonce_mismatch";

export interface VerifiedIdentity {
  provider: OAuthProviderName;
  /** The `sub` claim. Stable, opaque, and the ONLY thing that signs anyone in. */
  subject: string;
  /** Lower-cased, or null when the provider asserted none. */
  email: string | null;
  /** Did the provider say the email is verified? Unverified NEVER links. */
  emailVerified: boolean;
  /** Apple Hide My Email — a `@privaterelay.appleid.com` address. */
  isPrivateRelay: boolean;
  /** The `aud` this token actually carried — recorded, and used for revoke. */
  audience: string;
  /** Apple sends the name to the CLIENT on first authorisation, never here. */
  firstName: string | null;
  lastName: string | null;
}

export type IdentityVerdict =
  | { ok: true; identity: VerifiedIdentity }
  | { ok: false; reason: IdentityRefusal; detail?: string };

export const PRIVATE_RELAY_DOMAIN = "privaterelay.appleid.com";

export function isPrivateRelayEmail(email: string | null): boolean {
  return email !== null && email.toLowerCase().endsWith(`@${PRIVATE_RELAY_DOMAIN}`);
}

/** The exact transform the client must have applied before talking to Apple. */
export function hashNonce(rawNonce: string): string {
  return createHash("sha256").update(rawNonce, "utf8").digest("hex");
}

/**
 * Apple and Google both send `email_verified` as a BOOLEAN or as the STRING
 * "true"/"false", depending on the endpoint and the year. Treating the string
 * "false" as truthy — which a bare `!!claim` does — would link an unverified
 * email to an existing account, which is the account-takeover this whole
 * branch exists to prevent. So: exactly `true` or exactly `"true"`.
 */
function claimIsTrue(value: unknown): boolean {
  return value === true || value === "true";
}

interface VerifyArgs {
  provider: OAuthProviderName;
  token: string | undefined;
  audiences: readonly string[];
  issuers: readonly string[];
  cache: JwksCache;
}

async function verifySigned(
  args: VerifyArgs,
): Promise<{ ok: true; payload: jwt.JwtPayload } | { ok: false; reason: IdentityRefusal; detail?: string }> {
  // The OFF state, checked FIRST. An empty audience list with `jsonwebtoken`'s
  // `audience: []` does not refuse everything — it skips the check — so the
  // one thing that must never happen is falling through to verify with it.
  if (args.audiences.length === 0) return { ok: false, reason: "not_configured" };
  if (!args.token) return { ok: false, reason: "no_token" };

  const decoded = jwt.decode(args.token, { complete: true });
  if (
    !decoded ||
    typeof decoded === "string" ||
    !decoded.header.kid ||
    decoded.header.alg !== "RS256"
  ) {
    // 🔴 The `alg` check is not belt-and-braces. Without it a token with
    // `alg: "none"`, or an HS256 token signed with the provider's PUBLIC key
    // as the HMAC secret, is the textbook JWT forgery — and both providers
    // publish that key. `jwt.verify`'s `algorithms` option below refuses it
    // too; this refuses it before a key lookup, and neither is removable.
    return { ok: false, reason: "malformed" };
  }

  let key: KeyObject | undefined;
  try {
    key = await args.cache.keyFor(decoded.header.kid);
  } catch (err) {
    return {
      ok: false,
      reason: "jwks_unavailable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!key) return { ok: false, reason: "unknown_kid" };

  try {
    const verified = jwt.verify(args.token, key, {
      algorithms: ["RS256"],
      // An ARRAY: any one of the configured client ids is acceptable, which is
      // what lets one deploy serve the iOS app, the Android app and the web
      // button without three code paths.
      // The tuple casts are `jsonwebtoken`'s types insisting on a NON-EMPTY
      // array. Both lists are non-empty by construction here: `audiences` was
      // checked above (empty = `not_configured`, never a skipped check) and
      // `issuers` is a module-level literal.
      audience: [...args.audiences] as [string, ...string[]],
      issuer: [...args.issuers] as [string, ...string[]],
    });
    if (typeof verified === "string") return { ok: false, reason: "malformed" };
    return { ok: true, payload: verified };
  } catch (err) {
    // Expiry, wrong audience, wrong issuer and a bad signature all land here
    // and all get the SAME reason. The detail goes to the log; the route says
    // 401 and nothing else.
    return {
      ok: false,
      reason: "bad_signature_or_claims",
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}

function readAudience(payload: jwt.JwtPayload, fallback: string): string {
  const aud = payload.aud;
  if (typeof aud === "string") return aud;
  if (Array.isArray(aud) && typeof aud[0] === "string") return aud[0];
  return fallback;
}

function readEmail(payload: jwt.JwtPayload): string | null {
  const raw = payload["email"];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}

export interface AppleVerifyOptions {
  identityToken: string | undefined;
  /** The pre-hash value. Apple's token carries sha256hex of it. */
  rawNonce: string | undefined;
  audiences: readonly string[];
  cache: JwksCache;
}

export async function verifyAppleIdentityToken(
  opts: AppleVerifyOptions,
): Promise<IdentityVerdict> {
  const signed = await verifySigned({
    provider: "apple",
    token: opts.identityToken,
    audiences: opts.audiences,
    issuers: [APPLE_ISSUER],
    cache: opts.cache,
  });
  if (!signed.ok) return signed;
  const { payload } = signed;

  const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!subject) return { ok: false, reason: "no_subject" };

  // ── the nonce, and it is NOT optional ───────────────────────────────────
  const tokenNonce = payload["nonce"];
  if (typeof opts.rawNonce !== "string" || opts.rawNonce.trim() === "") {
    return { ok: false, reason: "nonce_missing" };
  }
  if (typeof tokenNonce !== "string" || tokenNonce === "") {
    // A token with no nonce claim cannot be bound to this sign-in attempt, so
    // it is refused even though every other check passed. Accepting it "when
    // Apple did not send one" would be a downgrade an attacker chooses.
    return { ok: false, reason: "nonce_missing" };
  }
  if (tokenNonce.toLowerCase() !== hashNonce(opts.rawNonce)) {
    return { ok: false, reason: "nonce_mismatch" };
  }

  const email = readEmail(payload);
  return {
    ok: true,
    identity: {
      provider: "apple",
      subject,
      email,
      // Apple's `email_verified` is `true` or `"true"`; a relay address is
      // always verified by construction (Apple owns the mailbox).
      emailVerified: claimIsTrue(payload["email_verified"]),
      // Apple sends `is_private_email`; the address itself is the belt to that
      // brace, and either one is enough — a relay address whose claim is
      // missing must still be flagged.
      isPrivateRelay:
        claimIsTrue(payload["is_private_email"]) || isPrivateRelayEmail(email),
      audience: readAudience(payload, opts.audiences[0] ?? ""),
      // Apple NEVER puts a name in the identity token. It hands the name to
      // the client once, on the very first authorisation, and never again — so
      // the route takes it from the body. These stay null; they exist on the
      // type only so both providers return the same shape.
      firstName: null,
      lastName: null,
    },
  };
}

export interface GoogleVerifyOptions {
  idToken: string | undefined;
  clientIds: readonly string[];
  cache: JwksCache;
}

export async function verifyGoogleIdentityToken(
  opts: GoogleVerifyOptions,
): Promise<IdentityVerdict> {
  const signed = await verifySigned({
    provider: "google",
    token: opts.idToken,
    audiences: opts.clientIds,
    issuers: GOOGLE_USER_ISSUERS,
    cache: opts.cache,
  });
  if (!signed.ok) return signed;
  const { payload } = signed;

  const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!subject) return { ok: false, reason: "no_subject" };

  const str = (k: string): string | null => {
    const v = payload[k];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };

  return {
    ok: true,
    identity: {
      provider: "google",
      subject,
      email: readEmail(payload),
      emailVerified: claimIsTrue(payload["email_verified"]),
      isPrivateRelay: false,
      audience: readAudience(payload, opts.clientIds[0] ?? ""),
      // Google DOES send these, so they are read. The body still wins at the
      // route (§2.4c) — a client that collected a name is more current than a
      // Google profile the user last edited in 2014.
      firstName: str("given_name"),
      lastName: str("family_name"),
    },
  };
}

// ── the production caches ────────────────────────────────────────────────
//
// One per provider, module-level, so the key set survives across requests —
// which is the entire point of caching them. Built lazily and from an injected
// fetch, because a module-level `new JwksCache({ fetch: globalThis.fetch })`
// would be a live network handle constructed at import time in the test suite.

let appleCache: JwksCache | null = null;
let googleCache: JwksCache | null = null;

function realFetch(): JwksCacheDeps["fetch"] {
  return (url: string) => globalThis.fetch(url) as unknown as ReturnType<JwksCacheDeps["fetch"]>;
}

export function productionAppleJwksCache(): JwksCache {
  appleCache ??= new JwksCache({ fetch: realFetch(), jwksUrl: APPLE_JWKS_URL });
  return appleCache;
}

export function productionGoogleJwksCache(): JwksCache {
  googleCache ??= new JwksCache({ fetch: realFetch(), jwksUrl: GOOGLE_JWKS_URL_V3 });
  return googleCache;
}

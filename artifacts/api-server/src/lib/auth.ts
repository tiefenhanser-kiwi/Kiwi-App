import { randomUUID } from "node:crypto";

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const BCRYPT_ROUNDS = 10; // TODO(pre-launch): upgrade to 12
const DEFAULT_SESSION_EXPIRY = "30d";

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  throw new Error("JWT_SECRET environment variable is required.");
}

// JWT purpose claim. WS7-2 Block A: lets a single signing helper produce
// purpose-scoped tokens (session vs password_reset vs email_change) and have
// the verifier refuse cross-purpose reuse — e.g. a stolen reset token can't
// be replayed as a session token.
// Row 13 · Block 1 (D-WS9-259) — "guest" joins the set. A guest token carries
// the GuestSession.id in the `userId` slot (so the !decoded.userId guard below
// and every limiter keyFn keep working unchanged) and expires in 24 h.
// requireAuth still demands purpose "session", so a guest token authenticates
// nothing outside the routes requireGuestOrAuth explicitly opens.
export type TokenPurpose =
  | "session"
  | "password_reset"
  | "email_change"
  | "guest";

export interface JwtPayload {
  userId: string;
  purpose: TokenPurpose;
  iat: number;
  exp: number;
  /**
   * WS9A BUG-233 — the token's unique id, the handle the spent-token ledger
   * is keyed by. Optional on read, not on write: every token minted from this
   * commit forward carries one, but a token minted before it does not, and
   * such a token is still inside its expiry window when this ships. Callers
   * that redeem a purpose token MUST treat a missing `jti` as unredeemable
   * rather than as "not yet spent" — see requireUnspent() in tokenRevocation.
   */
  jti?: string;
  /**
   * SEC-2 #6 — when the person last proved who they are (a sign-in), in
   * seconds. Stamped on every SESSION token at mint, and session tokens are
   * minted only by sign-up, sign-in and the OAuth doors, so it equals `iat`.
   * A token minted before SEC-2 has none: it keeps working everywhere except
   * the two routes that demand a recent sign-in from an OAuth-only account
   * (lib/reauth.ts).
   */
  auth_time?: number;
  [k: string]: unknown;
}

export interface SignTokenOptions {
  purpose?: TokenPurpose;
  expiresIn?: string;
  /** Extra non-reserved claims (e.g. { newEmail } for email-change tokens). */
  extra?: Record<string, unknown>;
}

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  plaintext: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

// SEC-2 #13 — a real hash of nothing anyone knows, made once on first use at
// the CURRENT cost, so a check against it takes as long as a check against a
// real account's hash.
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHash ??= bcrypt.hash(randomUUID(), BCRYPT_ROUNDS);
  return dummyHash;
}

/**
 * SEC-2 #13 — verify a password whether or not there is a hash to verify it
 * against. Login used to answer an unknown email (and an OAuth-only account)
 * without running bcrypt at all — a few milliseconds instead of a hundred,
 * which told anyone timing the 401 whether the address had an account. With
 * no hash, this compares against a dummy and returns false: the same work,
 * the same answer.
 */
export async function verifyPasswordOrDummy(
  plaintext: string,
  hash: string | null | undefined,
): Promise<boolean> {
  if (!hash) {
    await bcrypt.compare(plaintext, await getDummyHash());
    return false;
  }
  return bcrypt.compare(plaintext, hash);
}

export function signToken(
  userId: string,
  options: SignTokenOptions = {},
): string {
  const purpose: TokenPurpose = options.purpose ?? "session";
  const expiresIn = options.expiresIn ?? DEFAULT_SESSION_EXPIRY;
  const claims: Record<string, unknown> = {
    userId,
    purpose,
    ...(purpose === "session" ? { auth_time: Math.floor(Date.now() / 1000) } : {}),
    ...(options.extra ?? {}),
  };
  // jsonwebtoken's expiresIn typing is loose; cast at the boundary.
  // WS9A BUG-233 — `jwtid` becomes the `jti` claim. Minted for EVERY purpose,
  // sessions included: it costs one uuid, it keeps one shape for every token
  // this system issues, and it gives the session class a handle if server-side
  // session revocation is ever wanted. Only the redeemable purposes consult
  // the ledger today; a session token is evicted by the epoch, not by spending.
  return jwt.sign(claims, jwtSecret!, {
    // SEC-2 #14 — named, not defaulted, so sign and verify cannot drift.
    algorithm: "HS256",
    expiresIn: expiresIn as jwt.SignOptions["expiresIn"],
    jwtid: randomUUID(),
  });
}

export function verifyToken(
  token: string,
  expectedPurpose?: TokenPurpose,
): JwtPayload | null {
  try {
    // SEC-2 #14 — HS256 and nothing else. jsonwebtoken already refuses
    // `alg: none` and an asymmetric alg against a string secret; pinning the
    // list also refuses HS384/HS512 tokens, which this server never mints.
    const decoded = jwt.verify(token, jwtSecret!, { algorithms: ["HS256"] }) as JwtPayload;
    if (!decoded.userId) return null;
    // Tokens minted before the purpose claim existed default to 'session'
    // on read (backward-compat for any in-flight tokens).
    const purpose: TokenPurpose = (decoded.purpose as TokenPurpose) ?? "session";
    if (expectedPurpose && purpose !== expectedPurpose) return null;
    return { ...decoded, purpose };
  } catch {
    return null;
  }
}

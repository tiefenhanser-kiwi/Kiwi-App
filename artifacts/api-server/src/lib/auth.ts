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
export type TokenPurpose = "session" | "password_reset" | "email_change";

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

export function signToken(
  userId: string,
  options: SignTokenOptions = {},
): string {
  const purpose: TokenPurpose = options.purpose ?? "session";
  const expiresIn = options.expiresIn ?? DEFAULT_SESSION_EXPIRY;
  const claims: Record<string, unknown> = {
    userId,
    purpose,
    ...(options.extra ?? {}),
  };
  // jsonwebtoken's expiresIn typing is loose; cast at the boundary.
  // WS9A BUG-233 — `jwtid` becomes the `jti` claim. Minted for EVERY purpose,
  // sessions included: it costs one uuid, it keeps one shape for every token
  // this system issues, and it gives the session class a handle if server-side
  // session revocation is ever wanted. Only the redeemable purposes consult
  // the ledger today; a session token is evicted by the epoch, not by spending.
  return jwt.sign(claims, jwtSecret!, {
    expiresIn: expiresIn as jwt.SignOptions["expiresIn"],
    jwtid: randomUUID(),
  });
}

export function verifyToken(
  token: string,
  expectedPurpose?: TokenPurpose,
): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, jwtSecret!) as JwtPayload;
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

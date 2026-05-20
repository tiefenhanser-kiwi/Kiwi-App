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
  return jwt.sign(claims, jwtSecret!, {
    expiresIn: expiresIn as jwt.SignOptions["expiresIn"],
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

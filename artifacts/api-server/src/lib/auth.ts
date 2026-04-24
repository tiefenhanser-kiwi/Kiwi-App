import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const BCRYPT_ROUNDS = 10; // TODO(pre-launch): upgrade to 12
const JWT_EXPIRY = "30d";

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  throw new Error("JWT_SECRET environment variable is required.");
}

export interface JwtPayload {
  userId: string;
  iat: number;
  exp: number;
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

export function signToken(userId: string): string {
  return jwt.sign({ userId }, jwtSecret!, { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, jwtSecret!) as JwtPayload;
    if (!decoded.userId) return null;
    return decoded;
  } catch {
    return null;
  }
}

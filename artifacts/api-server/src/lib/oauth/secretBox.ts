// Row 9 (1.1) · OAuth Block 1 Part A — encryption at rest for the ONE secret
// this feature stores: Apple's refresh token.
//
// ── WHY THIS COLUMN IS ENCRYPTED WHEN NO OTHER COLUMN IS ─────────────────
//
// `users.passwordHash` is a bcrypt hash — a one-way digest, useless to a
// reader. An Apple refresh token is the opposite: it is a live bearer
// credential against `appleid.apple.com`, replayable by anyone holding the
// bytes, and it sits in a table a support query, a `pg_dump`, a Neon branch
// copy or a misdirected SELECT can reach. So it is the one value here that
// does not go in the database in the clear.
//
// ── WHAT THIS IS AND IS NOT ──────────────────────────────────────────────
//
// AES-256-GCM from `node:crypto`, no new dependency. The key is DERIVED with
// HKDF-SHA256 from `APPLE_REFRESH_TOKEN_ENC_KEY` rather than used raw, so the
// env var may be any string a human or Secret Manager produced (the raw value
// is almost never exactly 32 bytes, and truncating or zero-padding it is how
// a "256-bit" key quietly becomes far less).
//
// It is NOT envelope encryption and NOT a KMS. The key lives in the same
// environment as the ciphertext, so this defends against the database being
// read — a dump, a branch, a backup, a stray query — and not against the
// running process being compromised. That is the threat this column has, and
// saying which one is defended is the point of this paragraph. If Apple
// refresh tokens ever become the crown jewels, Cloud KMS is the upgrade and
// the `v1.` prefix below is where a `v2.` goes.
//
// 🔴 FORMAT:  v1.<iv>.<authTag>.<ciphertext>   (each part base64url)
// The version prefix is not decoration: a rotation or an algorithm change
// needs to be able to read the old rows while writing new ones, and a blob
// with no version cannot be told apart from one in a different scheme.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12; // GCM's native nonce size; 96 bits, per NIST SP 800-38D.
const KEY_BYTES = 32;

// Fixed, non-secret, and deliberately specific. HKDF's `info` binds the
// derived key to THIS purpose: if the same env secret is ever reused to
// protect something else, that something else derives a different key.
const HKDF_INFO = "kiwi:oauth:apple:refresh_token:v1";
// A fixed salt is correct for HKDF over a high-entropy-ish secret with a
// single purpose: a random per-row salt would have to be stored beside the
// ciphertext, and it buys nothing here because `info` already separates uses.
const HKDF_SALT = "kiwi-oauth-v1";

export class SecretBoxError extends Error {
  constructor(readonly detail: string) {
    super(`secret box: ${detail}`);
    this.name = "SecretBoxError";
  }
}

function deriveKey(secret: string): Buffer {
  if (secret.trim() === "") throw new SecretBoxError("empty secret");
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from(HKDF_SALT, "utf8"), Buffer.from(HKDF_INFO, "utf8"), KEY_BYTES),
  );
}

const b64u = (b: Buffer) => b.toString("base64url");

export function encryptSecret(plaintext: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, b64u(iv), b64u(cipher.getAuthTag()), b64u(ct)].join(".");
}

/**
 * Throws `SecretBoxError` on anything that is not an intact `v1.` blob under
 * this key: a wrong key, a truncated column, a flipped bit, a future version.
 *
 * It throws rather than returning null because every caller's correct answer
 * is the same — skip the revoke, log it, keep going — and a null that a caller
 * forgets to check is a `undefined` passed to Apple as a refresh token.
 */
export function decryptSecret(blob: string, secret: string): string {
  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretBoxError(`unrecognised blob (${parts[0] ?? "empty"})`);
  }
  const [, ivRaw, tagRaw, ctRaw] = parts as [string, string, string, string];
  const key = deriveKey(secret);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctRaw, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (err) {
    // GCM's tag check is what fails here, and it fails IDENTICALLY for a wrong
    // key and for tampered bytes. Neither the message nor the key goes further.
    throw new SecretBoxError(err instanceof Error ? err.message : "undecryptable");
  }
}

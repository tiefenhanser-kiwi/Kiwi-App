// Row 9 (1.1) · OAuth Block 2 Part B — THE NONCE, and the one encoding that
// makes it work.
//
// ── THE CONTRACT, restated from the server ───────────────────────────────
//
// artifacts/api-server/src/lib/oauth/verify.ts's header:
//
//   "The client generates a random `rawNonce`, sends Apple sha256hex(rawNonce),
//    Apple echoes that hash inside the signed token, and the client sends us
//    the RAW value…
//    🔴 HEX, LOWER-CASE, of the UTF-8 bytes… a client that base64s the digest
//    instead will fail this check with a perfectly valid token."
//
// That last sentence is the whole reason this file exists as its own module
// with its own tests. The failure it describes is invisible: the token is
// genuine, Apple signed it, the user did everything right, and the server
// answers 401 with no reason on the wire (§2.8, deliberately). There is no
// log line on the device that would say "your digest was base64". So the
// encoding is asserted here, in a test, against a published vector.
//
// ── WHAT expo-crypto ACTUALLY RETURNS (§2.7 said to check) ───────────────
//
// `digestStringAsync(SHA256, s, { encoding: HEX })` returns LOWER-CASE hex on
// all three platforms. Read, not assumed:
//
//   ios/CryptoModule.swift:52   digest.reduce("") { $0 + String(format: "%02x", $1) }
//   android/…/CryptoModule.kt   ((byte and 0xff) + 0x100).toString(radix = 16).substring(1)
//   build/ExpoCrypto.web.js:52  value.toString(16).padStart(2, "0")
//
// All three are lower-case, and all three hash the UTF-8 bytes of the string.
// So NO conversion is needed today — which is a fact with a shelf life, not a
// guarantee. `sha256hex` below still lower-cases and still refuses anything
// that is not 64 hex characters, because the cost is one call and the failure
// it prevents is a 401 nobody can diagnose from the outside.
//
// ── WHY THE DIGEST IS INJECTED ───────────────────────────────────────────
//
// So the vector can be checked under `node --test` without expo-crypto (and
// therefore without a loader stub). The production binding is three lines in
// ./crypto.ts; everything worth being wrong about is here.

/**
 * A SHA-256 over a string, in the encoding asked for. Shaped exactly like
 * expo-crypto's `digestStringAsync` minus the algorithm argument, so the
 * production binding is a pass-through and this signature is the seam.
 *
 * `encoding` is a parameter rather than a constant on purpose: it is the
 * thing that can be wrong, so it has to be visible at the call site below.
 */
export type Sha256 = (data: string, encoding: "hex" | "base64") => Promise<string>;

/** A source of cryptographically random bytes (expo-crypto's `getRandomBytes`). */
export type RandomBytes = (byteCount: number) => Uint8Array;

/**
 * 32 bytes → 64 hex characters. Well inside the server's `rawNonce` cap of
 * 500 chars, and the same width the digest itself has, which is the only
 * reason to prefer it over 16: a nonce and its hash that look alike are
 * harder to swap by accident in a debugger.
 */
export const NONCE_BYTES = 32;

const HEX_64 = /^[0-9a-f]{64}$/;

function toLowerHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * The value Apple must be handed: `sha256hex(rawNonce)`, lower-case hex of the
 * SHA-256 of the UTF-8 bytes.
 *
 * Throws rather than returning a wrong-shaped digest. A nonce that is not 64
 * hex characters cannot match what the server recomputes, so the sign-in was
 * going to fail either way — failing here produces an error the screen can
 * show instead of a bare 401 from a round trip that was doomed before it left.
 */
export async function sha256hex(data: string, sha256: Sha256): Promise<string> {
  const raw = await sha256(data, "hex");
  const hex = raw.trim().toLowerCase();
  if (!HEX_64.test(hex)) {
    throw new Error(
      `sha256hex: expected 64 lower-case hex characters, got ${JSON.stringify(
        raw.slice(0, 80),
      )}`,
    );
  }
  return hex;
}

/**
 * A fresh raw nonce. Hex so it survives every wire it crosses unescaped —
 * Apple's request, the signed token, our JSON body — with no encoding
 * question of its own.
 */
export function randomNonce(
  randomBytes: RandomBytes,
  byteCount: number = NONCE_BYTES,
): string {
  const bytes = randomBytes(byteCount);
  if (!bytes || bytes.length !== byteCount) {
    // A short read here would silently weaken the nonce, which is the one
    // property it has. Refuse instead.
    throw new Error(
      `randomNonce: asked for ${byteCount} bytes, got ${bytes ? bytes.length : "none"}`,
    );
  }
  return toLowerHex(bytes);
}

/**
 * The pair a native Apple sign-in needs: the value Apple is shown, and the
 * value Kiwi is told. Kept together so a caller cannot hand the same string
 * to both — which would pass Apple, pass the server's SHA compare only by
 * coincidence (it would not), and is precisely the mix-up the two names guard.
 */
export interface NoncePair {
  /** Sent to Apple as `nonce`. */
  hashed: string;
  /** Sent to Kiwi as `rawNonce`. NEVER sent to Apple. */
  raw: string;
}

export async function makeNoncePair(deps: {
  sha256: Sha256;
  randomBytes: RandomBytes;
}): Promise<NoncePair> {
  const raw = randomNonce(deps.randomBytes);
  const hashed = await sha256hex(raw, deps.sha256);
  return { hashed, raw };
}

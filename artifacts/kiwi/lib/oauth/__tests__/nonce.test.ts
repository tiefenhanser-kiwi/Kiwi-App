// Row 9 (1.1) · OAuth Block 2 Part B — the nonce, and the encoding that is the
// difference between a sign-in and an undiagnosable 401.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  NONCE_BYTES,
  makeNoncePair,
  randomNonce,
  sha256hex,
  type RandomBytes,
  type Sha256,
} from "../nonce";

// The production digest's twin: node's own SHA-256, in both encodings
// expo-crypto offers. Using the real algorithm rather than a canned string
// means the test vector below checks sha256hex's contract AND that the
// injection is wired to the right encoding.
const nodeSha256: Sha256 = async (data, encoding) =>
  createHash("sha256").update(data, "utf8").digest(encoding);

const countingBytes = (fill: number): RandomBytes => (n) =>
  new Uint8Array(n).fill(fill);

// ── the vector (§3 Part B) ───────────────────────────────────────────────

test("sha256hex('abc') is the published SHA-256 vector, lower-case hex", async () => {
  assert.equal(
    await sha256hex("abc", nodeSha256),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("the empty string hashes too — no special-casing anywhere", async () => {
  assert.equal(
    await sha256hex("", nodeSha256),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("UTF-8 bytes, not code units — a non-ASCII nonce would silently diverge otherwise", async () => {
  // The server hashes `Buffer.from(rawNonce, "utf8")`. Node and every
  // expo-crypto implementation do the same; this pins the agreement.
  const s = "nønce-æ";
  assert.equal(
    await sha256hex(s, nodeSha256),
    createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex"),
  );
});

// ── the guard (the whole reason this is not one line at the call site) ────

test("🔴 a BASE64 digest is REFUSED, not forwarded", async () => {
  // This is the exact failure the server's verify.ts header warns about: a
  // perfectly valid identity token, 401'd, with no reason on the wire. The
  // guard turns it into an error on the device instead of a mystery.
  const base64Digest: Sha256 = async (data) =>
    createHash("sha256").update(data, "utf8").digest("base64");
  await assert.rejects(
    () => sha256hex("abc", base64Digest),
    /expected 64 lower-case hex characters/,
  );
});

test("an UPPER-CASE hex digest is accepted and normalised down", async () => {
  // No expo-crypto implementation returns upper-case today (all three were
  // read). If one ever does, lower-casing is the whole fix, and this says so.
  const upper: Sha256 = async (data, encoding) =>
    (await nodeSha256(data, encoding)).toUpperCase();
  assert.equal(
    await sha256hex("abc", upper),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("surrounding whitespace is trimmed rather than failing the guard", async () => {
  const padded: Sha256 = async (data, encoding) => `\n${await nodeSha256(data, encoding)} `;
  assert.equal(
    await sha256hex("abc", padded),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("a truncated digest is refused", async () => {
  const short: Sha256 = async (data, encoding) =>
    (await nodeSha256(data, encoding)).slice(0, 32);
  await assert.rejects(() => sha256hex("abc", short), /expected 64/);
});

// ── the raw nonce ────────────────────────────────────────────────────────

test("randomNonce is 64 lower-case hex characters from 32 bytes", () => {
  assert.equal(NONCE_BYTES, 32);
  const nonce = randomNonce(countingBytes(0xab));
  assert.equal(nonce.length, 64);
  assert.match(nonce, /^[0-9a-f]{64}$/);
  assert.equal(nonce, "ab".repeat(32));
});

test("a zero byte is padded, not dropped", () => {
  // `(0).toString(16)` is "0"; without padStart the nonce would be 63
  // characters and the server would compare a different string.
  assert.equal(randomNonce((n) => new Uint8Array(n)), "00".repeat(32));
});

test("every byte value round-trips", () => {
  const nonce = randomNonce((n) => Uint8Array.from({ length: n }, (_, i) => i), 256);
  assert.equal(nonce.length, 512);
  assert.equal(nonce.slice(0, 8), "00010203");
  assert.equal(nonce.slice(-6), "fdfeff");
});

test("a short read is refused rather than weakening the nonce", () => {
  assert.throws(
    () => randomNonce(() => new Uint8Array(4)),
    /asked for 32 bytes, got 4/,
  );
});

// ── the pair ─────────────────────────────────────────────────────────────

test("makeNoncePair: Apple gets the HASH, Kiwi gets the RAW value", async () => {
  const pair = await makeNoncePair({
    sha256: nodeSha256,
    randomBytes: countingBytes(0x01),
  });
  assert.equal(pair.raw, "01".repeat(32));
  assert.equal(pair.hashed, await sha256hex(pair.raw, nodeSha256));
  assert.notEqual(pair.hashed, pair.raw);
});

test("makeNoncePair draws fresh bytes every time", async () => {
  let n = 0;
  const bytes: RandomBytes = (count) => new Uint8Array(count).fill(n++);
  const a = await makeNoncePair({ sha256: nodeSha256, randomBytes: bytes });
  const b = await makeNoncePair({ sha256: nodeSha256, randomBytes: bytes });
  assert.notEqual(a.raw, b.raw);
  assert.notEqual(a.hashed, b.hashed);
});

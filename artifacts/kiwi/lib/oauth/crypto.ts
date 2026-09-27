// Row 9 (1.1) · OAuth Block 2 Part B — the expo-crypto binding, and nothing
// else.
//
// This file is deliberately trivial and deliberately separate. ./nonce.ts
// holds every decision worth testing (the hex contract, the 64-character
// guard, the raw/hashed pair) and takes these two functions as parameters, so
// the tests run under plain `node --test` without a loader stub for
// expo-crypto. What is left here is a pass-through, and a pass-through is the
// only kind of code it is safe to leave unexercised.
//
// `digestStringAsync` over `digest`: the string form is the documented,
// cross-platform path that every Apple/Firebase client walks, and it does its
// own UTF-8 encoding natively. `digest` would take bytes and put a
// `TextEncoder` on the critical path of a sign-in — one more thing to be
// missing on a runtime, for no gain, since the hex encoding is checked in
// ./nonce.ts either way.

import * as Crypto from "expo-crypto";

import type { RandomBytes, Sha256 } from "./nonce";

export const expoSha256: Sha256 = (data, encoding) =>
  Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, data, {
    encoding:
      encoding === "base64" ? Crypto.CryptoEncoding.BASE64 : Crypto.CryptoEncoding.HEX,
  });

export const expoRandomBytes: RandomBytes = (byteCount) =>
  Crypto.getRandomBytes(byteCount);

// Row 5 · Block 1c (D-WS9-248 step 4) — the OIDC verifier the drain route
// gates on. Real RS256 keys generated here; Google's JWKS is a stub fetch
// that serves the matching public key. Every refusal reason is exercised
// with a token that differs from a valid one by exactly one claim, so a
// green here means the check is discriminating, not merely present.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import jwt from "jsonwebtoken";

import { GoogleJwksCache, parseEmailAllowlist, verifyGoogleIdToken, type JwksFetch } from "../googleOidc";

const AUD = "https://kiwi-api.test/api/internal/images/drain";
const SA = "kiwi-image-drain@kiwi-prod.iam.gserviceaccount.com";

function keyPair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  return { kid, privateKey, jwk: { kty: "RSA", alg: "RS256", use: "sig", kid, n: jwk.n, e: jwk.e } };
}

function sign(privateKey: KeyObject, kid: string, claims: Record<string, unknown>, opts: jwt.SignOptions = {}) {
  return jwt.sign(
    { iss: "https://accounts.google.com", aud: AUD, email: SA, email_verified: true, ...claims },
    privateKey,
    { algorithm: "RS256", keyid: kid, expiresIn: "5m", ...opts },
  );
}

function jwks(keys: Array<{ jwk: unknown }>, opts: { fail?: boolean; maxAge?: number } = {}) {
  let fetches = 0;
  const fetch: JwksFetch = async () => {
    fetches++;
    return {
      ok: !opts.fail,
      status: opts.fail ? 503 : 200,
      headers: { get: (n: string) => (n.toLowerCase() === "cache-control" && opts.maxAge != null ? `public, max-age=${opts.maxAge}` : null) },
      json: async () => ({ keys: keys.map((k) => k.jwk) }),
    };
  };
  return { fetch, fetches: () => fetches };
}

const expect = { audience: AUD, emails: [SA] };

describe("verifyGoogleIdToken", () => {
  it("accepts a token signed by a published key with the right iss/aud/email", async () => {
    const k = keyPair("k1");
    const j = jwks([k]);
    const v = await verifyGoogleIdToken(sign(k.privateKey, "k1", {}), expect, new GoogleJwksCache({ fetch: j.fetch }));
    assert.deepEqual(v, { ok: true, email: SA });
    assert.equal(j.fetches(), 1);
  });

  it("refuses: no token · malformed · wrong signature key · wrong audience · wrong issuer · expired · other email · unverified email", async () => {
    const k = keyPair("k1");
    const other = keyPair("k1"); // same kid, different key — the signature must fail, not the lookup
    const cache = new GoogleJwksCache({ fetch: jwks([k]).fetch });
    const reason = async (token: string | undefined) => {
      const v = await verifyGoogleIdToken(token, expect, cache);
      return v.ok ? "ok" : v.reason;
    };
    assert.equal(await reason(undefined), "no_token");
    assert.equal(await reason("not.a.jwt"), "malformed");
    assert.equal(await reason(sign(other.privateKey, "k1", {})), "bad_signature_or_claims");
    assert.equal(await reason(sign(k.privateKey, "k1", { aud: "https://elsewhere.test/" })), "bad_signature_or_claims");
    assert.equal(await reason(sign(k.privateKey, "k1", { iss: "https://evil.test" })), "bad_signature_or_claims");
    assert.equal(await reason(sign(k.privateKey, "k1", {}, { expiresIn: "-1m" })), "bad_signature_or_claims");
    assert.equal(await reason(sign(k.privateKey, "k1", { email: "someone-else@kiwi-prod.iam.gserviceaccount.com" })), "email_not_allowed");
    assert.equal(await reason(sign(k.privateKey, "k1", { email_verified: false })), "email_not_verified");
    // Non-vacuity: the same cache still accepts the good token.
    assert.equal(await reason(sign(k.privateKey, "k1", {})), "ok");
  });

  it("an HS256 token (alg confusion) is malformed, never verified against the RSA key", async () => {
    const k = keyPair("k1");
    const cache = new GoogleJwksCache({ fetch: jwks([k]).fetch });
    const hs = jwt.sign({ iss: "https://accounts.google.com", aud: AUD, email: SA, email_verified: true }, "secret", { algorithm: "HS256", keyid: "k1", expiresIn: "5m" });
    const v = await verifyGoogleIdToken(hs, expect, cache);
    assert.equal(v.ok ? "ok" : v.reason, "malformed");
  });

  it("the JWKS is cached for max-age and refetched once for an unknown kid (key rotation)", async () => {
    let now = 1_000_000;
    const k1 = keyPair("k1");
    const k2 = keyPair("k2");
    const served: Array<{ jwk: unknown }> = [k1];
    let fetches = 0;
    const fetch: JwksFetch = async () => {
      fetches++;
      return { ok: true, status: 200, headers: { get: (n: string) => (n.toLowerCase() === "cache-control" ? "max-age=3600" : null) }, json: async () => ({ keys: served.map((s) => s.jwk) }) };
    };
    const cache = new GoogleJwksCache({ fetch, now: () => now });
    assert.equal((await verifyGoogleIdToken(sign(k1.privateKey, "k1", {}), expect, cache)).ok, true);
    assert.equal((await verifyGoogleIdToken(sign(k1.privateKey, "k1", {}), expect, cache)).ok, true);
    assert.equal(fetches, 1, "second verify served from the cache");
    // A rotated key: unknown kid → one refetch; not yet served → unknown_kid.
    const v2 = await verifyGoogleIdToken(sign(k2.privateKey, "k2", {}), expect, cache);
    assert.equal(v2.ok ? "ok" : v2.reason, "unknown_kid");
    assert.equal(fetches, 2);
    served.push(k2);
    assert.equal((await verifyGoogleIdToken(sign(k2.privateKey, "k2", {}), expect, cache)).ok, true);
    assert.equal(fetches, 3);
    // Past max-age the next lookup refetches even for a known kid.
    now += 3_600_001;
    assert.equal((await verifyGoogleIdToken(sign(k1.privateKey, "k1", {}), expect, cache)).ok, true);
    assert.equal(fetches, 4);
  });

  it("the JWKS endpoint being down is jwks_unavailable (fail closed, distinguishable from a bad token)", async () => {
    const k = keyPair("k1");
    const cache = new GoogleJwksCache({ fetch: jwks([k], { fail: true }).fetch });
    const v = await verifyGoogleIdToken(sign(k.privateKey, "k1", {}), expect, cache);
    assert.equal(v.ok ? "ok" : v.reason, "jwks_unavailable");
  });

  it("an empty allowlist admits nobody (fail closed)", async () => {
    const k = keyPair("k1");
    const cache = new GoogleJwksCache({ fetch: jwks([k]).fetch });
    const v = await verifyGoogleIdToken(sign(k.privateKey, "k1", {}), { audience: AUD, emails: [] }, cache);
    assert.equal(v.ok ? "ok" : v.reason, "email_not_allowed");
  });
});

describe("parseEmailAllowlist", () => {
  it("splits, trims, lower-cases, drops blanks; unset → []", () => {
    assert.deepEqual(parseEmailAllowlist(" A@X.test , b@y.test,, "), ["a@x.test", "b@y.test"]);
    assert.deepEqual(parseEmailAllowlist(undefined), []);
    assert.deepEqual(parseEmailAllowlist(""), []);
  });
});

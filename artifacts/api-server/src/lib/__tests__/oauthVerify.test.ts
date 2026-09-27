// Row 9 (1.1) · OAuth Block 1 Part C — the identity-token verifier.
//
// Real RS256 keys are generated HERE and the providers' JWKS documents are
// stub fetches serving the matching public key. NOTHING IN THIS FILE REACHES
// appleid.apple.com OR googleapis.com, and it cannot: `JwksCache` has no
// default fetch, so a stub is the only way to construct one.
//
// Every refusal is exercised with a token that differs from a VALID one by
// exactly one claim. That is the difference between a test proving the check
// is present and a test proving it discriminates — and it is what the
// deliberate breaks in §3 are checked against.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import jwt from "jsonwebtoken";

import { JwksCache, type JwksFetch } from "../oauth/jwks";
import {
  APPLE_ISSUER,
  hashNonce,
  isPrivateRelayEmail,
  verifyAppleIdentityToken,
  verifyGoogleIdentityToken,
} from "../oauth/verify";

const BUNDLE_ID = "com.kitchenwizard.kiwi";
const SERVICES_ID = "com.kitchenwizard.kiwi.web";
const GOOGLE_IOS = "111-ios.apps.googleusercontent.com";
const GOOGLE_WEB = "222-web.apps.googleusercontent.com";
const RAW_NONCE = "a-random-raw-nonce-from-the-client";
const HASHED = createHash("sha256").update(RAW_NONCE, "utf8").digest("hex");

function keyPair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  return { kid, privateKey, jwk: { kty: "RSA", alg: "RS256", use: "sig", kid, n: jwk.n, e: jwk.e } };
}

function jwks(keys: Array<{ jwk: unknown }>, opts: { fail?: boolean } = {}) {
  let fetches = 0;
  const fetch: JwksFetch = async () => {
    fetches++;
    return {
      ok: !opts.fail,
      status: opts.fail ? 503 : 200,
      headers: { get: () => null },
      json: async () => ({ keys: keys.map((k) => k.jwk) }),
    };
  };
  return { fetch, fetches: () => fetches };
}

function cacheFor(keys: Array<{ jwk: unknown }>, opts: { fail?: boolean } = {}) {
  return new JwksCache({ fetch: jwks(keys, opts).fetch, jwksUrl: "https://stub.invalid/keys" });
}

function signApple(
  privateKey: KeyObject,
  kid: string,
  claims: Record<string, unknown> = {},
  signOpts: jwt.SignOptions = {},
) {
  return jwt.sign(
    {
      iss: APPLE_ISSUER,
      aud: BUNDLE_ID,
      sub: "000123.applesub.4567",
      email: "person@example.com",
      email_verified: "true", // Apple's string form, on purpose
      nonce: HASHED,
      ...claims,
    },
    privateKey,
    { algorithm: "RS256", keyid: kid, expiresIn: "5m", ...signOpts },
  );
}

function signGoogle(
  privateKey: KeyObject,
  kid: string,
  claims: Record<string, unknown> = {},
  signOpts: jwt.SignOptions = {},
) {
  return jwt.sign(
    {
      iss: "https://accounts.google.com",
      aud: GOOGLE_IOS,
      sub: "108888888888888888888",
      email: "person@example.com",
      email_verified: true,
      given_name: "Gee",
      family_name: "Mail",
      ...claims,
    },
    privateKey,
    { algorithm: "RS256", keyid: kid, expiresIn: "5m", ...signOpts },
  );
}

const APPLE_AUDS = [BUNDLE_ID, SERVICES_ID];
const GOOGLE_IDS = [GOOGLE_WEB, GOOGLE_IOS];

// ── helpers ──────────────────────────────────────────────────────────────

describe("hashNonce / isPrivateRelayEmail", () => {
  it("hashNonce is lower-case hex sha256 of the UTF-8 bytes — the client's contract", () => {
    assert.equal(hashNonce(RAW_NONCE), HASHED);
    assert.match(hashNonce("x"), /^[0-9a-f]{64}$/);
  });

  it("a relay address is recognised by domain, case-insensitively", () => {
    assert.equal(isPrivateRelayEmail("abc@privaterelay.appleid.com"), true);
    assert.equal(isPrivateRelayEmail("ABC@PrivateRelay.AppleID.com"), true);
    assert.equal(isPrivateRelayEmail("abc@example.com"), false);
    // Not a suffix match on the whole string — the @ matters.
    assert.equal(isPrivateRelayEmail("evilprivaterelay.appleid.com"), false);
    assert.equal(isPrivateRelayEmail(null), false);
  });
});

// ── Apple ────────────────────────────────────────────────────────────────

describe("verifyAppleIdentityToken", () => {
  it("accepts a well-formed token and reports what it actually carried", async () => {
    const k = keyPair("ap1");
    const v = await verifyAppleIdentityToken({
      identityToken: signApple(k.privateKey, "ap1"),
      rawNonce: RAW_NONCE,
      audiences: APPLE_AUDS,
      cache: cacheFor([k]),
    });
    assert.ok(v.ok);
    assert.equal(v.identity.provider, "apple");
    assert.equal(v.identity.subject, "000123.applesub.4567");
    assert.equal(v.identity.email, "person@example.com");
    assert.equal(v.identity.emailVerified, true, 'the STRING "true" is true');
    assert.equal(v.identity.isPrivateRelay, false);
    assert.equal(v.identity.audience, BUNDLE_ID, "the aud is recorded for the revoke call");
    // Apple never puts a name in the token; the route takes it from the body.
    assert.equal(v.identity.firstName, null);
    assert.equal(v.identity.lastName, null);
  });

  it("the SECOND configured audience (the web Services ID) is accepted too", async () => {
    const k = keyPair("ap1");
    const v = await verifyAppleIdentityToken({
      identityToken: signApple(k.privateKey, "ap1", { aud: SERVICES_ID }),
      rawNonce: RAW_NONCE,
      audiences: APPLE_AUDS,
      cache: cacheFor([k]),
    });
    assert.ok(v.ok);
    assert.equal(v.identity.audience, SERVICES_ID);
  });

  it("🔴 WRONG AUDIENCE is refused — a token minted for another app is not ours", async () => {
    const k = keyPair("ap1");
    const v = await verifyAppleIdentityToken({
      identityToken: signApple(k.privateKey, "ap1", { aud: "com.someone.else" }),
      rawNonce: RAW_NONCE,
      audiences: APPLE_AUDS,
      cache: cacheFor([k]),
    });
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.reason, "bad_signature_or_claims");
  });

  it("🔴 NONCE: missing on the body, missing in the token, or mismatched — all refused", async () => {
    const k = keyPair("ap1");
    const base = { audiences: APPLE_AUDS, cache: cacheFor([k]) };

    const noRaw = await verifyAppleIdentityToken({
      ...base,
      identityToken: signApple(k.privateKey, "ap1"),
      rawNonce: undefined,
    });
    assert.equal(noRaw.ok === false && noRaw.reason, "nonce_missing");

    const blankRaw = await verifyAppleIdentityToken({
      ...base,
      identityToken: signApple(k.privateKey, "ap1"),
      rawNonce: "   ",
    });
    assert.equal(blankRaw.ok === false && blankRaw.reason, "nonce_missing");

    // A token with NO nonce claim is refused, not waved through. This is the
    // downgrade an attacker would choose if "no nonce" meant "no check".
    const noClaim = await verifyAppleIdentityToken({
      ...base,
      identityToken: signApple(k.privateKey, "ap1", { nonce: undefined }),
      rawNonce: RAW_NONCE,
    });
    assert.equal(noClaim.ok === false && noClaim.reason, "nonce_missing");

    // The replay: a perfectly valid, correctly signed, in-date token from a
    // DIFFERENT sign-in attempt. Everything passes except this.
    const other = await verifyAppleIdentityToken({
      ...base,
      identityToken: signApple(k.privateKey, "ap1", { nonce: hashNonce("someone-elses-nonce") }),
      rawNonce: RAW_NONCE,
    });
    assert.equal(other.ok === false && other.reason, "nonce_mismatch");

    // The classic client bug: sending the RAW nonce where the hash belongs.
    const unhashed = await verifyAppleIdentityToken({
      ...base,
      identityToken: signApple(k.privateKey, "ap1", { nonce: RAW_NONCE }),
      rawNonce: RAW_NONCE,
    });
    assert.equal(unhashed.ok === false && unhashed.reason, "nonce_mismatch");
  });

  it("an upper-case hex nonce claim still matches — hex casing is not the check", async () => {
    const k = keyPair("ap1");
    const v = await verifyAppleIdentityToken({
      identityToken: signApple(k.privateKey, "ap1", { nonce: HASHED.toUpperCase() }),
      rawNonce: RAW_NONCE,
      audiences: APPLE_AUDS,
      cache: cacheFor([k]),
    });
    assert.ok(v.ok);
  });

  it("Hide My Email is flagged — by the claim, by the address, or by both", async () => {
    const k = keyPair("ap1");
    const relay = "001122.abc@privaterelay.appleid.com";

    const byBoth = await verifyAppleIdentityToken({
      identityToken: signApple(k.privateKey, "ap1", { email: relay, is_private_email: "true" }),
      rawNonce: RAW_NONCE,
      audiences: APPLE_AUDS,
      cache: cacheFor([k]),
    });
    assert.ok(byBoth.ok);
    assert.equal(byBoth.identity.isPrivateRelay, true);
    assert.equal(byBoth.identity.email, relay, "the relay address IS the user's email");

    // The claim absent but the address unmistakable — still flagged.
    const byAddress = await verifyAppleIdentityToken({
      identityToken: signApple(k.privateKey, "ap1", { email: relay }),
      rawNonce: RAW_NONCE,
      audiences: APPLE_AUDS,
      cache: cacheFor([k]),
    });
    assert.ok(byAddress.ok);
    assert.equal(byAddress.identity.isPrivateRelay, true);

    // The claim present on a normal address (Apple does this for some flows).
    const byClaim = await verifyAppleIdentityToken({
      identityToken: signApple(k.privateKey, "ap1", { is_private_email: true }),
      rawNonce: RAW_NONCE,
      audiences: APPLE_AUDS,
      cache: cacheFor([k]),
    });
    assert.ok(byClaim.ok);
    assert.equal(byClaim.identity.isPrivateRelay, true);
  });

  it("🔴 the STRING \"false\" is NOT verified — a bare !! would link an unverified email", async () => {
    const k = keyPair("ap1");
    const v = await verifyAppleIdentityToken({
      identityToken: signApple(k.privateKey, "ap1", { email_verified: "false" }),
      rawNonce: RAW_NONCE,
      audiences: APPLE_AUDS,
      cache: cacheFor([k]),
    });
    assert.ok(v.ok);
    assert.equal(v.identity.emailVerified, false);
  });

  it("no email claim at all → email null, not an empty string", async () => {
    const k = keyPair("ap1");
    const v = await verifyAppleIdentityToken({
      identityToken: signApple(k.privateKey, "ap1", { email: undefined }),
      rawNonce: RAW_NONCE,
      audiences: APPLE_AUDS,
      cache: cacheFor([k]),
    });
    assert.ok(v.ok);
    assert.equal(v.identity.email, null);
  });

  it("an empty audience list is `not_configured` — never a skipped check", async () => {
    const k = keyPair("ap1");
    const v = await verifyAppleIdentityToken({
      identityToken: signApple(k.privateKey, "ap1"),
      rawNonce: RAW_NONCE,
      audiences: [],
      cache: cacheFor([k]),
    });
    assert.equal(v.ok === false && v.reason, "not_configured");
  });
});

// ── Google ───────────────────────────────────────────────────────────────

describe("verifyGoogleIdentityToken", () => {
  it("accepts a well-formed token and reads the name claims", async () => {
    const k = keyPair("g1");
    const v = await verifyGoogleIdentityToken({
      idToken: signGoogle(k.privateKey, "g1"),
      clientIds: GOOGLE_IDS,
      cache: cacheFor([k]),
    });
    assert.ok(v.ok);
    assert.equal(v.identity.provider, "google");
    assert.equal(v.identity.subject, "108888888888888888888");
    assert.equal(v.identity.emailVerified, true);
    assert.equal(v.identity.firstName, "Gee");
    assert.equal(v.identity.lastName, "Mail");
    assert.equal(v.identity.isPrivateRelay, false, "private relay is an Apple concept");
    assert.equal(v.identity.audience, GOOGLE_IOS);
  });

  it("the bare `accounts.google.com` issuer is accepted — Google issues both", async () => {
    const k = keyPair("g1");
    const v = await verifyGoogleIdentityToken({
      idToken: signGoogle(k.privateKey, "g1", { iss: "accounts.google.com" }),
      clientIds: GOOGLE_IDS,
      cache: cacheFor([k]),
    });
    assert.ok(v.ok);
  });

  it("🔴 a foreign issuer is refused even with a valid signature and audience", async () => {
    const k = keyPair("g1");
    const v = await verifyGoogleIdentityToken({
      idToken: signGoogle(k.privateKey, "g1", { iss: "https://accounts.google.com.evil.test" }),
      clientIds: GOOGLE_IDS,
      cache: cacheFor([k]),
    });
    assert.equal(v.ok === false && v.reason, "bad_signature_or_claims");
  });

  it("email_verified false (boolean or string) comes back false, token still valid", async () => {
    const k = keyPair("g1");
    for (const claim of [false, "false"]) {
      const v = await verifyGoogleIdentityToken({
        idToken: signGoogle(k.privateKey, "g1", { email_verified: claim }),
        clientIds: GOOGLE_IDS,
        cache: cacheFor([k]),
      });
      assert.ok(v.ok);
      assert.equal(v.identity.emailVerified, false);
    }
  });

  it("no nonce is required — requiring one would refuse correct clients", async () => {
    const k = keyPair("g1");
    const v = await verifyGoogleIdentityToken({
      idToken: signGoogle(k.privateKey, "g1"),
      clientIds: GOOGLE_IDS,
      cache: cacheFor([k]),
    });
    assert.ok(v.ok);
  });
});

// ── the refusals both providers share ────────────────────────────────────

describe("shared refusals", () => {
  it("no token · not a JWT · expired · wrong signing key · unknown kid · JWKS down", async () => {
    const k = keyPair("k1");
    const impostor = keyPair("k1"); // SAME kid, different key: the signature must fail, not the lookup

    const none = await verifyGoogleIdentityToken({ idToken: undefined, clientIds: GOOGLE_IDS, cache: cacheFor([k]) });
    assert.equal(none.ok === false && none.reason, "no_token");

    const junk = await verifyGoogleIdentityToken({ idToken: "not.a.jwt", clientIds: GOOGLE_IDS, cache: cacheFor([k]) });
    assert.equal(junk.ok === false && junk.reason, "malformed");

    const expired = await verifyGoogleIdentityToken({
      idToken: signGoogle(k.privateKey, "k1", {}, { expiresIn: "-1s" }),
      clientIds: GOOGLE_IDS,
      cache: cacheFor([k]),
    });
    assert.equal(expired.ok === false && expired.reason, "bad_signature_or_claims");

    const forged = await verifyGoogleIdentityToken({
      idToken: signGoogle(impostor.privateKey, "k1"),
      clientIds: GOOGLE_IDS,
      cache: cacheFor([k]),
    });
    assert.equal(forged.ok === false && forged.reason, "bad_signature_or_claims");

    const unknownKid = await verifyGoogleIdentityToken({
      idToken: signGoogle(k.privateKey, "k9"),
      clientIds: GOOGLE_IDS,
      cache: cacheFor([k]),
    });
    assert.equal(unknownKid.ok === false && unknownKid.reason, "unknown_kid");

    const down = await verifyGoogleIdentityToken({
      idToken: signGoogle(k.privateKey, "k1"),
      clientIds: GOOGLE_IDS,
      cache: cacheFor([k], { fail: true }),
    });
    assert.equal(down.ok === false && down.reason, "jwks_unavailable");
  });

  it("🔴 alg=none and the HS256-with-the-public-key forgery are both refused", async () => {
    const k = keyPair("k1");

    // alg: none — an unsigned token asserting anything it likes.
    const header = Buffer.from(JSON.stringify({ alg: "none", kid: "k1", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({ iss: "https://accounts.google.com", aud: GOOGLE_IOS, sub: "attacker", exp: Math.floor(Date.now() / 1000) + 600 }),
    ).toString("base64url");
    const unsigned = `${header}.${body}.`;
    const v1 = await verifyGoogleIdentityToken({ idToken: unsigned, clientIds: GOOGLE_IDS, cache: cacheFor([k]) });
    assert.equal(v1.ok === false && v1.reason, "malformed");

    // The textbook one: HMAC the token with the provider's PUBLIC key, which
    // the provider publishes to everyone, and hope the verifier trusts `alg`.
    const pub = (k.privateKey as unknown as KeyObject);
    const hs = jwt.sign(
      { iss: "https://accounts.google.com", aud: GOOGLE_IOS, sub: "attacker" },
      Buffer.from(JSON.stringify(k.jwk)),
      { algorithm: "HS256", keyid: "k1", expiresIn: "5m" },
    );
    void pub;
    const v2 = await verifyGoogleIdentityToken({ idToken: hs, clientIds: GOOGLE_IDS, cache: cacheFor([k]) });
    assert.equal(v2.ok === false && v2.reason, "malformed");
  });

  it("a token with no `sub` is refused — there is no identity to sign in", async () => {
    const k = keyPair("k1");
    const v = await verifyGoogleIdentityToken({
      idToken: signGoogle(k.privateKey, "k1", { sub: undefined }),
      clientIds: GOOGLE_IDS,
      cache: cacheFor([k]),
    });
    assert.equal(v.ok === false && v.reason, "no_subject");
  });

  it("the key set is cached: a second verification does not refetch", async () => {
    const k = keyPair("k1");
    const j = jwks([k]);
    const cache = new JwksCache({ fetch: j.fetch, jwksUrl: "https://stub.invalid/keys" });
    await verifyGoogleIdentityToken({ idToken: signGoogle(k.privateKey, "k1"), clientIds: GOOGLE_IDS, cache });
    await verifyGoogleIdentityToken({ idToken: signGoogle(k.privateKey, "k1"), clientIds: GOOGLE_IDS, cache });
    assert.equal(j.fetches(), 1);
  });
});

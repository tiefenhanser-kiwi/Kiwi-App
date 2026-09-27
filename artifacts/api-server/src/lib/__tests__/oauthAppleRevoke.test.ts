// Row 9 (1.1) · OAuth Block 1 Part E — Apple's token endpoints and the
// revocation DELETE /me owes them.
//
// App Store Review guideline 5.1.1(v) is the reason this code exists: an app
// offering Sign in with Apple MUST revoke the Apple token on account deletion.
// The two things being defended are in tension, and both are tested:
//
//   THE CALL IS MADE — once per Apple identity, with the client_id that
//   identity was linked under, signed with a real ES256 client secret.
//
//   THE CALL CANNOT BLOCK THE DELETION — an unconfigured deploy, a token that
//   will not decrypt, an Apple refusal and an outright throw all leave the
//   deletion to proceed. A person asking to be deleted gets deleted.
//
// A REAL EC key pair is generated here and the client secret is VERIFIED with
// the matching public key, so "it signs something" is not mistaken for "it
// signs what Apple will accept". `fetch` is injected with no default —
// nothing in this file can reach appleid.apple.com.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import type { PrismaClient } from "@prisma/client";

import {
  APPLE_AUD,
  APPLE_REVOKE_URL,
  APPLE_TOKEN_URL,
  buildAppleClientSecret,
  exchangeAppleAuthorizationCode,
  revokeAppleToken,
  type AppleFetch,
} from "../oauth/appleTokens";
import type { AppleSigningConfig, OAuthConfig } from "../oauth/config";
import { encryptSecret } from "../oauth/secretBox";
import { revokeAppleIdentitiesForUser } from "../oauth/revokeOnDelete";

const { privateKey: ecPrivate, publicKey: ecPublic } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});
const PEM = ecPrivate.export({ format: "pem", type: "pkcs8" }).toString();

const SIGNING: AppleSigningConfig = {
  teamId: "ABCDE12345",
  keyId: "KEY1234567",
  privateKey: PEM,
};
const ENC_KEY = "an-encryption-secret";
const CLIENT_ID = "com.kitchenwizard.kiwi";

function config(over: Partial<OAuthConfig> = {}): OAuthConfig {
  return {
    appleAudiences: [CLIENT_ID],
    googleClientIds: [],
    appleSigning: SIGNING,
    appleRefreshEncSecret: ENC_KEY,
    // Row 9 (1.1) · Stripe S1 Part F — null is the NATIVE lane, i.e. every case
    // in this file except the two that override it. Both env vars unset.
    appleWebRedirect: null,
    ...over,
  };
}

interface Call {
  url: string;
  params: Record<string, string>;
}

function recordingFetch(
  responses: Array<{ ok: boolean; status?: number; body?: string }> | { ok: boolean; status?: number; body?: string },
) {
  const calls: Call[] = [];
  const queue = Array.isArray(responses) ? [...responses] : null;
  const fetchImpl: AppleFetch = async (url, init) => {
    calls.push({ url, params: Object.fromEntries(init.body.entries()) });
    const r = queue ? (queue.shift() ?? { ok: true, body: "{}" }) : (responses as { ok: boolean; status?: number; body?: string });
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      text: async () => r.body ?? "",
    };
  };
  return { fetchImpl, calls };
}

// ── the client secret ────────────────────────────────────────────────────

describe("buildAppleClientSecret", () => {
  it("is an ES256 JWT that VERIFIES against the key, with the claims Apple wants", () => {
    const now = 1_700_000_000;
    const secret = buildAppleClientSecret(SIGNING, CLIENT_ID, now);

    // Verified with the real public key — not merely decoded. A secret that
    // parses but does not verify is exactly what Apple would reject.
    const payload = jwt.verify(secret, ecPublic, {
      algorithms: ["ES256"],
      audience: APPLE_AUD,
      issuer: SIGNING.teamId,
      // The `iat` above is a fixed instant so the exp arithmetic is exact;
      // verifying at that instant is what makes this an ES256 check and not an
      // accidental clock test.
      clockTimestamp: now + 1,
    }) as jwt.JwtPayload;

    assert.equal(payload.sub, CLIENT_ID, "sub is the CLIENT_ID, not the user");
    assert.equal(payload.iss, SIGNING.teamId);
    assert.equal(payload.aud, APPLE_AUD);
    assert.equal(payload.iat, now);
    assert.equal(payload.exp, now + 600, "ten minutes, not Apple's six-month maximum");

    const header = JSON.parse(Buffer.from(secret.split(".")[0]!, "base64url").toString()) as Record<string, string>;
    assert.equal(header.alg, "ES256");
    assert.equal(header.kid, SIGNING.keyId, "Apple looks the key up by kid");
  });

  it("a different client id produces a different secret — the list is not one value", () => {
    const a = buildAppleClientSecret(SIGNING, "com.kitchenwizard.kiwi", 1);
    const b = buildAppleClientSecret(SIGNING, "com.kitchenwizard.kiwi.web", 1);
    assert.notEqual(a, b);
  });
});

// ── the code exchange ────────────────────────────────────────────────────

describe("exchangeAppleAuthorizationCode", () => {
  it("POSTs the grant to Apple's token URL and returns the refresh token", async () => {
    const { fetchImpl, calls } = recordingFetch({
      ok: true,
      body: JSON.stringify({ access_token: "a", refresh_token: "r.THE-REFRESH-TOKEN", token_type: "Bearer" }),
    });
    const out = await exchangeAppleAuthorizationCode({
      signing: SIGNING,
      clientId: CLIENT_ID,
      authorizationCode: "c-123",
      fetchImpl,
    });
    assert.equal(out.refreshToken, "r.THE-REFRESH-TOKEN");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, APPLE_TOKEN_URL);
    assert.equal(calls[0].params.grant_type, "authorization_code");
    assert.equal(calls[0].params.code, "c-123");
    assert.equal(calls[0].params.client_id, CLIENT_ID);
    assert.ok(calls[0].params.client_secret.startsWith("ey"), "a JWT, not a literal");
  });

  it("every failure is a null token, never a throw — a sign-in must not hinge on it", async () => {
    const cases: Array<[string, AppleFetch]> = [
      ["Apple 400", recordingFetch({ ok: false, status: 400, body: '{"error":"invalid_grant"}' }).fetchImpl],
      ["Apple 500", recordingFetch({ ok: false, status: 500, body: "" }).fetchImpl],
      ["not JSON", recordingFetch({ ok: true, body: "<html>nope</html>" }).fetchImpl],
      ["no refresh_token", recordingFetch({ ok: true, body: '{"access_token":"a"}' }).fetchImpl],
      ["transport throws", (async () => { throw new Error("ECONNRESET"); }) as unknown as AppleFetch],
    ];
    for (const [name, fetchImpl] of cases) {
      const out = await exchangeAppleAuthorizationCode({
        signing: SIGNING,
        clientId: CLIENT_ID,
        authorizationCode: "c",
        fetchImpl,
      });
      assert.equal(out.refreshToken, null, name);
    }
  });

  it("a timeout aborts and returns null rather than hanging the sign-in", async () => {
    const fetchImpl: AppleFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    const out = await exchangeAppleAuthorizationCode({
      signing: SIGNING,
      clientId: CLIENT_ID,
      authorizationCode: "c",
      fetchImpl,
      timeoutMs: 20,
    });
    assert.equal(out.refreshToken, null);
  });
});

// ── the revoke call ──────────────────────────────────────────────────────

describe("revokeAppleToken", () => {
  it("POSTs to the revoke URL with token_type_hint — Apple 400s without it", async () => {
    const { fetchImpl, calls } = recordingFetch({ ok: true, body: "" });
    const out = await revokeAppleToken({
      signing: SIGNING,
      clientId: CLIENT_ID,
      refreshToken: "r.tok",
      fetchImpl,
    });
    assert.deepEqual(out, { ok: true });
    assert.equal(calls[0].url, APPLE_REVOKE_URL);
    assert.equal(calls[0].params.token, "r.tok");
    assert.equal(calls[0].params.token_type_hint, "refresh_token");
  });

  it("a refusal is reported, with Apple's own reason — it carries no secret of ours", async () => {
    const { fetchImpl } = recordingFetch({ ok: false, status: 400, body: '{"error":"invalid_client"}' });
    const out = await revokeAppleToken({ signing: SIGNING, clientId: CLIENT_ID, refreshToken: "r", fetchImpl });
    assert.equal(out.ok, false);
    assert.match(out.ok === false ? out.detail : "", /invalid_client/);
  });
});

// ── DELETE /me's half ────────────────────────────────────────────────────

function makePrisma(identities: Array<Record<string, unknown>>) {
  return {
    userIdentity: {
      findMany: async ({ where }: { where: { userId: string; provider: string } }) =>
        identities.filter((i) => i.userId === where.userId && i.provider === where.provider),
    },
  } as unknown as PrismaClient;
}

const USER = "u-1";

describe("revokeAppleIdentitiesForUser", () => {
  it("🔴 calls Apple ONCE PER Apple identity, with each one's own client_id", async () => {
    const prisma = makePrisma([
      { id: "i-1", userId: USER, provider: "apple", appleRefreshTokenEnc: encryptSecret("tok-native", ENC_KEY), appleClientId: "com.kitchenwizard.kiwi" },
      { id: "i-2", userId: USER, provider: "apple", appleRefreshTokenEnc: encryptSecret("tok-web", ENC_KEY), appleClientId: "com.kitchenwizard.kiwi.web" },
      // A Google identity on the same account — never sent to Apple.
      { id: "i-3", userId: USER, provider: "google", appleRefreshTokenEnc: null, appleClientId: null },
    ]);
    const seen: Array<{ clientId: string; refreshToken: string }> = [];
    const out = await revokeAppleIdentitiesForUser({
      prisma,
      userId: USER,
      config: config(),
      revokeAppleToken: async (o) => {
        seen.push({ clientId: o.clientId, refreshToken: o.refreshToken });
        return { ok: true };
      },
    });
    assert.deepEqual(out, { found: 2, revoked: 2, skipped: [] });
    assert.deepEqual(seen, [
      { clientId: "com.kitchenwizard.kiwi", refreshToken: "tok-native" },
      { clientId: "com.kitchenwizard.kiwi.web", refreshToken: "tok-web" },
    ]);
  });

  it("no Apple identities → no call at all", async () => {
    let calls = 0;
    const out = await revokeAppleIdentitiesForUser({
      prisma: makePrisma([{ id: "i-1", userId: USER, provider: "google" }]),
      userId: USER,
      config: config(),
      revokeAppleToken: async () => { calls++; return { ok: true }; },
    });
    assert.deepEqual(out, { found: 0, revoked: 0, skipped: [] });
    assert.equal(calls, 0);
  });

  it("🔴 an Apple refusal does NOT throw — the deletion must proceed", async () => {
    const out = await revokeAppleIdentitiesForUser({
      prisma: makePrisma([{ id: "i-1", userId: USER, provider: "apple", appleRefreshTokenEnc: encryptSecret("t", ENC_KEY), appleClientId: CLIENT_ID }]),
      userId: USER,
      config: config(),
      revokeAppleToken: async () => ({ ok: false, detail: "http 400" }),
    });
    assert.deepEqual(out, { found: 1, revoked: 0, skipped: ["apple_refused"] });
  });

  it("🔴 a THROW from the revoke call is swallowed — same reason", async () => {
    const out = await revokeAppleIdentitiesForUser({
      prisma: makePrisma([{ id: "i-1", userId: USER, provider: "apple", appleRefreshTokenEnc: encryptSecret("t", ENC_KEY), appleClientId: CLIENT_ID }]),
      userId: USER,
      config: config(),
      revokeAppleToken: async () => { throw new Error("appleid unreachable"); },
    });
    assert.deepEqual(out, { found: 1, revoked: 0, skipped: ["threw"] });
  });

  it("an unconfigured deploy skips with a named reason and no call", async () => {
    let calls = 0;
    const out = await revokeAppleIdentitiesForUser({
      prisma: makePrisma([{ id: "i-1", userId: USER, provider: "apple", appleRefreshTokenEnc: "x", appleClientId: CLIENT_ID }]),
      userId: USER,
      config: config({ appleSigning: null }),
      revokeAppleToken: async () => { calls++; return { ok: true }; },
    });
    assert.deepEqual(out, { found: 1, revoked: 0, skipped: ["not_configured"] });
    assert.equal(calls, 0);
  });

  it("a ROTATED encryption key makes old rows undecryptable — skipped, never fatal", async () => {
    const out = await revokeAppleIdentitiesForUser({
      prisma: makePrisma([{ id: "i-1", userId: USER, provider: "apple", appleRefreshTokenEnc: encryptSecret("t", "the-OLD-secret"), appleClientId: CLIENT_ID }]),
      userId: USER,
      config: config(),
      revokeAppleToken: async () => ({ ok: true }),
    });
    assert.deepEqual(out, { found: 1, revoked: 0, skipped: ["undecryptable"] });
  });

  it("an identity with no stored token is skipped, and its siblings still go through", async () => {
    const seen: string[] = [];
    const out = await revokeAppleIdentitiesForUser({
      prisma: makePrisma([
        { id: "i-1", userId: USER, provider: "apple", appleRefreshTokenEnc: null, appleClientId: CLIENT_ID },
        { id: "i-2", userId: USER, provider: "apple", appleRefreshTokenEnc: encryptSecret("good", ENC_KEY), appleClientId: CLIENT_ID },
      ]),
      userId: USER,
      config: config(),
      revokeAppleToken: async (o) => { seen.push(o.refreshToken); return { ok: true }; },
    });
    assert.deepEqual(out, { found: 2, revoked: 1, skipped: ["no_token"] });
    assert.deepEqual(seen, ["good"], "one bad row does not stop the next");
  });

  it("🔴 the identity rows CASCADE with the user — asserted against the migration SQL", async () => {
    // The route deletes no identity row and must not: the FK does it. This
    // suite has no database, so the evidence is the DDL itself — exactly how
    // me-delete-account.test.ts derives its own FK rules ("read out of
    // prisma/migrations rather than inferred from Prisma's defaults", because
    // the two disagree). If someone weakens this to SET NULL, a deleted
    // account leaves an orphan row holding an encrypted Apple refresh token,
    // and this fails.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const sql = readFileSync(
      fileURLToPath(
        new URL(
          "../../../prisma/migrations/20260927120000_row9_oauth_user_identities/migration.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    assert.match(
      sql,
      /ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_userId_fkey"[\s\S]*?ON DELETE CASCADE/,
    );
    // And the constraint that makes (a) the identity branch: one row per
    // (provider, subject), which is also the first-sign-in race guard.
    assert.match(
      sql,
      /CREATE UNIQUE INDEX "user_identities_provider_subject_key" ON "user_identities"\("provider", "subject"\)/,
    );
  });

  it("a row written before appleClientId existed falls back to the first configured audience", async () => {
    const seen: string[] = [];
    await revokeAppleIdentitiesForUser({
      prisma: makePrisma([{ id: "i-1", userId: USER, provider: "apple", appleRefreshTokenEnc: encryptSecret("t", ENC_KEY), appleClientId: null }]),
      userId: USER,
      config: config(),
      revokeAppleToken: async (o) => { seen.push(o.clientId); return { ok: true }; },
    });
    assert.deepEqual(seen, [CLIENT_ID], "a guess beats not trying");
  });
});

// ── Row 9 (1.1) · Stripe S1 Part F — the web redirect_uri (D-WS9-268 follow-up)
//
// Apple REQUIRES `redirect_uri` on a code from the web flow and REFUSES it on a
// code from a native app, and both mistakes answer `invalid_grant` with nothing to
// tell them apart. So the decision is made from the VERIFIED audience, and these
// tests pin all four combinations — the one that sends it, the one that must not,
// and the two half-configured states that have to behave like today.

describe("exchangeAppleAuthorizationCode — redirect_uri by audience (Part F)", () => {
  const SERVICES_ID = "com.kitchenwizard.kiwi.web";
  const REDIRECT = "https://app.kitchenwizard.ai/auth/apple/callback";
  const WEB_REDIRECT = { servicesId: SERVICES_ID, redirectUri: REDIRECT };

  async function exchangeWith(
    clientId: string,
    webRedirect: { servicesId: string; redirectUri: string } | null | undefined,
  ): Promise<Record<string, string>> {
    const { fetchImpl, calls } = recordingFetch({
      ok: true,
      body: JSON.stringify({ refresh_token: "r.tok" }),
    });
    await exchangeAppleAuthorizationCode({
      signing: SIGNING,
      clientId,
      authorizationCode: "c-1",
      fetchImpl,
      ...(webRedirect === undefined ? {} : { webRedirect }),
    });
    return calls[0].params;
  }

  it("a SERVICES-ID audience sends redirect_uri, exactly as configured", async () => {
    const params = await exchangeWith(SERVICES_ID, WEB_REDIRECT);
    assert.equal(params.redirect_uri, REDIRECT);
    // Apple matches it byte-for-byte against the portal registration, so it must
    // not be normalised, re-encoded or given a trailing slash on the way out.
    assert.equal(params.client_id, SERVICES_ID);
  });

  it("a NATIVE (bundle-id) audience sends NO redirect_uri even when the pair is configured", async () => {
    const params = await exchangeWith(CLIENT_ID, WEB_REDIRECT);
    assert.equal("redirect_uri" in params, false, "Apple refuses a redirect_uri on a native code");
    assert.equal(params.client_id, CLIENT_ID);
  });

  it("no webRedirect configured → no redirect_uri, for EITHER audience (today's behaviour)", async () => {
    for (const aud of [CLIENT_ID, SERVICES_ID]) {
      assert.equal("redirect_uri" in (await exchangeWith(aud, null)), false, aud);
      // `undefined` is the omitted-argument case, which is what every existing
      // caller looked like before this block.
      assert.equal("redirect_uri" in (await exchangeWith(aud, undefined)), false, aud);
    }
  });

  it("the match is STRICT — a near-miss audience is treated as native, not web", async () => {
    // A trailing dot, a case difference, a suffix: none of these is the Services
    // ID, and guessing "close enough" would send a redirect_uri Apple refuses.
    for (const aud of [
      `${SERVICES_ID}.`,
      SERVICES_ID.toUpperCase(),
      `${SERVICES_ID}2`,
      SERVICES_ID.slice(0, -1),
    ]) {
      const params = await exchangeWith(aud, WEB_REDIRECT);
      assert.equal("redirect_uri" in params, false, aud);
    }
  });
});

// Row 9 (1.1) · OAuth Block 1 Part E — the two ROUTE halves of App Review
// guideline 5.1.1(v).
//
//   POST /auth/oauth/apple  — exchanges the one-time authorizationCode and
//                             stores the refresh token ENCRYPTED, and lets the
//                             sign-in succeed whatever that exchange does.
//   DELETE /me              — calls the revoke seam ONCE PER Apple identity
//                             BEFORE deleting, and still deletes when it
//                             throws.
//
// Both outbound calls go through injected seams; nothing here reaches
// appleid.apple.com.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import express, { type Express } from "express";
import type { Server } from "node:http";
import type { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

import { signToken } from "../../lib/auth";
import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import { JwksCache, type JwksFetch } from "../../lib/oauth/jwks";
import { APPLE_ISSUER, verifyAppleIdentityToken } from "../../lib/oauth/verify";
import type { AppleSigningConfig, OAuthConfig } from "../../lib/oauth/config";
import { decryptSecret } from "../../lib/oauth/secretBox";
import { createAuthRouter } from "../auth";
import { createMeRouter } from "../me";

const BUNDLE_ID = "com.kitchenwizard.kiwi";
const RAW_NONCE = "raw-nonce";
const HASHED = createHash("sha256").update(RAW_NONCE, "utf8").digest("hex");
const ENC_KEY = "the-encryption-secret";

const { privateKey: ecPrivate } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const SIGNING: AppleSigningConfig = {
  teamId: "TEAM123456",
  keyId: "KEYID12345",
  privateKey: ecPrivate.export({ format: "pem", type: "pkcs8" }).toString(),
};

const CONFIGURED: OAuthConfig = {
  appleAudiences: [BUNDLE_ID],
  googleClientIds: [],
  appleSigning: SIGNING,
  appleRefreshEncSecret: ENC_KEY,
};

// ── a real RS256 pair for the identity token ─────────────────────────────

const { privateKey: rsaPrivate, publicKey: rsaPublic } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const JWK = (() => {
  const k = rsaPublic.export({ format: "jwk" }) as { n: string; e: string };
  return { kty: "RSA", alg: "RS256", use: "sig", kid: "kid1", n: k.n, e: k.e };
})();
const jwksFetch: JwksFetch = async () => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ keys: [JWK] }),
});

function appleToken(claims: Record<string, unknown> = {}) {
  return jwt.sign(
    {
      iss: APPLE_ISSUER,
      aud: BUNDLE_ID,
      sub: "000999.apple.sub",
      email: "revoke-me@example.com",
      email_verified: "true",
      nonce: HASHED,
      ...claims,
    },
    rsaPrivate as KeyObject,
    { algorithm: "RS256", keyid: "kid1", expiresIn: "5m" },
  );
}

// ── the sign-in half ─────────────────────────────────────────────────────

function makeAuthPrisma() {
  let uid = 0;
  let iid = 0;
  const state = {
    users: [] as Record<string, unknown>[],
    identities: [] as Record<string, unknown>[],
    subscriptions: [] as Record<string, unknown>[],
  };
  const client = {
    user: {
      findUnique: async ({ where, include }: { where: { email?: string; id?: string }; include?: { subscription?: boolean } }) => {
        const row =
          where.email !== undefined
            ? state.users.find((u) => u.email === where.email)
            : state.users.find((u) => u.id === where.id);
        if (!row) return null;
        return include?.subscription ? { ...row, subscription: null } : row;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `u-${++uid}`,
          email: "",
          firstName: "",
          lastName: "",
          phone: null,
          zipCode: null,
          timezone: "America/New_York",
          accountStatus: "active",
          subscriptionStatus: "trialing",
          defaultHouseholdSize: 2,
          lastPlanDiscoveryFilters: [],
          lastPlansFilters: [],
          lastMealsFilters: [],
          marketingConsentEmail: false,
          marketingConsentSms: false,
          onboardingComplete: false,
          firstRunChoiceMade: false,
          signupSource: null,
          personalizeNudgeDismissedAt: null,
          createdAt: new Date(),
          ...data,
        };
        state.users.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.users.find((u) => u.id === where.id)!;
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && "increment" in (v as object)) continue;
          row[k] = v;
        }
        return row;
      },
    },
    userIdentity: {
      findUnique: async ({ where }: { where: { provider_subject: { provider: string; subject: string } } }) =>
        state.identities.find(
          (i) => i.provider === where.provider_subject.provider && i.subject === where.provider_subject.subject,
        ) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `i-${++iid}`, ...data };
        state.identities.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.identities.find((i) => i.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
    subscription: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { status: "trialing", planCode: "free", trialEndsAt: null, currentPeriodEnd: null, ...data };
        state.subscriptions.push(row);
        return row;
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
    _state: () => state,
  };
  return client;
}

async function spinUpAuth(
  prisma: ReturnType<typeof makeAuthPrisma>,
  exchangeAppleCode: unknown,
  config: OAuthConfig = CONFIGURED,
) {
  __clearRateLimitStoreForTests();
  const app: Express = express();
  app.use(express.json());
  app.use(
    "/api",
    createAuthRouter({
      prisma: prisma as unknown as PrismaClient,
      sendEmail: async () => ({ ok: true }) as never,
      oauthConfig: config,
      verifyApple: (o) =>
        verifyAppleIdentityToken({
          ...o,
          cache: new JwksCache({ fetch: jwksFetch, jwksUrl: "https://stub.invalid/keys" }),
        }),
      exchangeAppleCode: exchangeAppleCode as never,
    }),
  );
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const { port } = server.address() as { port: number };
  return {
    post: (body: unknown) =>
      fetch(`http://127.0.0.1:${port}/api/auth/oauth/apple`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("POST /auth/oauth/apple — the code exchange (5.1.1(v)'s first half)", () => {
  it("exchanges the code and stores the refresh token ENCRYPTED, never in the clear", async () => {
    const prisma = makeAuthPrisma();
    const seen: Array<Record<string, unknown>> = [];
    const api = await spinUpAuth(prisma, async (o: Record<string, unknown>) => {
      seen.push(o);
      return { refreshToken: "r.APPLE-REFRESH" };
    });
    try {
      const res = await api.post({
        identityToken: appleToken(),
        rawNonce: RAW_NONCE,
        authorizationCode: "one-time-code",
      });
      assert.equal(res.status, 201);

      assert.equal(seen.length, 1);
      assert.equal(seen[0].authorizationCode, "one-time-code");
      assert.equal(seen[0].clientId, BUNDLE_ID, "the aud the token ACTUALLY carried");

      const row = prisma._state().identities[0];
      const stored = row.appleRefreshTokenEnc as string;
      assert.ok(stored, "a token was stored");
      assert.ok(!stored.includes("r.APPLE-REFRESH"), "🔴 not in the clear");
      assert.match(stored, /^v1\./);
      assert.equal(decryptSecret(stored, ENC_KEY), "r.APPLE-REFRESH");
      assert.equal(row.appleClientId, BUNDLE_ID, "recorded so the revoke can use the same one");
    } finally {
      await api.close();
    }
  });

  it("no authorizationCode → no exchange, and the sign-in still succeeds", async () => {
    const prisma = makeAuthPrisma();
    let calls = 0;
    const api = await spinUpAuth(prisma, async () => {
      calls++;
      return { refreshToken: "x" };
    });
    try {
      const res = await api.post({ identityToken: appleToken(), rawNonce: RAW_NONCE });
      assert.equal(res.status, 201);
      assert.equal(calls, 0);
      assert.equal(prisma._state().identities[0].appleRefreshTokenEnc, null);
    } finally {
      await api.close();
    }
  });

  it("🔴 a FAILED exchange never blocks the sign-in — the person is already verified", async () => {
    const prisma = makeAuthPrisma();
    const api = await spinUpAuth(prisma, async () => ({ refreshToken: null }));
    try {
      const res = await api.post({
        identityToken: appleToken(),
        rawNonce: RAW_NONCE,
        authorizationCode: "c",
      });
      assert.equal(res.status, 201, "a secondary call to Apple must not cost someone their login");
      assert.equal(prisma._state().identities[0].appleRefreshTokenEnc, null);
    } finally {
      await api.close();
    }
  });

  it("an unconfigured deploy skips the exchange entirely — Apple sign-in still works", async () => {
    const prisma = makeAuthPrisma();
    let calls = 0;
    const api = await spinUpAuth(
      prisma,
      async () => { calls++; return { refreshToken: "x" }; },
      { ...CONFIGURED, appleSigning: null },
    );
    try {
      const res = await api.post({
        identityToken: appleToken(),
        rawNonce: RAW_NONCE,
        authorizationCode: "c",
      });
      assert.equal(res.status, 201, "the revocation gap must not disable the route");
      assert.equal(calls, 0);
    } finally {
      await api.close();
    }
  });

  it("no encryption key → the exchange is skipped rather than storing a bearer token in the clear", async () => {
    const prisma = makeAuthPrisma();
    let calls = 0;
    const api = await spinUpAuth(
      prisma,
      async () => { calls++; return { refreshToken: "r.LIVE" }; },
      { ...CONFIGURED, appleRefreshEncSecret: null },
    );
    try {
      assert.equal((await api.post({ identityToken: appleToken(), rawNonce: RAW_NONCE, authorizationCode: "c" })).status, 201);
      assert.equal(calls, 0);
      assert.equal(prisma._state().identities[0].appleRefreshTokenEnc, null);
    } finally {
      await api.close();
    }
  });

  it("a LATER sign-in with no code does not blank the token an earlier one stored", async () => {
    const prisma = makeAuthPrisma();
    let give = true;
    const api = await spinUpAuth(prisma, async () => (give ? { refreshToken: "r.FIRST" } : { refreshToken: null }));
    try {
      await api.post({ identityToken: appleToken(), rawNonce: RAW_NONCE, authorizationCode: "c1" });
      const stored = prisma._state().identities[0].appleRefreshTokenEnc as string;
      give = false;
      await api.post({ identityToken: appleToken(), rawNonce: RAW_NONCE });
      assert.equal(
        prisma._state().identities[0].appleRefreshTokenEnc,
        stored,
        "🔴 a sign-in without a code must not destroy the only thing DELETE /me can revoke with",
      );
    } finally {
      await api.close();
    }
  });
});

// ── the deletion half ────────────────────────────────────────────────────

const USER_ID = "revoke-user";

function makeDeletePrisma() {
  const state = { deleted: [] as string[], users: [{ id: USER_ID, tokensValidFrom: null }] };
  const noop = { deleteMany: async () => ({ count: 0 }), updateMany: async () => ({ count: 0 }) };
  const client = {
    meal: { findMany: async () => [], ...noop },
    dish: { findMany: async () => [], ...noop },
    mealPlanTemplate: { findMany: async () => [], ...noop },
    groceryList: noop,
    mealPlanInstance: noop,
    recipeInstructionStep: noop,
    orderSession: noop,
    retailerConnection: noop,
    notificationPreference: noop,
    usedToken: noop,
    lLMCallLog: noop,
    userIdentity: { findMany: async () => [] },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.users.find((u) => u.id === where.id) ?? null,
      delete: async ({ where }: { where: { id: string } }) => {
        state.deleted.push(where.id);
        return { id: where.id };
      },
    },
    // The route passes an ARRAY of promises; each element is already running.
    $transaction: async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]),
    _state: () => state,
  };
  return client;
}

async function spinUpMe(
  prisma: ReturnType<typeof makeDeletePrisma>,
  revokeAppleIdentities: unknown,
) {
  __clearRateLimitStoreForTests();
  const app: Express = express();
  app.use(express.json());
  app.use(
    createMeRouter({
      prisma: prisma as unknown as PrismaClient,
      oauthConfig: CONFIGURED,
      revokeAppleIdentities: revokeAppleIdentities as never,
    }),
  );
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const { port } = server.address() as { port: number };
  return {
    del: () =>
      fetch(`http://127.0.0.1:${port}/me`, {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${signToken(USER_ID)}`,
        },
        body: JSON.stringify({ confirm: "delete" }),
      }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("DELETE /me — the revocation (5.1.1(v)'s second half)", () => {
  it("🔴 calls the revoke seam BEFORE deleting, once, with the user", async () => {
    const prisma = makeDeletePrisma();
    const order: string[] = [];
    const api = await spinUpMe(prisma, async (o: { userId: string }) => {
      order.push(`revoke:${o.userId}`);
      return { found: 1, revoked: 1, skipped: [] };
    });
    try {
      const res = await api.del();
      assert.equal(res.status, 204);
      order.push(`delete:${prisma._state().deleted[0]}`);
      assert.deepEqual(order, [`revoke:${USER_ID}`, `delete:${USER_ID}`], "revoke first — the identity rows cascade away with the user");
    } finally {
      await api.close();
    }
  });

  it("🔴 STILL DELETES when the revoke throws — a third party's outage is not a life sentence", async () => {
    const prisma = makeDeletePrisma();
    const api = await spinUpMe(prisma, async () => {
      throw new Error("appleid.apple.com unreachable");
    });
    try {
      const res = await api.del();
      assert.equal(res.status, 204, "the person asked to be deleted");
      assert.deepEqual(prisma._state().deleted, [USER_ID]);
    } finally {
      await api.close();
    }
  });

  it("an account with no Apple identity deletes exactly as before", async () => {
    const prisma = makeDeletePrisma();
    const api = await spinUpMe(prisma, async () => ({ found: 0, revoked: 0, skipped: [] }));
    try {
      assert.equal((await api.del()).status, 204);
      assert.deepEqual(prisma._state().deleted, [USER_ID]);
    } finally {
      await api.close();
    }
  });

  it("a partial revocation (some skipped) does not change the outcome", async () => {
    const prisma = makeDeletePrisma();
    const api = await spinUpMe(prisma, async () => ({ found: 2, revoked: 1, skipped: ["apple_refused"] }));
    try {
      assert.equal((await api.del()).status, 204);
      assert.deepEqual(prisma._state().deleted, [USER_ID]);
    } finally {
      await api.close();
    }
  });
});

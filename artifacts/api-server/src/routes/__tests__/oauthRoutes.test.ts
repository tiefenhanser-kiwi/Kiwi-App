// Row 9 (1.1) · OAuth Block 1 Part D — POST /auth/oauth/apple and
// POST /auth/oauth/google.
//
//   a valid Apple token          → 201, a new user, an identity row, a
//                                  Subscription row, isNewUser true
//   the same subject again       → 200, THE SAME user, no second identity
//   a verified email that already
//   has a password account       → linked, not duplicated, isNewUser false
//   Google email_verified: false → REFUSED (401). Not "create a new user" —
//                                  see the note above that test.
//   wrong aud / expired / bad
//   signature / nonce mismatch   → one generic 401, no reason on the wire
//   unset env                    → 503 oauth_unavailable
//   a private relay address      → stored as the email, flagged
//   guest claim through Google,
//   NEW user                     → onboardingRequired false, signupSource
//                                  test_kitchen, preferences copied
//   guest claim through Apple,
//   EXISTING user                → the plan is claimed, the preferences are NOT
//
// ⚠️ BUG-279 — the suite loads `.env`, so a router test can fire a live call.
// Verification here goes through the router's `verifyApple` / `verifyGoogle`
// seams over a LOCALLY GENERATED key pair; nothing in this file can reach
// appleid.apple.com or googleapis.com.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import express, { type Express } from "express";
import type { Server } from "node:http";
import type { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import { JwksCache, type JwksFetch } from "../../lib/oauth/jwks";
import {
  APPLE_ISSUER,
  verifyAppleIdentityToken,
  verifyGoogleIdentityToken,
} from "../../lib/oauth/verify";
import type { OAuthConfig } from "../../lib/oauth/config";
import { createAuthRouter } from "../auth";

const BUNDLE_ID = "com.kitchenwizard.kiwi";
const GOOGLE_IOS = "111-ios.apps.googleusercontent.com";
const RAW_NONCE = "raw-nonce-from-this-sign-in";
const HASHED = createHash("sha256").update(RAW_NONCE, "utf8").digest("hex");
const HOUR = 60 * 60 * 1000;

const CONFIG: OAuthConfig = {
  appleAudiences: [BUNDLE_ID],
  googleClientIds: [GOOGLE_IOS],
  appleSigning: null,
  appleRefreshEncSecret: null,
  appleWebRedirect: null,
};
const OFF: OAuthConfig = {
  appleAudiences: [],
  googleClientIds: [],
  appleSigning: null,
  appleRefreshEncSecret: null,
  appleWebRedirect: null,
};

// ── a real key pair, served by a stub JWKS ───────────────────────────────

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = (() => {
  const k = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  return { kty: "RSA", alg: "RS256", use: "sig", kid: "test-kid", n: k.n, e: k.e };
})();
const jwksFetch: JwksFetch = async () => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ keys: [JWK] }),
});
const cache = () => new JwksCache({ fetch: jwksFetch, jwksUrl: "https://stub.invalid/keys" });

function appleToken(claims: Record<string, unknown> = {}, opts: jwt.SignOptions = {}) {
  return jwt.sign(
    {
      iss: APPLE_ISSUER,
      aud: BUNDLE_ID,
      sub: "000123.apple.sub",
      email: "apple-person@example.com",
      email_verified: "true",
      nonce: HASHED,
      ...claims,
    },
    privateKey as KeyObject,
    { algorithm: "RS256", keyid: "test-kid", expiresIn: "5m", ...opts },
  );
}

function googleToken(claims: Record<string, unknown> = {}, opts: jwt.SignOptions = {}) {
  return jwt.sign(
    {
      iss: "https://accounts.google.com",
      aud: GOOGLE_IOS,
      sub: "10888888888",
      email: "google-person@example.com",
      email_verified: true,
      given_name: "Gee",
      family_name: "Mail",
      ...claims,
    },
    privateKey as KeyObject,
    { algorithm: "RS256", keyid: "test-kid", expiresIn: "5m", ...opts },
  );
}

// ── the stub Prisma ──────────────────────────────────────────────────────
//
// Models the two things the routes actually depend on and nothing more: the
// (provider, subject) unique lookup, and the fact that a `$transaction`
// callback that throws leaves no user behind.

interface UserRow extends Record<string, unknown> {
  id: string;
  email: string;
  onboardingComplete: boolean;
}
interface IdentityRow extends Record<string, unknown> {
  id: string;
  userId: string;
  provider: string;
  subject: string;
}

const WIZARD_BODY = {
  planDurationDays: 5,
  householdSize: 4,
  cuisines: ["italian"],
  allergiesAndAvoidances: ["peanut"],
  difficulty: "medium",
};

function makePrisma(opts: { users?: Array<Partial<UserRow>>; guest?: { id: string; draft?: unknown; expired?: boolean } } = {}) {
  let uid = 0;
  let iid = 0;
  const state = {
    users: [] as UserRow[],
    identities: [] as IdentityRow[],
    subscriptions: [] as Record<string, unknown>[],
    preferencesCreates: [] as Record<string, unknown>[],
    guestEvents: [] as Record<string, unknown>[],
    logins: [] as string[],
    guest: opts.guest
      ? {
          id: opts.guest.id,
          expiresAt: new Date(Date.now() + (opts.guest.expired ? -HOUR : HOUR)),
          claimedAt: null as Date | null,
          claimedByUserId: null as string | null,
          preferences: WIZARD_BODY as unknown,
          draft: opts.guest.draft ?? null,
          lastEvent: null as string | null,
        }
      : null,
  };
  for (const u of opts.users ?? []) {
    state.users.push(makeUser(`seed-${++uid}`, u));
  }

  function makeUser(id: string, data: Partial<UserRow>): UserRow {
    return {
      id,
      email: "",
      passwordHash: null,
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
    } as UserRow;
  }

  const client = {
    user: {
      findUnique: async ({ where, include }: { where: { email?: string; id?: string }; include?: { subscription?: boolean } }) => {
        const row =
          where.email !== undefined
            ? state.users.find((u) => u.email === where.email)
            : state.users.find((u) => u.id === where.id);
        if (!row) return null;
        if (include?.subscription) {
          return { ...row, subscription: state.subscriptions.find((s) => s.userId === row.id) ?? null };
        }
        return row;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = makeUser(`u-${++uid}`, data as Partial<UserRow>);
        state.users.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.users.find((u) => u.id === where.id)!;
        if (data.lastLoginAt) state.logins.push(row.id);
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && "increment" in (v as object)) continue;
          row[k] = v;
        }
        return row;
      },
    },
    userIdentity: {
      findUnique: async ({ where }: { where: { provider_subject: { provider: string; subject: string } } }) => {
        const { provider, subject } = where.provider_subject;
        return state.identities.find((i) => i.provider === provider && i.subject === subject) ?? null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `i-${++iid}`, ...data } as IdentityRow;
        // The unique index, modelled — the race-guard test depends on it.
        if (state.identities.some((i) => i.provider === row.provider && i.subject === row.subject)) {
          const err = new Error("Unique constraint failed") as Error & { code: string };
          err.code = "P2002";
          throw err;
        }
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
        const row = { status: "trialing", planCode: "free", currentPeriodEnd: null, ...data };
        state.subscriptions.push(row);
        return row;
      },
    },
    userPreferences: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.preferencesCreates.push(data);
        return data;
      },
    },
    guestSession: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.guest && where.id === state.guest.id ? state.guest : null,
      updateMany: async ({ where, data }: { where: { id: string; claimedAt?: null; claimedByUserId?: string }; data: Record<string, unknown> }) => {
        if (!state.guest || where.id !== state.guest.id) return { count: 0 };
        if (where.claimedAt === null && state.guest.claimedAt !== null) return { count: 0 };
        if (where.claimedByUserId !== undefined && state.guest.claimedByUserId !== where.claimedByUserId) {
          return { count: 0 };
        }
        Object.assign(state.guest, data);
        return { count: 1 };
      },
    },
    guestEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.guestEvents.push(data);
        return data;
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const beforeUsers = state.users.length;
      const beforeIdentities = state.identities.length;
      try {
        return await fn(client);
      } catch (err) {
        state.users.length = beforeUsers; // the rollback, modelled
        state.identities.length = beforeIdentities;
        throw err;
      }
    },
    _state: () => state,
  };
  return client;
}

async function spinUp(
  prisma: ReturnType<typeof makePrisma>,
  config: OAuthConfig = CONFIG,
  extra: Record<string, unknown> = {},
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
      // The seam. A locally generated key pair, a stub JWKS: the real
      // verifier logic runs, the network does not.
      verifyApple: (o) => verifyAppleIdentityToken({ ...o, cache: cache() }),
      verifyGoogle: (o) => verifyGoogleIdentityToken({ ...o, cache: cache() }),
      ...extra,
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  return {
    post: (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}/api${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ── the happy paths ──────────────────────────────────────────────────────

describe("POST /auth/oauth/apple — a first sign-in IS a sign-up", () => {
  it("creates the user, the identity and the subscription; isNewUser true", async () => {
    const prisma = makePrisma();
    const api = await spinUp(prisma);
    try {
      const res = await api.post("/auth/oauth/apple", {
        identityToken: appleToken(),
        rawNonce: RAW_NONCE,
        firstName: "App",
        lastName: "Leseed",
        platform: "ios",
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as Record<string, any>;
      assert.equal(body.isNewUser, true);
      assert.equal(body.user.email, "apple-person@example.com");
      assert.equal(body.user.firstName, "App", "the BODY's name, since Apple sends none in the token");
      assert.equal(body.user.lastName, "Leseed");
      assert.equal(body.user.signupSource, "ios");
      assert.ok(typeof body.authToken === "string" && body.authToken.length > 20);
      assert.equal(body.onboardingRequired, true, "no claim, so the form is still owed");
      assert.equal(body.claimedPlanId, null);

      const st = prisma._state();
      assert.equal(st.users.length, 1);
      assert.equal(st.subscriptions.length, 1, "every user has a Subscription row");
      assert.equal(st.identities.length, 1);
      assert.equal(st.identities[0].provider, "apple");
      assert.equal(st.identities[0].subject, "000123.apple.sub");
      assert.equal(st.identities[0].emailVerified, true);
      assert.equal(st.identities[0].appleClientId, BUNDLE_ID, "recorded for the later revoke call");
      assert.equal(st.users[0].passwordHash, null, "an OAuth-only account has no password");
    } finally {
      await api.close();
    }
  });

  it("the SAME subject again is the same user — no duplicate account, no second identity", async () => {
    const prisma = makePrisma();
    const api = await spinUp(prisma);
    try {
      const first = await api.post("/auth/oauth/apple", { identityToken: appleToken(), rawNonce: RAW_NONCE });
      assert.equal(first.status, 201);
      const firstId = ((await first.json()) as any).user.id;

      // A later sign-in: a fresh token, same subject, and Apple no longer
      // sends the name (it only ever does on the first authorisation).
      const again = await api.post("/auth/oauth/apple", { identityToken: appleToken(), rawNonce: RAW_NONCE });
      assert.equal(again.status, 200, "not 201 — nothing was created");
      const body = (await again.json()) as any;
      assert.equal(body.isNewUser, false);
      assert.equal(body.user.id, firstId);

      const st = prisma._state();
      assert.equal(st.users.length, 1);
      assert.equal(st.identities.length, 1);
      assert.deepEqual(st.logins, [firstId], "login tracking runs for a returning user only");
    } finally {
      await api.close();
    }
  });

  it("an identity whose subject is known is NOT re-decided — even if the email now matches someone else", async () => {
    // The takeover this ordering prevents: identity (a) wins over email (b).
    const prisma = makePrisma();
    const api = await spinUp(prisma);
    try {
      const first = await api.post("/auth/oauth/apple", { identityToken: appleToken(), rawNonce: RAW_NONCE });
      const mine = ((await first.json()) as any).user.id;
      // Someone else's account now holds the address this token asserts.
      prisma._state().users.push({ id: "other", email: "moved@example.com" } as never);

      const again = await api.post("/auth/oauth/apple", {
        identityToken: appleToken({ email: "moved@example.com" }),
        rawNonce: RAW_NONCE,
      });
      const body = (await again.json()) as any;
      assert.equal(body.user.id, mine, "the sub is the identity; the email is not");
      assert.equal(prisma._state().identities[0].userId, mine, "userId is never rewritten");
      assert.equal(prisma._state().identities[0].emailAtLink, "moved@example.com", "…but the fact is refreshed");
    } finally {
      await api.close();
    }
  });
});

describe("linking to an existing account", () => {
  it("a VERIFIED email matching a password user links — it does not duplicate", async () => {
    const prisma = makePrisma({
      users: [{ email: "google-person@example.com", passwordHash: "$2a$hash", firstName: "Pass", lastName: "Word", onboardingComplete: true }],
    });
    const api = await spinUp(prisma);
    try {
      const res = await api.post("/auth/oauth/google", { idToken: googleToken() });
      assert.equal(res.status, 200, "an existing account is not a creation");
      const body = (await res.json()) as any;
      assert.equal(body.isNewUser, false);
      assert.equal(body.user.id, "seed-1");
      assert.equal(body.user.firstName, "Pass", "the provider's name does NOT overwrite theirs");

      const st = prisma._state();
      assert.equal(st.users.length, 1, "no second account");
      assert.equal(st.identities.length, 1);
      assert.equal(st.identities[0].userId, "seed-1");
      assert.equal(st.users[0].passwordHash, "$2a$hash", "the password still works too");
    } finally {
      await api.close();
    }
  });

  it("the match is case-insensitive on the stored, normalised address", async () => {
    const prisma = makePrisma({ users: [{ email: "google-person@example.com" }] });
    const api = await spinUp(prisma);
    try {
      const res = await api.post("/auth/oauth/google", {
        idToken: googleToken({ email: "Google-Person@Example.COM" }),
      });
      assert.equal(res.status, 200);
      assert.equal(prisma._state().users.length, 1);
    } finally {
      await api.close();
    }
  });

  it("🔴 an UNVERIFIED email is REFUSED — it neither links nor creates", async () => {
    // The choice, stated: creating would be the tempting fallback and it is
    // the unsafe one. `users.email` is unique and is what password reset
    // delivers to, so an account made from an unverified assertion of a real
    // person's address SITS on that address — and when the real owner later
    // signs in with the same, genuinely verified, address, the link branch
    // would attach them to the squatter's account. Refusing is the safe answer,
    // and it reaches the wire as the same generic 401 as every other failure.
    const prisma = makePrisma({ users: [{ email: "google-person@example.com", passwordHash: "$2a$hash" }] });
    const api = await spinUp(prisma);
    try {
      const res = await api.post("/auth/oauth/google", { idToken: googleToken({ email_verified: false }) });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: "invalid credentials" });
      const st = prisma._state();
      assert.equal(st.identities.length, 0, "nothing linked");
      assert.equal(st.users.length, 1, "and nothing created");
    } finally {
      await api.close();
    }
  });

  it("an unverified email with NO existing account is refused too — same answer", async () => {
    const prisma = makePrisma();
    const api = await spinUp(prisma);
    try {
      const res = await api.post("/auth/oauth/google", { idToken: googleToken({ email_verified: false }) });
      assert.equal(res.status, 401);
      assert.equal(prisma._state().users.length, 0);
    } finally {
      await api.close();
    }
  });
});

describe("Hide My Email (PRD OQ-3.3)", () => {
  it("a private-relay address becomes the user's email and is flagged", async () => {
    const relay = "00a1b2c3@privaterelay.appleid.com";
    const prisma = makePrisma();
    const api = await spinUp(prisma);
    try {
      const res = await api.post("/auth/oauth/apple", {
        identityToken: appleToken({ email: relay, is_private_email: "true" }),
        rawNonce: RAW_NONCE,
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as any;
      assert.equal(body.user.email, relay, "the account works in-app on the relay address");
      assert.equal(prisma._state().identities[0].isPrivateRelay, true);
    } finally {
      await api.close();
    }
  });
});

// ── the refusals ─────────────────────────────────────────────────────────

describe("every verification failure is ONE generic 401", () => {
  const cases: Array<[string, () => Record<string, unknown>]> = [
    ["wrong audience", () => ({ identityToken: appleToken({ aud: "com.someone.else" }), rawNonce: RAW_NONCE })],
    ["expired", () => ({ identityToken: appleToken({}, { expiresIn: "-1s" }), rawNonce: RAW_NONCE })],
    ["bad signature", () => ({ identityToken: `${appleToken()}x`, rawNonce: RAW_NONCE })],
    ["nonce mismatch", () => ({ identityToken: appleToken(), rawNonce: "a-different-raw-nonce" })],
    ["foreign issuer", () => ({ identityToken: appleToken({ iss: "https://appleid.apple.com.evil" }), rawNonce: RAW_NONCE })],
  ];

  for (const [name, body] of cases) {
    it(`${name} → 401, no reason on the wire, nothing written`, async () => {
      const prisma = makePrisma();
      const api = await spinUp(prisma);
      try {
        const res = await api.post("/auth/oauth/apple", body());
        assert.equal(res.status, 401);
        // The SAME three bytes for all five. An attacker learns nothing about
        // which of their guesses was closest.
        assert.deepEqual(await res.json(), { error: "invalid credentials" });
        assert.equal(prisma._state().users.length, 0);
        assert.equal(prisma._state().identities.length, 0);
      } finally {
        await api.close();
      }
    });
  }

  it("a body with no token at all is a 400 (schema), not a 401", async () => {
    const api = await spinUp(makePrisma());
    try {
      assert.equal((await api.post("/auth/oauth/apple", { rawNonce: RAW_NONCE })).status, 400);
      assert.equal((await api.post("/auth/oauth/apple", { identityToken: appleToken() })).status, 400, "rawNonce is required");
      assert.equal((await api.post("/auth/oauth/google", {})).status, 400);
    } finally {
      await api.close();
    }
  });
});

describe("the OFF state", () => {
  it("no audience configured → 503 oauth_unavailable, and the token is never even looked at", async () => {
    const prisma = makePrisma();
    const api = await spinUp(prisma, OFF);
    try {
      const apple = await api.post("/auth/oauth/apple", { identityToken: appleToken(), rawNonce: RAW_NONCE });
      assert.equal(apple.status, 503);
      assert.deepEqual(await apple.json(), { code: "oauth_unavailable" });

      const google = await api.post("/auth/oauth/google", { idToken: googleToken() });
      assert.equal(google.status, 503);
      assert.deepEqual(await google.json(), { code: "oauth_unavailable" });
      assert.equal(prisma._state().users.length, 0);
    } finally {
      await api.close();
    }
  });

  it("one provider on and the other off — independently", async () => {
    const prisma = makePrisma();
    const api = await spinUp(prisma, { ...OFF, googleClientIds: [GOOGLE_IOS] });
    try {
      assert.equal((await api.post("/auth/oauth/apple", { identityToken: appleToken(), rawNonce: RAW_NONCE })).status, 503);
      assert.equal((await api.post("/auth/oauth/google", { idToken: googleToken() })).status, 201);
    } finally {
      await api.close();
    }
  });
});

// ── the Test Kitchen claim, through OAuth (§2.7) ─────────────────────────

describe("the guest claim works through OAuth too", () => {
  it("Google · NEW user → preferences copied, onboardingRequired FALSE, signupSource test_kitchen", async () => {
    const prisma = makePrisma({ guest: { id: "g-1" } });
    const api = await spinUp(prisma);
    try {
      const res = await api.post("/auth/oauth/google", {
        idToken: googleToken(),
        guestSessionId: "g-1",
        // The client also sent a platform. The guest claim is the more
        // specific fact and must win (D-WS9-264).
        platform: "web",
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as any;
      assert.equal(body.isNewUser, true);
      assert.equal(body.user.signupSource, "test_kitchen");
      assert.equal(
        body.onboardingRequired,
        false,
        "they just filled in the wizard — do not show them an empty copy of it",
      );

      const st = prisma._state();
      assert.equal(st.preferencesCreates.length, 1, "a NEW account copies the guest's answers");
      assert.equal(st.preferencesCreates[0].difficultyDefault, "medium");
      assert.equal(st.preferencesCreates[0].householdSize, 4);
      assert.ok(st.guest!.claimedAt, "the session is marked claimed");
      assert.equal(st.guest!.claimedByUserId, body.user.id);
    } finally {
      await api.close();
    }
  });

  it("🔴 Apple · EXISTING user → the plan is claimed, the PREFERENCES ARE NOT TOUCHED", async () => {
    // The asymmetry that matters: someone who has used Kiwi for a month and
    // idly tries the Test Kitchen must not have their allergy list replaced by
    // whatever they typed into a public demo.
    const prisma = makePrisma({
      users: [{ email: "apple-person@example.com", passwordHash: "$2a$hash", onboardingComplete: true }],
      guest: { id: "g-2" },
    });
    const api = await spinUp(prisma);
    try {
      const res = await api.post("/auth/oauth/apple", {
        identityToken: appleToken(),
        rawNonce: RAW_NONCE,
        guestSessionId: "g-2",
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.isNewUser, false);

      const st = prisma._state();
      assert.equal(st.preferencesCreates.length, 0, "🔴 NOT ONE preferences write");
      assert.equal(st.users.length, 1);
      assert.ok(st.guest!.claimedAt, "the session is still claimed — the plan follows them");
      assert.equal(st.guest!.claimedByUserId, "seed-1");
    } finally {
      await api.close();
    }
  });

  it("a stale guest session does not refuse a sign-in for an EXISTING user — logged, not 409", async () => {
    const prisma = makePrisma({
      users: [{ email: "apple-person@example.com" }],
      guest: { id: "g-3", expired: true },
    });
    const api = await spinUp(prisma);
    try {
      const res = await api.post("/auth/oauth/apple", {
        identityToken: appleToken(),
        rawNonce: RAW_NONCE,
        guestSessionId: "g-3",
      });
      assert.equal(res.status, 200, "their identity is verified; a stale demo must not lock them out");
      assert.equal(((await res.json()) as any).claimedPlanId, null);
    } finally {
      await api.close();
    }
  });

  it("a stale guest session DOES refuse a first sign-in (409) and leaves no account behind", async () => {
    const prisma = makePrisma({ guest: { id: "g-4", expired: true } });
    const api = await spinUp(prisma);
    try {
      const res = await api.post("/auth/oauth/google", { idToken: googleToken(), guestSessionId: "g-4" });
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { code: "guest_session_invalid" });
      assert.equal(prisma._state().users.length, 0, "the transaction rolled back");
      assert.equal(prisma._state().identities.length, 0);
    } finally {
      await api.close();
    }
  });

  it("both claim ids at once is a 400, same as the password routes", async () => {
    const api = await spinUp(makePrisma());
    try {
      const res = await api.post("/auth/oauth/google", {
        idToken: googleToken(),
        guestSessionId: "g-1",
        templatePlanId: "t-1",
      });
      assert.equal(res.status, 400);
    } finally {
      await api.close();
    }
  });
});

// ── the small print ──────────────────────────────────────────────────────

describe("consents and account state", () => {
  it("SMS consent without a phone is refused, exactly as on signup", async () => {
    const api = await spinUp(makePrisma());
    try {
      const res = await api.post("/auth/oauth/google", { idToken: googleToken(), marketingConsentSms: true });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "SMS consent requires a phone number" });
    } finally {
      await api.close();
    }
  });

  it("consents on the wire are written on CREATE and ignored on a later sign-in", async () => {
    const prisma = makePrisma();
    const api = await spinUp(prisma);
    try {
      await api.post("/auth/oauth/google", {
        idToken: googleToken(),
        marketingConsentEmail: true,
        phone: "+12125551234",
        marketingConsentSms: true,
      });
      assert.equal(prisma._state().users[0].marketingConsentEmail, true);
      assert.equal(prisma._state().users[0].marketingConsentSms, true);

      // Signing in again with the flags OFF must not silently withdraw them.
      await api.post("/auth/oauth/google", { idToken: googleToken(), marketingConsentEmail: false });
      assert.equal(prisma._state().users[0].marketingConsentEmail, true, "a sign-in is not a consent update");
    } finally {
      await api.close();
    }
  });

  it("a suspended account is 403, not signed in", async () => {
    const prisma = makePrisma({ users: [{ email: "google-person@example.com", accountStatus: "suspended" }] });
    const api = await spinUp(prisma);
    try {
      const res = await api.post("/auth/oauth/google", { idToken: googleToken() });
      assert.equal(res.status, 403);
    } finally {
      await api.close();
    }
  });

  it("a name the client did not send falls back to the token's, then to empty strings", async () => {
    const prisma = makePrisma();
    const api = await spinUp(prisma);
    try {
      // Google carries given_name / family_name — used when the body has none.
      await api.post("/auth/oauth/google", { idToken: googleToken() });
      assert.equal(prisma._state().users[0].firstName, "Gee");
      assert.equal(prisma._state().users[0].lastName, "Mail");

      // Apple carries neither, and the body sent neither: empty, never a
      // fabricated "Apple User" shown to a real person on their own Home.
      await api.post("/auth/oauth/apple", { identityToken: appleToken(), rawNonce: RAW_NONCE });
      const appleUser = prisma._state().users.find((u) => u.email === "apple-person@example.com")!;
      assert.equal(appleUser.firstName, "");
      assert.equal(appleUser.lastName, "");
    } finally {
      await api.close();
    }
  });
});

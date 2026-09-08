// BUG-234 — a password reset must evict live sessions.
//
// The whole point of a reset, for a user whose account is compromised, is to
// get the other person out. Before this fix it did not: session JWTs carry a
// 30-day expiry, requireAuth checked only signature + expiry + purpose, and
// there was no user-level version or epoch to consult. The attacker's session
// survived the reset for up to 30 more days.
//
// This is NOT the same mechanism as BUG-233 and neither test file substitutes
// for the other. A spent-token ledger cannot help here: the attacker's session
// JWT has never been redeemed, so there is no row to find, and the server
// cannot enumerate outstanding stateless JWTs in order to write one.
//
// The probe in every test is a REAL authenticated request through the REAL
// middleware, and the assertion reads its live status. The session token is
// minted with an explicitly-placed `iat` in the past so the comparison is
// deterministic — a JWT `iat` has one-second resolution, and minting "now"
// while bumping "now" is precisely the ambiguous case.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

import { isIssuedBeforeEpoch } from "../../lib/tokenRevocation";
import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import type { EmailSender } from "../../lib/email/sendEmail";
import { createAuthRouter } from "../auth";
import { createMeRouter } from "../me";
import { makeUsedTokenLedger } from "./fixtures/sessionUserStub";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET required for tests");

const USER_ID = "bug234-user";
// bcrypt hash of "currentPassword123", so PATCH /me/password can actually pass
// its bcrypt compare and reach the write. Generated with BCRYPT_ROUNDS = 10.
const CURRENT_PASSWORD = "currentPassword123";

const silentSender: EmailSender = async () => ({ sent: false, reason: "no_api_key" });

// The full row GET /auth/me serialises. It is spelled out rather than trimmed
// to the two fields this file cares about, because the probe has to return a
// real 200 for the "session is live before the reset" step to mean anything —
// a 500 from a half-built stub would satisfy a weaker assertion and prove
// nothing about revocation.
interface UserRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  zipCode: string | null;
  timezone: string;
  accountStatus: string;
  subscriptionStatus: string;
  defaultHouseholdSize: number;
  lastPlanDiscoveryFilters: string[];
  lastPlansFilters: string[];
  lastMealsFilters: string[];
  marketingConsentEmail: boolean;
  marketingConsentSms: boolean;
  onboardingComplete: boolean;
  firstRunChoiceMade: boolean;
  createdAt: Date;
  passwordHash: string | null;
  tokensValidFrom: Date | null;
  subscription: unknown;
}

function makeState(passwordHash: string | null) {
  const user: UserRow = {
    id: USER_ID,
    email: "bug234@example.test",
    firstName: "Bug",
    lastName: "TwoThreeFour",
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
    onboardingComplete: true,
    firstRunChoiceMade: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    passwordHash,
    tokensValidFrom: null,
    subscription: null,
  };
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
        if (where.id && where.id !== user.id) return null;
        if (where.email && where.email !== user.email) return null;
        return { ...user };
      },
      update: async ({ data }: { data: Partial<UserRow> }) => {
        Object.assign(user, data);
        return { ...user };
      },
    },
    usedToken: makeUsedTokenLedger(),
  };
  return { user, prisma };
}

async function spinUp(
  mount: (prisma: unknown) => unknown,
  prisma: unknown,
  ...also: Array<(prisma: unknown) => unknown>
) {
  const app: Express = express();
  app.use(express.json());
  app.use(mount(prisma) as never);
  for (const extra of also) app.use(extra(prisma) as never);
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A 30-day session JWT issued `secondsAgo` seconds ago — the attacker's. */
function sessionTokenIssuedAgo(secondsAgo: number): string {
  const iat = Math.floor(Date.now() / 1000) - secondsAgo;
  return jwt.sign(
    {
      userId: USER_ID,
      purpose: "session",
      iat,
      exp: iat + 30 * 24 * 3600,
      jti: `sess-${secondsAgo}-${Math.random()}`,
    },
    JWT_SECRET!,
  );
}

function purposeTokenIssuedAgo(secondsAgo: number): string {
  const iat = Math.floor(Date.now() / 1000) - secondsAgo;
  return jwt.sign(
    {
      userId: USER_ID,
      purpose: "password_reset",
      iat,
      exp: iat + 3600,
      jti: `reset-${secondsAgo}-${Math.random()}`,
    },
    JWT_SECRET!,
  );
}

beforeEach(() => __clearRateLimitStoreForTests());

describe("BUG-234 — a completed password reset evicts existing sessions", () => {
  it("a session JWT minted before the reset stops authenticating after it", async () => {
    const { user, prisma } = makeState("$2a$10$notarealhashnotarealhashnotarealhashnotarealhash");
    const h = await spinUp(
      (p) => createAuthRouter({ prisma: p as never, sendEmail: silentSender }),
      prisma,
    );
    try {
      // The other person's session, established well before the reset.
      const attackerSession = sessionTokenIssuedAgo(600);
      const probe = () =>
        fetch(`${h.baseUrl}/auth/me`, {
          headers: { authorization: `Bearer ${attackerSession}` },
        });

      // Non-vacuity FIRST: prove the token genuinely works, so the 401 below
      // cannot be a token that was broken all along.
      const before = await probe();
      assert.equal(before.status, 200, "the session must be live before the reset");
      assert.equal(user.tokensValidFrom, null, "no epoch is set before the reset");

      const reset = await fetch(`${h.baseUrl}/auth/password-reset/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: purposeTokenIssuedAgo(60),
          newPassword: "brandNewPassword123",
        }),
      });
      assert.equal(reset.status, 200, "the reset must complete");

      // THE FINDING. Before the fix this stayed 200 for up to 30 days.
      const after = await probe();
      assert.equal(
        after.status,
        401,
        "the pre-reset session must be evicted; 200 here is BUG-234 shipping",
      );

      // Assert the mechanism, not just the outcome: the epoch is what did it.
      assert.notEqual(
        user.tokensValidFrom,
        null,
        "the reset must stamp the revocation epoch on the user",
      );
    } finally {
      await h.close();
    }
  });
});

describe("BUG-234 — a signed-in password change evicts other sessions", () => {
  it("PATCH /me/password invalidates a session JWT minted before it", async () => {
    // A real bcrypt hash is needed here: PATCH /me/password compares the
    // supplied current password before it will write anything, so a fake hash
    // would make this test pass on a 400 and prove nothing.
    const { hashPassword } = await import("../../lib/auth");
    const hash = await hashPassword(CURRENT_PASSWORD);
    const { user, prisma } = makeState(hash);
    const h = await spinUp(
      (p) => createMeRouter({ prisma: p as never, sendEmail: silentSender }),
      prisma,
      (p) => createAuthRouter({ prisma: p as never, sendEmail: silentSender }),
    );
    try {
      const oldSession = sessionTokenIssuedAgo(600);
      // GET /auth/me is the probe in both tests: one well-modelled
      // authenticated route, so a stub gap can never be mistaken for a
      // revocation. Both routers are mounted on the same app for that reason.
      const probe = () =>
        fetch(`${h.baseUrl}/auth/me`, {
          headers: { authorization: `Bearer ${oldSession}` },
        });

      // A real 200, not merely "not 401" — a 500 from an incomplete stub would
      // satisfy the weaker form and this step is the non-vacuity proof.
      const before = await probe();
      assert.equal(
        before.status,
        200,
        "the session must authenticate before the password change",
      );

      // This is the path Hans actually exercised on device.
      const changed = await fetch(`${h.baseUrl}/me/password`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${oldSession}`,
        },
        body: JSON.stringify({
          currentPassword: CURRENT_PASSWORD,
          newPassword: "aDifferentPassword123",
        }),
      });
      assert.equal(changed.status, 200, "the password change must succeed");

      const after = await probe();
      assert.equal(
        after.status,
        401,
        "a session predating the password change must be evicted",
      );
      assert.notEqual(
        user.tokensValidFrom,
        null,
        "the change must stamp the revocation epoch on the user",
      );
    } finally {
      await h.close();
    }
  });
});

describe("BUG-234 — the epoch comparison itself", () => {
  it("a null epoch revokes nothing (every row today, identical to c38a596)", () => {
    const iat = Math.floor(Date.now() / 1000);
    assert.equal(isIssuedBeforeEpoch(iat, null), false);
    assert.equal(isIssuedBeforeEpoch(iat, undefined), false);
  });

  it("a token issued before the epoch is revoked, one issued after is not", () => {
    const epoch = new Date("2026-09-08T12:00:00.000Z");
    const epochSec = epoch.getTime() / 1000;
    assert.equal(isIssuedBeforeEpoch(epochSec - 1, epoch), true, "one second earlier: revoked");
    assert.equal(isIssuedBeforeEpoch(epochSec + 1, epoch), false, "one second later: kept");
  });

  it("fails CLOSED on a same-second mint and on a missing iat", () => {
    // A millisecond into the epoch's second, a token stamped with that whole
    // second reads as issued at the top of it — before the bump. Refusing is
    // the deliberate choice: the alternative leaves a sub-second window in
    // which a pre-reset token still authenticates.
    const epoch = new Date("2026-09-08T12:00:00.500Z");
    assert.equal(
      isIssuedBeforeEpoch(Math.floor(epoch.getTime() / 1000), epoch),
      true,
      "same-second token is refused, not admitted",
    );
    assert.equal(
      isIssuedBeforeEpoch(undefined, new Date()),
      true,
      "a token we cannot place in time resolves against the token",
    );
  });
});

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
    // 12:00:37, NOT a minute boundary. A boundary constant makes flooring to
    // the second and flooring to the minute agree, so a guard built on one
    // cannot detect a fix that floors too far — see the epoch below.
    const epoch = new Date("2026-09-08T12:00:37.000Z");
    const epochSec = epoch.getTime() / 1000;
    assert.equal(isIssuedBeforeEpoch(epochSec - 1, epoch), true, "one second earlier: revoked");
    assert.equal(isIssuedBeforeEpoch(epochSec + 1, epoch), false, "one second later: kept");
  });

  it("still fails closed on a token that cannot be placed in time", () => {
    assert.equal(
      isIssuedBeforeEpoch(undefined, new Date()),
      true,
      "a token we cannot place in time resolves against the token",
    );
  });
});

// ── The same-second granularity defect, found by device acceptance ──────────
//
// The first cut of isIssuedBeforeEpoch compared `iat * 1000` against the raw
// TIMESTAMP(3) epoch, so a token minted in the same second as a bump floored
// below it and was refused. Measured on device at machine speed:
//
//   login -> PATCH /me/password 200 -> old token correctly 401
//         -> re-login IN THE SAME SECOND yields a valid 279-char token
//         -> that token is ALSO 401
//         -> the same login 5 s later returns 200   <- rules out a units bug
//
// Both directions are guarded below, because a fix in either direction alone is
// a different defect: floor too little and legitimate logins break, floor too
// much and a genuinely stale token walks in.
describe("BUG-234 — the epoch comparison is second-granular in BOTH directions", () => {
  // 37 seconds past the minute, deliberately. An epoch on a minute boundary
  // floors identically to the second and to the minute, which would let a
  // too-wide floor pass both guards below; this constant separates them.
  const epoch = new Date("2026-09-08T12:00:37.500Z");
  const epochSecond = Math.floor(epoch.getTime() / 1000);

  it("ACCEPTS a token minted in the SAME second as the bump (the device defect)", () => {
    assert.equal(
      isIssuedBeforeEpoch(epochSecond, epoch),
      false,
      "a token stamped with the bump's own second must authenticate; " +
        "true here is the re-login 401 Hans measured on device",
    );
  });

  it("REJECTS a token minted STRICTLY before the bump's second", () => {
    assert.equal(
      isIssuedBeforeEpoch(epochSecond - 1, epoch),
      true,
      "one second earlier is genuinely stale and must still be evicted; " +
        "false here means the floor was widened past the defect it fixes",
    );
  });

  it("end to end: a session minted in the bump's own second still authenticates", async () => {
    // The device sequence, reproduced through the live routes. The re-login is
    // not simulated with a hand-picked constant: the token is stamped with the
    // second read back off the epoch the password change actually wrote, which
    // is exactly what a login microseconds later would carry.
    const { hashPassword } = await import("../../lib/auth");
    const hash = await hashPassword(CURRENT_PASSWORD);
    const { user, prisma } = makeState(hash);
    const h = await spinUp(
      (p) => createMeRouter({ prisma: p as never, sendEmail: silentSender }),
      prisma,
      (p) => createAuthRouter({ prisma: p as never, sendEmail: silentSender }),
    );
    try {
      const changed = await fetch(`${h.baseUrl}/me/password`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${sessionTokenIssuedAgo(600)}`,
        },
        body: JSON.stringify({
          currentPassword: CURRENT_PASSWORD,
          newPassword: "aDifferentPassword123",
        }),
      });
      assert.equal(changed.status, 200, "the password change must succeed");

      const bumpedAt = user.tokensValidFrom;
      assert.ok(bumpedAt, "the change must have stamped an epoch to test against");

      // Non-vacuity: the epoch must carry sub-second precision, or this test
      // is asserting against a value that was never the hard case. TIMESTAMP(3)
      // in production; a JS Date here. A whole-second stamp would make the
      // same-second comparison trivially safe and prove nothing.
      const ms = bumpedAt.getTime() % 1000;

      // A login landing in the SAME second the epoch was stamped.
      const reLogin = jwt.sign(
        {
          userId: USER_ID,
          purpose: "session",
          iat: Math.floor(bumpedAt.getTime() / 1000),
          exp: Math.floor(bumpedAt.getTime() / 1000) + 30 * 24 * 3600,
          jti: `relogin-${Math.random()}`,
        },
        JWT_SECRET!,
      );

      const res = await fetch(`${h.baseUrl}/auth/me`, {
        headers: { authorization: `Bearer ${reLogin}` },
      });
      assert.equal(
        res.status,
        200,
        `a re-login in the bump's own second must authenticate (epoch ms=${ms}); ` +
          "401 here is the defect device acceptance caught",
      );
    } finally {
      await h.close();
    }
  });
});

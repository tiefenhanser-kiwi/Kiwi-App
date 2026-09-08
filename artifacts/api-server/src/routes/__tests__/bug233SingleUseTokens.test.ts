// BUG-233 — purpose tokens must work exactly ONCE.
//
// The finding was measured, not theorised: an op-counting probe presented one
// email-change token three times and got 200, 200, 200. signToken embedded
// {userId, purpose}, verifyToken checked signature + expiry + purpose, and
// nothing anywhere marked a token spent — "spent" was not a state the system
// could represent. The password-reset token was replayable by the identical
// mechanism, which is the one that matters: anyone who saw a reset link once
// could re-take the account repeatedly for the next hour.
//
// Every assertion below drives the LIVE route and reads the LIVE response
// status. Nothing here restates an expected value against itself: the second
// presentation of a token is a real second HTTP request whose status is
// compared to a literal, and if the ledger write is removed that status is 200
// and the test fails. The ledger stub enforces jti uniqueness for real (see
// fixtures/sessionUserStub.ts) so it can refuse — a permissive fake would let
// a replay through and turn all of this green while the defect shipped.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

import { signToken } from "../../lib/auth";
import { sweepExpiredUsedTokens } from "../../lib/tokenRevocation";
import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import type { EmailSender } from "../../lib/email/sendEmail";
import { createAuthRouter } from "../auth";
import { createMeRouter } from "../me";
import { makeUsedTokenLedger } from "./fixtures/sessionUserStub";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET required for tests");

const USER_ID = "bug233-user";

// No test may reach a mail provider. Injected, never the production sender.
const silentSender: EmailSender = async () => ({ sent: false, reason: "no_api_key" });

interface UserRow {
  id: string;
  email: string;
  accountStatus: string;
  passwordHash: string | null;
  tokensValidFrom: Date | null;
}

function makeState(overrides: Partial<UserRow> = {}) {
  const user: UserRow = {
    id: USER_ID,
    email: "bug233@example.test",
    accountStatus: "active",
    passwordHash: "$2a$10$notarealhashnotarealhashnotarealhashnotarealhash",
    tokensValidFrom: null,
    ...overrides,
  };
  const ledger = makeUsedTokenLedger();
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
    usedToken: ledger,
  };
  return { user, ledger, prisma };
}

async function spinUp(mount: (prisma: unknown) => unknown, prisma: unknown) {
  const app: Express = express();
  app.use(express.json());
  app.use(mount(prisma) as never);
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * A purpose token with an explicitly-placed `iat`, so the epoch comparisons in
 * these tests are deterministic rather than racing the wall clock. A JWT `iat`
 * has one-second resolution; minting "now" and bumping "now" in the same second
 * is exactly the ambiguous case, so tests place tokens in the past on purpose.
 */
function purposeTokenIssuedAgo(
  secondsAgo: number,
  purpose: "password_reset" | "email_change",
  extra: Record<string, unknown> = {},
): string {
  const iat = Math.floor(Date.now() / 1000) - secondsAgo;
  return jwt.sign(
    {
      userId: USER_ID,
      purpose,
      ...extra,
      iat,
      exp: iat + 3600,
      jti: `jti-${purpose}-${secondsAgo}-${Math.random()}`,
    },
    JWT_SECRET!,
  );
}

beforeEach(() => __clearRateLimitStoreForTests());

describe("BUG-233 — a password-reset token is single-use", () => {
  it("the SAME reset token is accepted once and refused on replay", async () => {
    const { prisma, ledger } = makeState();
    const h = await spinUp(
      (p) => createAuthRouter({ prisma: p as never, sendEmail: silentSender }),
      prisma,
    );
    try {
      const token = signToken(USER_ID, { purpose: "password_reset", expiresIn: "1h" });
      const send = (newPassword: string) =>
        fetch(`${h.baseUrl}/auth/password-reset/confirm`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, newPassword }),
        });

      const first = await send("firstPassword123");
      assert.equal(first.status, 200, "the first redemption must succeed");

      // THE REGRESSION. Before this fix the same token returned 200 again.
      const second = await send("secondPassword123");
      assert.equal(
        second.status,
        400,
        "a replayed reset token must be refused; 200 here is BUG-233 shipping",
      );

      // The ledger is the mechanism, so assert it actually recorded the spend
      // rather than trusting that a 400 came from the right place.
      assert.equal(ledger._rows().length, 1, "exactly one ledger row per token");
      assert.equal(ledger._rows()[0].purpose, "password_reset");
    } finally {
      await h.close();
    }
  });

  it("a completed reset also kills every OTHER outstanding reset token", async () => {
    const { prisma } = makeState();
    const h = await spinUp(
      (p) => createAuthRouter({ prisma: p as never, sendEmail: silentSender }),
      prisma,
    );
    try {
      // Two links outstanding at once — the user clicked "forgot password"
      // twice, or an attacker requested one of them.
      const older = purposeTokenIssuedAgo(120, "password_reset");
      const newer = purposeTokenIssuedAgo(60, "password_reset");

      const completed = await fetch(`${h.baseUrl}/auth/password-reset/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: newer, newPassword: "chosenPassword123" }),
      });
      assert.equal(completed.status, 200, "the presented reset must complete");

      // `older` has a DIFFERENT jti, so the ledger cannot refuse it. Only the
      // epoch bumped by the completed reset can, which is the whole point of
      // this case: it is not covered by single-use.
      const stale = await fetch(`${h.baseUrl}/auth/password-reset/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: older, newPassword: "attackerPassword123" }),
      });
      assert.equal(
        stale.status,
        400,
        "an older outstanding reset link must die with the completed reset",
      );
    } finally {
      await h.close();
    }
  });

  it("two SIMULTANEOUS redemptions of one reset token: exactly one wins", async () => {
    // This case isolates the ledger, and nothing else can satisfy it.
    //
    // Sequential replay of a reset token is ALSO caught by the revocation
    // epoch, because completing the first reset stamps `tokensValidFrom` past
    // the token's `iat`. Concurrency is where that stops being true: both
    // requests read the epoch before either writes it, both see NULL, and both
    // are entitled to proceed. Only the atomic insert on the UsedToken primary
    // key can break the tie — which is why the ledger is not redundant here
    // even though the epoch covers the sequential case.
    const { prisma, ledger } = makeState();
    const h = await spinUp(
      (p) => createAuthRouter({ prisma: p as never, sendEmail: silentSender }),
      prisma,
    );
    try {
      const token = signToken(USER_ID, { purpose: "password_reset", expiresIn: "1h" });
      const fire = (newPassword: string) =>
        fetch(`${h.baseUrl}/auth/password-reset/confirm`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, newPassword }),
        });

      const [a, b] = await Promise.all([fire("racerOnePassword123"), fire("racerTwoPassword123")]);
      const statuses = [a.status, b.status].sort();

      assert.deepEqual(
        statuses,
        [200, 400],
        `exactly one concurrent redemption may win; got ${JSON.stringify(statuses)}`,
      );
      assert.equal(ledger._rows().length, 1, "one spend recorded, not two");
    } finally {
      await h.close();
    }
  });

  it("a reset token with no jti is refused outright (pre-fix tokens are unredeemable)", async () => {
    const { prisma } = makeState();
    const h = await spinUp(
      (p) => createAuthRouter({ prisma: p as never, sendEmail: silentSender }),
      prisma,
    );
    try {
      const iat = Math.floor(Date.now() / 1000) - 60;
      // Exactly the shape signToken produced at c38a596: no jti claim at all.
      const legacy = jwt.sign(
        { userId: USER_ID, purpose: "password_reset", iat, exp: iat + 3600 },
        JWT_SECRET!,
      );
      const res = await fetch(`${h.baseUrl}/auth/password-reset/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: legacy, newPassword: "somePassword123" }),
      });
      assert.equal(
        res.status,
        400,
        "a token that cannot be ledgered cannot be proven unused, so it must be refused",
      );
    } finally {
      await h.close();
    }
  });
});

describe("BUG-233 — an email-change token is single-use (the measured 200/200/200)", () => {
  it("the SAME email-change token returns 200 once, then 400, then 400", async () => {
    const { prisma, user, ledger } = makeState();
    const h = await spinUp(
      (p) => createMeRouter({ prisma: p as never, sendEmail: silentSender }),
      prisma,
    );
    try {
      const newEmail = "moved@example.test";
      const token = signToken(USER_ID, {
        purpose: "email_change",
        expiresIn: "1h",
        extra: { newEmail },
      });
      const present = () =>
        fetch(`${h.baseUrl}/me/email/verify-change`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });

      const statuses = [
        (await present()).status,
        (await present()).status,
        (await present()).status,
      ];

      // The probe recorded [200, 200, 200]. This is that exact sequence.
      assert.deepEqual(
        statuses,
        [200, 400, 400],
        `replaying one email-change token must succeed once; got ${JSON.stringify(statuses)}`,
      );
      assert.equal(user.email, newEmail, "the first redemption must have applied");
      assert.equal(ledger._rows().length, 1, "one spend recorded, not three");
    } finally {
      await h.close();
    }
  });
});

describe("BUG-233 — the ledger sweep", () => {
  it("deletes rows whose JWT has expired and keeps the rest", async () => {
    const ledger = makeUsedTokenLedger();
    const now = new Date("2026-09-08T12:00:00.000Z");
    await ledger.create({
      data: {
        jti: "dead",
        userId: USER_ID,
        purpose: "password_reset",
        expiresAt: new Date(now.getTime() - 1),
      },
    });
    await ledger.create({
      data: {
        jti: "alive",
        userId: USER_ID,
        purpose: "email_change",
        expiresAt: new Date(now.getTime() + 60_000),
      },
    });

    const removed = await sweepExpiredUsedTokens({ usedToken: ledger } as never, now);

    assert.equal(removed, 1, "exactly the expired row is swept");
    assert.deepEqual(
      ledger._rows().map((r) => r.jti),
      ["alive"],
      "a live token's ledger row must survive the sweep",
    );
  });

  it("the ledger refuses a duplicate jti (the constraint the fix rests on)", async () => {
    const ledger = makeUsedTokenLedger();
    const data = {
      jti: "dupe",
      userId: USER_ID,
      purpose: "password_reset",
      expiresAt: new Date(Date.now() + 60_000),
    };
    await ledger.create({ data });
    await assert.rejects(
      () => ledger.create({ data }),
      (err: { code?: string }) => err.code === "P2002",
      "the stub must model the unique-constraint violation, or every single-use test above is vacuous",
    );
  });
});

// SERVER-9 B (BUG-603, P1 security) — common and breached passwords are refused
// wherever a NEW password is set: sign-up, password reset, password change.
// Existing accounts are never forced to change: login with a listed password
// still works.
//
// Every route assertion drives the live route over HTTP with a stub Prisma.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";
import bcrypt from "bcryptjs";

import { signToken } from "../../lib/auth";
import {
  PASSWORD_TOO_COMMON,
  PASSWORD_TOO_COMMON_MESSAGE,
  isCommonPassword,
} from "../../lib/commonPasswords";
import { SECLISTS_COMMON_10K } from "../../lib/commonPasswordsList";
import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import type { EmailSender } from "../../lib/email/sendEmail";
import { createAuthRouter } from "../auth";
import { createMeRouter } from "../me";
import { makeUsedTokenLedger, withSessionUser } from "./fixtures/sessionUserStub";

const PHRASE = "maple otter lantern drizzle";
const silentSender: EmailSender = async () => ({ sent: false, reason: "no_api_key" });

beforeEach(() => __clearRateLimitStoreForTests());

async function serve(router: unknown) {
  const app: Express = express();
  app.use(express.json());
  app.use(router as never);
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}, method = "POST") =>
  fetch(url, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("SERVER-9 B — isCommonPassword", () => {
  it("the bundled list is SecLists' 10k file, verbatim", () => {
    assert.equal(SECLISTS_COMMON_10K.length, 10001);
    assert.equal(SECLISTS_COMMON_10K[0], "password");
  });

  for (const pw of ["password", "Password1", "123456789", "letmein", "  Password1  ", "PASSWORD", "QWERTY123"]) {
    it(`refuses ${JSON.stringify(pw)} (trimmed, any case)`, () => assert.equal(isCommonPassword(pw), true));
  }

  it('refuses "kiwi" and "kitchenwizard" in any case', () => {
    assert.equal(isCommonPassword("Kiwi"), true);
    assert.equal(isCommonPassword(" KitchenWizard "), true);
  });

  it("refuses the account's own email local part, with or without its +tag", () => {
    assert.equal(isCommonPassword("Jane.Doe.Cooks", "jane.doe.cooks@example.com"), true);
    assert.equal(isCommonPassword("jane.doe.cooks+kiwi", "jane.doe.cooks+kiwi@example.com"), true);
    assert.equal(isCommonPassword("jane.doe.cooks", "jane.doe.cooks+kiwi@example.com"), true);
    assert.equal(isCommonPassword("jane.doe.cooks", "someone.else@example.com"), false);
    assert.equal(isCommonPassword("example.com", "jane@example.com"), false, "the domain is not the local part");
  });

  it("accepts a four-word phrase, and a listed word inside a longer phrase", () => {
    assert.equal(isCommonPassword(PHRASE), false);
    assert.equal(isCommonPassword("correct horse battery staple"), false);
    assert.equal(isCommonPassword("password lantern otter maple"), false);
  });
});

describe("SERVER-9 B — POST /auth/signup", () => {
  function signupPrisma() {
    const calls = { reads: 0, creates: 0 };
    const prisma = {
      user: {
        findFirst: async () => null,
        findUnique: async () => {
          calls.reads++;
          return null;
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          calls.creates++;
          return {
            id: "u-s9",
            email: data["email"],
            firstName: data["firstName"],
            lastName: data["lastName"],
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
            howHeard: null,
            howHeardDetail: null,
            personalizeNudgeDismissedAt: null,
            createdAt: new Date(),
          };
        },
      },
      subscription: {
        create: async () => ({ status: "trialing", planCode: "free", trialEndsAt: new Date(), currentPeriodEnd: null }),
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    };
    return { prisma, calls };
  }

  const signup = async (password: string, email = "new.cook@example.com") => {
    const { prisma, calls } = signupPrisma();
    const h = await serve(
      createAuthRouter({ prisma: prisma as never, signupAlert: async () => {}, welcomeEmail: async () => {} }),
    );
    try {
      __clearRateLimitStoreForTests();
      const res = await post(`${h.base}/auth/signup`, { email, password, firstName: "N", lastName: "C" });
      return { status: res.status, body: (await res.json()) as Record<string, unknown>, calls };
    } finally {
      await h.close();
    }
  };

  for (const pw of ["password", "Password1", "123456789"]) {
    it(`${JSON.stringify(pw)} → 400 password_too_common, before any read or write`, async () => {
      const r = await signup(pw);
      assert.equal(r.status, 400);
      assert.equal(r.body["error"], PASSWORD_TOO_COMMON);
      assert.equal(r.body["userFacingMessage"], "That password is too common. Try a longer phrase only you would use.");
      assert.equal(r.calls.reads + r.calls.creates, 0, "refused before the email lookup");
    });
  }

  it('"letmein" (7 characters) is refused by the length rule, which is unchanged and runs first', async () => {
    const r = await signup("letmein");
    assert.equal(r.status, 400);
    assert.equal(r.body["error"], "invalid request body");
    assert.equal(isCommonPassword("letmein"), true);
  });

  it('"  letmein  " (padded past the length rule) is refused as too common', async () => {
    const r = await signup("  letmein  ");
    assert.equal(r.status, 400);
    assert.equal(r.body["error"], PASSWORD_TOO_COMMON);
  });

  it("the email's own local part is refused; kitchenwizard is refused", async () => {
    assert.equal((await signup("New.Cook.Home", "new.cook.home@example.com")).body["error"], PASSWORD_TOO_COMMON);
    assert.equal((await signup("KitchenWizard")).body["error"], PASSWORD_TOO_COMMON);
  });

  it("a four-word phrase signs up", async () => {
    const r = await signup(PHRASE);
    assert.equal(r.status, 201);
    assert.equal(r.calls.creates, 1);
  });
});

describe("SERVER-9 B — POST /auth/password-reset/confirm", () => {
  it("a common password is refused and the link stays unspent; a phrase then succeeds with the same link", async () => {
    const user = { id: "u-reset", email: "reset.person@example.com", accountStatus: "active", passwordHash: "x", tokensValidFrom: null as Date | null };
    const ledger = makeUsedTokenLedger();
    const prisma = {
      user: {
        findUnique: async () => ({ ...user }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(user, data);
          return { ...user };
        },
      },
      usedToken: ledger,
    };
    const h = await serve(createAuthRouter({ prisma: prisma as never, sendEmail: silentSender }));
    try {
      const token = signToken(user.id, { purpose: "password_reset", expiresIn: "1h" });
      for (const pw of ["password", "Password1", "123456789", "reset.person"]) {
        const res = await post(`${h.base}/auth/password-reset/confirm`, { token, newPassword: pw });
        assert.equal(res.status, 400, pw);
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(body["error"], PASSWORD_TOO_COMMON, pw);
        assert.equal(body["userFacingMessage"], PASSWORD_TOO_COMMON_MESSAGE);
        assert.equal(user.passwordHash, "x", "nothing written");
      }
      const ok = await post(`${h.base}/auth/password-reset/confirm`, { token, newPassword: PHRASE });
      assert.equal(ok.status, 200, "the link was not spent by the refusals");
      assert.equal(await bcrypt.compare(PHRASE, user.passwordHash), true);
    } finally {
      await h.close();
    }
  });

  it("a bad link with a common password still says the link is bad (no oracle)", async () => {
    const prisma = { user: { findUnique: async () => null }, usedToken: makeUsedTokenLedger() };
    const h = await serve(createAuthRouter({ prisma: prisma as never, sendEmail: silentSender }));
    try {
      const res = await post(`${h.base}/auth/password-reset/confirm`, { token: "not-a-real-token-at-all", newPassword: "password" });
      assert.equal(res.status, 400);
      assert.equal(((await res.json()) as Record<string, unknown>)["error"], "invalid or expired reset token");
    } finally {
      await h.close();
    }
  });
});

describe("SERVER-9 B — PATCH /me/password", () => {
  async function change(currentPassword: string, newPassword: string) {
    const row = { id: "u-change", email: "change.me@example.com", passwordHash: await bcrypt.hash("current-secret-77", 4) };
    const prisma = {
      user: {
        findUnique: async () => ({ ...row }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(row, data);
          return { ...row };
        },
      },
    };
    const h = await serve(createMeRouter({ prisma: withSessionUser(prisma) as never }));
    try {
      const res = await post(
        `${h.base}/me/password`,
        { currentPassword, newPassword },
        { Authorization: `Bearer ${signToken(row.id)}` },
        "PATCH",
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown>, row };
    } finally {
      await h.close();
    }
  }

  for (const pw of ["password", "Password1", "123456789", "change.me"]) {
    it(`${JSON.stringify(pw)} → 400 password_too_common, the hash unchanged`, async () => {
      const r = await change("current-secret-77", pw);
      assert.equal(r.status, 400);
      assert.equal(r.body["error"], PASSWORD_TOO_COMMON);
      assert.equal(await bcrypt.compare("current-secret-77", r.row.passwordHash), true);
    });
  }

  it("a wrong current password is answered first", async () => {
    const r = await change("wrong-current-1", "password");
    assert.equal(r.body["error"], "invalid_current_password");
  });

  it("a four-word phrase is accepted", async () => {
    const r = await change("current-secret-77", PHRASE);
    assert.equal(r.status, 200);
    assert.equal(await bcrypt.compare(PHRASE, r.row.passwordHash), true);
  });
});

describe("SERVER-9 B — existing accounts are never forced to change", () => {
  it("login with a password now on the list still signs in", async () => {
    const user = {
      id: "u-old",
      email: "old.account@example.com",
      passwordHash: await bcrypt.hash("password1", 4),
      firstName: "O",
      lastName: "A",
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
      signupSource: null,
      howHeard: null,
      howHeardDetail: null,
      personalizeNudgeDismissedAt: null,
      tokensValidFrom: null,
      createdAt: new Date(),
      subscription: null,
    };
    const prisma = {
      user: {
        findUnique: async () => ({ ...user }),
        update: async () => ({}),
        updateMany: async () => ({ count: 1 }),
      },
    };
    const h = await serve(createAuthRouter({ prisma: prisma as never }));
    try {
      const res = await post(`${h.base}/auth/login`, { email: user.email, password: "password1" });
      assert.equal(res.status, 200);
      assert.ok(((await res.json()) as { authToken?: string }).authToken);
    } finally {
      await h.close();
    }
  });
});

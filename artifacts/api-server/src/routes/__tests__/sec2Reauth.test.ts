// SEC-2 #6 — a stolen session cannot become a permanent takeover.
//
//   · POST /me/email/request-change needs the current password, or for an
//     OAuth-only account a sign-in within the last 10 minutes (`auth_time`).
//   · A verified email change notifies the OLD address.
//   · POST /auth/logout revokes every session of that account.
//   · A token minted before SEC-2 (no `auth_time`) keeps working elsewhere.
//
// DELETE /me's half of the rule is in me-delete-account.test.ts, beside the
// harness that models its tables.

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

import { hashPassword, signToken } from "../../lib/auth";
import type { EmailMessage } from "../../lib/email/sendEmail";
import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import { createAuthRouter } from "../auth";
import { createMeRouter } from "../me";
import { makeUsedTokenLedger } from "./fixtures/sessionUserStub";

const SECRET = process.env["JWT_SECRET"]!;
const PW_USER = "sec2-pw-user";
const OAUTH_USER = "sec2-oauth-user";
const RIGHT = "the-right-password";

interface UserRow {
  id: string;
  email: string;
  passwordHash: string | null;
  tokensValidFrom: Date | null;
  [k: string]: unknown;
}

function makePrisma(users: UserRow[]) {
  return {
    user: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) =>
        users.find((u) => (where.id ? u.id === where.id : u.email === where.email)) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
        const u = users.find((r) => r.id === where.id)!;
        Object.assign(u, data);
        return u;
      },
    },
    usedToken: makeUsedTokenLedger(),
  };
}

async function spinUp(prisma: unknown, sent: EmailMessage[]) {
  const sendEmail = async (m: EmailMessage) => {
    sent.push(m);
    return { sent: true as const, id: "x" };
  };
  const app: Express = express();
  app.use(express.json());
  app.use(createMeRouter({ prisma: prisma as never, sendEmail: sendEmail as never }));
  app.use(createAuthRouter({ prisma: prisma as never, sendEmail: sendEmail as never }));
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    call: (method: string, path: string, token: string | null, body?: unknown) =>
      fetch(`${base}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A session token signed `ageSeconds` ago, with or without auth_time. */
function sessionToken(userId: string, ageSeconds: number, withAuthTime: boolean): string {
  const iat = Math.floor(Date.now() / 1000) - ageSeconds;
  return jwt.sign(
    { userId, purpose: "session", iat, ...(withAuthTime ? { auth_time: iat } : {}) },
    SECRET,
    { expiresIn: "30d" },
  );
}

let pwHash = "";
before(async () => {
  pwHash = await hashPassword(RIGHT);
});
beforeEach(() => __clearRateLimitStoreForTests());

function users(): UserRow[] {
  return [
    { id: PW_USER, email: "pw@example.com", passwordHash: pwHash, tokensValidFrom: null, accountStatus: "active", createdAt: new Date() },
    { id: OAUTH_USER, email: "oauth@example.com", passwordHash: null, tokensValidFrom: null, accountStatus: "active", createdAt: new Date() },
  ];
}

describe("SEC-2 #6 — POST /me/email/request-change needs recent proof of ownership", () => {
  const cases: Array<[string, string, () => string, Record<string, unknown>, number, string | null]> = [
    ["password account, no password", PW_USER, () => signToken(PW_USER), {}, 403, "reauth_required"],
    ["password account, wrong password", PW_USER, () => signToken(PW_USER), { currentPassword: "nope" }, 403, "password_incorrect"],
    ["password account, right password", PW_USER, () => signToken(PW_USER), { currentPassword: RIGHT }, 200, null],
    ["OAuth-only, fresh sign-in", OAUTH_USER, () => signToken(OAUTH_USER), {}, 200, null],
    ["OAuth-only, signed in 11 minutes ago", OAUTH_USER, () => sessionToken(OAUTH_USER, 11 * 60, true), {}, 403, "reauth_required"],
    ["OAuth-only, a pre-SEC-2 token (no auth_time)", OAUTH_USER, () => sessionToken(OAUTH_USER, 5, false), {}, 403, "reauth_required"],
  ];
  for (const [label, userId, token, extra, status, code] of cases) {
    it(`${label} → ${status}${code ? ` ${code}` : ""}`, async () => {
      const sent: EmailMessage[] = [];
      const api = await spinUp(makePrisma(users()), sent);
      try {
        const res = await api.call("POST", "/me/email/request-change", token(), { newEmail: "thief@example.com", ...extra });
        assert.equal(res.status, status);
        const body = (await res.json()) as { code?: string; method?: string };
        if (code) {
          assert.equal(body.code, code);
          assert.equal(sent.length, 0, "no verification mail goes out");
          if (code === "reauth_required") assert.equal(body.method, userId === PW_USER ? "password" : "sign_in");
        } else {
          assert.deepEqual(sent.map((m) => m.to), ["thief@example.com"]);
        }
      } finally {
        await api.close();
      }
    });
  }
});

describe("SEC-2 #6 — a verified change notifies the OLD address", () => {
  it("the old inbox gets a notice naming a masked new address", async () => {
    const sent: EmailMessage[] = [];
    const prisma = makePrisma(users());
    const api = await spinUp(prisma, sent);
    try {
      const link = signToken(PW_USER, { purpose: "email_change", expiresIn: "1h", extra: { newEmail: "brand.new@example.com" } });
      const res = await api.call("POST", "/me/email/verify-change", null, { token: link });
      assert.equal(res.status, 200);
      await new Promise((r) => setTimeout(r, 20)); // the notice is not awaited by the route
      assert.deepEqual(sent.map((m) => m.to), ["pw@example.com"]);
      assert.match(sent[0]!.text, /b[*]+w@example\.com/);
      assert.doesNotMatch(sent[0]!.text, /brand\.new@/);
    } finally {
      await api.close();
    }
  });
});

describe("THX-3d 3b (A2) — an older change link cannot undo a newer change", () => {
  it("two links requested from the same address: the first redeemed moves the account, the second is then stale", async () => {
    const sent: EmailMessage[] = [];
    const rows = users();
    const api = await spinUp(makePrisma(rows), sent);
    try {
      // Both requested with the password, from pw@example.com (the route binds fromEmail).
      for (const newEmail of ["back@example.com", "new@example.com"]) {
        const r = await api.call("POST", "/me/email/request-change", signToken(PW_USER), { newEmail, currentPassword: RIGHT });
        assert.equal(r.status, 200);
      }
      const links = sent.map((m) => /token=([^\s"&]+)/.exec(m.text)?.[1]).filter((t): t is string => !!t).map(decodeURIComponent);
      assert.equal(links.length, 2);
      const second = await api.call("POST", "/me/email/verify-change", null, { token: links[1] });
      assert.equal(second.status, 200);
      assert.equal(rows[0]!.email, "new@example.com");
      const first = await api.call("POST", "/me/email/verify-change", null, { token: links[0] });
      assert.equal(first.status, 400, "the older link was for pw@example.com, which the account no longer has");
      assert.equal(rows[0]!.email, "new@example.com");
    } finally {
      await api.close();
    }
  });
});

describe("SEC-2 #6 — POST /auth/logout ends every session", () => {
  it("both devices' sessions die; a fresh sign-in afterwards works", async () => {
    const sent: EmailMessage[] = [];
    const rows = users();
    const api = await spinUp(makePrisma(rows), sent);
    try {
      const phone = sessionToken(PW_USER, 120, true);
      const laptop = sessionToken(PW_USER, 60, true);
      assert.equal((await api.call("GET", "/auth/me", laptop)).status, 200);
      const out = await api.call("POST", "/auth/logout", phone);
      assert.equal(out.status, 200);
      assert.ok(rows[0]!.tokensValidFrom instanceof Date);
      assert.equal((await api.call("GET", "/auth/me", phone)).status, 401);
      assert.equal((await api.call("GET", "/auth/me", laptop)).status, 401, "the OTHER device is out too");
      const login = await api.call("POST", "/auth/login", null, { email: "pw@example.com", password: RIGHT });
      assert.equal(login.status, 200);
      const fresh = ((await login.json()) as { authToken: string }).authToken;
      assert.equal((await api.call("GET", "/auth/me", fresh)).status, 200);
    } finally {
      await api.close();
    }
  });

  it("no token, or a token already revoked, changes nothing", async () => {
    const sent: EmailMessage[] = [];
    const rows = users();
    const revokedAt = new Date();
    rows[0]!.tokensValidFrom = revokedAt;
    const api = await spinUp(makePrisma(rows), sent);
    try {
      assert.equal((await api.call("POST", "/auth/logout", null)).status, 200);
      const stale = sessionToken(PW_USER, 600, true);
      assert.equal((await api.call("POST", "/auth/logout", stale)).status, 200);
      assert.equal(rows[0]!.tokensValidFrom, revokedAt, "a revoked token cannot keep re-bumping the epoch");
    } finally {
      await api.close();
    }
  });

  it("a pre-SEC-2 token (no auth_time) still works on ordinary routes", async () => {
    const api = await spinUp(makePrisma(users()), []);
    try {
      assert.equal((await api.call("GET", "/auth/me", sessionToken(PW_USER, 3600, false))).status, 200);
    } finally {
      await api.close();
    }
  });
});

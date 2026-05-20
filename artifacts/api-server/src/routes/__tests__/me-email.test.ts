// WS7-2 Block A — POST /me/email/request-change + /me/email/verify-change.
// 6 tests: request happy / always-200 on registered-elsewhere + verify happy /
// expired token 400 / wrong-purpose 400 / email-taken-race 400.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

import { signToken } from "../../lib/auth";
import { createMeRouter } from "../me";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("JWT_SECRET required for tests");

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

interface UserRow {
  id: string;
  email: string;
}

async function spinUp(prisma: unknown): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use(createMeRouter({ prisma: prisma as never }));
  return await new Promise<Harness>((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("server did not bind"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r, j) =>
            server.close((err) => (err ? j(err) : r())),
          ),
      });
    });
  });
}

function makeStubPrisma(initial: UserRow[]) {
  let rows = [...initial];
  return {
    user: {
      findUnique: async ({
        where,
      }: {
        where: { id?: string; email?: string };
        select?: unknown;
      }): Promise<UserRow | null> => {
        if (where.id) return rows.find((r) => r.id === where.id) ?? null;
        if (where.email) return rows.find((r) => r.email === where.email) ?? null;
        return null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<UserRow>;
      }): Promise<UserRow> => {
        const idx = rows.findIndex((r) => r.id === where.id);
        if (idx === -1) throw new Error("user not found");
        rows[idx] = { ...rows[idx], ...data };
        return rows[idx];
      },
    },
    _rows: () => rows,
  };
}

const USER_ID = "u-email";

describe("POST /me/email/request-change", () => {
  it("happy: returns 200 + logs verification token when email is available", async () => {
    const prisma = makeStubPrisma([{ id: USER_ID, email: "old@example.com" }]);
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/email/request-change`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ newEmail: "new@example.com" }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { success: boolean };
      assert.equal(body.success, true);
    } finally {
      await harness.close();
    }
  });

  it("returns 200 (no enumeration leak) when the new email is registered to someone else", async () => {
    const prisma = makeStubPrisma([
      { id: USER_ID, email: "me@example.com" },
      { id: "u-other", email: "taken@example.com" },
    ]);
    const harness = await spinUp(prisma);
    try {
      const token = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/email/request-change`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ newEmail: "taken@example.com" }),
      });
      assert.equal(res.status, 200);
      // The user's email must not have changed (request never updates).
      const me = prisma._rows().find((r) => r.id === USER_ID)!;
      assert.equal(me.email, "me@example.com");
    } finally {
      await harness.close();
    }
  });
});

describe("POST /me/email/verify-change", () => {
  it("happy: applies the email change and returns the new address", async () => {
    const prisma = makeStubPrisma([{ id: USER_ID, email: "old@example.com" }]);
    const harness = await spinUp(prisma);
    try {
      const verifyTokenStr = signToken(USER_ID, {
        purpose: "email_change",
        expiresIn: "1h",
        extra: { newEmail: "fresh@example.com" },
      });
      const res = await fetch(`${harness.baseUrl}/me/email/verify-change`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: verifyTokenStr }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { success: boolean; email: string };
      assert.equal(body.success, true);
      assert.equal(body.email, "fresh@example.com");
      const me = prisma._rows().find((r) => r.id === USER_ID)!;
      assert.equal(me.email, "fresh@example.com");
    } finally {
      await harness.close();
    }
  });

  it("returns 400 on an expired email_change token", async () => {
    const prisma = makeStubPrisma([{ id: USER_ID, email: "old@example.com" }]);
    const harness = await spinUp(prisma);
    try {
      const expired = jwt.sign(
        {
          userId: USER_ID,
          purpose: "email_change",
          newEmail: "fresh@example.com",
        },
        JWT_SECRET!,
        { expiresIn: "-1s" },
      );
      const res = await fetch(`${harness.baseUrl}/me/email/verify-change`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: expired }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "invalid_token");
    } finally {
      await harness.close();
    }
  });

  it("returns 400 when the token has a different purpose (e.g. session)", async () => {
    const prisma = makeStubPrisma([{ id: USER_ID, email: "old@example.com" }]);
    const harness = await spinUp(prisma);
    try {
      // A session token (default purpose) must NOT serve as an email-change token.
      const sessionToken = signToken(USER_ID);
      const res = await fetch(`${harness.baseUrl}/me/email/verify-change`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: sessionToken }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "invalid_token");
      // User email must be unchanged.
      assert.equal(prisma._rows().find((r) => r.id === USER_ID)!.email, "old@example.com");
    } finally {
      await harness.close();
    }
  });

  it("returns 400 with email_taken when another account grabbed the address between request and verify", async () => {
    const prisma = makeStubPrisma([
      { id: USER_ID, email: "old@example.com" },
      { id: "u-faster", email: "fresh@example.com" }, // race winner
    ]);
    const harness = await spinUp(prisma);
    try {
      const verifyTokenStr = signToken(USER_ID, {
        purpose: "email_change",
        expiresIn: "1h",
        extra: { newEmail: "fresh@example.com" },
      });
      const res = await fetch(`${harness.baseUrl}/me/email/verify-change`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: verifyTokenStr }),
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as {
        error: string;
        userFacingMessage: string;
      };
      assert.equal(body.error, "email_taken");
      assert.match(body.userFacingMessage, /already registered/i);
      assert.equal(prisma._rows().find((r) => r.id === USER_ID)!.email, "old@example.com");
    } finally {
      await harness.close();
    }
  });
});

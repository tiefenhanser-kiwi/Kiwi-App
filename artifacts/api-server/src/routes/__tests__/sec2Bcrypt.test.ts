// SEC-2 — bcrypt cost 10 → 12 (the WS2 lock: "before public launch").
// New hashes are made at 12; a cost-10 hash is re-made at 12 on the next
// successful sign-in, and only if the stored hash is still the one that just
// verified (a password change in between is never overwritten).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";
import bcrypt from "bcryptjs";

import { BCRYPT_ROUNDS, hashPassword } from "../../lib/auth";
import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import { createAuthRouter } from "../auth";

const PASSWORD = "an-old-password-1";

describe("SEC-2 — bcrypt cost 12", () => {
  it("new hashes are made at cost 12", async () => {
    assert.equal(BCRYPT_ROUNDS, 12);
    assert.equal(bcrypt.getRounds(await hashPassword("x-password")), 12);
  });

  describe("a cost-10 hash is upgraded on a successful sign-in", () => {
    let server: Server;
    let base = "";
    const user: Record<string, unknown> = {};
    before(async () => {
      Object.assign(user, {
        id: "u-bcrypt",
        email: "bcrypt@example.com",
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        firstName: "B",
        lastName: "C",
        accountStatus: "active",
        tokensValidFrom: null,
        createdAt: new Date(),
        subscription: null,
      });
      const prisma = {
        user: {
          findUnique: async () => ({ ...user }),
          update: async () => ({}),
          updateMany: async ({ where, data }: { where: { id: string; passwordHash: string }; data: { passwordHash: string } }) => {
            if (where.id !== user["id"] || where.passwordHash !== user["passwordHash"]) return { count: 0 };
            user["passwordHash"] = data.passwordHash;
            return { count: 1 };
          },
        },
      };
      const app: Express = express();
      app.use(express.json());
      app.use(createAuthRouter({ prisma: prisma as never }));
      server = await new Promise((r) => {
        const s = app.listen(0, "127.0.0.1", () => r(s));
      });
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    });
    after(async () => new Promise<void>((r) => server.close(() => r())));

    const login = (password: string) => {
      __clearRateLimitStoreForTests();
      return fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "bcrypt@example.com", password }),
      });
    };
    const settle = async () => {
      for (let i = 0; i < 40 && bcrypt.getRounds(user["passwordHash"] as string) < 12; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    it("a WRONG password upgrades nothing", async () => {
      assert.equal((await login("not-it")).status, 401);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(bcrypt.getRounds(user["passwordHash"] as string), 10);
    });

    it("the right password signs in, and the stored hash becomes cost 12 for the same password", async () => {
      assert.equal((await login(PASSWORD)).status, 200);
      await settle();
      const now = user["passwordHash"] as string;
      assert.equal(bcrypt.getRounds(now), 12);
      assert.equal(await bcrypt.compare(PASSWORD, now), true);
      // And signing in again still works, with nothing left to upgrade.
      assert.equal((await login(PASSWORD)).status, 200);
    });
  });
});

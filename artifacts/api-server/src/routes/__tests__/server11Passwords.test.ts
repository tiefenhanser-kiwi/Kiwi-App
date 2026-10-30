// SERVER-11 (BUG-621) — a listed word with digits or symbols around it is as
// common as the word: "Password123" got a 201 because SERVER-9's list has
// "password1" but not "password123". isCommonPassword now also judges the
// password's core (leading and trailing digits and symbols stripped), at 4
// letters or more. Sign-up, reset and change all call isCommonPassword, so the
// sign-up route stands for the three.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { PASSWORD_TOO_COMMON, PASSWORD_TOO_COMMON_MESSAGE, isCommonPassword, passwordCore } from "../../lib/commonPasswords";
import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import { createAuthRouter } from "../auth";

const REFUSED = ["Password123", "password!", "Password1!", "Kiwi2026!", "123password", "Qwerty123", "Letmein99"];
const ACCEPTED = ["Correct-Horse-Battery", "Kiwi-for-dinner-7", "Tr0ub4dor&3x"];

describe("SERVER-11 — isCommonPassword judges the core", () => {
  for (const pw of REFUSED) {
    it(`refuses ${JSON.stringify(pw)}`, () => assert.equal(isCommonPassword(pw), true));
  }
  for (const pw of ACCEPTED) {
    it(`accepts ${JSON.stringify(pw)}`, () => assert.equal(isCommonPassword(pw), false));
  }

  it("the core strips leading and trailing digits and symbols only", () => {
    assert.equal(passwordCore("  Password1!  "), "password");
    assert.equal(passwordCore("123password"), "password");
    assert.equal(passwordCore("Kiwi-for-dinner-7"), "kiwi-for-dinner");
    assert.equal(passwordCore("Tr0ub4dor&3x"), "tr0ub4dor&3x");
    assert.equal(passwordCore("12345678"), "");
  });

  it("the email's local part is refused as a core too", () => {
    assert.equal(isCommonPassword("Jane.Doe.Cooks2026!", "jane.doe.cooks@example.com"), true);
    assert.equal(isCommonPassword("Jane.Doe.Cooks2026!", "someone.else@example.com"), false);
  });

  it("a core under 4 letters is not judged", () => {
    assert.equal(isCommonPassword("Abc-2026!!", "abc@example.com"), false, '"abc" is the local part but too short to judge as a core');
  });
});

describe("SERVER-11 — POST /auth/signup with Password123", () => {
  it("→ 400 password_too_common with the message, before any read or write", async () => {
    const calls = { reads: 0, creates: 0 };
    const prisma = {
      user: {
        findFirst: async () => null,
        findUnique: async () => {
          calls.reads++;
          return null;
        },
        create: async () => {
          calls.creates++;
          throw new Error("must not create");
        },
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    };
    const app: Express = express();
    app.use(express.json());
    app.use(createAuthRouter({ prisma: prisma as never, signupAlert: async () => {}, welcomeEmail: async () => {} }) as never);
    const server: Server = await new Promise((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    try {
      __clearRateLimitStoreForTests();
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const res = await fetch(`${base}/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "new.cook@example.com", password: "Password123", firstName: "N", lastName: "C" }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 400);
      assert.equal(body["error"], PASSWORD_TOO_COMMON);
      assert.equal(body["userFacingMessage"], PASSWORD_TOO_COMMON_MESSAGE);
      assert.equal(calls.reads + calls.creates, 0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

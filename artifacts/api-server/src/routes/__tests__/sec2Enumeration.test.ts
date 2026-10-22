// SEC-2 #13 — login and password-reset stop telling a stranger whether an
// address has an account.
//
//   · login runs bcrypt for an unknown email too (and for an OAuth-only
//     account with no password), so the 401 takes the same time either way;
//   · the password is checked BEFORE the "not active" answer, so a 403 only
//     ever reaches someone who already knows the password;
//   · password-reset no longer waits for the mail to send before answering.
//
// The timing case compares medians with a wide margin: bcrypt at cost 10+ is
// tens of milliseconds, a lookup with no compare is about one. Before the fix
// the unknown-email path ran no bcrypt at all and sat far under half.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { hashPassword } from "../../lib/auth";
import type { EmailMessage } from "../../lib/email/sendEmail";
import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import { createAuthRouter } from "../auth";

const PASSWORD = "the-right-password";
let hash = "";

function row(id: string, email: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    email,
    passwordHash: hash,
    firstName: "E",
    lastName: "N",
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
    personalizeNudgeDismissedAt: null,
    tokensValidFrom: null,
    createdAt: new Date(),
    subscription: null,
    ...extra,
  };
}

describe("SEC-2 #13 — login and reset do not enumerate accounts", () => {
  let server: Server;
  let base = "";
  const sent: EmailMessage[] = [];
  let users: ReturnType<typeof row>[] = [];

  before(async () => {
    hash = await hashPassword(PASSWORD);
    users = [
      row("u-active", "active@example.com"),
      row("u-suspended", "suspended@example.com", { accountStatus: "suspended" }),
      row("u-oauth", "oauth@example.com", { passwordHash: null }),
    ];
    const prisma = {
      user: {
        findUnique: async ({ where }: { where: { email?: string; id?: string } }) =>
          users.find((u) => (where.email ? u.email === where.email : u.id === where.id)) ?? null,
        update: async () => ({}),
      },
    };
    // A slow mail provider: the reset reply must not wait for it.
    const sendEmail = async (m: EmailMessage) => {
      await new Promise((r) => setTimeout(r, 400));
      sent.push(m);
      return { sent: true as const, id: "x" };
    };
    const app: Express = express();
    app.use(express.json());
    app.use(createAuthRouter({ prisma: prisma as never, sendEmail: sendEmail as never }));
    server = await new Promise((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => __clearRateLimitStoreForTests());

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  async function medianMs(body: unknown): Promise<number> {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      __clearRateLimitStoreForTests();
      const t0 = performance.now();
      const res = await post("/auth/login", body);
      times.push(performance.now() - t0);
      assert.equal(res.status, 401);
    }
    return times.sort((a, b) => a - b)[2]!;
  }

  it("an unknown email and an OAuth-only account take as long to refuse as a wrong password", async () => {
    const wrong = await medianMs({ email: "active@example.com", password: "nope" });
    const unknown = await medianMs({ email: "nobody@example.com", password: "nope" });
    const oauthOnly = await medianMs({ email: "oauth@example.com", password: "nope" });
    assert.ok(unknown > wrong * 0.5, `unknown ${unknown.toFixed(1)} ms vs wrong-password ${wrong.toFixed(1)} ms`);
    assert.ok(oauthOnly > wrong * 0.5, `oauth-only ${oauthOnly.toFixed(1)} ms vs wrong-password ${wrong.toFixed(1)} ms`);
  });

  it("a suspended account with the WRONG password is the plain 401; only the right one learns it is suspended", async () => {
    const wrong = await post("/auth/login", { email: "suspended@example.com", password: "nope" });
    assert.equal(wrong.status, 401);
    assert.deepEqual(await wrong.json(), { error: "invalid credentials" });
    const right = await post("/auth/login", { email: "suspended@example.com", password: PASSWORD });
    assert.equal(right.status, 403);
  });

  it("password-reset answers before the mail is sent, the same for a real and an unknown address", async () => {
    sent.length = 0;
    const t0 = performance.now();
    const real = await post("/auth/password-reset/request", { email: "active@example.com" });
    const realMs = performance.now() - t0;
    const t1 = performance.now();
    const unknown = await post("/auth/password-reset/request", { email: "nobody@example.com" });
    const unknownMs = performance.now() - t1;
    assert.deepEqual([real.status, unknown.status], [200, 200]);
    assert.deepEqual(await real.json(), await unknown.json());
    assert.ok(realMs < 300, `the reply did not wait for the 400 ms mail (${realMs.toFixed(0)} ms)`);
    assert.ok(unknownMs < 300);
    assert.equal(sent.length, 0, "the mail has not gone yet when the reply arrives");
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(sent.map((m) => m.to), ["active@example.com"], "…and it does go");
  });
});

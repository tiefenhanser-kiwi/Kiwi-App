// SEC-2 #1 — a limiter's bucket is the route the request MATCHED, and login /
// password-reset carry a per-EMAIL limit on top of the per-IP one.
//
// SEC-1's probe: ten 401s, two 429s, then `/auth/LOGIN`, `/auth/Login`,
// `/auth/login/` and `/AUTH/login` all answered 401 — each spelling reached the
// same handler with a fresh bucket. These cases drive the live auth router.
//
// The per-email cases vary X-Forwarded-For under `trust proxy` 1, so the per-IP
// limiter sees a different caller on every request and only the per-email
// bucket can answer 429.

import { describe, it, beforeEach, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import bcrypt from "bcryptjs";
import { signToken } from "../../lib/auth";
import { __clearRateLimitStoreForTests, __setRateLimitClockForTests, rateLimit } from "../../lib/rateLimit";
import { createAuthRouter } from "../auth";
import { makeUsedTokenLedger } from "./fixtures/sessionUserStub";

const KNOWN_EMAIL = "known@example.com";
const KNOWN_PASSWORD = "right-password-1";

let knownHash = "";

function userRow() {
  return {
    id: "sec2-rl-user",
    email: KNOWN_EMAIL,
    passwordHash: knownHash,
    firstName: "R",
    lastName: "L",
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
    createdAt: new Date("2026-01-01T00:00:00Z"),
    subscription: null,
  };
}

const prisma = {
  user: {
    findUnique: async ({ where }: { where: { email?: string; id?: string } }) =>
      where.email === KNOWN_EMAIL || where.id === "sec2-rl-user" ? userRow() : null,
    // SEC-2b — a completed reset writes the new hash; login reads it back.
    update: async ({ data }: { data: { passwordHash?: string } }) => {
      if (data.passwordHash) knownHash = data.passwordHash;
      return {};
    },
  },
  usedToken: makeUsedTokenLedger(),
};

async function spinUp(mount: (app: Express) => void) {
  const app: Express = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  mount(app);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let ipSeq = 0;
const post = (baseUrl: string, path: string, body: unknown, rotateIp = false) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(rotateIp ? { "x-forwarded-for": `198.51.100.${(ipSeq++ % 250) + 1}` } : {}),
    },
    body: JSON.stringify(body),
  });

describe("SEC-2 #1 — rate-limit keys and per-email limits", () => {
  let h: Awaited<ReturnType<typeof spinUp>>;
  before(async () => {
    // Cost 4, not the production 12: this file is about the limiter, and eleven
    // cost-12 compares under suite load take long enough for the per-minute
    // bucket to refill a token mid-test.
    knownHash = await bcrypt.hash(KNOWN_PASSWORD, 4);
    h = await spinUp((app) => {
      app.use(createAuthRouter({ prisma: prisma as never, sendEmail: async () => ({ sent: false, reason: "no_api_key" }) as never }));
      // A parameterised route: every id must share one bucket.
      app.post("/things/:id", rateLimit({ capacity: 2, refillPerSec: 0 }), (_req, res) => {
        res.json({ ok: true });
      });
    });
  });
  after(async () => h.close());
  beforeEach(() => __clearRateLimitStoreForTests());
  afterEach(() => __setRateLimitClockForTests(null));

  it("case and trailing-slash variants of /auth/login share /auth/login's bucket (SEC-1's probe)", async () => {
    // Drained with bodies the schema refuses: the per-IP limiter runs before
    // the handler, so each still spends a token, and a 400 costs no bcrypt.
    // (Ten real failed logins at cost 12 take seconds under suite load, and
    // the bucket refills one token every six.) A fresh email every time, so
    // only the per-IP limiter can answer 429.
    let n = 0;
    const bad = () => ({ email: `nobody-${n++}@example.com`, password: "wrong-password-123" });
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await post(h.baseUrl, "/auth/login", {})).status);
    assert.deepEqual(codes, Array(10).fill(400));
    for (const p of ["/auth/login", "/auth/LOGIN", "/auth/Login", "/auth/login/", "/AUTH/login"]) {
      assert.equal((await post(h.baseUrl, p, bad())).status, 429, `${p} must be refused`);
    }
  });

  it("a parameterised route keys on its pattern, not on the id", async () => {
    assert.equal((await post(h.baseUrl, "/things/a", {})).status, 200);
    assert.equal((await post(h.baseUrl, "/things/b", {})).status, 200);
    assert.equal((await post(h.baseUrl, "/things/c", {})).status, 429);
  });

  it("failed logins against one email are capped at 10 per window whatever the IP", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      // Case differences are the same account.
      const email = i % 2 ? KNOWN_EMAIL.toUpperCase() : "Known@Example.com";
      codes.push((await post(h.baseUrl, "/auth/login", { email, password: "wrong" }, true)).status);
    }
    assert.deepEqual(codes.slice(0, 10), Array(10).fill(401));
    assert.equal(codes[10], 429);
    // Refused BEFORE the password is checked: the right password is a 429 too.
    const right = await post(h.baseUrl, "/auth/login", { email: KNOWN_EMAIL, password: KNOWN_PASSWORD }, true);
    assert.equal(right.status, 429);
  });

  // SEC-2b — the window is SHORT and there is no daily cap: an attacker can
  // slow the owner down, never lock them out for the day. SEC-2 #1 also had a
  // 30-a-day bucket, so the third burst below would have stayed refused.
  it("15 minutes after ten failures the owner signs in, burst after burst — no daily lockout", async () => {
    let t = 1_000_000_000_000;
    __setRateLimitClockForTests(() => t);
    for (let burst = 0; burst < 4; burst++) {
      for (let i = 0; i < 10; i++) {
        assert.equal((await post(h.baseUrl, "/auth/login", { email: KNOWN_EMAIL, password: "wrong" }, true)).status, 401);
      }
      assert.equal((await post(h.baseUrl, "/auth/login", { email: KNOWN_EMAIL, password: KNOWN_PASSWORD }, true)).status, 429, `burst ${burst}: locked for now`);
      t += 15 * 60 * 1000;
      assert.equal((await post(h.baseUrl, "/auth/login", { email: KNOWN_EMAIL, password: KNOWN_PASSWORD }, true)).status, 200, `burst ${burst}: 15 minutes later the owner is in`);
    }
  });

  it("a completed password reset clears the window at once", async () => {
    const t = 1_000_000_000_000;
    __setRateLimitClockForTests(() => t);
    const savedHash = knownHash; // the reset rewrites the fixture account's hash
    try {
      for (let i = 0; i < 10; i++) {
        assert.equal((await post(h.baseUrl, "/auth/login", { email: KNOWN_EMAIL, password: "wrong" }, true)).status, 401);
      }
      assert.equal((await post(h.baseUrl, "/auth/login", { email: KNOWN_EMAIL, password: KNOWN_PASSWORD }, true)).status, 429);
      const resetToken = signToken("sec2-rl-user", { purpose: "password_reset", expiresIn: "1h" });
      const reset = await post(h.baseUrl, "/auth/password-reset/confirm", { token: resetToken, newPassword: "a-brand-new-password" }, true);
      assert.equal(reset.status, 200);
      // Same instant — no time has passed; only the reset cleared it.
      assert.equal((await post(h.baseUrl, "/auth/login", { email: KNOWN_EMAIL, password: "a-brand-new-password" }, true)).status, 200);
    } finally {
      knownHash = savedHash;
    }
  });

  it("successful logins never spend the per-email budget", async () => {
    for (let i = 0; i < 15; i++) {
      const res = await post(h.baseUrl, "/auth/login", { email: KNOWN_EMAIL, password: KNOWN_PASSWORD }, true);
      assert.equal(res.status, 200, `login ${i + 1}`);
    }
  });

  it("password-reset requests are capped per email whatever the IP, every call counting", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await post(h.baseUrl, "/auth/password-reset/request", { email: "victim@example.com" }, true)).status);
    }
    assert.deepEqual(codes.slice(0, 10), Array(10).fill(200));
    assert.equal(codes[10], 429);
    // A different email is a different bucket.
    assert.equal((await post(h.baseUrl, "/auth/password-reset/request", { email: "other@example.com" }, true)).status, 200);
  });
});

// LIFE-1 — the three HTTP surfaces of the lifecycle emails and the feedback box.
//
//   POST /api/internal/lifecycle/emails — the hourly tick. The guest sweep's
//     OIDC shape, pinned the same way: unconfigured → 404 (fail closed), no or
//     bad token → 401 and the tick NEVER RUNS, JWKS down → 503 + Retry-After,
//     a good token → 200 with the tick's summary.
//   POST /api/email/unsubscribe + GET /email/unsubscribe — the one-click
//     opt-out: JSON from the page, form POST from a mail client (RFC 8058),
//     write-if-null, a bad token writes nothing.
//   POST /api/me/feedback — auth, validation, FEEDBACK_TO, Reply-To, limit.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import express, { type Express } from "express";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";

import type { EmailMessage, SendResult } from "../../lib/email/sendEmail";
import type { JwksFetch } from "../../lib/googleOidc";
import { signToken } from "../../lib/auth";
import { makeUnsubscribeToken } from "../../lib/lifecycle/unsubscribe";
import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";
import type { TickSummary } from "../../lib/lifecycle/run";
import { createFeedbackRouter, feedbackMessage } from "../feedback";
import {
  createInternalRouter,
  ENV_LIFECYCLE_EMAIL_OIDC_AUDIENCE,
  ENV_LIFECYCLE_EMAIL_OIDC_EMAIL,
} from "../internal";
import { createLifecycleEmailRouter } from "../lifecycleEmail";
import { createPagesRouter } from "../pages";

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

// ── the scheduler route ──────────────────────────────────────────────────

const AUD = "https://kiwi-api.test/api/internal/lifecycle/emails";
const SA = "kiwi-lifecycle-email@kiwi-prod.iam.gserviceaccount.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };

function oidcToken(claims: Record<string, unknown> = {}) {
  return jwt.sign(
    { iss: "https://accounts.google.com", aud: AUD, email: SA, email_verified: true, ...claims },
    privateKey,
    { algorithm: "RS256", keyid: "k1", expiresIn: "5m" },
  );
}

async function tickApp(opts: { env?: NodeJS.ProcessEnv; jwksDown?: boolean; tickThrows?: boolean } = {}) {
  let ticks = 0;
  const summary: TickSummary = { enabled: true, candidates: 3, sent: 2, skipped: 1, failed: 0, byKind: { welcome: 2 } };
  const jwksFetch: JwksFetch = async () => ({
    ok: !opts.jwksDown,
    status: opts.jwksDown ? 503 : 200,
    headers: { get: () => null },
    json: async () => ({ keys: [{ kty: "RSA", alg: "RS256", use: "sig", kid: "k1", n: jwk.n, e: jwk.e }] }),
  });
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createInternalRouter({
      env: opts.env ?? { [ENV_LIFECYCLE_EMAIL_OIDC_EMAIL]: SA, [ENV_LIFECYCLE_EMAIL_OIDC_AUDIENCE]: AUD },
      jwksFetch,
      drainDeps: async () => {
        throw new Error("the drain must not run");
      },
      prisma: {} as never,
      lifecycleTick: async () => {
        ticks++;
        if (opts.tickThrows) throw new Error("boom");
        return summary;
      },
    }),
  );
  const srv = await listen(app);
  return { ...srv, ticks: () => ticks };
}

async function postTick(base: string, auth?: string) {
  return fetch(`${base}/api/internal/lifecycle/emails`, {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  });
}

describe("LIFE-1 POST /api/internal/lifecycle/emails", () => {
  it("🔴 unconfigured → 404 to everyone, even a valid token; the tick never runs", async () => {
    const t = await tickApp({ env: {} });
    try {
      const r = await postTick(t.base, `Bearer ${oidcToken()}`);
      assert.equal(r.status, 404);
      assert.equal(t.ticks(), 0);
    } finally {
      await t.close();
    }
  });

  it("🔴 no token, a wrong audience, a wrong service account → 401 and no tick", async () => {
    const t = await tickApp();
    try {
      assert.equal((await postTick(t.base)).status, 401);
      assert.equal((await postTick(t.base, `Bearer ${oidcToken({ aud: "https://elsewhere" })}`)).status, 401);
      assert.equal((await postTick(t.base, `Bearer ${oidcToken({ email: "someone@else.iam.gserviceaccount.com" })}`)).status, 401);
      assert.equal(t.ticks(), 0);
    } finally {
      await t.close();
    }
  });

  it("JWKS down → 503 + Retry-After, no tick", async () => {
    const t = await tickApp({ jwksDown: true });
    try {
      const r = await postTick(t.base, `Bearer ${oidcToken()}`);
      assert.equal(r.status, 503);
      assert.equal(r.headers.get("retry-after"), "30");
      assert.equal(t.ticks(), 0);
    } finally {
      await t.close();
    }
  });

  it("a good token → 200 with the tick's summary", async () => {
    const t = await tickApp();
    try {
      const r = await postTick(t.base, `Bearer ${oidcToken()}`);
      assert.equal(r.status, 200);
      const body = (await r.json()) as Record<string, unknown>;
      assert.equal(body.ok, true);
      assert.equal(body.sent, 2);
      assert.equal(body.caller, SA);
      assert.equal(t.ticks(), 1);
    } finally {
      await t.close();
    }
  });

  it("a tick that throws → 503 retryable", async () => {
    const t = await tickApp({ tickThrows: true });
    try {
      const r = await postTick(t.base, `Bearer ${oidcToken()}`);
      assert.equal(r.status, 503);
      assert.equal(r.headers.get("retry-after"), "60");
    } finally {
      await t.close();
    }
  });
});

// ── the unsubscribe ──────────────────────────────────────────────────────

const ENV = { JWT_SECRET: "life1-route-secret", PUBLIC_APP_URL: "https://api.kiwi.test" };
const USER = "00000000-0000-4000-8000-0000000000aa";

async function unsubApp() {
  const rows = new Map<string, Date | null>([[USER, null]]);
  const writes: unknown[] = [];
  const prisma = {
    user: {
      updateMany: async ({ where, data }: { where: { id: string; lifecycleEmailOptOutAt: null }; data: { lifecycleEmailOptOutAt: Date } }) => {
        writes.push(where);
        if (!rows.has(where.id) || rows.get(where.id) !== null) return { count: 0 };
        rows.set(where.id, data.lifecycleEmailOptOutAt);
        return { count: 1 };
      },
    },
  };
  let clock = new Date("2026-10-20T12:00:00Z");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(createPagesRouter());
  app.use("/api", createLifecycleEmailRouter({ prisma: prisma as never, env: ENV, now: () => clock }));
  const srv = await listen(app);
  return { ...srv, rows, writes, tick: () => (clock = new Date(clock.getTime() + 60_000)) };
}

describe("LIFE-1 the one-click unsubscribe", () => {
  it("🔴 the page's JSON POST opts the account out", async () => {
    const a = await unsubApp();
    try {
      const r = await fetch(`${a.base}/api/email/unsubscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: makeUnsubscribeToken(USER, ENV) }),
      });
      assert.equal(r.status, 200);
      assert.ok(a.rows.get(USER) instanceof Date);
    } finally {
      await a.close();
    }
  });

  it("🔴 RFC 8058: a mail client's form POST with the token in the query opts out", async () => {
    const a = await unsubApp();
    try {
      const token = encodeURIComponent(makeUnsubscribeToken(USER, ENV)!);
      const r = await fetch(`${a.base}/api/email/unsubscribe?token=${token}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      });
      assert.equal(r.status, 200);
      assert.ok(a.rows.get(USER) instanceof Date);
    } finally {
      await a.close();
    }
  });

  it("🔴 a bad token is 400 and writes nothing", async () => {
    const a = await unsubApp();
    try {
      for (const token of ["", "nope", `${USER}.AAAA`, makeUnsubscribeToken(USER, { JWT_SECRET: "other" })]) {
        const r = await fetch(`${a.base}/api/email/unsubscribe`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        assert.equal(r.status, 400);
      }
      assert.equal(a.writes.length, 0);
      assert.equal(a.rows.get(USER), null);
    } finally {
      await a.close();
    }
  });

  it("twice is harmless and keeps the first time (write-if-null)", async () => {
    const a = await unsubApp();
    try {
      const body = JSON.stringify({ token: makeUnsubscribeToken(USER, ENV) });
      const post = () => fetch(`${a.base}/api/email/unsubscribe`, { method: "POST", headers: { "content-type": "application/json" }, body });
      assert.equal((await post()).status, 200);
      const first = a.rows.get(USER);
      a.tick();
      assert.equal((await post()).status, 200);
      assert.equal(a.rows.get(USER), first);
    } finally {
      await a.close();
    }
  });

  it("🔴 GET /email/unsubscribe serves the page and writes NOTHING (a scanner's prefetch cannot opt anyone out)", async () => {
    const a = await unsubApp();
    try {
      const token = encodeURIComponent(makeUnsubscribeToken(USER, ENV)!);
      const r = await fetch(`${a.base}/email/unsubscribe?token=${token}`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type") ?? "", /text\/html/);
      assert.equal(r.headers.get("cache-control"), "no-store");
      const html = await r.text();
      assert.match(html, /fetch\("\/api\/email\/unsubscribe"/);
      assert.equal(a.writes.length, 0);
      assert.equal(a.rows.get(USER), null);
    } finally {
      await a.close();
    }
  });
});

// ── the feedback box ─────────────────────────────────────────────────────

const MEMBER = { id: "00000000-0000-4000-8000-0000000000bb", email: "ana@mail.kiwi-members.net", firstName: "Ana", lastName: "Ruiz" };

async function feedbackApp(opts: { env?: NodeJS.ProcessEnv; result?: SendResult; capacity?: number } = {}) {
  __clearRateLimitStoreForTests();
  const sent: EmailMessage[] = [];
  const prisma = {
    user: {
      findUnique: async ({ where, select }: { where: { id: string }; select: Record<string, boolean> }) => {
        if (where.id !== MEMBER.id) return null;
        if (select && "tokensValidFrom" in select) return { tokensValidFrom: null };
        return { email: MEMBER.email, firstName: MEMBER.firstName, lastName: MEMBER.lastName };
      },
    },
  };
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createFeedbackRouter({
      prisma: prisma as never,
      env: opts.env ?? { FEEDBACK_TO: "support@kitchenwizard.ai" },
      sendEmail: async (m) => {
        sent.push(m);
        return opts.result ?? { sent: true, id: "re_f" };
      },
      limiterOpts: { capacity: opts.capacity ?? 50, refillPerSec: 0.0001 },
    }),
  );
  const srv = await listen(app);
  const post = (body: unknown, auth = true) =>
    fetch(`${srv.base}/api/me/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${signToken(MEMBER.id)}` } : {}) },
      body: JSON.stringify(body),
    });
  return { ...srv, sent, post };
}

describe("LIFE-1 POST /api/me/feedback", () => {
  it("🔴 signed out → 401, nothing sent", async () => {
    const a = await feedbackApp();
    try {
      assert.equal((await a.post({ message: "hi" }, false)).status, 401);
      assert.equal(a.sent.length, 0);
    } finally {
      await a.close();
    }
  });

  it("emails FEEDBACK_TO with the member's email, version, platform, screen; Reply-To is the member", async () => {
    const a = await feedbackApp();
    try {
      const r = await a.post({ message: "The grocery list\nmissed onions", screen: "Profile", appVersion: "1.1.0", platform: "android" });
      assert.equal(r.status, 200);
      const m = a.sent[0]!;
      assert.equal(m.to, "support@kitchenwizard.ai");
      assert.equal(m.replyTo, MEMBER.email);
      assert.equal(m.subject, "Kiwi feedback: The grocery list…");
      assert.match(m.text, /From: Ana Ruiz <ana@mail\.kiwi-members\.net>/);
      assert.match(m.text, /App: android v1\.1\.0/);
      assert.match(m.text, /Screen: Profile/);
      assert.match(m.text, /missed onions/);
    } finally {
      await a.close();
    }
  });

  it("🔴 FEEDBACK_TO unset → 503 feedback_unavailable (never a silent drop)", async () => {
    const a = await feedbackApp({ env: {} });
    try {
      const r = await a.post({ message: "hi" });
      assert.equal(r.status, 503);
      assert.equal(((await r.json()) as { error: string }).error, "feedback_unavailable");
      assert.equal(a.sent.length, 0);
    } finally {
      await a.close();
    }
  });

  it("empty, too long, or unknown fields → 400", async () => {
    const a = await feedbackApp();
    try {
      assert.equal((await a.post({ message: "   " })).status, 400);
      assert.equal((await a.post({ message: "x".repeat(4001) })).status, 400);
      assert.equal((await a.post({ message: "hi", extra: 1 })).status, 400);
      assert.equal((await a.post({ message: "hi", platform: "windows" })).status, 400);
      assert.equal(a.sent.length, 0);
    } finally {
      await a.close();
    }
  });

  it("Resend refusing → 502 send_failed", async () => {
    const a = await feedbackApp({ result: { sent: false, reason: "send_failed", status: 500 } });
    try {
      assert.equal((await a.post({ message: "hi" })).status, 502);
    } finally {
      await a.close();
    }
  });

  it("🔴 rate-limited per user", async () => {
    const a = await feedbackApp({ capacity: 2 });
    try {
      assert.equal((await a.post({ message: "one" })).status, 200);
      assert.equal((await a.post({ message: "two" })).status, 200);
      assert.equal((await a.post({ message: "three" })).status, 429);
      assert.equal(a.sent.length, 2);
    } finally {
      await a.close();
    }
  });

  it("feedbackMessage: no name, no version → readable placeholders", () => {
    const m = feedbackMessage({ email: "x@y.net", firstName: null, lastName: null }, { message: "short" });
    assert.equal(m.subject, "Kiwi feedback: short");
    assert.match(m.text, /From: \(no name\) <x@y\.net>/);
    assert.match(m.text, /App: unknown platform/);
  });
});

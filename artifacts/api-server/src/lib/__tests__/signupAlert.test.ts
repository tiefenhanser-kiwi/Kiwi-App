// SRV-2 · D-WS9-308 — the signup alert email.
//
//   1. SIGNUP_ALERT_TO unset          → no send, no query, no log line
//   2. a password signup              → one send
//   3. a NEW OAuth user               → one send (Google and Apple)
//   4. an EXISTING OAuth user         → nothing (same subject, and email-linked)
//   5. Resend hangs, then fails       → the signup answers 201 BEFORE the send
//                                       settles, and ONE `signup_alert_failed`
//                                       warn follows, with no name and no email
//   6. the subject                    → "First L." / "(no name)", source, method
//   7. the real-accounts count        → ONE query, excluding all three patterns
//
// Routes are driven through the real auth router; the router's `signupAlert`
// seam wraps the REAL `sendSignupAlert` so each test can await the promise the
// route deliberately does not.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import type { EmailMessage, EmailSender, SendResult } from "../email/sendEmail";
import { logger } from "../logger";
import { __clearRateLimitStoreForTests } from "../rateLimit";
import type { OAuthConfig } from "../oauth/config";
import type { IdentityVerdict, VerifiedIdentity } from "../oauth/verify";
import {
  REAL_ACCOUNT_WHERE,
  sendSignupAlert,
  signupAlertMessage,
  type SignupAlertInput,
} from "../signupAlert";
import { createAuthRouter } from "../../routes/auth";

const ALERT_TO = "alerts@hans.test";

// ── env + log capture ────────────────────────────────────────────────────

let savedTo: string | undefined;
function setAlertTo(v: string | undefined) {
  if (v === undefined) delete process.env.SIGNUP_ALERT_TO;
  else process.env.SIGNUP_ALERT_TO = v;
}

async function captureWarns(run: () => Promise<void>) {
  const lines: Array<Record<string, unknown>> = [];
  const realWarn = logger.warn.bind(logger);
  const L = logger as unknown as { warn: unknown };
  L.warn = ((obj: unknown, ...rest: unknown[]) => {
    if (obj && typeof obj === "object") lines.push(obj as Record<string, unknown>);
    return realWarn(obj as never, ...(rest as [never]));
  }) as never;
  try {
    await run();
  } finally {
    L.warn = realWarn;
  }
  return lines;
}

// ── a stub Prisma that evaluates REAL_ACCOUNT_WHERE for real ─────────────

type Clause = { email: { endsWith?: string; startsWith?: string; mode?: string } };

function matches(email: string, c: Clause): boolean {
  const ci = c.email.mode === "insensitive";
  const e = ci ? email.toLowerCase() : email;
  const norm = (s: string) => (ci ? s.toLowerCase() : s);
  if (c.email.endsWith !== undefined && !e.endsWith(norm(c.email.endsWith))) return false;
  if (c.email.startsWith !== undefined && !e.startsWith(norm(c.email.startsWith))) return false;
  return true;
}

interface UserRow extends Record<string, unknown> {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  signupSource: string | null;
  createdAt: Date;
}

function makePrisma(seed: Array<Partial<UserRow>> = []) {
  let uid = 0;
  let iid = 0;
  const users: UserRow[] = [];
  const identities: Array<Record<string, unknown>> = [];
  const countCalls: unknown[] = [];
  const plans = new Map<string, { titleOverride: string | null; template: { title: string } | null }>();

  function makeUser(data: Partial<UserRow>): UserRow {
    return {
      id: `u-${++uid}`,
      email: "",
      passwordHash: null,
      firstName: "",
      lastName: "",
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
      personalizeNudgeDismissedAt: null,
      createdAt: new Date("2026-10-12T14:05:00Z"),
      ...data,
    } as UserRow;
  }
  for (const s of seed) users.push(makeUser(s));

  const client = {
    user: {
      findUnique: async ({ where, include }: { where: { id?: string; email?: string }; include?: { subscription?: boolean } }) => {
        const row =
          where.email !== undefined
            ? users.find((u) => u.email === where.email)
            : users.find((u) => u.id === where.id);
        if (!row) return null;
        return include?.subscription ? { ...row, subscription: null } : row;
      },
      create: async ({ data }: { data: Partial<UserRow> }) => {
        const row = makeUser(data);
        users.push(row);
        return row;
      },
      update: async ({ where }: { where: { id: string } }) => users.find((u) => u.id === where.id)!,
      count: async (args: { where: { NOT: Clause[] } }) => {
        countCalls.push(args);
        return users.filter((u) => !args.where.NOT.some((c) => matches(u.email, c))).length;
      },
    },
    subscription: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        status: "trialing",
        planCode: "free",
        currentPeriodEnd: null,
        ...data,
      }),
    },
    userIdentity: {
      findUnique: async ({ where }: { where: { provider_subject: { provider: string; subject: string } } }) =>
        identities.find(
          (i) => i.provider === where.provider_subject.provider && i.subject === where.provider_subject.subject,
        ) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `i-${++iid}`, ...data };
        identities.push(row);
        return row;
      },
      update: async ({ where }: { where: { id: string } }) => identities.find((i) => i.id === where.id)!,
      // SEC-2 #5 — the "was this address ever proven?" read on the link branch.
      findFirst: async () => null,
    },
    usedToken: { findFirst: async () => null },
    mealPlanInstance: {
      findUnique: async ({ where }: { where: { id: string } }) => plans.get(where.id) ?? null,
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
    _users: users,
    _countCalls: countCalls,
    _plans: plans,
  };
  return client;
}

function recorder(result: SendResult = { sent: true, id: "re_1" }) {
  const sent: EmailMessage[] = [];
  const send: EmailSender = async (msg) => {
    sent.push(msg);
    return result;
  };
  return { sent, send };
}

// ── the router harness ───────────────────────────────────────────────────

const OAUTH_CONFIG: OAuthConfig = {
  appleAudiences: ["com.kitchenwizard.kiwi"],
  googleClientIds: ["111-ios.apps.googleusercontent.com"],
  appleSigning: null,
  appleRefreshEncSecret: null,
  appleWebRedirect: null,
};

function identity(over: Partial<VerifiedIdentity> = {}): VerifiedIdentity {
  return {
    provider: "google",
    subject: "g-sub-1",
    email: "gee@gmail.com",
    emailVerified: true,
    isPrivateRelay: false,
    audience: "111-ios.apps.googleusercontent.com",
    firstName: "Gee",
    lastName: "Mail",
    ...over,
  };
}

interface Harness {
  baseUrl: string;
  prisma: ReturnType<typeof makePrisma>;
  sent: EmailMessage[];
  pending: Array<Promise<void>>;
  close: () => Promise<void>;
}

async function spinUp(opts: {
  seed?: Array<Partial<UserRow>>;
  send?: EmailSender;
  sent?: EmailMessage[];
  verdict?: () => IdentityVerdict;
} = {}): Promise<Harness> {
  const prisma = makePrisma(opts.seed);
  const rec = recorder();
  const send = opts.send ?? rec.send;
  const sent = opts.sent ?? rec.sent;
  const pending: Array<Promise<void>> = [];
  const verdict = opts.verdict ?? (() => ({ ok: true, identity: identity() }) as IdentityVerdict);
  const app: Express = express();
  app.use(express.json());
  app.use(
    createAuthRouter({
      prisma: prisma as never,
      sendEmail: send,
      oauthConfig: OAUTH_CONFIG,
      verifyGoogle: async () => verdict(),
      verifyApple: async () => verdict(),
      exchangeAppleCode: async () => ({ refreshToken: null }) as never,
      signupAlert: (input: SignupAlertInput) => {
        const p = sendSignupAlert(input, { prisma: prisma as never, sendEmail: send });
        pending.push(p);
        return p;
      },
    }),
  );
  return await new Promise<Harness>((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) return reject(new Error("server did not bind"));
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        prisma,
        sent,
        pending,
        close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

function post(h: Harness, path: string, body: Record<string, unknown>) {
  return fetch(`${h.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SIGNUP = {
  email: "newcook@gmail.com",
  password: "password123",
  firstName: "Nova",
  lastName: "Cook",
  platform: "web",
};

// ── tests ────────────────────────────────────────────────────────────────

describe("signup alert (SRV-2 · D-WS9-308)", () => {
  before(() => {
    savedTo = process.env.SIGNUP_ALERT_TO;
  });
  after(() => setAlertTo(savedTo));
  beforeEach(() => {
    setAlertTo(ALERT_TO);
    __clearRateLimitStoreForTests();
  });

  it("1. SIGNUP_ALERT_TO unset → no send, no query, no log line", async () => {
    for (const v of [undefined, "", "   "]) {
      setAlertTo(v);
      const prisma = makePrisma([{ email: "a@gmail.com" }]);
      const { sent, send } = recorder();
      const warns = await captureWarns(() =>
        sendSignupAlert({ userId: "u-1", via: "signup", method: "password" }, { prisma: prisma as never, sendEmail: send }),
      );
      assert.equal(sent.length, 0, `value ${JSON.stringify(v)}`);
      assert.equal(prisma._countCalls.length, 0, "no query when off");
      assert.equal(warns.length, 0, "nothing logged when off");
    }
    // And through the route: a signup with the variable unset sends nothing.
    setAlertTo(undefined);
    const h = await spinUp();
    try {
      assert.equal((await post(h, "/auth/signup", SIGNUP)).status, 201);
      await Promise.all(h.pending);
      assert.equal(h.sent.length, 0);
    } finally {
      await h.close();
    }
  });

  it("2. a password signup sends ONE alert, to SIGNUP_ALERT_TO, method password", async () => {
    const h = await spinUp();
    try {
      assert.equal((await post(h, "/auth/signup", SIGNUP)).status, 201);
      await Promise.all(h.pending);
      assert.equal(h.sent.length, 1);
      assert.equal(h.sent[0].to, ALERT_TO);
      assert.equal(h.sent[0].subject, "New Kiwi signup: Nova C. via web (password)");
    } finally {
      await h.close();
    }
  });

  for (const provider of ["google", "apple"] as const) {
    it(`3. a NEW ${provider} user sends ONE alert, method ${provider}`, async () => {
      const h = await spinUp({
        verdict: () => ({ ok: true, identity: identity({ provider, subject: `${provider}-new` }) }),
      });
      try {
        const body =
          provider === "google"
            ? { idToken: "t", platform: "ios" }
            : { identityToken: "t", rawNonce: "n", platform: "ios" };
        const res = await post(h, `/auth/oauth/${provider}`, body);
        assert.equal(res.status, 201);
        assert.equal(((await res.json()) as { isNewUser: boolean }).isNewUser, true);
        await Promise.all(h.pending);
        assert.equal(h.sent.length, 1);
        assert.equal(h.sent[0].subject, `New Kiwi signup: Gee M. via ios (${provider})`);
      } finally {
        await h.close();
      }
    });
  }

  it("4. an EXISTING OAuth user sends nothing — a returning subject, and a verified email linked to a password account", async () => {
    const h = await spinUp();
    try {
      // First sign-in creates (one alert), the second is a return (none).
      assert.equal((await post(h, "/auth/oauth/google", { idToken: "t" })).status, 201);
      await Promise.all(h.pending);
      assert.equal(h.sent.length, 1);
      const again = await post(h, "/auth/oauth/google", { idToken: "t" });
      assert.equal(again.status, 200);
      assert.equal(((await again.json()) as { isNewUser: boolean }).isNewUser, false);
      await Promise.all(h.pending);
      assert.equal(h.sent.length, 1, "a returning user's sign-in must not alert");
    } finally {
      await h.close();
    }

    const linked = await spinUp({
      seed: [{ email: "gee@gmail.com", firstName: "Gee", lastName: "Mail" }],
    });
    try {
      const res = await post(linked, "/auth/oauth/google", { idToken: "t" });
      assert.equal(res.status, 200);
      await Promise.all(linked.pending);
      assert.equal(linked.pending.length, 0, "the alert seam is not even called");
      assert.equal(linked.sent.length, 0);
    } finally {
      await linked.close();
    }
  });

  it("5. Resend hangs then fails → 201 arrives first, then ONE signup_alert_failed warn with no PII", async () => {
    let release!: (r: SendResult) => void;
    const sent: EmailMessage[] = [];
    const hanging: EmailSender = (msg) => {
      sent.push(msg);
      return new Promise<SendResult>((r) => {
        release = r;
      });
    };
    const h = await spinUp({ send: hanging, sent });
    try {
      const warns = await captureWarns(async () => {
        const res = await post(h, "/auth/signup", SIGNUP);
        // The response is here while the send is still pending: the route did
        // not wait on Resend.
        assert.equal(res.status, 201);
        assert.equal(h.pending.length, 1);
        await new Promise((r) => setImmediate(r));
        assert.equal(sent.length, 1, "the send was started");
        release({ sent: false, reason: "send_failed", status: 500 });
        await Promise.all(h.pending);
      });
      const failed = warns.filter((w) => w.event === "signup_alert_failed");
      assert.equal(failed.length, 1);
      assert.deepEqual(Object.keys(failed[0]).sort(), ["error", "event", "userId", "via"]);
      assert.equal(failed[0].userId, h.prisma._users[0].id);
      assert.equal(failed[0].via, "signup");
      const flat = JSON.stringify(failed[0]);
      for (const pii of [SIGNUP.email, SIGNUP.firstName, SIGNUP.lastName]) {
        assert.ok(!flat.includes(pii), `the warn must not carry ${pii}`);
      }
    } finally {
      await h.close();
    }

    // A sender that THROWS is caught the same way: still 201, still one warn.
    const throwing = await spinUp({
      send: async () => {
        throw new Error("socket hang up");
      },
    });
    try {
      const warns = await captureWarns(async () => {
        assert.equal((await post(throwing, "/auth/signup", SIGNUP)).status, 201);
        await Promise.all(throwing.pending);
      });
      const failed = warns.filter((w) => w.event === "signup_alert_failed");
      assert.equal(failed.length, 1);
      assert.equal(failed[0].error, "socket hang up");
    } finally {
      await throwing.close();
    }
  });

  it("6. subject: First + last initial, (no name), source, method; body has no address", () => {
    const base = {
      signupSource: "test_kitchen",
      createdAt: new Date("2026-10-12T14:05:00Z"),
      method: "google" as const,
      planTitle: "Weeknight Mediterranean",
      realAccounts: 42,
    };
    assert.equal(
      signupAlertMessage({ ...base, firstName: "Hans", lastName: "tiefenthaler" }).subject,
      "New Kiwi signup: Hans T. via test_kitchen (google)",
    );
    assert.equal(
      signupAlertMessage({ ...base, firstName: "", lastName: "" }).subject,
      "New Kiwi signup: (no name) via test_kitchen (google)",
    );
    assert.equal(
      signupAlertMessage({ ...base, firstName: "  ", lastName: null, signupSource: null, method: "apple" }).subject,
      "New Kiwi signup: (no name) via (no source) (apple)",
    );
    assert.equal(
      signupAlertMessage({ ...base, firstName: "Cher", lastName: "" }).subject,
      "New Kiwi signup: Cher via test_kitchen (google)",
    );
    const msg = signupAlertMessage({ ...base, firstName: "Hans", lastName: "T" });
    assert.equal(
      msg.text,
      [
        "Signed up: Mon, Oct 12, 2026, 10:05 AM EDT",
        "Source: test_kitchen",
        "Method: google",
        "Plan: Weeknight Mediterranean",
        "Real accounts: 42",
      ].join("\n"),
    );
    // Not a Test Kitchen signup → no Plan line at all.
    const web = signupAlertMessage({ ...base, signupSource: "web", planTitle: undefined, firstName: "A", lastName: "B" });
    assert.ok(!web.text.includes("Plan:"));
  });

  it("6b. a test_kitchen signup reads its plan's title; an unbuilt plan says so", async () => {
    const prisma = makePrisma([{ email: "tk@gmail.com", firstName: "Tess", lastName: "Kay", signupSource: "test_kitchen" }]);
    prisma._plans.set("plan-1", { titleOverride: null, template: { title: "Cozy Fall Week" } });
    const { sent, send } = recorder();
    await sendSignupAlert(
      { userId: "u-1", via: "oauth_google", method: "google", claimedPlanId: "plan-1" },
      { prisma: prisma as never, sendEmail: send },
    );
    await sendSignupAlert(
      { userId: "u-1", via: "oauth_google", method: "google", claimedPlanId: null },
      { prisma: prisma as never, sendEmail: send },
    );
    assert.match(sent[0].text, /^Plan: Cozy Fall Week$/m);
    assert.match(sent[1].text, /^Plan: \(not built\)$/m);
  });

  it("7. the real-accounts count is ONE query and excludes all three test patterns", async () => {
    const prisma = makePrisma([
      { email: "real.one@gmail.com", firstName: "Real" },
      { email: "hans@kitchenwizard.ai" },
      { email: "Ops@KitchenWizard.AI" },
      { email: "kiwitester@gmail.com" },
      { email: "KiwiTester7@icloud.com" },
      { email: "fixture@example.com" },
      { email: "real.two@icloud.com" },
      // Near misses that ARE real: the patterns are anchored.
      { email: "notkiwitester@gmail.com" },
      { email: "me@example.com.au" },
    ]);
    const { sent, send } = recorder();
    await sendSignupAlert({ userId: "u-1", via: "signup", method: "password" }, { prisma: prisma as never, sendEmail: send });
    assert.equal(prisma._countCalls.length, 1, "one count query");
    assert.deepEqual(prisma._countCalls[0], { where: REAL_ACCOUNT_WHERE });
    assert.match(sent[0].text, /^Real accounts: 4$/m);
    for (const u of prisma._users) {
      assert.ok(!sent[0].text.includes(u.email) && !sent[0].subject.includes(u.email), "no address anywhere");
    }
  });
});

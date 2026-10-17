// LIFE-1 — the sender: one tick, and the welcome at signup.
//
// The fake database MODELS THE CONSTRAINT the once-only rule depends on: a
// second (userId, kind) claim throws a Prisma-shaped P2002, exactly as the
// unique index does. A fake that accepted every insert would let the
// "at most once" tests pass while the defect shipped (sessionUserStub.ts has
// the same rule for UsedToken).
//
// The fake `findMany` deliberately does NOT filter: it returns every account,
// opted out or not, so the runner's own opt-out check is what is under test.
// The WHERE it was given is asserted separately.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { EmailMessage, SendResult } from "../email/sendEmail";
import {
  MAX_SENDS_PER_TICK,
  SEND_SPACING_MS,
  isUndeliverable,
  lifecycleEmailEnabled,
  runLifecycleTick,
  sendWelcomeEmail,
  type CandidateUser,
} from "../lifecycle/run";
import { REPLY_TO } from "../lifecycle/copy";

const H = 60 * 60 * 1000;
// Tuesday 2026-10-20 15:00 EDT — inside sending hours.
const NOW = new Date("2026-10-20T19:00:00Z");

const ENV: NodeJS.ProcessEnv = {
  LIFECYCLE_EMAIL_ENABLED: "true",
  JWT_SECRET: "life1-test-secret",
  PUBLIC_APP_URL: "https://api.kiwi.test",
  BILLING_ENFORCED: "true",
};

let seq = 0;
function user(over: Partial<CandidateUser> = {}): CandidateUser {
  seq++;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    email: `member${seq}@mail.kiwi-members.net`,
    firstName: "Ana",
    timezone: "America/New_York",
    createdAt: new Date(NOW.getTime() - 1 * H),
    firstPlanCreatedAt: null,
    lifecycleEmailOptOutAt: null,
    subscription: { status: "trialing", source: null, trialEndsAt: new Date(NOW.getTime() + 13 * 24 * H) },
    lifecycleEmailSends: [],
    ...over,
  };
}

interface SendRow { id: string; userId: string; kind: string; sentAt: Date | null; providerMessageId: string | null }

function fakeDb(users: CandidateUser[], opts: { committedPlans?: string[] } = {}) {
  const sends: SendRow[] = [];
  const calls = { findMany: 0, findUnique: 0, wheres: [] as unknown[] };
  const withSends = (u: CandidateUser): CandidateUser => ({
    ...u,
    lifecycleEmailSends: [
      ...u.lifecycleEmailSends,
      ...sends.filter((s) => s.userId === u.id).map((s) => ({ kind: s.kind })),
    ],
  });
  const prisma = {
    user: {
      findMany: async ({ where }: { where: unknown }) => {
        calls.findMany++;
        calls.wheres.push(where);
        return users.map(withSends);
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        calls.findUnique++;
        const u = users.find((x) => x.id === where.id);
        return u ? withSends(u) : null;
      },
    },
    lifecycleEmailSend: {
      create: async ({ data }: { data: { userId: string; kind: string } }) => {
        if (sends.some((s) => s.userId === data.userId && s.kind === data.kind)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row = { id: `send-${sends.length + 1}`, ...data, sentAt: null, providerMessageId: null };
        sends.push(row);
        return { id: row.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<SendRow> }) => {
        const row = sends.find((s) => s.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const i = sends.findIndex((s) => s.id === where.id);
        return sends.splice(i, 1)[0];
      },
    },
    mealPlanInstance: {
      count: async ({ where }: { where: { userId: string } }) =>
        (opts.committedPlans ?? []).filter((id) => id === where.userId).length,
    },
  };
  return { prisma: prisma as never, raw: prisma, sends, calls };
}

function recorder(result: SendResult | ((n: number) => SendResult) = { sent: true, id: "re_1" }) {
  const sent: EmailMessage[] = [];
  return {
    sent,
    sendEmail: async (m: EmailMessage): Promise<SendResult> => {
      sent.push(m);
      return typeof result === "function" ? result(sent.length) : result;
    },
  };
}

const noSleep = async () => {};

describe("LIFE-1 runner — the kill switch", () => {
  it("🔴 off: the tick reads nothing and sends nothing", async () => {
    const db = fakeDb([user()]);
    const rec = recorder();
    for (const v of [undefined, "", "false", "1", "yes", "ture"]) {
      const s = await runLifecycleTick({ ...db, ...rec, env: { ...ENV, LIFECYCLE_EMAIL_ENABLED: v }, now: () => NOW, sleep: noSleep });
      assert.equal(s.enabled, false, `value ${String(v)}`);
    }
    assert.equal(db.calls.findMany, 0);
    assert.equal(rec.sent.length, 0);
  });

  it("🔴 off: the signup welcome returns before touching the database", async () => {
    const u = user();
    const db = fakeDb([u]);
    const rec = recorder();
    await sendWelcomeEmail(u.id, { ...db, ...rec, env: { ...ENV, LIFECYCLE_EMAIL_ENABLED: "false" }, now: () => NOW });
    assert.equal(db.calls.findUnique, 0);
    assert.equal(rec.sent.length, 0);
  });

  it("on means exactly 'true', any case", () => {
    assert.equal(lifecycleEmailEnabled({ LIFECYCLE_EMAIL_ENABLED: "true" }), true);
    assert.equal(lifecycleEmailEnabled({ LIFECYCLE_EMAIL_ENABLED: " TRUE " }), true);
    assert.equal(lifecycleEmailEnabled({ LIFECYCLE_EMAIL_ENABLED: "on" }), false);
  });
});

describe("LIFE-1 runner — what goes out", () => {
  it("a new account gets the welcome: HTML + text, Reply-To support@, NO unsubscribe header", async () => {
    const u = user();
    const db = fakeDb([u]);
    const rec = recorder();
    const s = await runLifecycleTick({ ...db, ...rec, env: ENV, now: () => NOW, sleep: noSleep });
    assert.equal(s.sent, 1);
    assert.deepEqual(s.byKind, { welcome: 1 });
    const m = rec.sent[0]!;
    assert.equal(m.to, u.email);
    assert.equal(m.subject, "Welcome to Kiwi. Let's plan your week.");
    assert.equal(m.replyTo, REPLY_TO);
    assert.equal(REPLY_TO, "support@kitchenwizard.ai");
    assert.ok(m.html && m.html.includes("Hi Ana,"));
    assert.ok(m.text.startsWith("Hi Ana,"));
    assert.equal(m.headers, undefined);
    assert.equal(m.from, undefined, "EMAIL_FROM is the default sender");
    assert.equal(db.sends.length, 1);
    assert.ok(db.sends[0]!.sentAt instanceof Date);
    assert.equal(db.sends[0]!.providerMessageId, "re_1");
  });

  it("Day 1 carries the one-click unsubscribe: List-Unsubscribe + -Post headers and the footer link", async () => {
    const u = user({ createdAt: new Date(NOW.getTime() - 25 * H), lifecycleEmailSends: [{ kind: "welcome" }] });
    const db = fakeDb([u]);
    const rec = recorder();
    await runLifecycleTick({ ...db, ...rec, env: ENV, now: () => NOW, sleep: noSleep });
    const m = rec.sent[0]!;
    assert.equal(m.subject, "Your week isn't planned yet. It takes about 2 minutes.");
    assert.match(m.headers!["List-Unsubscribe"]!, /^<https:\/\/api\.kiwi\.test\/api\/email\/unsubscribe\?token=.+>$/);
    assert.equal(m.headers!["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.match(m.html!, /href="https:\/\/api\.kiwi\.test\/email\/unsubscribe\?token=/);
  });

  it("LIFECYCLE_EMAIL_FROM overrides the sender for these emails only", async () => {
    const db = fakeDb([user()]);
    const rec = recorder();
    await runLifecycleTick({ ...db, ...rec, env: { ...ENV, LIFECYCLE_EMAIL_FROM: "Hans at Kiwi <hans@kitchenwizard.ai>" }, now: () => NOW, sleep: noSleep });
    assert.equal(rec.sent[0]!.from, "Hans at Kiwi <hans@kitchenwizard.ai>");
  });

  it("the free-time 'ending' email names the end date from Subscription.trialEndsAt", async () => {
    const end = new Date("2026-11-03T04:59:59Z"); // 23:59:59 EST Nov 2 — the D-WS9-310 cohort
    const u = user({
      createdAt: new Date("2026-10-01T15:00:00Z"),
      subscription: { status: "trialing", source: null, trialEndsAt: end },
      lifecycleEmailSends: [{ kind: "welcome" }, { kind: "day1" }, { kind: "day3" }, { kind: "day5" }],
    });
    const db = fakeDb([u]);
    const rec = recorder();
    await runLifecycleTick({ ...db, ...rec, env: ENV, now: () => new Date("2026-10-31T14:00:00Z"), sleep: noSleep });
    assert.equal(rec.sent[0]!.subject, "Your free Kiwi access ends Monday, November 2.");
  });

  it("sends are spaced for Resend's rate limit", async () => {
    const db = fakeDb([user(), user(), user()]);
    const rec = recorder();
    const sleeps: number[] = [];
    await runLifecycleTick({ ...db, ...rec, env: ENV, now: () => NOW, sleep: async (ms) => void sleeps.push(ms) });
    assert.equal(rec.sent.length, 3);
    assert.deepEqual(sleeps, [SEND_SPACING_MS, SEND_SPACING_MS]);
  });

  it("one tick sends at most MAX_SENDS_PER_TICK", async () => {
    const many = Array.from({ length: MAX_SENDS_PER_TICK + 5 }, () => user());
    const db = fakeDb(many);
    const rec = recorder();
    const s = await runLifecycleTick({ ...db, ...rec, env: ENV, now: () => NOW, sleep: noSleep });
    assert.equal(s.sent, MAX_SENDS_PER_TICK);
  });
});

describe("LIFE-1 runner — skip rules", () => {
  it("🔴 Day 1 skips an account with a plan — by the stamp, or by a committed plan without one", async () => {
    const base = { createdAt: new Date(NOW.getTime() - 25 * H), lifecycleEmailSends: [{ kind: "welcome" }] };
    const stamped = user({ ...base, firstPlanCreatedAt: new Date() });
    const unstamped = user(base);
    const none = user(base);
    const db = fakeDb([stamped, unstamped, none], { committedPlans: [unstamped.id] });
    const rec = recorder();
    await runLifecycleTick({ ...db, ...rec, env: ENV, now: () => NOW, sleep: noSleep });
    assert.deepEqual(rec.sent.map((m) => m.to), [none.email]);
  });

  it("🔴 a paying subscriber gets no free-time email", async () => {
    const end = new Date(NOW.getTime() + 48 * H);
    const sent = [{ kind: "welcome" }, { kind: "day1" }, { kind: "day3" }, { kind: "day5" }];
    const old = new Date(NOW.getTime() - 12 * 24 * H);
    const paying = user({ createdAt: old, lifecycleEmailSends: sent, subscription: { status: "active", source: "stripe", trialEndsAt: end } });
    const storePaid = user({ createdAt: old, lifecycleEmailSends: sent, subscription: { status: "trialing", source: "google", trialEndsAt: end } });
    const free = user({ createdAt: old, lifecycleEmailSends: sent, subscription: { status: "trialing", source: null, trialEndsAt: end } });
    const db = fakeDb([paying, storePaid, free]);
    const rec = recorder();
    await runLifecycleTick({ ...db, ...rec, env: ENV, now: () => NOW, sleep: noSleep });
    assert.deepEqual(rec.sent.map((m) => m.to), [free.email]);
  });

  it("🔴 BILLING_ENFORCED off: no free-time email, and the trial branch is not even queried", async () => {
    const end = new Date(NOW.getTime() + 48 * H);
    const u = user({
      createdAt: new Date(NOW.getTime() - 12 * 24 * H),
      lifecycleEmailSends: [{ kind: "welcome" }, { kind: "day1" }, { kind: "day3" }, { kind: "day5" }],
      subscription: { status: "trialing", source: null, trialEndsAt: end },
    });
    const db = fakeDb([u]);
    const rec = recorder();
    await runLifecycleTick({ ...db, ...rec, env: { ...ENV, BILLING_ENFORCED: undefined }, now: () => NOW, sleep: noSleep });
    assert.equal(rec.sent.length, 0);
    assert.equal(JSON.stringify(db.calls.wheres[0]).includes("trialEndsAt"), false);
  });

  it("fixture addresses (example.com, *.test …) are never sent to and never claimed", async () => {
    const db = fakeDb([user({ email: "someone@example.com" }), user({ email: "a@b.test" })]);
    const rec = recorder();
    const s = await runLifecycleTick({ ...db, ...rec, env: ENV, now: () => NOW, sleep: noSleep });
    assert.equal(rec.sent.length, 0);
    assert.equal(db.sends.length, 0);
    assert.equal(s.skipped, 2);
    assert.equal(isUndeliverable("hans@gmail.com"), false);
    assert.equal(isUndeliverable("hans@kitchenwizard.ai"), false);
    assert.equal(isUndeliverable("x@privaterelay.appleid.com"), false);
  });

  it("🔴 no JWT_SECRET → no unsubscribe link → every email but the welcome is refused, nothing claimed", async () => {
    const u = user({ createdAt: new Date(NOW.getTime() - 25 * H), lifecycleEmailSends: [{ kind: "welcome" }] });
    const db = fakeDb([u]);
    const rec = recorder();
    await runLifecycleTick({ ...db, ...rec, env: { ...ENV, JWT_SECRET: undefined }, now: () => NOW, sleep: noSleep });
    assert.equal(rec.sent.length, 0);
    assert.equal(db.sends.length, 0);
  });
});

describe("LIFE-1 runner — once only, opt-out, failures", () => {
  it("🔴 a second tick sends nothing that the first already sent", async () => {
    const db = fakeDb([user(), user()]);
    const rec = recorder();
    await runLifecycleTick({ ...db, ...rec, env: ENV, now: () => NOW, sleep: noSleep });
    const again = await runLifecycleTick({ ...db, ...rec, env: ENV, now: () => new Date(NOW.getTime() + H), sleep: noSleep });
    assert.equal(rec.sent.length, 2);
    assert.equal(again.sent, 0);
  });

  it("🔴 a claim held by another tick (the unique key) means no second send", async () => {
    const u = user();
    const db = fakeDb([u]);
    await db.raw.lifecycleEmailSend.create({ data: { userId: u.id, kind: "welcome" } });
    // The account row this tick reads predates the other tick's claim.
    db.raw.user.findMany = async () => [u];
    const rec = recorder();
    const s = await runLifecycleTick({ ...db, ...rec, env: ENV, now: () => NOW, sleep: noSleep });
    assert.equal(rec.sent.length, 0);
    assert.equal(s.skipped, 1);
  });

  it("🔴 the signup welcome and the tick cannot both send it", async () => {
    const u = user();
    const db = fakeDb([u]);
    const rec = recorder();
    await sendWelcomeEmail(u.id, { ...db, ...rec, env: ENV, now: () => NOW });
    await runLifecycleTick({ ...db, ...rec, env: ENV, now: () => NOW, sleep: noSleep });
    assert.equal(rec.sent.length, 1);
  });

  it("🔴 an opted-out account is skipped even when the query returns it; the query asks for opt-out IS NULL", async () => {
    const out = user({ lifecycleEmailOptOutAt: new Date(), createdAt: new Date(NOW.getTime() - 73 * H), lifecycleEmailSends: [{ kind: "welcome" }] });
    const db = fakeDb([out]);
    const rec = recorder();
    await runLifecycleTick({ ...db, ...rec, env: ENV, now: () => NOW, sleep: noSleep });
    assert.equal(rec.sent.length, 0);
    const where = db.calls.wheres[0] as { lifecycleEmailOptOutAt?: unknown; accountStatus?: unknown };
    assert.equal(where.lifecycleEmailOptOutAt, null);
    assert.equal(where.accountStatus, "active");
  });

  it("a refused send releases its claim, and the next tick retries inside the window", async () => {
    const u = user();
    const db = fakeDb([u]);
    const failing = recorder({ sent: false, reason: "send_failed", status: 500 });
    const s1 = await runLifecycleTick({ ...db, ...failing, env: ENV, now: () => NOW, sleep: noSleep });
    assert.equal(s1.failed, 1);
    assert.equal(db.sends.length, 0, "claim released");
    const ok = recorder();
    const s2 = await runLifecycleTick({ ...db, ...ok, env: ENV, now: () => new Date(NOW.getTime() + H), sleep: noSleep });
    assert.equal(s2.sent, 1);
  });

  it("mail not configured (no_api_key) stops the tick after the first refusal", async () => {
    const db = fakeDb([user(), user(), user()]);
    const rec = recorder({ sent: false, reason: "no_api_key" });
    const s = await runLifecycleTick({ ...db, ...rec, env: ENV, now: () => NOW, sleep: noSleep });
    assert.equal(rec.sent.length, 1);
    assert.equal(s.stoppedFor, "no_api_key");
    assert.equal(db.sends.length, 0);
  });

  it("the signup welcome never throws, whatever the database does", async () => {
    const boom = { user: { findUnique: async () => { throw new Error("db down"); } } };
    await sendWelcomeEmail("u1", { prisma: boom as never, sendEmail: recorder().sendEmail, env: ENV, now: () => NOW });
  });

  it("the signup welcome sends only while the welcome is due (not for an old account)", async () => {
    const old = user({ createdAt: new Date(NOW.getTime() - 30 * H) });
    const db = fakeDb([old]);
    const rec = recorder();
    await sendWelcomeEmail(old.id, { ...db, ...rec, env: ENV, now: () => NOW });
    assert.equal(rec.sent.length, 0);
  });
});

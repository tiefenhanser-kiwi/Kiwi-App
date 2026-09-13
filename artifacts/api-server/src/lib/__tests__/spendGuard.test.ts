// D-WS9-240 — spend guard unit tests.
// Run via: pnpm --filter @workspace/api-server test
//
// Each check: refuses AT the boundary, passes one below it. UTC-day rollover.
// Unset env = pass-through with zero DB reads. Prisma is a recording stub —
// the guard never writes, so the stub has no `create`.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  AI_DISABLED_RETRY_AFTER_SECONDS,
  checkSpendGuard,
  readSpendGuardConfig,
  secondsUntilNextUtcDay,
  utcDayStart,
  _resetSpendGuardLogSampling,
} from "../spendGuard";
import type { PrismaLike } from "../ai/promptRegistry";
import {
  aiFailureStatus,
  userFacingMessage,
  withAIFailureStatus,
  SPEND_CAP_USER_COPY,
  AI_UNAVAILABLE_COPY,
} from "../ai/errors";

// ── stub prisma ────────────────────────────────────────────────────────

interface StubCalls {
  aggregate: Array<{ where: unknown }>;
  count: Array<{ where: unknown }>;
}

function makePrisma(opts: {
  spentToday?: number | null;
  userCallsToday?: number;
  throwOn?: "aggregate" | "count";
  // Omit the read surface entirely (simulates the pre-existing test stubs).
  bare?: boolean;
}): { prisma: PrismaLike; calls: StubCalls } {
  const calls: StubCalls = { aggregate: [], count: [] };
  const lLMCallLog: PrismaLike["lLMCallLog"] = {
    create: async () => {
      throw new Error("spend guard must never write LLMCallLog");
    },
  };
  if (!opts.bare) {
    lLMCallLog.aggregate = async (args) => {
      calls.aggregate.push({ where: args.where });
      if (opts.throwOn === "aggregate") throw new Error("neon asleep");
      // Mimic Prisma: a Decimal-ish object (has toString), or null on an empty day.
      const v = opts.spentToday;
      return {
        _sum: {
          costEstimateUsd:
            v == null ? null : { toString: () => String(v) },
        },
      };
    };
    lLMCallLog.count = async (args) => {
      calls.count.push({ where: args.where });
      if (opts.throwOn === "count") throw new Error("neon asleep");
      return opts.userCallsToday ?? 0;
    };
  }
  const prisma = {
    aIPrompt: { findUnique: async () => null },
    systemSetting: { findUnique: async () => null },
    lLMCallLog,
  } as unknown as PrismaLike;
  return { prisma, calls };
}

const NOW = new Date("2026-09-13T15:30:00.000Z");
const USER = "user-1";

beforeEach(() => _resetSpendGuardLogSampling());

// ── env parsing ────────────────────────────────────────────────────────

describe("readSpendGuardConfig", () => {
  it("unset env = every check disabled", () => {
    const cfg = readSpendGuardConfig({});
    assert.deepEqual(cfg, {
      disabled: false,
      dailyCeilingUsd: null,
      userDailyCalls: null,
    });
  });

  it("parses the three variables; blank and garbage disable a check", () => {
    assert.equal(readSpendGuardConfig({ AI_DISABLED: "1" }).disabled, true);
    assert.equal(readSpendGuardConfig({ AI_DISABLED: "TRUE" }).disabled, true);
    assert.equal(readSpendGuardConfig({ AI_DISABLED: "0" }).disabled, false);
    assert.equal(readSpendGuardConfig({ AI_DISABLED: "false" }).disabled, false);
    assert.equal(readSpendGuardConfig({ AI_DISABLED: "" }).disabled, false);
    assert.equal(
      readSpendGuardConfig({ AI_DAILY_CEILING_USD: "10" }).dailyCeilingUsd,
      10,
    );
    assert.equal(
      readSpendGuardConfig({ AI_DAILY_CEILING_USD: "0" }).dailyCeilingUsd,
      0,
    );
    assert.equal(
      readSpendGuardConfig({ AI_DAILY_CEILING_USD: " " }).dailyCeilingUsd,
      null,
    );
    assert.equal(
      readSpendGuardConfig({ AI_DAILY_CEILING_USD: "ten" }).dailyCeilingUsd,
      null,
    );
    assert.equal(
      readSpendGuardConfig({ AI_DAILY_CEILING_USD: "-5" }).dailyCeilingUsd,
      null,
    );
    assert.equal(
      readSpendGuardConfig({ AI_USER_DAILY_CALLS: "500" }).userDailyCalls,
      500,
    );
  });
});

// ── UTC day arithmetic ─────────────────────────────────────────────────

describe("UTC day helpers", () => {
  it("utcDayStart truncates to 00:00:00.000Z of the same UTC date", () => {
    assert.equal(
      utcDayStart(NOW).toISOString(),
      "2026-09-13T00:00:00.000Z",
    );
    // One ms before midnight still belongs to the 13th.
    assert.equal(
      utcDayStart(new Date("2026-09-13T23:59:59.999Z")).toISOString(),
      "2026-09-13T00:00:00.000Z",
    );
    // Midnight itself is the 14th.
    assert.equal(
      utcDayStart(new Date("2026-09-14T00:00:00.000Z")).toISOString(),
      "2026-09-14T00:00:00.000Z",
    );
  });

  it("secondsUntilNextUtcDay counts to the next UTC midnight, never below 1", () => {
    // 15:30:00 → 8h30m = 30600s.
    assert.equal(secondsUntilNextUtcDay(NOW), 30600);
    assert.equal(
      secondsUntilNextUtcDay(new Date("2026-09-13T23:59:59.500Z")),
      1,
    );
    assert.equal(
      secondsUntilNextUtcDay(new Date("2026-09-13T00:00:00.000Z")),
      86400,
    );
  });
});

// ── the check ──────────────────────────────────────────────────────────

describe("checkSpendGuard — unset env", () => {
  it("passes through with ZERO DB reads", async () => {
    const { prisma, calls } = makePrisma({ spentToday: 999, userCallsToday: 999 });
    const v = await checkSpendGuard({ prisma, userId: USER, promptKey: "k", env: {}, now: NOW });
    assert.deepEqual(v, { refused: false });
    assert.equal(calls.aggregate.length, 0);
    assert.equal(calls.count.length, 0);
  });
});

describe("checkSpendGuard — kill switch", () => {
  it("AI_DISABLED refuses everything before any DB read, with a fixed Retry-After", async () => {
    const { prisma, calls } = makePrisma({ spentToday: 0, userCallsToday: 0 });
    const v = await checkSpendGuard({
      prisma,
      userId: USER,
      promptKey: "k",
      env: { AI_DISABLED: "true", AI_DAILY_CEILING_USD: "10", AI_USER_DAILY_CALLS: "500" },
      now: NOW,
    });
    assert.deepEqual(v, {
      refused: true,
      reason: "ai_disabled",
      retryAfterSeconds: AI_DISABLED_RETRY_AFTER_SECONDS,
    });
    assert.equal(calls.aggregate.length, 0);
    assert.equal(calls.count.length, 0);
  });

  it("refuses system-triggered (null userId) calls too", async () => {
    const { prisma } = makePrisma({});
    const v = await checkSpendGuard({
      prisma, userId: null, promptKey: "k", env: { AI_DISABLED: "yes" }, now: NOW,
    });
    assert.equal(v.refused, true);
  });
});

describe("checkSpendGuard — global daily ceiling", () => {
  const env = { AI_DAILY_CEILING_USD: "10" };

  it("refuses AT the ceiling", async () => {
    const { prisma } = makePrisma({ spentToday: 10 });
    const v = await checkSpendGuard({ prisma, userId: USER, promptKey: "k", env, now: NOW });
    assert.deepEqual(v, {
      refused: true,
      reason: "spend_cap_global",
      retryAfterSeconds: 30600,
    });
  });

  it("passes one cent below the ceiling", async () => {
    const { prisma } = makePrisma({ spentToday: 9.99 });
    const v = await checkSpendGuard({ prisma, userId: USER, promptKey: "k", env, now: NOW });
    assert.deepEqual(v, { refused: false });
  });

  it("queries the current UTC day and user-attributed rows only", async () => {
    const { prisma, calls } = makePrisma({ spentToday: 0 });
    await checkSpendGuard({ prisma, userId: USER, promptKey: "k", env, now: NOW });
    assert.equal(calls.aggregate.length, 1);
    assert.deepEqual(calls.aggregate[0].where, {
      createdAt: { gte: new Date("2026-09-13T00:00:00.000Z") },
      userId: { not: null },
    });
  });

  it("an empty day (null sum) is $0 and passes", async () => {
    const { prisma } = makePrisma({ spentToday: null });
    const v = await checkSpendGuard({ prisma, userId: USER, promptKey: "k", env, now: NOW });
    assert.deepEqual(v, { refused: false });
  });

  it("applies to null-userId callers as well (the sum is global)", async () => {
    const { prisma } = makePrisma({ spentToday: 10 });
    const v = await checkSpendGuard({ prisma, userId: null, promptKey: "k", env, now: NOW });
    assert.equal(v.refused && v.reason, "spend_cap_global");
  });

  it("UTC-day rollover: the day window moves with `now`", async () => {
    const { prisma, calls } = makePrisma({ spentToday: 0 });
    await checkSpendGuard({
      prisma, userId: USER, promptKey: "k", env, now: new Date("2026-09-14T00:00:00.000Z"),
    });
    assert.deepEqual(
      (calls.aggregate[0].where as { createdAt: { gte: Date } }).createdAt.gte,
      new Date("2026-09-14T00:00:00.000Z"),
    );
  });

  it("a ceiling of 0 refuses everything (kill switch by another name)", async () => {
    const { prisma } = makePrisma({ spentToday: null });
    const v = await checkSpendGuard({
      prisma, userId: USER, promptKey: "k", env: { AI_DAILY_CEILING_USD: "0" }, now: NOW,
    });
    assert.equal(v.refused && v.reason, "spend_cap_global");
  });

  it("fails OPEN when the DB read throws", async () => {
    const { prisma } = makePrisma({ throwOn: "aggregate" });
    const v = await checkSpendGuard({ prisma, userId: USER, promptKey: "k", env, now: NOW });
    assert.deepEqual(v, { refused: false });
  });
});

describe("checkSpendGuard — per-user daily cap", () => {
  const env = { AI_USER_DAILY_CALLS: "500" };

  it("refuses AT the cap", async () => {
    const { prisma } = makePrisma({ userCallsToday: 500 });
    const v = await checkSpendGuard({ prisma, userId: USER, promptKey: "k", env, now: NOW });
    assert.deepEqual(v, {
      refused: true,
      reason: "spend_cap_user",
      retryAfterSeconds: 30600,
    });
  });

  it("passes one call below the cap", async () => {
    const { prisma } = makePrisma({ userCallsToday: 499 });
    const v = await checkSpendGuard({ prisma, userId: USER, promptKey: "k", env, now: NOW });
    assert.deepEqual(v, { refused: false });
  });

  it("counts THIS user over the current UTC day", async () => {
    const { prisma, calls } = makePrisma({ userCallsToday: 0 });
    await checkSpendGuard({ prisma, userId: USER, promptKey: "k", env, now: NOW });
    assert.equal(calls.count.length, 1);
    assert.deepEqual(calls.count[0].where, {
      userId: USER,
      createdAt: { gte: new Date("2026-09-13T00:00:00.000Z") },
    });
  });

  it("does not apply to null-userId (system) callers — no count query", async () => {
    const { prisma, calls } = makePrisma({ userCallsToday: 9999 });
    const v = await checkSpendGuard({ prisma, userId: null, promptKey: "k", env, now: NOW });
    assert.deepEqual(v, { refused: false });
    assert.equal(calls.count.length, 0);
  });

  it("fails OPEN when the DB read throws", async () => {
    const { prisma } = makePrisma({ throwOn: "count" });
    const v = await checkSpendGuard({ prisma, userId: USER, promptKey: "k", env, now: NOW });
    assert.deepEqual(v, { refused: false });
  });
});

describe("checkSpendGuard — ordering and degenerate prisma", () => {
  it("global ceiling wins over the per-user cap when both trip", async () => {
    const { prisma, calls } = makePrisma({ spentToday: 10, userCallsToday: 500 });
    const v = await checkSpendGuard({
      prisma, userId: USER, promptKey: "k",
      env: { AI_DAILY_CEILING_USD: "10", AI_USER_DAILY_CALLS: "500" }, now: NOW,
    });
    assert.equal(v.refused && v.reason, "spend_cap_global");
    // Short-circuited: the per-user count never ran.
    assert.equal(calls.count.length, 0);
  });

  it("both configured, both under: exactly two reads", async () => {
    const { prisma, calls } = makePrisma({ spentToday: 1, userCallsToday: 1 });
    const v = await checkSpendGuard({
      prisma, userId: USER, promptKey: "k",
      env: { AI_DAILY_CEILING_USD: "10", AI_USER_DAILY_CALLS: "500" }, now: NOW,
    });
    assert.deepEqual(v, { refused: false });
    assert.equal(calls.aggregate.length, 1);
    assert.equal(calls.count.length, 1);
  });

  it("no prisma / a stub without the read surface passes through", async () => {
    const env = { AI_DAILY_CEILING_USD: "0", AI_USER_DAILY_CALLS: "0" };
    const v1 = await checkSpendGuard({ prisma: null, userId: USER, promptKey: "k", env, now: NOW });
    assert.deepEqual(v1, { refused: false });
    const { prisma } = makePrisma({ bare: true });
    const v2 = await checkSpendGuard({ prisma, userId: USER, promptKey: "k", env, now: NOW });
    assert.deepEqual(v2, { refused: false });
  });
});

// ── HTTP mapping + copy ────────────────────────────────────────────────

describe("aiFailureStatus / withAIFailureStatus / copy", () => {
  it("maps the three guard reasons; everything else stays 502", () => {
    assert.deepEqual(aiFailureStatus("spend_cap_user", NOW), {
      status: 429,
      retryAfterSeconds: 30600,
    });
    assert.deepEqual(aiFailureStatus("spend_cap_global", NOW), {
      status: 503,
      retryAfterSeconds: 30600,
    });
    assert.deepEqual(aiFailureStatus("ai_disabled", NOW), {
      status: 503,
      retryAfterSeconds: AI_DISABLED_RETRY_AFTER_SECONDS,
    });
    for (const r of ["sdk_error", "validation_failed", "parse_failed", "no_api_key", "rate_limited", "meal_failed:Tacos"]) {
      assert.deepEqual(aiFailureStatus(r, NOW), { status: 502 }, r);
    }
  });

  it("withAIFailureStatus sets Retry-After only for guard reasons", () => {
    const make = () => {
      const headers: Record<string, string> = {};
      let code = 0;
      const res = {
        setHeader(k: string, v: string) { headers[k] = v; },
        status(c: number) { code = c; return res; },
        code: () => code,
        headers,
      };
      return res;
    };
    const a = make();
    withAIFailureStatus(a, "spend_cap_user", NOW);
    assert.equal(a.code(), 429);
    assert.equal(a.headers["Retry-After"], "30600");

    const b = make();
    withAIFailureStatus(b, "sdk_error", NOW);
    assert.equal(b.code(), 502);
    assert.equal(b.headers["Retry-After"], undefined);
  });

  it("copy: per-user is the planning-limit sentence; global/disabled is the short-break sentence", () => {
    assert.equal(userFacingMessage("spend_cap_user"), SPEND_CAP_USER_COPY);
    assert.equal(userFacingMessage("spend_cap_global"), AI_UNAVAILABLE_COPY);
    assert.equal(userFacingMessage("ai_disabled"), AI_UNAVAILABLE_COPY);
    // Not D-WS9-229's rate-limit copy.
    assert.ok(!SPEND_CAP_USER_COPY.includes("missing the mark"));
    assert.ok(!AI_UNAVAILABLE_COPY.includes("missing the mark"));
  });
});

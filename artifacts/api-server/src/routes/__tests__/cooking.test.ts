// WS6 6d-1 + 6d-2 — Cook Mode family route tests.
// Real Express + JWT; loaders + AI stubbed at the deps boundary.
// 6d-1 tests cover POST /api/meals/:mealId/cooking-sequence.
// 6d-2 tests cover POST /api/plans/:planId/prep-week.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import {
  CookingSequenceAIError,
  CookingSequenceEmptyMealError,
  CookingSequenceNotFoundError,
  EMPTY_MEAL_COPY,
  type CookingSequenceResult,
} from "../../lib/cookingSequence";
import {
  PrepWeekEmptyPlanError,
  PrepWeekNotFoundError,
  EMPTY_PLAN_COPY,
} from "../../lib/prepWeekAggregation";
import type { PrepWeekResult } from "../../lib/ai/schemas/prepWeek";
import { createCookingRouter } from "../cooking";

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function spinUp(
  deps: Parameters<typeof createCookingRouter>[0],
): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use("/api", createCookingRouter(deps));

  return await new Promise<Harness>((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("server did not bind"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/api`,
        close: () =>
          new Promise<void>((r, j) =>
            server.close((err) => (err ? j(err) : r())),
          ),
      });
    });
  });
}

const TEST_USER_ID = "test-user-cooking-route";

const HAPPY_MULTI_DISH_RESULT: CookingSequenceResult = {
  sequence: [
    {
      dishId: "dish-a",
      originalStepIndex: 0,
      sequenceIndex: 0,
      startsAtMinutes: 0,
      reason: "Lead with the protein sear.",
    },
    {
      dishId: "dish-b",
      originalStepIndex: 0,
      sequenceIndex: 1,
      startsAtMinutes: 1,
    },
  ],
  totalEstimatedMinutes: 12,
  dishCount: 2,
  usedAI: true,
};

describe("POST /api/meals/:mealId/cooking-sequence — auth", () => {
  let harness: Harness;
  before(async () => {
    harness = await spinUp({
      runCookingSequence: (async () => HAPPY_MULTI_DISH_RESULT) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: {} as any,
    });
  });
  after(async () => harness.close());

  it("returns 401 when the Authorization header is missing", async () => {
    const res = await fetch(
      `${harness.baseUrl}/meals/meal-abc/cooking-sequence`,
      { method: "POST" },
    );
    assert.equal(res.status, 401);
  });
});

describe("POST /api/meals/:mealId/cooking-sequence — happy multi-dish", () => {
  let harness: Harness;
  let calls = 0;
  let lastMealId: string | null = null;

  before(async () => {
    harness = await spinUp({
      runCookingSequence: (async ({ mealId }: { mealId: string }) => {
        calls++;
        lastMealId = mealId;
        return HAPPY_MULTI_DISH_RESULT;
      }) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: {} as any,
    });
  });
  after(async () => harness.close());

  it("returns 200 with the sequence + dishCount + usedAI flags", async () => {
    const token = signToken(TEST_USER_ID);
    const res = await fetch(
      `${harness.baseUrl}/meals/meal-multi/cooking-sequence`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as CookingSequenceResult;
    assert.equal(body.dishCount, 2);
    assert.equal(body.usedAI, true);
    assert.equal(body.totalEstimatedMinutes, 12);
    assert.equal(body.sequence.length, 2);
    assert.equal(body.sequence[0].reason, "Lead with the protein sear.");
    assert.equal(calls, 1);
    assert.equal(lastMealId, "meal-multi");
  });
});

describe("POST /api/meals/:mealId/cooking-sequence — error mapping", () => {
  let harness: Harness;
  before(async () => {
    harness = await spinUp({
      runCookingSequence: (async ({ mealId }: { mealId: string }) => {
        if (mealId === "missing") throw new CookingSequenceNotFoundError(mealId);
        if (mealId === "stranger") throw new CookingSequenceNotFoundError(mealId);
        if (mealId === "empty") throw new CookingSequenceEmptyMealError(mealId);
        if (mealId === "ai-fail") {
          throw new CookingSequenceAIError(
            "Kiwi got distracted. Try again?",
            "validation_failed",
          );
        }
        return HAPPY_MULTI_DISH_RESULT;
      }) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: {} as any,
    });
  });
  after(async () => harness.close());

  const token = () => signToken(TEST_USER_ID + "-errors");
  const post = (mealId: string) =>
    fetch(`${harness.baseUrl}/meals/${mealId}/cooking-sequence`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}` },
    });

  it("returns 404 when the meal is not found", async () => {
    const res = await post("missing");
    assert.equal(res.status, 404);
  });

  it("returns 404 when the meal is not the caller's (no leak)", async () => {
    const res = await post("stranger");
    assert.equal(res.status, 404);
  });

  it("returns 400 with the locked empty-meal copy", async () => {
    const res = await post("empty");
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, EMPTY_MEAL_COPY);
    // Make sure the copy actually mentions the "didn't find anything to cook"
    // hook — guard against silent message edits.
    assert.match(body.error, /didn't find anything to cook/);
  });

  it("returns 502 with the AI failure user-facing message", async () => {
    const res = await post("ai-fail");
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string; reason: string };
    assert.match(body.error, /Kiwi got distracted/);
    assert.equal(body.reason, "validation_failed");
  });
});

describe("POST /api/meals/:mealId/cooking-sequence — rate limit", () => {
  let harness: Harness;
  let calls = 0;

  before(async () => {
    harness = await spinUp({
      runCookingSequence: (async () => {
        calls++;
        return HAPPY_MULTI_DISH_RESULT;
      }) as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: {} as any,
      rateLimiterOpts: { capacity: 2, refillPerSec: 0 },
    });
  });
  after(async () => harness.close());

  it("returns 429 once the per-user bucket is empty", async () => {
    const token = signToken(TEST_USER_ID + "-rate");
    const post = () =>
      fetch(`${harness.baseUrl}/meals/meal-rl/cooking-sequence`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

    const r1 = await post();
    const r2 = await post();
    const r3 = await post();

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 429);
    assert.equal(calls, 2);
  });
});

// ── 6d-2 — POST /api/plans/:planId/prep-week ─────────────────────────

const PLAN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEAL_ID_X = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function happyPrepWeekResult(): PrepWeekResult {
  return {
    totalEstimatedMinutes: 8,
    phases: [
      {
        phase: "seasonings_dry",
        title: "Seasonings & dry ingredients",
        skippable: true,
        steps: [],
      },
      {
        phase: "sauces_marinades",
        title: "Sauces, marinades & garnishes",
        skippable: true,
        steps: [],
      },
      {
        phase: "produce",
        title: "Produce",
        skippable: false,
        steps: [
          {
            number: 1,
            title: "Dice onion",
            instructions: "Dice 2 onions total.",
            estimatedMinutes: 5,
            contributesToMealIds: [MEAL_ID_X],
          },
        ],
      },
      {
        phase: "proteins",
        title: "Proteins",
        skippable: false,
        steps: [
          {
            number: 1,
            title: "Portion chicken",
            instructions: "Cube 1 lb chicken.",
            estimatedMinutes: 3,
            contributesToMealIds: [MEAL_ID_X],
          },
        ],
      },
    ],
  };
}

// In-memory cache stub for PrepWeekStructure.upsert/findUnique.
function makeCacheStub() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = new Map<string, any>();
  let writeCount = 0;
  let llmLogWrites = 0;
  return {
    rows,
    writeCount: () => writeCount,
    llmLogWrites: () => llmLogWrites,
    incLog: () => {
      llmLogWrites++;
    },
    prisma: {
      prepWeekStructure: {
        findUnique: async ({ where }: { where: { planId: string } }) =>
          rows.get(where.planId) ?? null,
        upsert: async ({
          where,
          create,
          update,
        }: {
          where: { planId: string };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          create: any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          update: any;
        }) => {
          writeCount++;
          const existing = rows.get(where.planId);
          if (existing) {
            const next = { ...existing, ...update };
            rows.set(where.planId, next);
            return next;
          }
          const row = { id: `row-${rows.size + 1}`, ...create, ...where };
          rows.set(where.planId, row);
          return row;
        },
      },
    },
  };
}

// Minimal loader stub: returns a valid PrepWeekInput shape.
function makeLoaderStub(opts: {
  planRevisionId: number;
  mealIds: string[];
  throwOn?: "not_found" | "empty";
}) {
  return (async (params: { planId: string }) => {
    if (opts.throwOn === "not_found") {
      throw new PrepWeekNotFoundError(params.planId);
    }
    if (opts.throwOn === "empty") {
      throw new PrepWeekEmptyPlanError(params.planId);
    }
    return {
      input: {
        planId: params.planId,
        planName: "Test Plan",
        meals: opts.mealIds.map((mealId) => ({
          mealId,
          mealName: "M",
          servings: 4,
          dishes: [
            {
              dishId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              dishName: "D",
              ingredients: [
                {
                  ingredientId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                  ingredientName: "onion",
                  quantity: 1,
                  unit: "medium",
                },
              ],
            },
          ],
        })),
      },
      planRevisionId: opts.planRevisionId,
    };
  }) as never;
}

function makeAICallStub(opts: {
  result?: PrepWeekResult;
  failure?: { reason: string; userFacingMessage: string };
  onCall?: () => void;
  promptVersion?: number;
}) {
  return (async () => {
    opts.onCall?.();
    if (opts.failure) {
      return {
        success: false,
        reason: opts.failure.reason,
        userFacingMessage: opts.failure.userFacingMessage,
        metadata: {},
      };
    }
    return {
      success: true,
      data: opts.result ?? happyPrepWeekResult(),
      metadata: {
        promptKey: "prep.aggregation_logic",
        promptVersion: opts.promptVersion ?? 1,
        model: "claude-sonnet-4-6",
        mode: "tool",
        latencyMs: 1234,
        inputTokens: 100,
        outputTokens: 200,
        costEstimateUsd: 0.02,
        retryCount: 0,
      },
    };
  }) as never;
}

describe("POST /api/plans/:planId/prep-week — auth + entitlement + validation", () => {
  it("returns 401 without auth", async () => {
    const cache = makeCacheStub();
    const harness = await spinUp({
      loadPrepWeekInput: makeLoaderStub({ planRevisionId: 1, mealIds: [MEAL_ID_X] }),
      runAICall: makeAICallStub({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: cache.prisma as any,
      subscriptionService: { can: async () => ({ allowed: true }) },
    });
    try {
      const res = await fetch(`${harness.baseUrl}/plans/${PLAN_ID}/prep-week`, {
        method: "POST",
      });
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });

  it("returns 402 when entitlement check denies", async () => {
    const cache = makeCacheStub();
    const harness = await spinUp({
      loadPrepWeekInput: makeLoaderStub({ planRevisionId: 1, mealIds: [MEAL_ID_X] }),
      runAICall: makeAICallStub({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: cache.prisma as any,
      subscriptionService: {
        can: async () => ({ allowed: false, reason: "Premium only — sign up." }),
      },
    });
    try {
      const token = signToken("u-402");
      const res = await fetch(`${harness.baseUrl}/plans/${PLAN_ID}/prep-week`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 402);
      const body = (await res.json()) as { error: string; reason: string };
      assert.equal(body.error, "upgrade required");
      assert.match(body.reason, /Premium/);
    } finally {
      await harness.close();
    }
  });

  it("returns 400 when planId is not a UUID", async () => {
    const cache = makeCacheStub();
    const harness = await spinUp({
      loadPrepWeekInput: makeLoaderStub({ planRevisionId: 1, mealIds: [MEAL_ID_X] }),
      runAICall: makeAICallStub({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: cache.prisma as any,
      subscriptionService: { can: async () => ({ allowed: true }) },
    });
    try {
      const token = signToken("u-400");
      const res = await fetch(`${harness.baseUrl}/plans/not-a-uuid/prep-week`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 400);
    } finally {
      await harness.close();
    }
  });
});

describe("POST /api/plans/:planId/prep-week — cache miss → AI → write", () => {
  it("calls AI, writes PrepWeekStructure row, returns cacheHit=false", async () => {
    const cache = makeCacheStub();
    let aiCalls = 0;
    const harness = await spinUp({
      loadPrepWeekInput: makeLoaderStub({ planRevisionId: 3, mealIds: [MEAL_ID_X] }),
      runAICall: makeAICallStub({
        onCall: () => {
          aiCalls++;
        },
        promptVersion: 4,
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: cache.prisma as any,
      subscriptionService: { can: async () => ({ allowed: true }) },
    });
    try {
      const token = signToken("u-miss");
      const res = await fetch(`${harness.baseUrl}/plans/${PLAN_ID}/prep-week`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        cacheHit: boolean;
        result: PrepWeekResult;
        planRevisionId: number;
        promptVersion: number;
      };
      assert.equal(body.cacheHit, false);
      assert.equal(body.planRevisionId, 3);
      assert.equal(body.promptVersion, 4);
      assert.equal(body.result.phases.length, 4);
      assert.equal(body.result.phases[3].phase, "proteins");
      assert.equal(aiCalls, 1);
      assert.equal(cache.writeCount(), 1);
      // Row stamped with the revisionId the loader returned.
      const row = cache.rows.get(PLAN_ID);
      assert.ok(row);
      assert.equal(row.lastGeneratedFromPlanRevisionId, 3);
      assert.equal(row.promptVersion, 4);
    } finally {
      await harness.close();
    }
  });
});

describe("POST /api/plans/:planId/prep-week — cache hit", () => {
  it("returns cacheHit=true and skips the AI call", async () => {
    const cache = makeCacheStub();
    // Pre-seed the cache with a matching revisionId.
    const cached = happyPrepWeekResult();
    cache.rows.set(PLAN_ID, {
      id: "row-pre",
      planId: PLAN_ID,
      structureJson: cached,
      lastGeneratedFromPlanRevisionId: 5,
      lastGeneratedAt: new Date("2026-05-10T12:00:00Z"),
      promptVersion: 2,
    });
    let aiCalls = 0;
    const harness = await spinUp({
      loadPrepWeekInput: makeLoaderStub({ planRevisionId: 5, mealIds: [MEAL_ID_X] }),
      runAICall: makeAICallStub({
        onCall: () => {
          aiCalls++;
        },
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: cache.prisma as any,
      subscriptionService: { can: async () => ({ allowed: true }) },
    });
    try {
      const token = signToken("u-hit");
      const res = await fetch(`${harness.baseUrl}/plans/${PLAN_ID}/prep-week`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        cacheHit: boolean;
        result: PrepWeekResult;
        planRevisionId: number;
        promptVersion: number;
      };
      assert.equal(body.cacheHit, true);
      assert.equal(body.planRevisionId, 5);
      assert.equal(body.promptVersion, 2);
      // AI not invoked.
      assert.equal(aiCalls, 0);
      // No new write — row only existed from pre-seed.
      assert.equal(cache.writeCount(), 0);
    } finally {
      await harness.close();
    }
  });
});

describe("POST /api/plans/:planId/prep-week — stale cache", () => {
  it("regenerates when revisionId moved and updates (not duplicates) the row", async () => {
    const cache = makeCacheStub();
    const oldResult = happyPrepWeekResult();
    oldResult.totalEstimatedMinutes = 99; // marker for "old"
    cache.rows.set(PLAN_ID, {
      id: "row-old",
      planId: PLAN_ID,
      structureJson: oldResult,
      lastGeneratedFromPlanRevisionId: 2,
      lastGeneratedAt: new Date("2026-05-01T12:00:00Z"),
      promptVersion: 1,
    });
    let aiCalls = 0;
    const harness = await spinUp({
      loadPrepWeekInput: makeLoaderStub({ planRevisionId: 9, mealIds: [MEAL_ID_X] }),
      runAICall: makeAICallStub({
        onCall: () => {
          aiCalls++;
        },
        promptVersion: 3,
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: cache.prisma as any,
      subscriptionService: { can: async () => ({ allowed: true }) },
    });
    try {
      const token = signToken("u-stale");
      const res = await fetch(`${harness.baseUrl}/plans/${PLAN_ID}/prep-week`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        cacheHit: boolean;
        result: PrepWeekResult;
        planRevisionId: number;
      };
      assert.equal(body.cacheHit, false);
      assert.equal(body.planRevisionId, 9);
      // New result, not 99.
      assert.notEqual(body.result.totalEstimatedMinutes, 99);
      assert.equal(aiCalls, 1);
      // Still exactly one row in the cache map.
      assert.equal(cache.rows.size, 1);
      const row = cache.rows.get(PLAN_ID);
      assert.ok(row);
      assert.equal(row.lastGeneratedFromPlanRevisionId, 9);
      assert.equal(row.promptVersion, 3);
    } finally {
      await harness.close();
    }
  });
});

describe("POST /api/plans/:planId/prep-week — loader error mapping", () => {
  it("returns 404 when the plan is not found", async () => {
    const cache = makeCacheStub();
    const harness = await spinUp({
      loadPrepWeekInput: makeLoaderStub({
        planRevisionId: 1,
        mealIds: [MEAL_ID_X],
        throwOn: "not_found",
      }),
      runAICall: makeAICallStub({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: cache.prisma as any,
      subscriptionService: { can: async () => ({ allowed: true }) },
    });
    try {
      const token = signToken("u-nf");
      const res = await fetch(`${harness.baseUrl}/plans/${PLAN_ID}/prep-week`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("returns 400 with the locked empty-plan copy", async () => {
    const cache = makeCacheStub();
    const harness = await spinUp({
      loadPrepWeekInput: makeLoaderStub({
        planRevisionId: 1,
        mealIds: [MEAL_ID_X],
        throwOn: "empty",
      }),
      runAICall: makeAICallStub({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: cache.prisma as any,
      subscriptionService: { can: async () => ({ allowed: true }) },
    });
    try {
      const token = signToken("u-empty");
      const res = await fetch(`${harness.baseUrl}/plans/${PLAN_ID}/prep-week`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, EMPTY_PLAN_COPY);
    } finally {
      await harness.close();
    }
  });
});

describe("POST /api/plans/:planId/prep-week — invalid meal reference guard", () => {
  it("returns 502 when AI returns a contributesToMealIds entry not in input", async () => {
    const cache = makeCacheStub();
    const bogus = happyPrepWeekResult();
    // Replace the meal-id with an invented UUID not present in the input.
    bogus.phases[2].steps[0].contributesToMealIds = [
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
    ];
    const harness = await spinUp({
      loadPrepWeekInput: makeLoaderStub({ planRevisionId: 1, mealIds: [MEAL_ID_X] }),
      runAICall: makeAICallStub({ result: bogus }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: cache.prisma as any,
      subscriptionService: { can: async () => ({ allowed: true }) },
    });
    try {
      const token = signToken("u-bogus");
      const res = await fetch(`${harness.baseUrl}/plans/${PLAN_ID}/prep-week`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 502);
      const body = (await res.json()) as { reason: string };
      assert.equal(body.reason, "invalid_meal_reference");
      // Cache must NOT be written on failure.
      assert.equal(cache.writeCount(), 0);
    } finally {
      await harness.close();
    }
  });
});

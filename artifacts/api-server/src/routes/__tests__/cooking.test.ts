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
      startOffsetMinutes: -12,
      reason: "Lead with the protein sear.",
    },
    {
      dishId: "dish-b",
      originalStepIndex: 0,
      sequenceIndex: 1,
      startOffsetMinutes: -6,
    },
  ],
  totalEstimatedMinutes: 12,
  dishCount: 2,
  // Deterministic path — permanently false; the wire still carries the field.
  usedAI: false,
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
    assert.equal(body.usedAI, false);
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
            stepKey: "produce#ing-onion",
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
            stepKey: "proteins#ing-chicken",
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

// In-memory cache stub for PrepWeekStructure + (B3) PrepStepCompletion and the
// MealPlanInstance ownership/structure lookup the completion endpoints use.
function makeCacheStub() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = new Map<string, any>(); // prepWeekStructure rows by planId
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const planHolder = new Map<string, any>(); // mealPlanInstance config by planId
  let completions: { planId: string; stepKey: string; checkedAt: Date }[] = [];
  let writeCount = 0;
  let llmLogWrites = 0;
  let pruneCalls = 0;
  return {
    rows,
    completionRows: () => completions,
    completionKeys: (planId: string) =>
      completions.filter((c) => c.planId === planId).map((c) => c.stepKey).sort(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setPlan: (planId: string, cfg: any) => planHolder.set(planId, cfg),
    seedCompletion: (planId: string, stepKey: string) =>
      completions.push({ planId, stepKey, checkedAt: new Date() }),
    writeCount: () => writeCount,
    pruneCalls: () => pruneCalls,
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
      prepStepCompletion: {
        findMany: async ({ where }: { where: { planId: string } }) =>
          completions
            .filter((c) => c.planId === where.planId)
            .sort((a, b) => a.checkedAt.getTime() - b.checkedAt.getTime())
            .map((c) => ({ stepKey: c.stepKey, checkedAt: c.checkedAt })),
        upsert: async ({
          where,
        }: {
          where: { planId_stepKey: { planId: string; stepKey: string } };
        }) => {
          const { planId, stepKey } = where.planId_stepKey;
          const ex = completions.find(
            (c) => c.planId === planId && c.stepKey === stepKey,
          );
          if (ex) return ex; // idempotent — keep original checkedAt
          const row = { planId, stepKey, checkedAt: new Date() };
          completions.push(row);
          return row;
        },
        deleteMany: async ({
          where,
        }: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          where: { planId: string; stepKey?: any };
        }) => {
          const { planId, stepKey } = where;
          const before = completions.length;
          if (stepKey && typeof stepKey === "object" && Array.isArray(stepKey.notIn)) {
            // Orphan-prune: keep only rows whose key is in the fresh set.
            pruneCalls++;
            const keep = new Set<string>(stepKey.notIn);
            completions = completions.filter(
              (c) => c.planId !== planId || keep.has(c.stepKey),
            );
          } else {
            // Exact uncheck (or no-op on a missing key).
            completions = completions.filter(
              (c) => !(c.planId === planId && c.stepKey === stepKey),
            );
          }
          return { count: before - completions.length };
        },
      },
      mealPlanInstance: {
        findUnique: async ({
          where,
          select,
        }: {
          where: { id: string };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          select?: any;
        }) => {
          const cfg = planHolder.get(where.id);
          if (!cfg) return null;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const out: any = {};
          if (select?.userId) out.userId = cfg.userId;
          if (select?.prepStatus) out.prepStatus = cfg.prepStatus ?? "not_prepped";
          if (select?.prepStatusIsManual)
            out.prepStatusIsManual = cfg.prepStatusIsManual ?? false;
          if (select?.items)
            out.items = (cfg.mealIds ?? []).map((mealId: string) => ({ mealId }));
          if (select?.prepWeekStructure) {
            const row = rows.get(where.id);
            out.prepWeekStructure = row
              ? { structureJson: row.structureJson }
              : null;
          }
          return out;
        },
      },
    },
  };
}

// Enriched loader stub: returns the PrepLoadedPlan shape the adapter+engine
// consume. Each meal carries one diced produce onion (same ingredientId across
// meals → the engine groups it into ONE produce step whose contributesToMealIds
// is the union of all the meals).
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
        meals: opts.mealIds.map((mealId, idx) => ({
          mealId,
          mealName: `Meal ${idx + 1}`,
          cuisine: null,
          servingsOverride: null,
          dishes: [
            {
              dishId: `dddddddd-dddd-4ddd-8ddd-${String(idx).padStart(12, "0")}`,
              dishName: "Dish",
              baseServings: 4,
              authoredBaseServings: 4,
              stepTexts: [],
              ingredients: [
                {
                  ingredientId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                  ingredientName: "yellow onion",
                  category: "Produce",
                  quantity: 1,
                  unit: "each",
                  preparationNote: "diced",
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

// Narration AI stub. The route now calls runAICall ONLY to narrate the
// code-computed step plan; this stub ECHOES the stepIds it is handed back with
// canned prose. It cannot return a quantity or a mealId — the narration schema
// has no such field — which is exactly the by-construction guarantee.
function makeAICallStub(opts: {
  failure?: { reason: string; userFacingMessage: string };
  onCall?: () => void;
  promptVersion?: number;
  estimatedMinutes?: number;
  // Override the echoed steps (e.g. drop one to force narration_incomplete,
  // or inject garbage prose to prove it can't move the math).
  narrate?: (steps: { stepId: string }[]) => unknown[];
}) {
  return (async (
    _promptKey: string,
    vars: { prepNarrationInput?: { steps: { stepId: string }[] } },
  ) => {
    opts.onCall?.();
    if (opts.failure) {
      return {
        success: false,
        reason: opts.failure.reason,
        userFacingMessage: opts.failure.userFacingMessage,
        metadata: {},
      };
    }
    const inputSteps = vars.prepNarrationInput?.steps ?? [];
    const steps = opts.narrate
      ? opts.narrate(inputSteps)
      : inputSteps.map((s, i) => ({
          stepId: s.stepId,
          title: `Step ${i + 1}`,
          instructions: `Do step ${i + 1}.`,
          estimatedMinutes: opts.estimatedMinutes ?? 5,
        }));
    return {
      success: true,
      data: { steps },
      metadata: {
        promptKey: "prep.narrate_steps",
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

  // BUG-022 — the narration call must raise max_tokens well above runAICall's
  // 4096 default; the whole week is narrated in one shot and a heavy plan
  // truncates the forced tool_use JSON at 4096 → {} → "steps: Required" → 502.
  it("passes a raised maxTokens to the narration call (guards against 4096-truncation)", async () => {
    const cache = makeCacheStub();
    let capturedOpts: { maxTokens?: number } | undefined;
    const capturingRunAICall = (async (
      _promptKey: string,
      vars: { prepNarrationInput?: { steps: { stepId: string }[] } },
      _schema: unknown,
      opts?: { maxTokens?: number },
    ) => {
      capturedOpts = opts;
      const inputSteps = vars.prepNarrationInput?.steps ?? [];
      return {
        success: true,
        data: {
          steps: inputSteps.map((s, i) => ({
            stepId: s.stepId,
            title: `Step ${i + 1}`,
            instructions: `Do step ${i + 1}.`,
            estimatedMinutes: 5,
          })),
        },
        metadata: {
          promptKey: "prep.narrate_steps",
          promptVersion: 1,
          model: "claude-sonnet-4-6",
          mode: "tool",
          latencyMs: 1,
          inputTokens: 100,
          outputTokens: 200,
          costEstimateUsd: 0.01,
          retryCount: 0,
        },
      };
    }) as never;
    const harness = await spinUp({
      loadPrepWeekInput: makeLoaderStub({ planRevisionId: 3, mealIds: [MEAL_ID_X] }),
      runAICall: capturingRunAICall,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: cache.prisma as any,
      subscriptionService: { can: async () => ({ allowed: true }) },
    });
    try {
      const token = signToken("u-maxtokens");
      const res = await fetch(`${harness.baseUrl}/plans/${PLAN_ID}/prep-week`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      assert.ok(capturedOpts, "runAICall opts must be passed");
      assert.equal(capturedOpts!.maxTokens, 16384);
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

describe("POST /api/plans/:planId/prep-week — prose cannot move the math", () => {
  it("contributesToMealIds come from the engine, not the AI narration", async () => {
    const cache = makeCacheStub();
    const MEAL_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const MEAL_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const harness = await spinUp({
      // Two meals share the same onion ingredientId → one produce step whose
      // attribution is the union of both meals.
      loadPrepWeekInput: makeLoaderStub({
        planRevisionId: 1,
        mealIds: [MEAL_A, MEAL_B],
      }),
      // Narration returns garbage prose — and literally cannot return mealIds.
      runAICall: makeAICallStub({
        narrate: (steps) =>
          steps.map((s) => ({
            stepId: s.stepId,
            title: "TOTALLY WRONG TITLE",
            instructions: "Ignore the numbers entirely.",
            estimatedMinutes: 9,
          })),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: cache.prisma as any,
      subscriptionService: { can: async () => ({ allowed: true }) },
    });
    try {
      const token = signToken("u-construct");
      const res = await fetch(`${harness.baseUrl}/plans/${PLAN_ID}/prep-week`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { result: PrepWeekResult };
      const produce = body.result.phases.find((p) => p.phase === "produce")!;
      assert.equal(produce.steps.length, 1);
      // Attribution is code-owned: BOTH meals, regardless of the narration.
      assert.deepEqual(
        [...produce.steps[0].contributesToMealIds].sort(),
        [MEAL_A, MEAL_B].sort(),
      );
      // Prose is the AI's; numbers/attribution are not.
      assert.equal(produce.steps[0].title, "TOTALLY WRONG TITLE");
      assert.equal(produce.steps[0].number, 1);
    } finally {
      await harness.close();
    }
  });

  it("returns 502 (narration_incomplete) when the AI drops a planned step", async () => {
    const cache = makeCacheStub();
    const harness = await spinUp({
      loadPrepWeekInput: makeLoaderStub({ planRevisionId: 1, mealIds: [MEAL_ID_X] }),
      // Narrate nothing → the single planned step is unmatched.
      runAICall: makeAICallStub({ narrate: () => [] }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: cache.prisma as any,
      subscriptionService: { can: async () => ({ allowed: true }) },
    });
    try {
      const token = signToken("u-incomplete");
      const res = await fetch(`${harness.baseUrl}/plans/${PLAN_ID}/prep-week`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 502);
      const body = (await res.json()) as { reason: string };
      assert.equal(body.reason, "narration_incomplete");
      // Nothing persisted on failure.
      assert.equal(cache.writeCount(), 0);
    } finally {
      await harness.close();
    }
  });
});

// ── WS7-8a B3 — prep-step checkbox persistence endpoints ─────────────────────

// The onion ingredientId the loader stub emits → its derived produce stepKey.
const ONION_STEP_KEY = "produce#eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const COMPLETION_OWNER = "u-completions";

// Spin up a router whose plan PLAN_ID is owned by COMPLETION_OWNER. The read
// endpoint recomputes the step set from the injected loader (spinCompletion's
// makeLoaderStub: one onion produce step → ONION_STEP_KEY, for [MEAL_ID_X]).
function completionHarness(opts?: {
  mealIds?: string[];
  prepStatus?: "not_prepped" | "partial" | "prepped";
  prepStatusIsManual?: boolean;
}) {
  const cache = makeCacheStub();
  cache.setPlan(PLAN_ID, {
    userId: COMPLETION_OWNER,
    mealIds: opts?.mealIds ?? [MEAL_ID_X],
    prepStatus: opts?.prepStatus ?? "not_prepped",
    prepStatusIsManual: opts?.prepStatusIsManual ?? false,
  });
  return cache;
}

async function spinCompletion(cache: ReturnType<typeof makeCacheStub>) {
  return spinUp({
    loadPrepWeekInput: makeLoaderStub({ planRevisionId: 1, mealIds: [MEAL_ID_X] }),
    runAICall: makeAICallStub({}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma: cache.prisma as any,
    subscriptionService: { can: async () => ({ allowed: true }) },
  });
}

const completionUrl = (base: string) =>
  `${base}/plans/${PLAN_ID}/prep-week/completions`;

describe("prep-week completions — auth + ownership + validation (B3)", () => {
  it("401 without auth on GET/PUT/DELETE", async () => {
    const harness = await spinCompletion(completionHarness());
    try {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const res = await fetch(completionUrl(harness.baseUrl), {
          method,
          headers: { "Content-Type": "application/json" },
          body: method === "GET" ? undefined : JSON.stringify({ stepKey: ONION_STEP_KEY }),
        });
        assert.equal(res.status, 401, `${method} should be 401`);
      }
    } finally {
      await harness.close();
    }
  });

  it("404 (no leak) when the plan is not the caller's", async () => {
    const harness = await spinCompletion(completionHarness());
    try {
      const token = signToken("not-the-owner");
      const res = await fetch(completionUrl(harness.baseUrl), {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("400 on a non-UUID plan id and on a missing stepKey body", async () => {
    const harness = await spinCompletion(completionHarness());
    try {
      const token = signToken(COMPLETION_OWNER);
      const badPlan = await fetch(
        `${harness.baseUrl}/plans/not-a-uuid/prep-week/completions`,
        { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      );
      assert.equal(badPlan.status, 400);
      const badBody = await fetch(completionUrl(harness.baseUrl), {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ notStepKey: "x" }),
      });
      assert.equal(badBody.status, 400);
    } finally {
      await harness.close();
    }
  });

});

describe("prep-week completions — check / read / uncheck round-trip (B3)", () => {
  it("check → read flips perMeal + rollup; uncheck → reverts", async () => {
    const cache = completionHarness();
    const harness = await spinCompletion(cache);
    try {
      const token = signToken(COMPLETION_OWNER);
      const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const read = async () =>
        (await (
          await fetch(completionUrl(harness.baseUrl), {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
          })
        ).json()) as {
          completions: { stepKey: string; checkedAt: string }[];
          perMeal: Record<string, boolean>;
          prepStatus: string;
          derivedPrepStatus: string;
        };

      // Initially nothing checked → meal not prepped, rollup not_prepped.
      const empty = await read();
      assert.deepEqual(empty.completions, []);
      assert.equal(empty.perMeal[MEAL_ID_X], false);
      assert.equal(empty.derivedPrepStatus, "not_prepped");

      // Check the onion step (the recomputed key for the loader's single step).
      const checkRes = await fetch(completionUrl(harness.baseUrl), {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ stepKey: ONION_STEP_KEY }),
      });
      assert.equal(checkRes.status, 200);
      assert.deepEqual(await checkRes.json(), { stepKey: ONION_STEP_KEY, checked: true });

      // Read back: one row; the only contributing step is checked → meal
      // prepped → derived rollup prepped.
      const afterCheck = await read();
      assert.equal(afterCheck.completions.length, 1);
      assert.equal(afterCheck.completions[0].stepKey, ONION_STEP_KEY);
      assert.ok(afterCheck.completions[0].checkedAt); // ISO string present
      assert.equal(afterCheck.perMeal[MEAL_ID_X], true);
      assert.equal(afterCheck.derivedPrepStatus, "prepped");

      // Idempotent re-check → still one row.
      await fetch(completionUrl(harness.baseUrl), {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ stepKey: ONION_STEP_KEY }),
      });
      assert.equal(cache.completionKeys(PLAN_ID).length, 1);

      // Uncheck → gone, rollup reverts.
      const uncheckRes = await fetch(completionUrl(harness.baseUrl), {
        method: "DELETE",
        headers: auth,
        body: JSON.stringify({ stepKey: ONION_STEP_KEY }),
      });
      assert.equal(uncheckRes.status, 200);
      assert.deepEqual(await uncheckRes.json(), { stepKey: ONION_STEP_KEY, checked: false });

      const afterUncheck = await read();
      assert.deepEqual(afterUncheck.completions, []);
      assert.equal(afterUncheck.perMeal[MEAL_ID_X], false);
      assert.equal(afterUncheck.derivedPrepStatus, "not_prepped");

      // Uncheck again is an idempotent no-op (200).
      const uncheckAgain = await fetch(completionUrl(harness.baseUrl), {
        method: "DELETE",
        headers: auth,
        body: JSON.stringify({ stepKey: ONION_STEP_KEY }),
      });
      assert.equal(uncheckAgain.status, 200);
    } finally {
      await harness.close();
    }
  });
});

// ── WS7-8b Block 2 (D-WS7-184) — demoted-step exclusion (BUG-013 / BUG-015) ──
// The GET completions endpoint routes through the real loadPrepStepSet, so the
// skipSuggested overlay read from structureJson is exercised end-to-end: a
// demoted-and-unchecked step no longer blocks the meal from ever reaching
// prepped (the forever-nag), while a real required step still gates it.

const CARROT_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const CARROT_STEP_KEY = `produce#${CARROT_ID}`;

// A loader producing TWO distinct produce steps for MEAL_ID_X (onion + carrot),
// so one can be demoted while the other still gates the meal.
function makeTwoProduceLoaderStub(planRevisionId: number) {
  return (async (params: { planId: string }) => ({
    input: {
      planId: params.planId,
      planName: "Two Produce Plan",
      meals: [
        {
          mealId: MEAL_ID_X,
          mealName: "Meal 1",
          cuisine: null,
          servingsOverride: null,
          dishes: [
            {
              dishId: "dddddddd-dddd-4ddd-8ddd-000000000000",
              dishName: "Dish",
              baseServings: 4,
              authoredBaseServings: 4,
              stepTexts: [],
              ingredients: [
                {
                  ingredientId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                  ingredientName: "yellow onion",
                  category: "Produce",
                  quantity: 1,
                  unit: "each",
                  preparationNote: "diced",
                },
                {
                  ingredientId: CARROT_ID,
                  ingredientName: "carrot",
                  category: "Produce",
                  quantity: 2,
                  unit: "each",
                  preparationNote: "diced",
                },
              ],
            },
          ],
        },
      ],
    },
    planRevisionId,
  })) as never;
}

async function spinTwoProduce(cache: ReturnType<typeof makeCacheStub>) {
  return spinUp({
    loadPrepWeekInput: makeTwoProduceLoaderStub(1),
    runAICall: makeAICallStub({}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma: cache.prisma as any,
    subscriptionService: { can: async () => ({ allowed: true }) },
  });
}

describe("prep-week completions — demoted-step exclusion (D-WS7-184)", () => {
  it("a demoted-and-unchecked step is excluded; checking the real required step reaches prepped", async () => {
    const cache = completionHarness();
    // structureJson demotes the ONION step (skipSuggested); the carrot step is
    // kept (no flag). This is the persisted narration artifact loadPrepStepSet
    // overlays onto the recomputed set.
    cache.rows.set(PLAN_ID, {
      id: "row-demoted",
      planId: PLAN_ID,
      structureJson: {
        phases: [
          {
            phase: "produce",
            steps: [
              { stepKey: ONION_STEP_KEY, skipSuggested: true },
              { stepKey: CARROT_STEP_KEY },
            ],
          },
        ],
      },
    });
    const harness = await spinTwoProduce(cache);
    try {
      const token = signToken(COMPLETION_OWNER);
      const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const read = async () =>
        (await (
          await fetch(completionUrl(harness.baseUrl), {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
          })
        ).json()) as { perMeal: Record<string, boolean>; derivedPrepStatus: string };

      // Nothing checked: the demoted onion is EXCLUDED, but the kept carrot is
      // still required and unchecked → meal not prepped (exclusion did not make
      // it vacuously prepped).
      const empty = await read();
      assert.equal(empty.perMeal[MEAL_ID_X], false);
      assert.equal(empty.derivedPrepStatus, "not_prepped");

      // Check ONLY the carrot (its real required step). The onion is demoted, so
      // it never needs a check — the meal reaches prepped. Without the exclusion
      // the unchecked onion would nag forever (BUG-013 / BUG-015).
      const checkRes = await fetch(completionUrl(harness.baseUrl), {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ stepKey: CARROT_STEP_KEY }),
      });
      assert.equal(checkRes.status, 200);

      const afterCheck = await read();
      assert.equal(afterCheck.perMeal[MEAL_ID_X], true, "meal reaches prepped with the demoted step unchecked");
      assert.equal(afterCheck.derivedPrepStatus, "prepped");
    } finally {
      await harness.close();
    }
  });

  it("with NO structure row, BOTH steps are required (degrade-to-KEEP)", async () => {
    const cache = completionHarness(); // no structure row seeded
    const harness = await spinTwoProduce(cache);
    try {
      const token = signToken(COMPLETION_OWNER);
      const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const read = async () =>
        (await (
          await fetch(completionUrl(harness.baseUrl), {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
          })
        ).json()) as { perMeal: Record<string, boolean>; derivedPrepStatus: string };

      // Absence → nothing excluded → both onion + carrot required. Checking only
      // the carrot leaves the onion required → still not prepped.
      await fetch(completionUrl(harness.baseUrl), {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ stepKey: CARROT_STEP_KEY }),
      });
      const afterCarrot = await read();
      assert.equal(afterCarrot.perMeal[MEAL_ID_X], false, "onion still required when no structure demotes it");
      assert.equal(afterCarrot.derivedPrepStatus, "not_prepped");

      // Checking the onion too → both required steps checked → prepped.
      await fetch(completionUrl(harness.baseUrl), {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ stepKey: ONION_STEP_KEY }),
      });
      const afterBoth = await read();
      assert.equal(afterBoth.perMeal[MEAL_ID_X], true);
      assert.equal(afterBoth.derivedPrepStatus, "prepped");
    } finally {
      await harness.close();
    }
  });
});

describe("prep-week completions — orphan-prune on regenerate (B3)", () => {
  it("regenerate prunes orphan keys but keeps still-valid ones", async () => {
    const cache = makeCacheStub();
    // Seed two completions BEFORE regenerate: the onion key the fresh assembly
    // will re-emit (survives) + an orphan whose step was dropped (pruned).
    cache.seedCompletion(PLAN_ID, ONION_STEP_KEY);
    cache.seedCompletion(PLAN_ID, "produce#orphan-removed-ingredient");
    // Stale cache row so the POST takes the regenerate path (revision moved).
    cache.rows.set(PLAN_ID, {
      id: "row-stale",
      planId: PLAN_ID,
      structureJson: happyPrepWeekResult(),
      lastGeneratedFromPlanRevisionId: 1,
      lastGeneratedAt: new Date("2026-05-01T12:00:00Z"),
      promptVersion: 1,
    });
    const harness = await spinUp({
      // revisionId 2 ≠ cached 1 → regenerate.
      loadPrepWeekInput: makeLoaderStub({ planRevisionId: 2, mealIds: [MEAL_ID_X] }),
      runAICall: makeAICallStub({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: cache.prisma as any,
      subscriptionService: { can: async () => ({ allowed: true }) },
    });
    try {
      const token = signToken("u-prune");
      const res = await fetch(`${harness.baseUrl}/plans/${PLAN_ID}/prep-week`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { cacheHit: boolean };
      assert.equal(body.cacheHit, false); // regenerated
      // Prune ran once; orphan gone, valid onion key kept.
      assert.equal(cache.pruneCalls(), 1);
      assert.deepEqual(cache.completionKeys(PLAN_ID), [ONION_STEP_KEY]);
    } finally {
      await harness.close();
    }
  });
});

// WS6 6b-1 — POST /api/meals/find-similar tests.
// Covers input validation, source-strip defense, premium-deny fallback,
// AI happy path with LLMCallLog accounting, AI failure, and activity events.
//
// HTTP transport: same lightweight Express harness as wizard.test.ts. JWT
// auth exercised end-to-end with a real signed token.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { createMealsRouter } from "../meals";
import type {
  AICallFailure,
  AICallSuccess,
  AICallResult,
} from "../../lib/ai/runAICall";
import type {
  FindSimilarResult,
  MealCandidate,
} from "../../lib/ai/schemas/findSimilar";
import type {
  EntitlementResult,
  SubscriptionService,
} from "../../lib/subscriptionService";

// ── stubs ──────────────────────────────────────────────────────────────

function makeStubPrisma() {
  const llmCalls: unknown[] = [];
  const activities: { eventType: string; userId: string; entityId: string | null }[] = [];
  return {
    aIPrompt: { findUnique: async () => null },
    systemSetting: { findUnique: async () => null },
    userActivity: {
      create: async ({
        data,
      }: {
        data: { eventType: string; userId: string; entityId: string | null };
      }) => {
        activities.push(data);
        return data;
      },
    },
    lLMCallLog: {
      create: async ({ data }: { data: unknown }) => {
        llmCalls.push(data);
        return data;
      },
    },
    _activities: () => activities,
    _llmCalls: () => llmCalls,
  };
}

function makeRunAICall(
  result: () => Promise<AICallResult<FindSimilarResult>>,
) {
  let calls = 0;
  const capturedVars: Record<string, unknown>[] = [];
  const fn = (async (
    _promptKey: string,
    vars: Record<string, unknown>,
    ..._rest: unknown[]
  ) => {
    calls++;
    capturedVars.push(vars);
    return result();
  }) as unknown as Parameters<typeof createMealsRouter>[0] extends
    | { runAICall?: infer R }
    | undefined
    ? R
    : never;
  return {
    fn,
    getCalls: () => calls,
    getVars: () => capturedVars,
  };
}

function happyResult(): AICallSuccess<FindSimilarResult> {
  return {
    success: true,
    data: {
      matches: [
        {
          mealId: "cand-1",
          similarityScore: 0.91,
          reason: "Same cuisine, same protein",
        },
        {
          mealId: "cand-2",
          similarityScore: 0.74,
          reason: "Same cuisine, different protein",
        },
        {
          mealId: "cand-3",
          similarityScore: 0.42,
          reason: "Adjacent cuisine family",
        },
      ],
    },
    metadata: {
      promptKey: "meals.find_similar",
      promptVersion: 2,
      model: "claude-haiku-4-5-20251001",
      mode: "text",
      latencyMs: 320,
      inputTokens: 600,
      outputTokens: 80,
      costEstimateUsd: 0.001,
      retryCount: 0,
    },
  };
}

function failureResult(): AICallFailure {
  return {
    success: false,
    reason: "validation_failed",
    userFacingMessage: "Kiwi got distracted. Try again?",
    metadata: {
      promptKey: "meals.find_similar",
      promptVersion: 2,
      model: "claude-haiku-4-5-20251001",
      mode: "text",
      latencyMs: 280,
      inputTokens: 600,
      outputTokens: 0,
      retryCount: 1,
    },
  };
}

function makeSubscriptionService(allowed: boolean): SubscriptionService {
  return {
    async can(): Promise<EntitlementResult> {
      return allowed
        ? { allowed: true }
        : { allowed: false, reason: "Trial expired — upgrade to continue." };
    },
  };
}

// ── server harness ─────────────────────────────────────────────────────

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function spinUp(deps: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runAICall: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any;
  subscriptionService: SubscriptionService;
  rateLimiterOpts?: { capacity: number; refillPerSec: number };
}): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use("/api", createMealsRouter(deps));

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

// ── fixtures ───────────────────────────────────────────────────────────

const SOURCE: MealCandidate = {
  id: "src-tacos",
  title: "Beef Tacos",
  cuisine: "Mexican",
  mealType: "dinner",
  keyIngredients: ["ground beef", "taco shells", "cheese"],
  tags: ["weeknight", "quick"],
};

const CANDIDATES: MealCandidate[] = [
  {
    id: "cand-1",
    title: "Chicken Tacos",
    cuisine: "Mexican",
    mealType: "dinner",
    keyIngredients: ["chicken thighs", "tortillas", "salsa"],
  },
  {
    id: "cand-2",
    title: "Quesadillas",
    cuisine: "Mexican",
    mealType: "dinner",
    keyIngredients: ["tortillas", "cheese", "chicken"],
  },
  {
    id: "cand-3",
    title: "Tex-Mex Bowl",
    cuisine: "Tex-Mex",
    mealType: "dinner",
  },
  {
    id: "cand-4",
    title: "Pad Thai",
    cuisine: "Thai",
    mealType: "dinner",
  },
];

const TEST_USER_ID = "test-user-find-similar";

// ── tests ──────────────────────────────────────────────────────────────

describe("POST /api/meals/find-similar — happy path", () => {
  let harness: Harness;
  const ai = makeRunAICall(async () => happyResult());
  const prisma = makeStubPrisma();

  before(async () => {
    harness = await spinUp({
      runAICall: ai.fn,
      prisma,
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns 200 + filtered matches and emits meal_found_similar_used", async () => {
    const token = signToken(TEST_USER_ID);
    const res = await fetch(`${harness.baseUrl}/meals/find-similar`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ source: SOURCE, candidates: CANDIDATES }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      matches: { mealId: string; similarityScore: number; reason: string }[];
      metadata: { mode: string; promptVersion: number };
    };
    assert.equal(body.matches.length, 3);
    assert.equal(body.metadata.mode, "ai");
    assert.equal(body.metadata.promptVersion, 2);
    assert.equal(ai.getCalls(), 1);

    const events = prisma._activities();
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "meal_found_similar_used");
    assert.equal(events[0].entityId, SOURCE.id);
  });

  it("forwards the trim payload to the AI helper as findSimilarInput", async () => {
    const lastVars = ai.getVars().at(-1) as
      | { findSimilarInput?: { source: MealCandidate; candidates: MealCandidate[]; limit: number } }
      | undefined;
    assert.ok(lastVars?.findSimilarInput);
    assert.equal(lastVars.findSimilarInput.source.id, SOURCE.id);
    // Source not in candidates (it shouldn't appear in the input list either).
    assert.equal(
      lastVars.findSimilarInput.candidates.find((c) => c.id === SOURCE.id),
      undefined,
    );
    // Default limit of 10 applied when client omits.
    assert.equal(lastVars.findSimilarInput.limit, 10);
  });
});

describe("POST /api/meals/find-similar — source meal stripped from candidates", () => {
  let harness: Harness;
  const ai = makeRunAICall(async () => happyResult());

  before(async () => {
    harness = await spinUp({
      runAICall: ai.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("drops the source meal from candidates if the client included it", async () => {
    const token = signToken(TEST_USER_ID + "-self");
    const candidatesWithSource = [SOURCE, ...CANDIDATES];
    await fetch(`${harness.baseUrl}/meals/find-similar`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        source: SOURCE,
        candidates: candidatesWithSource,
      }),
    });

    const lastVars = ai.getVars().at(-1) as
      | { findSimilarInput?: { candidates: MealCandidate[] } }
      | undefined;
    assert.ok(lastVars);
    const ids = lastVars.findSimilarInput!.candidates.map((c) => c.id);
    assert.ok(
      !ids.includes(SOURCE.id),
      `source meal should be stripped, saw ${ids.join(",")}`,
    );
    assert.equal(ids.length, CANDIDATES.length);
  });
});

describe("POST /api/meals/find-similar — premium-deny fallback", () => {
  let harness: Harness;
  const ai = makeRunAICall(async () => happyResult());
  const prisma = makeStubPrisma();

  before(async () => {
    harness = await spinUp({
      runAICall: ai.fn,
      prisma,
      subscriptionService: makeSubscriptionService(false),
    });
  });
  after(async () => harness.close());

  it("returns cuisine-only matches without invoking AI or emitting activity", async () => {
    const token = signToken(TEST_USER_ID + "-deny");
    const res = await fetch(`${harness.baseUrl}/meals/find-similar`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ source: SOURCE, candidates: CANDIDATES }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      matches: { mealId: string; similarityScore: number; reason: string }[];
      metadata: { mode: string };
    };
    // Only Mexican candidates (cand-1, cand-2) match the source cuisine.
    // Tex-Mex and Thai are excluded.
    const ids = body.matches.map((m) => m.mealId).sort();
    assert.deepEqual(ids, ["cand-1", "cand-2"]);
    for (const m of body.matches) {
      assert.equal(m.similarityScore, 0);
      assert.equal(m.reason, "Same cuisine");
    }
    assert.equal(body.metadata.mode, "fallback_cuisine");

    // No AI call, no activity event.
    assert.equal(ai.getCalls(), 0);
    assert.equal(prisma._activities().length, 0);
  });
});

describe("POST /api/meals/find-similar — AI invented match dropped", () => {
  let harness: Harness;
  const ai = makeRunAICall(async () => ({
    success: true,
    data: {
      matches: [
        // Two valid candidates from the input list.
        { mealId: "cand-1", similarityScore: 0.9, reason: "valid match" },
        { mealId: "cand-2", similarityScore: 0.7, reason: "valid match" },
        // One invented match — must be dropped.
        {
          mealId: "made-up-id",
          similarityScore: 0.85,
          reason: "AI invented this",
        },
      ],
    },
    metadata: {
      promptKey: "meals.find_similar",
      promptVersion: 2,
      model: "claude-haiku-4-5-20251001",
      mode: "text" as const,
      latencyMs: 200,
      inputTokens: 500,
      outputTokens: 100,
      costEstimateUsd: 0.001,
      retryCount: 0,
    },
  }));

  before(async () => {
    harness = await spinUp({
      runAICall: ai.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("filters out matches whose mealId is not in the candidate set", async () => {
    const token = signToken(TEST_USER_ID + "-invent");
    const res = await fetch(`${harness.baseUrl}/meals/find-similar`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ source: SOURCE, candidates: CANDIDATES }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      matches: { mealId: string }[];
    };
    const ids = body.matches.map((m) => m.mealId);
    assert.ok(!ids.includes("made-up-id"));
    assert.equal(body.matches.length, 2);
  });
});

describe("POST /api/meals/find-similar — input validation", () => {
  let harness: Harness;
  const ai = makeRunAICall(async () => happyResult());

  before(async () => {
    harness = await spinUp({
      runAICall: ai.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("rejects 400 when source is missing", async () => {
    const token = signToken(TEST_USER_ID);
    const res = await fetch(`${harness.baseUrl}/meals/find-similar`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ candidates: CANDIDATES }),
    });
    assert.equal(res.status, 400);
    assert.equal(ai.getCalls(), 0);
  });

  it("rejects 400 when limit is out of range", async () => {
    const token = signToken(TEST_USER_ID);
    const res = await fetch(`${harness.baseUrl}/meals/find-similar`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        source: SOURCE,
        candidates: CANDIDATES,
        limit: 999,
      }),
    });
    assert.equal(res.status, 400);
  });

  it("rejects 401 when no authorization header", async () => {
    const res = await fetch(`${harness.baseUrl}/meals/find-similar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: SOURCE, candidates: CANDIDATES }),
    });
    assert.equal(res.status, 401);
  });
});

describe("POST /api/meals/find-similar — AI failure", () => {
  let harness: Harness;
  const prisma = makeStubPrisma();
  const ai = makeRunAICall(async () => failureResult());

  before(async () => {
    harness = await spinUp({
      runAICall: ai.fn,
      prisma,
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns 502 with Kiwi-styled message and does NOT emit activity", async () => {
    const token = signToken(TEST_USER_ID + "-aifail");
    const res = await fetch(`${harness.baseUrl}/meals/find-similar`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ source: SOURCE, candidates: CANDIDATES }),
    });

    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string; reason: string };
    assert.match(body.error, /Kiwi got distracted/);
    assert.equal(body.reason, "validation_failed");

    // Activity event must not fire on AI failure — it's a "successful use"
    // counter, not a "user clicked" counter.
    const events = prisma._activities().map((a) => a.eventType);
    assert.ok(!events.includes("meal_found_similar_used"));
  });
});

describe("POST /api/meals/find-similar — LLMCallLog accounting", () => {
  let harness: Harness;
  const prisma = makeStubPrisma();
  // Inject runAICall stub that simulates the orchestrator's log write.
  const ai = makeRunAICall(async () => {
    void prisma.lLMCallLog.create({
      data: {
        promptKey: "meals.find_similar",
        promptVersion: 2,
        model: "claude-haiku-4-5-20251001",
        mode: "text",
        userId: null,
        latencyMs: 320,
        inputTokens: 600,
        outputTokens: 80,
        costEstimateUsd: 0.001,
        retryCount: 0,
        success: true,
        failureReason: null,
      },
    });
    return happyResult();
  });

  before(async () => {
    harness = await spinUp({
      runAICall: ai.fn,
      prisma,
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("writes 1 LLMCallLog row on AI path; 0 on fallback path", async () => {
    const token = signToken(TEST_USER_ID + "-logs");
    await fetch(`${harness.baseUrl}/meals/find-similar`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ source: SOURCE, candidates: CANDIDATES }),
    });

    const logs = prisma._llmCalls() as Array<{ promptKey: string }>;
    const findSimilarLogs = logs.filter(
      (l) => l.promptKey === "meals.find_similar",
    );
    assert.equal(findSimilarLogs.length, 1);
  });

  it("does NOT write an LLMCallLog row when the request hits the fallback path", async () => {
    const fallbackPrisma = makeStubPrisma();
    const fallbackAi = makeRunAICall(async () => happyResult());
    const fallbackHarness = await spinUp({
      runAICall: fallbackAi.fn,
      prisma: fallbackPrisma,
      subscriptionService: makeSubscriptionService(false),
    });

    try {
      const token = signToken(TEST_USER_ID + "-fblogs");
      await fetch(`${fallbackHarness.baseUrl}/meals/find-similar`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ source: SOURCE, candidates: CANDIDATES }),
      });
      assert.equal((fallbackPrisma._llmCalls() as unknown[]).length, 0);
      assert.equal(fallbackAi.getCalls(), 0);
    } finally {
      await fallbackHarness.close();
    }
  });
});

// WS6 6a-3 — POST /api/wizard/build-plans tests.
// Covers input validation, entitlement gate, rate limit, happy path, AI failure.
// No real Anthropic call — runAICall is stubbed via the route's DI seam.
//
// HTTP transport: a lightweight Express app is mounted on a random port and
// exercised with native fetch. JWT auth is exercised end-to-end with a
// real signed token.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { createWizardRouter } from "../wizard";
import type {
  AICallFailure,
  AICallSuccess,
  AICallResult,
} from "../../lib/ai/runAICall";
import type { WizardPlanCandidatesResult } from "../../lib/ai/schemas/wizard";
import type {
  EntitlementResult,
  SubscriptionService,
} from "../../lib/subscriptionService";

// ── stubs ──────────────────────────────────────────────────────────────

function makeStubPrisma() {
  const llmCalls: unknown[] = [];
  const activities: unknown[] = [];
  return {
    aIPrompt: { findUnique: async () => null },
    systemSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        if (where.key === "wizard.candidate_count") {
          return { key: where.key, value: 3 };
        }
        if (where.key === "wizard.max_refreshes_per_session") {
          return { key: where.key, value: 3 };
        }
        return null;
      },
    },
    pantryStaple: { findMany: async () => [] },
    userActivity: {
      findMany: async () => [],
      create: async ({ data }: { data: unknown }) => {
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

function happyCandidates(): WizardPlanCandidatesResult {
  return {
    candidates: [
      {
        id: "c1",
        title: "Cozy Comfort Week",
        tags: ["Comfort", "Easy"],
        whyBullets: [
          "Sheet-pan and one-pot meals minimize cleanup",
          "Garlic shared across 3 meals — buy one head, use it all",
        ],
        mealTitles: [
          "Sheet-pan harissa chicken",
          "Tomato soup + grilled cheese",
          "Baked potato bar",
          "Chicken noodle soup",
          "Skillet meatballs + pasta",
        ],
        dailyMacros: { calories: 540, proteinG: 28, carbsG: 56, fatG: 22 },
      },
      {
        id: "c2",
        title: "Mediterranean-Leaning Variety",
        tags: ["Mediterranean", "Variety"],
        whyBullets: [
          "Lemons used across 4 meals — buy a bag, use them all",
          "One fancy Friday, four easy weeknights",
        ],
        mealTitles: [
          "Greek salad + grilled shrimp",
          "Lemon herb salmon + quinoa",
          "Big greek salad",
          "Pesto pasta + green beans",
          "Mediterranean grain bowl",
        ],
        dailyMacros: { calories: 520, proteinG: 32, carbsG: 48, fatG: 24 },
      },
      {
        id: "c3",
        title: "High-Protein Reset",
        tags: ["High Protein"],
        whyBullets: [
          "Hits >25g protein/serving across all 5 nights",
          "Chicken prepped once, used in two different meals",
        ],
        mealTitles: [
          "Herb chicken + roasted potatoes",
          "Steak + green beans",
          "Salmon + asparagus",
          "Turkey taco bowls",
          "Chicken caesar wraps",
        ],
        dailyMacros: { calories: 560, proteinG: 42, carbsG: 32, fatG: 24 },
      },
    ],
  };
}

function makeRunAICall(
  result: () => Promise<AICallResult<WizardPlanCandidatesResult>>,
) {
  let calls = 0;
  const fn = (async (..._args: unknown[]) => {
    calls++;
    return result();
  }) as unknown as Parameters<typeof createWizardRouter>[0] extends
    | { runAICall?: infer R }
    | undefined
    ? R
    : never;
  return { fn, getCalls: () => calls };
}

function happyResult(): AICallSuccess<WizardPlanCandidatesResult> {
  return {
    success: true,
    data: happyCandidates(),
    metadata: {
      promptKey: "wizard.set_preferences.generate",
      promptVersion: 2,
      model: "claude-sonnet-4-6",
      mode: "tool",
      latencyMs: 1234,
      inputTokens: 1500,
      outputTokens: 320,
      costEstimateUsd: 0.0093,
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
      promptKey: "wizard.set_preferences.generate",
      promptVersion: 2,
      model: "claude-sonnet-4-6",
      mode: "tool",
      latencyMs: 850,
      inputTokens: 1500,
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
  app.use("/api", createWizardRouter(deps));

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

const VALID_BODY = {
  planDurationDays: 5,
  householdSize: 4,
  wantsLeftovers: true,
  cuisines: ["Italian", "Mexican", "Thai"],
  eatingStyles: [],
  allergiesAndAvoidances: [],
  difficulty: "medium" as const,
  weeklyPacing: "mixed" as const,
};

const TEST_USER_ID = "test-user-wizard-route";

// ── tests ──────────────────────────────────────────────────────────────

describe("POST /api/wizard/build-plans — happy path", () => {
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

  it("returns 200 + 3 candidates and emits a wizard_complete activity", async () => {
    const token = signToken(TEST_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/build-plans`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(VALID_BODY),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      candidates: { id: string; title: string }[];
      metadata: { promptVersion: number };
    };
    assert.equal(body.candidates.length, 3);
    assert.ok(body.candidates[0].title.length > 0);
    assert.equal(body.metadata.promptVersion, 2);
    assert.equal(ai.getCalls(), 1);
    assert.ok(prisma._activities().length >= 1);
  });
});

describe("POST /api/wizard/build-plans — input validation", () => {
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

  it("rejects 400 when difficulty is invalid", async () => {
    const token = signToken(TEST_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/build-plans`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...VALID_BODY, difficulty: "extreme" }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /invalid request body/);
    // Validation rejected before AI ran.
    assert.equal(ai.getCalls(), 0);
  });

  it("rejects 400 when planDurationDays is out of range", async () => {
    const token = signToken(TEST_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/build-plans`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...VALID_BODY, planDurationDays: 99 }),
    });

    assert.equal(res.status, 400);
  });

  it("rejects 401 when no authorization header", async () => {
    const res = await fetch(`${harness.baseUrl}/wizard/build-plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    assert.equal(res.status, 401);
  });
});

describe("POST /api/wizard/build-plans — entitlement gate", () => {
  let harness: Harness;
  const ai = makeRunAICall(async () => happyResult());

  before(async () => {
    harness = await spinUp({
      runAICall: ai.fn,
      prisma: makeStubPrisma(),
      // Trial expired — feature blocked.
      subscriptionService: makeSubscriptionService(false),
    });
  });
  after(async () => harness.close());

  it("returns 402 when entitlement.allowed is false (no AI call made)", async () => {
    const token = signToken(TEST_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/build-plans`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(VALID_BODY),
    });

    assert.equal(res.status, 402);
    const body = (await res.json()) as { error: string; reason: string };
    assert.match(body.error, /upgrade required/);
    assert.match(body.reason, /Trial expired/);
    assert.equal(ai.getCalls(), 0);
  });
});

describe("POST /api/wizard/build-plans — AI failure", () => {
  let harness: Harness;

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => failureResult()).fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns 502 with Kiwi-styled message when runAICall fails", async () => {
    const token = signToken(TEST_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/build-plans`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(VALID_BODY),
    });

    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string; reason: string };
    assert.match(body.error, /Kiwi got distracted/);
    assert.equal(body.reason, "validation_failed");
  });
});

describe("POST /api/wizard/build-plans — rate limit", () => {
  let harness: Harness;
  const ai = makeRunAICall(async () => happyResult());

  before(async () => {
    harness = await spinUp({
      runAICall: ai.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
      // Tight bucket so the burst is observable in the test.
      rateLimiterOpts: { capacity: 2, refillPerSec: 0 },
    });
  });
  after(async () => harness.close());

  it("returns 429 once the per-user bucket is empty", async () => {
    const token = signToken(TEST_USER_ID + "-rate");
    const post = () =>
      fetch(`${harness.baseUrl}/wizard/build-plans`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(VALID_BODY),
      });

    const r1 = await post();
    const r2 = await post();
    const r3 = await post();

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 429);
    assert.equal(ai.getCalls(), 2);
  });
});

describe("GET /api/wizard/limits", () => {
  let harness: Harness;

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => happyResult()).fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns candidateCount and maxRefreshesPerSession from SystemSetting", async () => {
    const token = signToken(TEST_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/limits`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      candidateCount: number;
      maxRefreshesPerSession: number;
    };
    assert.equal(body.candidateCount, 3);
    assert.equal(body.maxRefreshesPerSession, 3);
  });
});

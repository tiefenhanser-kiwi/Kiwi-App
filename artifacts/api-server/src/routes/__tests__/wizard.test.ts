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
import type { ParsedIntent } from "../../lib/ai/schemas/tellKiwi";
import type {
  EntitlementResult,
  SubscriptionService,
} from "../../lib/subscriptionService";

// ── stubs ──────────────────────────────────────────────────────────────

interface StubPrismaOpts {
  preferences?: {
    cookingEquipment?: string[];
    spiceTolerance?: "mild" | "medium" | "hot" | "very_hot";
    budgetLevel?: "economy" | "mid_range" | "premium";
    pickyAvoidances?: string[];
    recurringGroceryItems?: string[];
  } | null;
  pantryStaples?: string[];
}

function makeStubPrisma(opts: StubPrismaOpts = {}) {
  const llmCalls: unknown[] = [];
  const activities: { eventType: string; userId: string }[] = [];
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
    userPreferences: {
      findUnique: async () => opts.preferences ?? null,
    },
    pantryStaple: {
      findMany: async () =>
        (opts.pantryStaples ?? []).map((ingredientName) => ({
          ingredientName,
        })),
    },
    userActivity: {
      findMany: async () => [],
      create: async ({
        data,
      }: {
        data: { eventType: string; userId: string };
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
  const capturedVars: Record<string, unknown>[] = [];
  const fn = (async (
    _promptKey: string,
    vars: Record<string, unknown>,
    ..._rest: unknown[]
  ) => {
    calls++;
    capturedVars.push(vars);
    return result();
  }) as unknown as Parameters<typeof createWizardRouter>[0] extends
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
  const prisma = makeStubPrisma({
    preferences: {
      // WS7-2 Block A: DB columns renamed to mobile-aligned names.
      // AI input shape (asserted below) keeps the legacy 'equipment' /
      // 'recurringItems' keys — wizard route maps at the boundary.
      cookingEquipment: ["oven", "stove", "instant_pot"],
      spiceTolerance: "medium",
      budgetLevel: "mid_range",
      pickyAvoidances: ["cilantro"],
      recurringGroceryItems: ["olive_oil", "salt"],
    },
    pantryStaples: ["garlic", "rice"],
  });

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
    const events = prisma._activities().map((a) => a.eventType);
    assert.ok(events.includes("wizard_complete"));
  });

  it("injects UserPreferences hidden context into the AI input", async () => {
    // The previous test fired one call; this test fires another and inspects
    // the captured vars on the most recent invocation.
    const token = signToken(TEST_USER_ID);
    await fetch(`${harness.baseUrl}/wizard/build-plans`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(VALID_BODY),
    });

    const lastVars = ai.getVars().at(-1) as
      | { wizardInput?: { hiddenContext?: Record<string, unknown> } }
      | undefined;
    assert.ok(lastVars?.wizardInput?.hiddenContext);
    const ctx = lastVars.wizardInput.hiddenContext as Record<string, unknown>;
    assert.deepEqual(ctx.equipment, ["oven", "stove", "instant_pot"]);
    assert.equal(ctx.spiceTolerance, "medium");
    assert.equal(ctx.budgetLevel, "mid_range");
    assert.deepEqual(ctx.pickyAvoidances, ["cilantro"]);
    assert.deepEqual(ctx.recurringItems, ["olive_oil", "salt"]);
    assert.deepEqual(ctx.pantryStaples, ["garlic", "rice"]);
  });
});

describe("POST /api/wizard/build-plans — sequential distinctness", () => {
  let harness: Harness;
  // Stub returns a counter-keyed candidate so two invocations produce two
  // distinct payloads. This proves the route fires runAICall twice (no
  // hook-level/route-level caching) — the property the mobile regen relies on.
  let counter = 0;
  const ai = makeRunAICall(async () => {
    counter++;
    return {
      success: true,
      data: {
        candidates: [
          {
            id: `c-${counter}`,
            title: `Generated plan #${counter}`,
            tags: ["test"],
            whyBullets: [`Iteration ${counter}`],
            mealTitles: ["a", "b", "c", "d", "e"],
            dailyMacros: { calories: 500, proteinG: 30, carbsG: 50, fatG: 20 },
          },
        ],
      },
      metadata: {
        promptKey: "wizard.set_preferences.generate",
        promptVersion: 2,
        model: "claude-sonnet-4-6",
        mode: "tool" as const,
        latencyMs: 100,
        inputTokens: 100,
        outputTokens: 100,
        costEstimateUsd: 0.001,
        retryCount: 0,
      },
    };
  });

  before(async () => {
    harness = await spinUp({
      runAICall: ai.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("two POSTs with identical body produce two distinct AI calls", async () => {
    const token = signToken(TEST_USER_ID + "-distinct");
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
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    const b1 = (await r1.json()) as {
      candidates: { id: string; title: string }[];
    };
    const b2 = (await r2.json()) as {
      candidates: { id: string; title: string }[];
    };
    assert.equal(ai.getCalls(), 2);
    assert.notEqual(b1.candidates[0].id, b2.candidates[0].id);
    assert.notEqual(b1.candidates[0].title, b2.candidates[0].title);
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
  const prisma = makeStubPrisma();

  before(async () => {
    harness = await spinUp({
      runAICall: makeRunAICall(async () => failureResult()).fn,
      prisma,
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns 502 with Kiwi-styled message and emits wizard_failure activity", async () => {
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
    const events = prisma._activities().map((a) => a.eventType);
    assert.ok(
      events.includes("wizard_failure"),
      `expected wizard_failure activity, saw ${events.join(",") || "(none)"}`,
    );
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

// ── Tell Kiwi (build-from-text) tests — WS6 6a-4 ──────────────────────

interface CapturedCall {
  promptKey: string;
  vars: Record<string, unknown>;
}

// Two-step orchestrator stub. `route` returns the parsedIntent for a given
// userInput, and `gen` returns the generate-step result. Each scenario test
// configures these helpers.
function makeTellKiwiRunner(args: {
  parse: (vars: Record<string, unknown>) => AICallResult<ParsedIntent>;
  generate?: (vars: Record<string, unknown>) => AICallResult<WizardPlanCandidatesResult>;
}) {
  const calls: CapturedCall[] = [];
  const fn = (async (
    promptKey: string,
    vars: Record<string, unknown>,
    ..._rest: unknown[]
  ) => {
    calls.push({ promptKey, vars });
    if (promptKey === "wizard.directed.parse_intent") {
      return args.parse(vars);
    }
    if (promptKey === "wizard.directed.generate") {
      if (!args.generate) {
        throw new Error("generate stub not configured");
      }
      return args.generate(vars);
    }
    throw new Error(`unexpected promptKey ${promptKey}`);
  }) as unknown as Parameters<typeof createWizardRouter>[0] extends
    | { runAICall?: infer R }
    | undefined
    ? R
    : never;
  return { fn, getCalls: () => calls };
}

function parseSuccess(intent: ParsedIntent): AICallSuccess<ParsedIntent> {
  return {
    success: true,
    data: intent,
    metadata: {
      promptKey: "wizard.directed.parse_intent",
      promptVersion: 2,
      model: "claude-haiku-4-5-20251001",
      mode: "text",
      latencyMs: 350,
      inputTokens: 800,
      outputTokens: 50,
      costEstimateUsd: 0.0011,
      retryCount: 0,
    },
  };
}

function genSuccess(
  candidates: WizardPlanCandidatesResult,
): AICallSuccess<WizardPlanCandidatesResult> {
  return {
    success: true,
    data: candidates,
    metadata: {
      promptKey: "wizard.directed.generate",
      promptVersion: 2,
      model: "claude-sonnet-4-6",
      mode: "tool",
      latencyMs: 1500,
      inputTokens: 2000,
      outputTokens: 400,
      costEstimateUsd: 0.012,
      retryCount: 0,
    },
  };
}

function failureFor(promptKey: string): AICallFailure {
  return {
    success: false,
    reason: "validation_failed",
    userFacingMessage: "Kiwi got distracted. Try again?",
    metadata: {
      promptKey,
      promptVersion: 2,
      model: promptKey.includes("parse")
        ? "claude-haiku-4-5-20251001"
        : "claude-sonnet-4-6",
      mode: promptKey.includes("parse") ? "text" : "tool",
      latencyMs: 500,
      inputTokens: 800,
      outputTokens: 0,
      retryCount: 1,
    },
  };
}

const TELL_KIWI_BODY = {
  description: "Make me an easy week with comfort food",
  householdSize: 4,
  wantsLeftovers: true,
  eatingStyles: [],
  allergiesAndAvoidances: [],
  planDurationDays: 5,
};

const TELL_KIWI_USER_ID = "test-user-tellkiwi-route";

function threeCandidates(
  prefix: string,
  required: string[] = [],
): WizardPlanCandidatesResult {
  // The prompt requires explicit meals to be present in every candidate for
  // the 'partial' scenario; tests verify that contract. This helper just
  // mirrors the contract — always include the required meals first.
  const fillers = ["Chicken", "Salad", "Soup", "Pizza", "Pasta"];
  const buildTitles = (variant: string): string[] => {
    const all = [...required.map((m) => `${m} ${variant}`), ...fillers];
    return all.slice(0, 5);
  };
  return {
    candidates: [1, 2, 3].map((n) => ({
      id: `${prefix}-${n}`,
      title: `${prefix} candidate ${n}`,
      tags: ["test"],
      whyBullets: [`Variation ${n}`],
      mealTitles: buildTitles(`v${n}`),
      dailyMacros: { calories: 540, proteinG: 30, carbsG: 50, fatG: 20 },
    })),
  };
}

function oneCandidate(
  title: string,
  meals: string[],
  cannotGenerateMore = true,
): WizardPlanCandidatesResult {
  return {
    candidates: [
      {
        id: `${title}-only`,
        title,
        tags: ["fully-specified"],
        whyBullets: ["Here's your plan, exactly as you described"],
        mealTitles: meals,
        dailyMacros: { calories: 540, proteinG: 30, carbsG: 50, fatG: 20 },
      },
    ],
    cannotGenerateMore,
  };
}

describe("POST /api/wizard/build-from-text — vague scenario", () => {
  let harness: Harness;
  const runner = makeTellKiwiRunner({
    parse: () =>
      parseSuccess({
        scenario: "vague",
        explicitMeals: [],
        intentDescriptors: ["easy", "comfort food"],
        mealCount: 5,
      }),
    generate: () => genSuccess(threeCandidates("vague")),
  });
  const prisma = makeStubPrisma();

  before(async () => {
    harness = await spinUp({
      runAICall: runner.fn,
      prisma,
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns 3 candidates and fires both AI calls in order", async () => {
    const token = signToken(TELL_KIWI_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(TELL_KIWI_BODY),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      candidates: { id: string }[];
      parsedIntent: ParsedIntent;
      needsClarification?: unknown;
      metadata: { flow: string };
    };
    assert.equal(body.candidates.length, 3);
    assert.equal(body.parsedIntent.scenario, "vague");
    assert.equal(body.needsClarification, undefined);
    assert.equal(body.metadata.flow, "tellkiwi");

    const calls = runner.getCalls();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].promptKey, "wizard.directed.parse_intent");
    assert.equal(calls[1].promptKey, "wizard.directed.generate");

    const events = prisma._activities().map((a) => a.eventType);
    assert.ok(events.includes("wizard_complete"));
  });
});

describe("POST /api/wizard/build-from-text — partial scenario", () => {
  let harness: Harness;
  const runner = makeTellKiwiRunner({
    parse: () =>
      parseSuccess({
        scenario: "partial",
        explicitMeals: ["Tacos", "Pasta"],
        intentDescriptors: [],
        mealCount: 5,
      }),
    generate: () => genSuccess(threeCandidates("partial", ["Tacos", "Pasta"])),
  });

  before(async () => {
    harness = await spinUp({
      runAICall: runner.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns 3 candidates that all include the explicit meals", async () => {
    const token = signToken(TELL_KIWI_USER_ID + "-partial");
    const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ...TELL_KIWI_BODY,
        description: "I want tacos and pasta this week",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      candidates: { mealTitles: string[] }[];
      parsedIntent: ParsedIntent;
    };
    assert.equal(body.candidates.length, 3);
    assert.equal(body.parsedIntent.scenario, "partial");
    // Every candidate must include at least one mention of each explicit meal.
    for (const c of body.candidates) {
      const joined = c.mealTitles.join(" | ").toLowerCase();
      assert.ok(joined.includes("tacos"), `candidate missing tacos: ${joined}`);
      assert.ok(joined.includes("pasta"), `candidate missing pasta: ${joined}`);
    }

    // Generate step received parsedIntent with explicitMeals.
    const calls = runner.getCalls();
    const genCall = calls.find((c) => c.promptKey === "wizard.directed.generate");
    assert.ok(genCall);
    const generateInput = (genCall.vars as { generateInput?: { parsedIntent: ParsedIntent } })
      .generateInput;
    assert.deepEqual(generateInput?.parsedIntent.explicitMeals, ["Tacos", "Pasta"]);
  });
});

describe("POST /api/wizard/build-from-text — fully_specified scenario", () => {
  let harness: Harness;
  const runner = makeTellKiwiRunner({
    parse: () =>
      parseSuccess({
        scenario: "fully_specified",
        explicitMeals: ["Tacos", "Salmon", "Stir Fry", "Pizza", "Pasta"],
        intentDescriptors: [],
        mealCount: 5,
      }),
    generate: () =>
      genSuccess(
        oneCandidate("Your 5-meal lineup", [
          "Tacos",
          "Salmon",
          "Stir Fry",
          "Pizza",
          "Pasta",
        ]),
      ),
  });

  before(async () => {
    harness = await spinUp({
      runAICall: runner.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns exactly 1 candidate with cannotGenerateMore set", async () => {
    const token = signToken(TELL_KIWI_USER_ID + "-fully");
    const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ...TELL_KIWI_BODY,
        description: "Mon: tacos, Tue: salmon, Wed: stir fry, Thu: pizza, Fri: pasta",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      candidates: { id: string; mealTitles: string[] }[];
      parsedIntent: ParsedIntent;
      cannotGenerateMore?: boolean;
    };
    assert.equal(body.candidates.length, 1);
    assert.equal(body.parsedIntent.scenario, "fully_specified");
    assert.equal(body.cannotGenerateMore, true);
  });
});

describe("POST /api/wizard/build-from-text — overflow scenario", () => {
  let harness: Harness;
  const runner = makeTellKiwiRunner({
    parse: () =>
      parseSuccess({
        scenario: "overflow",
        explicitMeals: [
          "Tacos",
          "Salmon",
          "Lasagna",
          "Stir Fry",
          "Pizza",
          "Pasta",
          "Soup",
          "Sandwiches",
        ],
        intentDescriptors: [],
        mealCount: 5,
        needsClarification: {
          reason: "You named more meals than fit in 5 nights.",
          options: ["Pasta", "Soup", "Sandwiches"],
        },
      }),
    generate: () =>
      genSuccess(
        oneCandidate("Your 5-night lineup", [
          "Tacos",
          "Salmon",
          "Lasagna",
          "Stir Fry",
          "Pizza",
        ]),
      ),
  });

  before(async () => {
    harness = await spinUp({
      runAICall: runner.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns 1 candidate plus needsClarification.options with dropped meals", async () => {
    const token = signToken(TELL_KIWI_USER_ID + "-overflow");
    const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ...TELL_KIWI_BODY,
        description:
          "I want tacos, salmon, lasagna, stir fry, pizza, pasta, soup, sandwiches",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      candidates: { id: string }[];
      parsedIntent: ParsedIntent;
      needsClarification?: { reason: string; options?: string[] };
    };
    assert.equal(body.candidates.length, 1);
    assert.equal(body.parsedIntent.scenario, "overflow");
    assert.deepEqual(body.needsClarification?.options, [
      "Pasta",
      "Soup",
      "Sandwiches",
    ]);
  });
});

describe("POST /api/wizard/build-from-text — unclear scenario", () => {
  let harness: Harness;
  const runner = makeTellKiwiRunner({
    parse: () =>
      parseSuccess({
        scenario: "unclear",
        explicitMeals: [],
        intentDescriptors: [],
        mealCount: 5,
        needsClarification: {
          reason: "Tell me a bit more — what kind of week do you want?",
        },
      }),
    // No generate stub — unclear must NOT call step 2.
  });
  const prisma = makeStubPrisma();

  before(async () => {
    harness = await spinUp({
      runAICall: runner.fn,
      prisma,
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns empty candidates + needsClarification, skips step 2 call", async () => {
    const token = signToken(TELL_KIWI_USER_ID + "-unclear");
    const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...TELL_KIWI_BODY, description: "yellow" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      candidates: unknown[];
      parsedIntent: ParsedIntent;
      needsClarification?: { reason: string };
    };
    assert.equal(body.candidates.length, 0);
    assert.equal(body.parsedIntent.scenario, "unclear");
    assert.match(body.needsClarification?.reason ?? "", /Tell me a bit more/);

    // Cost-saving guarantee: step 2 was NOT called.
    const calls = runner.getCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].promptKey, "wizard.directed.parse_intent");

    // wizard_complete still fires (the user got a useful response).
    const events = prisma._activities().map((a) => a.eventType);
    assert.ok(events.includes("wizard_complete"));
  });
});

describe("POST /api/wizard/build-from-text — LLMCallLog accounting", () => {
  let harness: Harness;
  // Inject a prisma stub whose lLMCallLog.create writes are observable.
  // The route delegates LLMCallLog writes to runAICall (via the AI seam),
  // not the route itself, so this test simulates 2 calls per request by
  // instrumenting the ai stub to write a log row each time it's invoked.
  const prisma = makeStubPrisma();
  const runner = makeTellKiwiRunner({
    parse: (vars) => {
      // Simulate orchestrator log write so the test can count them.
      void prisma.lLMCallLog.create({
        data: {
          promptKey: "wizard.directed.parse_intent",
          promptVersion: 2,
          model: "claude-haiku-4-5-20251001",
          mode: "text",
          userId: null,
          latencyMs: 100,
          inputTokens: 100,
          outputTokens: 20,
          costEstimateUsd: 0.0001,
          retryCount: 0,
          success: true,
          failureReason: null,
        },
      });
      return parseSuccess({
        scenario: "vague",
        explicitMeals: [],
        intentDescriptors: ["easy"],
        mealCount: 5,
      });
    },
    generate: () => {
      void prisma.lLMCallLog.create({
        data: {
          promptKey: "wizard.directed.generate",
          promptVersion: 2,
          model: "claude-sonnet-4-6",
          mode: "tool",
          userId: null,
          latencyMs: 1500,
          inputTokens: 2000,
          outputTokens: 400,
          costEstimateUsd: 0.012,
          retryCount: 0,
          success: true,
          failureReason: null,
        },
      });
      return genSuccess(threeCandidates("logging-test"));
    },
  });

  before(async () => {
    harness = await spinUp({
      runAICall: runner.fn,
      prisma,
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("writes 2 LLMCallLog rows per request (parse + generate)", async () => {
    const token = signToken(TELL_KIWI_USER_ID + "-logs");
    await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(TELL_KIWI_BODY),
    });

    const logs = prisma._llmCalls() as Array<{
      promptKey: string;
      success: boolean;
    }>;
    const tellKiwiLogs = logs.filter((l) =>
      l.promptKey.startsWith("wizard.directed."),
    );
    assert.equal(tellKiwiLogs.length, 2);
    const keys = tellKiwiLogs.map((l) => l.promptKey).sort();
    assert.deepEqual(keys, [
      "wizard.directed.generate",
      "wizard.directed.parse_intent",
    ]);
  });
});

describe("POST /api/wizard/build-from-text — parse-step failure", () => {
  let harness: Harness;
  const prisma = makeStubPrisma();
  const runner = makeTellKiwiRunner({
    parse: () => failureFor("wizard.directed.parse_intent"),
    // No generate stub — parse failure should short-circuit before step 2.
  });

  before(async () => {
    harness = await spinUp({
      runAICall: runner.fn,
      prisma,
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns 502 + emits wizard_failure when step 1 fails", async () => {
    const token = signToken(TELL_KIWI_USER_ID + "-parsefail");
    const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(TELL_KIWI_BODY),
    });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string; reason: string };
    assert.match(body.error, /Kiwi got distracted/);
    assert.equal(body.reason, "validation_failed");

    const calls = runner.getCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].promptKey, "wizard.directed.parse_intent");

    const events = prisma._activities().map((a) => a.eventType);
    assert.ok(events.includes("wizard_failure"));
  });
});

describe("POST /api/wizard/build-from-text — generate-step failure", () => {
  let harness: Harness;
  const prisma = makeStubPrisma();
  const runner = makeTellKiwiRunner({
    parse: () =>
      parseSuccess({
        scenario: "vague",
        explicitMeals: [],
        intentDescriptors: ["easy"],
        mealCount: 5,
      }),
    generate: () => failureFor("wizard.directed.generate"),
  });

  before(async () => {
    harness = await spinUp({
      runAICall: runner.fn,
      prisma,
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("returns 502 + emits wizard_failure when step 2 fails", async () => {
    const token = signToken(TELL_KIWI_USER_ID + "-genfail");
    const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(TELL_KIWI_BODY),
    });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string; reason: string };
    assert.match(body.error, /Kiwi got distracted/);
    assert.equal(body.reason, "validation_failed");

    // Both calls fired.
    const calls = runner.getCalls();
    assert.equal(calls.length, 2);

    const events = prisma._activities().map((a) => a.eventType);
    assert.ok(events.includes("wizard_failure"));
  });
});

describe("POST /api/wizard/build-from-text — entitlement gate", () => {
  let harness: Harness;
  const runner = makeTellKiwiRunner({
    parse: () =>
      parseSuccess({
        scenario: "vague",
        explicitMeals: [],
        intentDescriptors: ["easy"],
        mealCount: 5,
      }),
    generate: () => genSuccess(threeCandidates("blocked")),
  });

  before(async () => {
    harness = await spinUp({
      runAICall: runner.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(false),
    });
  });
  after(async () => harness.close());

  it("returns 402 when kitchen_wizard_just_say is denied; no AI calls fire", async () => {
    const token = signToken(TELL_KIWI_USER_ID + "-blocked");
    const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(TELL_KIWI_BODY),
    });
    assert.equal(res.status, 402);
    assert.equal(runner.getCalls().length, 0);
  });
});

describe("POST /api/wizard/build-from-text — input validation", () => {
  let harness: Harness;
  const runner = makeTellKiwiRunner({
    parse: () =>
      parseSuccess({
        scenario: "vague",
        explicitMeals: [],
        intentDescriptors: [],
        mealCount: 5,
      }),
    generate: () => genSuccess(threeCandidates("validation")),
  });

  before(async () => {
    harness = await spinUp({
      runAICall: runner.fn,
      prisma: makeStubPrisma(),
      subscriptionService: makeSubscriptionService(true),
    });
  });
  after(async () => harness.close());

  it("rejects 400 when description is too short", async () => {
    const token = signToken(TELL_KIWI_USER_ID);
    const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...TELL_KIWI_BODY, description: "yo" }),
    });
    assert.equal(res.status, 400);
    assert.equal(runner.getCalls().length, 0);
  });

  it("rejects 401 when no auth header is present", async () => {
    const res = await fetch(`${harness.baseUrl}/wizard/build-from-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(TELL_KIWI_BODY),
    });
    assert.equal(res.status, 401);
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

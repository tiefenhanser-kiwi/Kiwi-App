// WS6 6b-4 — POST /api/builder/assist-{ingredients,steps} tests.
// Covers auth + input validation + happy path + AI failure + rate limit.
// HTTP transport: same lightweight Express harness as meals.test.ts.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { createBuilderRouter } from "../builder";
import type {
  AssistDishIngredientsResult,
  AssistDishStepsResult,
} from "../../lib/kiwiAssist";
import type { ParseMealFromTextResult } from "../../lib/mealBuilder";
import type {
  EntitlementResult,
  SubscriptionService,
} from "../../lib/subscriptionService";

// ── stub prisma ────────────────────────────────────────────────────────

function makeStubPrisma() {
  const llmCalls: unknown[] = [];
  return {
    aIPrompt: { findUnique: async () => null },
    systemSetting: { findUnique: async () => null },
    lLMCallLog: {
      create: async ({ data }: { data: unknown }) => {
        llmCalls.push(data);
        return data;
      },
    },
    _llmCalls: () => llmCalls,
  };
}

// ── stubbed helpers ────────────────────────────────────────────────────

function makeAssistIngredients(
  result: () => Promise<AssistDishIngredientsResult>,
) {
  let calls = 0;
  const captured: unknown[] = [];
  const fn = (async (opts: unknown) => {
    calls++;
    captured.push(opts);
    return result();
  }) as unknown as Parameters<typeof createBuilderRouter>[0] extends
    | { assistDishIngredients?: infer R }
    | undefined
    ? R
    : never;
  return { fn, getCalls: () => calls, getCaptured: () => captured };
}

function makeAssistSteps(result: () => Promise<AssistDishStepsResult>) {
  let calls = 0;
  const captured: unknown[] = [];
  const fn = (async (opts: unknown) => {
    calls++;
    captured.push(opts);
    return result();
  }) as unknown as Parameters<typeof createBuilderRouter>[0] extends
    | { assistDishSteps?: infer R }
    | undefined
    ? R
    : never;
  return { fn, getCalls: () => calls, getCaptured: () => captured };
}

function ingredientsSuccess(): AssistDishIngredientsResult {
  return {
    status: "success",
    ingredients: [
      {
        name: "spaghetti",
        quantity: 1,
        unit: "lb",
        isUserProvided: true,
        addedByKiwi: false,
      },
      {
        name: "eggs",
        quantity: 4,
        unit: "each",
        isUserProvided: true,
        addedByKiwi: false,
      },
      {
        name: "guanciale",
        quantity: 4,
        unit: "oz",
        isUserProvided: false,
        addedByKiwi: true,
      },
    ],
  };
}

function ingredientsFailure(): AssistDishIngredientsResult {
  return {
    status: "failed",
    error: "Kiwi got distracted. Try again?",
  };
}

function stepsSuccess(): AssistDishStepsResult {
  return {
    status: "success",
    steps: [
      {
        content: "Boil the water.",
        estimatedMinutes: 8,
        phaseType: "preheat",
      },
      {
        content: "Cook the pasta.",
        estimatedMinutes: 9,
        phaseType: "cook",
        isTimingSensitive: true,
      },
    ],
  };
}

function stepsFailure(): AssistDishStepsResult {
  return { status: "failed", error: "Kiwi got distracted. Try again?" };
}

function makeParseMeal(result: () => Promise<ParseMealFromTextResult>) {
  let calls = 0;
  const captured: unknown[] = [];
  const fn = (async (opts: unknown) => {
    calls++;
    captured.push(opts);
    return result();
  }) as unknown as Parameters<typeof createBuilderRouter>[0] extends
    | { parseMealFromText?: infer R }
    | undefined
    ? R
    : never;
  return { fn, getCalls: () => calls, getCaptured: () => captured };
}

function parseMealSuccess(): ParseMealFromTextResult {
  return {
    status: "success",
    meal: {
      title: "Chicken Piccata with Arugula Salad",
      cuisine: "italian",
      estimatedPrepMinutes: 15,
      estimatedCookMinutes: 20,
      servingsDefault: 4,
      difficulty: "medium",
      tags: ["italian", "weeknight"],
      subDishes: [
        {
          title: "Chicken Piccata",
          role: "main",
          positionIndex: 0,
          ingredients: [
            { name: "chicken cutlets", quantity: 1.5, unit: "lb" },
          ],
          steps: [
            {
              content: "Pat chicken dry and season.",
              estimatedMinutes: 2,
              phaseType: "prep",
            },
          ],
        },
      ],
    },
  };
}

function makeSubscriptionService(
  result: EntitlementResult,
): SubscriptionService {
  return { can: async () => result };
}

// ── harness ────────────────────────────────────────────────────────────

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function spinUp(deps: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assistDishIngredients?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assistDishSteps?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parseMealFromText?: any;
  subscriptionService?: SubscriptionService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any;
  rateLimiterOpts?: { capacity: number; refillPerSec: number };
}): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use("/api", createBuilderRouter(deps));

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

const TEST_USER_ID = "test-user-builder";

// ── tests: assist-ingredients ──────────────────────────────────────────

describe("POST /api/builder/assist-ingredients — happy path", () => {
  let harness: Harness;
  const helper = makeAssistIngredients(async () => ingredientsSuccess());

  before(async () => {
    harness = await spinUp({
      assistDishIngredients: helper.fn,
      prisma: makeStubPrisma(),
    });
  });
  after(async () => harness.close());

  it("returns 200 + ingredients on a valid request", async () => {
    const token = signToken(TEST_USER_ID);
    const res = await fetch(`${harness.baseUrl}/builder/assist-ingredients`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        dishTitle: "Spaghetti Carbonara",
        cuisine: "Italian",
        existingIngredients: [{ name: "spaghetti" }, { name: "eggs" }],
        servings: 4,
      }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      status: string;
      ingredients: Array<{
        name: string;
        isUserProvided: boolean;
        addedByKiwi: boolean;
      }>;
    };
    assert.equal(body.status, "success");
    assert.equal(body.ingredients.length, 3);
    assert.ok(
      body.ingredients.some((i) => i.name === "spaghetti" && i.isUserProvided),
    );
    assert.ok(
      body.ingredients.some((i) => i.name === "guanciale" && i.addedByKiwi),
    );
    assert.equal(helper.getCalls(), 1);
  });
});

describe("POST /api/builder/assist-ingredients — auth + input validation", () => {
  let harness: Harness;
  const helper = makeAssistIngredients(async () => ingredientsSuccess());

  before(async () => {
    harness = await spinUp({
      assistDishIngredients: helper.fn,
      prisma: makeStubPrisma(),
    });
  });
  after(async () => harness.close());

  it("rejects 401 when no authorization header", async () => {
    const res = await fetch(`${harness.baseUrl}/builder/assist-ingredients`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dishTitle: "Tacos",
        existingIngredients: [],
        servings: 4,
      }),
    });
    assert.equal(res.status, 401);
  });

  it("rejects 400 when dishTitle is missing", async () => {
    const token = signToken(TEST_USER_ID);
    const res = await fetch(`${harness.baseUrl}/builder/assist-ingredients`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ existingIngredients: [], servings: 4 }),
    });
    assert.equal(res.status, 400);
  });

  it("rejects 400 when servings is out of range", async () => {
    const token = signToken(TEST_USER_ID);
    const res = await fetch(`${harness.baseUrl}/builder/assist-ingredients`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        dishTitle: "Tacos",
        existingIngredients: [],
        servings: 999,
      }),
    });
    assert.equal(res.status, 400);
  });
});

describe("POST /api/builder/assist-ingredients — AI failure", () => {
  let harness: Harness;
  const helper = makeAssistIngredients(async () => ingredientsFailure());

  before(async () => {
    harness = await spinUp({
      assistDishIngredients: helper.fn,
      prisma: makeStubPrisma(),
    });
  });
  after(async () => harness.close());

  it("returns 502 with the helper's error message", async () => {
    const token = signToken(TEST_USER_ID + "-fail");
    const res = await fetch(`${harness.baseUrl}/builder/assist-ingredients`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        dishTitle: "Tacos",
        existingIngredients: [],
        servings: 4,
      }),
    });

    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string; status: string };
    assert.equal(body.status, "failed");
    assert.match(body.error, /Kiwi got distracted/);
  });
});

// ── tests: assist-steps ────────────────────────────────────────────────

describe("POST /api/builder/assist-steps — happy path", () => {
  let harness: Harness;
  const helper = makeAssistSteps(async () => stepsSuccess());

  before(async () => {
    harness = await spinUp({
      assistDishSteps: helper.fn,
      prisma: makeStubPrisma(),
    });
  });
  after(async () => harness.close());

  it("returns 200 + steps on a valid request", async () => {
    const token = signToken(TEST_USER_ID + "-steps");
    const res = await fetch(`${harness.baseUrl}/builder/assist-steps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        dishTitle: "Spaghetti Carbonara",
        cuisine: "Italian",
        ingredients: [
          { name: "spaghetti", quantity: 1, unit: "lb" },
          { name: "eggs", quantity: 4, unit: "each" },
        ],
        servings: 4,
      }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      status: string;
      steps: Array<{ content: string; phaseType: string }>;
    };
    assert.equal(body.status, "success");
    assert.equal(body.steps.length, 2);
    assert.equal(body.steps[0].phaseType, "preheat");
    assert.equal(helper.getCalls(), 1);
  });
});

describe("POST /api/builder/assist-steps — auth + input validation", () => {
  let harness: Harness;
  const helper = makeAssistSteps(async () => stepsSuccess());

  before(async () => {
    harness = await spinUp({
      assistDishSteps: helper.fn,
      prisma: makeStubPrisma(),
    });
  });
  after(async () => harness.close());

  it("rejects 401 when no authorization header", async () => {
    const res = await fetch(`${harness.baseUrl}/builder/assist-steps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dishTitle: "Tacos",
        ingredients: [{ name: "beef", quantity: 1, unit: "lb" }],
        servings: 4,
      }),
    });
    assert.equal(res.status, 401);
  });

  it("rejects 400 when ingredients is empty", async () => {
    const token = signToken(TEST_USER_ID + "-steps");
    const res = await fetch(`${harness.baseUrl}/builder/assist-steps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        dishTitle: "Tacos",
        ingredients: [],
        servings: 4,
      }),
    });
    assert.equal(res.status, 400);
  });
});

describe("POST /api/builder/assist-steps — AI failure", () => {
  let harness: Harness;
  const helper = makeAssistSteps(async () => stepsFailure());

  before(async () => {
    harness = await spinUp({
      assistDishSteps: helper.fn,
      prisma: makeStubPrisma(),
    });
  });
  after(async () => harness.close());

  it("returns 502 with the helper's error message", async () => {
    const token = signToken(TEST_USER_ID + "-stepfail");
    const res = await fetch(`${harness.baseUrl}/builder/assist-steps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        dishTitle: "Tacos",
        ingredients: [{ name: "beef", quantity: 1, unit: "lb" }],
        servings: 4,
      }),
    });

    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string; status: string };
    assert.equal(body.status, "failed");
    assert.match(body.error, /Kiwi got distracted/);
  });
});

// ── tests: rate limit (one endpoint suffices — same limiter on both) ──

describe("POST /api/builder/assist-ingredients — rate limit", () => {
  let harness: Harness;
  const helper = makeAssistIngredients(async () => ingredientsSuccess());

  before(async () => {
    // Capacity 2, refill 0 → 3rd request in burst must 429.
    harness = await spinUp({
      assistDishIngredients: helper.fn,
      prisma: makeStubPrisma(),
      rateLimiterOpts: { capacity: 2, refillPerSec: 0 },
    });
  });
  after(async () => harness.close());

  it("returns 429 after exceeding the per-user capacity", async () => {
    const token = signToken(TEST_USER_ID + "-rl");
    const body = JSON.stringify({
      dishTitle: "Tacos",
      existingIngredients: [],
      servings: 4,
    });
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
    const r1 = await fetch(`${harness.baseUrl}/builder/assist-ingredients`, {
      method: "POST",
      headers,
      body,
    });
    const r2 = await fetch(`${harness.baseUrl}/builder/assist-ingredients`, {
      method: "POST",
      headers,
      body,
    });
    const r3 = await fetch(`${harness.baseUrl}/builder/assist-ingredients`, {
      method: "POST",
      headers,
      body,
    });

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 429);
  });
});

// ── tests: parse-meal (Mode A) ────────────────────────────────────────

describe("POST /api/builder/parse-meal — happy path", () => {
  let harness: Harness;
  const helper = makeParseMeal(async () => parseMealSuccess());

  before(async () => {
    harness = await spinUp({
      parseMealFromText: helper.fn,
      subscriptionService: makeSubscriptionService({ allowed: true }),
      prisma: makeStubPrisma(),
    });
  });
  after(async () => harness.close());

  it("returns 200 + meal on a valid request", async () => {
    const token = signToken(TEST_USER_ID + "-modea");
    const res = await fetch(`${harness.baseUrl}/builder/parse-meal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        freeText:
          "Chicken piccata with a side arugula salad and lemon vinaigrette",
        servings: 4,
      }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      status: string;
      meal: { title: string; cuisine: string; subDishes: unknown[] };
    };
    assert.equal(body.status, "success");
    assert.equal(body.meal.cuisine, "italian");
    assert.equal(body.meal.subDishes.length, 1);
    assert.equal(helper.getCalls(), 1);
  });
});

describe("POST /api/builder/parse-meal — premium gate denied", () => {
  let harness: Harness;
  const helper = makeParseMeal(async () => parseMealSuccess());

  before(async () => {
    harness = await spinUp({
      parseMealFromText: helper.fn,
      subscriptionService: makeSubscriptionService({
        allowed: false,
        reason: "Mode A is a premium feature.",
      }),
      prisma: makeStubPrisma(),
    });
  });
  after(async () => harness.close());

  it("returns 402 upgrade-required without invoking the helper", async () => {
    const token = signToken(TEST_USER_ID + "-modea-denied");
    const res = await fetch(`${harness.baseUrl}/builder/parse-meal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        freeText: "Beef stew",
        servings: 4,
      }),
    });

    assert.equal(res.status, 402);
    const body = (await res.json()) as { error: string; reason: string };
    assert.match(body.error, /upgrade required/);
    assert.match(body.reason, /premium/);
    assert.equal(helper.getCalls(), 0);
  });
});

describe("POST /api/builder/parse-meal — auth + input validation", () => {
  let harness: Harness;
  const helper = makeParseMeal(async () => parseMealSuccess());

  before(async () => {
    harness = await spinUp({
      parseMealFromText: helper.fn,
      subscriptionService: makeSubscriptionService({ allowed: true }),
      prisma: makeStubPrisma(),
    });
  });
  after(async () => harness.close());

  it("rejects 401 when no authorization header", async () => {
    const res = await fetch(`${harness.baseUrl}/builder/parse-meal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freeText: "Beef stew", servings: 4 }),
    });
    assert.equal(res.status, 401);
  });

  it("rejects 400 when freeText is too short", async () => {
    const token = signToken(TEST_USER_ID + "-modea-bad");
    const res = await fetch(`${harness.baseUrl}/builder/parse-meal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ freeText: "x", servings: 4 }),
    });
    assert.equal(res.status, 400);
  });
});

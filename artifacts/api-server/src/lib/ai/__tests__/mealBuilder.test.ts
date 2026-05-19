// WS6 6b-5 — parseMealFromText helper unit tests.
// Run via: pnpm --filter @workspace/api-server test
// SDK is mocked by injecting opts.client — no network calls.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";

import { parseMealFromText } from "../../mealBuilder";
import { _resetClientCache } from "../runAICall";
import type {
  AIPromptRow,
  LLMCallLogCreateData,
  PrismaLike,
  SystemSettingRow,
} from "../promptRegistry";

// ── stub prisma ────────────────────────────────────────────────────────

function makeStubPrisma(): {
  prisma: PrismaLike;
  llmCalls: () => LLMCallLogCreateData[];
} {
  const llmCalls: LLMCallLogCreateData[] = [];
  const prisma: PrismaLike = {
    aIPrompt: {
      findUnique: async (): Promise<AIPromptRow | null> => null,
    },
    systemSetting: {
      findUnique: async (): Promise<SystemSettingRow | null> => null,
    },
    lLMCallLog: {
      create: async ({ data }: { data: LLMCallLogCreateData }) => {
        llmCalls.push(data);
        return data;
      },
    },
  };
  return { prisma, llmCalls: () => llmCalls };
}

// ── fake Anthropic client ──────────────────────────────────────────────

interface QueuedResponse {
  content: Anthropic.ContentBlock[];
  inputTokens?: number;
  outputTokens?: number;
}

interface FakeClient {
  client: Pick<Anthropic, "messages">;
  callCount: () => number;
  lastUserMessage: () => string | null;
}

function makeFakeClient(responses: QueuedResponse[]): FakeClient {
  let calls = 0;
  let lastUserMessage: string | null = null;
  const queue = [...responses];
  const client = {
    messages: {
      create: async (
        params: Anthropic.MessageCreateParams,
      ): Promise<Anthropic.Message> => {
        calls++;
        const msg = params.messages[0];
        if (msg && typeof msg.content === "string") {
          lastUserMessage = msg.content;
        }
        const next = queue.shift();
        if (!next) throw new Error("fake client exhausted: no queued responses");
        return {
          id: `msg_test_${calls}`,
          container: null,
          content: next.content,
          model: params.model,
          role: "assistant",
          stop_details: null,
          stop_reason: "end_turn",
          stop_sequence: null,
          type: "message",
          usage: {
            input_tokens: next.inputTokens ?? 200,
            output_tokens: next.outputTokens ?? 400,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            server_tool_use: null,
            service_tier: null,
          },
        } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Pick<Anthropic, "messages">;
  return {
    client,
    callCount: () => calls,
    lastUserMessage: () => lastUserMessage,
  };
}

function makeThrowingClient(err: Error): FakeClient {
  let calls = 0;
  const client = {
    messages: {
      create: async (): Promise<Anthropic.Message> => {
        calls++;
        throw err;
      },
    },
  } as unknown as Pick<Anthropic, "messages">;
  return {
    client,
    callCount: () => calls,
    lastUserMessage: () => null,
  };
}

// ── canned AI responses ────────────────────────────────────────────────

const THREE_SUB_DISH_PAYLOAD = {
  meal: {
    title: "Chicken Piccata with Arugula Salad",
    cuisine: "italian",
    estimatedPrepMinutes: 15,
    estimatedCookMinutes: 20,
    servingsDefault: 4,
    difficulty: "medium",
    tags: ["italian", "weeknight", "lemon"],
    subDishes: [
      {
        title: "Chicken Piccata",
        role: "main",
        positionIndex: 0,
        ingredients: [
          { name: "chicken cutlets", quantity: 1.5, unit: "lb" },
          { name: "lemon", quantity: 2, unit: "each" },
          { name: "capers", quantity: 2, unit: "tbsp" },
          { name: "all-purpose flour", quantity: 0.5, unit: "cup" },
          { name: "butter", quantity: 4, unit: "tbsp" },
        ],
        steps: [
          {
            content: "Pat chicken dry and season with salt and pepper.",
            estimatedMinutes: 3,
            phaseType: "prep",
            parallelGroup: "group-1",
          },
          {
            content: "Dredge cutlets in flour.",
            estimatedMinutes: 2,
            phaseType: "prep",
            parallelGroup: "group-1",
          },
          {
            content: "Sear cutlets in butter until golden.",
            estimatedMinutes: 6,
            phaseType: "cook",
            isTimingSensitive: true,
          },
          {
            content: "Deglaze pan with lemon juice and capers.",
            estimatedMinutes: 3,
            phaseType: "cook",
            isTimingSensitive: true,
          },
        ],
      },
      {
        title: "Arugula Salad",
        role: "side",
        positionIndex: 1,
        ingredients: [
          { name: "arugula", quantity: 6, unit: "cup" },
          { name: "shaved parmesan", quantity: 0.25, unit: "cup" },
        ],
        steps: [
          {
            content: "Toss arugula with vinaigrette in a large bowl.",
            estimatedMinutes: 2,
            phaseType: "assemble",
            parallelGroup: "group-1",
          },
          {
            content: "Top with shaved parmesan and serve.",
            estimatedMinutes: 1,
            phaseType: "assemble",
          },
        ],
      },
      {
        title: "Lemon Vinaigrette",
        role: "sauce",
        positionIndex: 2,
        ingredients: [
          { name: "lemon juice", quantity: 3, unit: "tbsp" },
          { name: "extra-virgin olive oil", quantity: 0.25, unit: "cup" },
          { name: "dijon mustard", quantity: 1, unit: "tsp" },
        ],
        steps: [
          {
            content: "Whisk lemon juice and mustard together.",
            estimatedMinutes: 1,
            phaseType: "prep",
            parallelGroup: "group-1",
          },
          {
            content: "Slowly stream in olive oil while whisking to emulsify.",
            estimatedMinutes: 2,
            phaseType: "prep",
            isTimingSensitive: true,
          },
        ],
      },
    ],
  },
};

const SINGLE_DISH_PAYLOAD = {
  meal: {
    title: "Slow-Cooker Beef Stew",
    cuisine: "american",
    estimatedPrepMinutes: 15,
    estimatedCookMinutes: 360,
    servingsDefault: 4,
    difficulty: "easy",
    tags: ["slow-cooker", "comfort", "beef"],
    subDishes: [
      {
        title: "Slow-Cooker Beef Stew",
        role: "main",
        positionIndex: 0,
        ingredients: [
          { name: "beef chuck", quantity: 2, unit: "lb" },
          { name: "carrots", quantity: 4, unit: "each" },
          { name: "potatoes", quantity: 1.5, unit: "lb" },
          { name: "beef broth", quantity: 4, unit: "cup" },
          { name: "onion", quantity: 1, unit: "each" },
        ],
        steps: [
          {
            content: "Brown the beef cubes in batches.",
            estimatedMinutes: 8,
            phaseType: "cook",
            isTimingSensitive: true,
          },
          {
            content: "Transfer beef and aromatics to the slow cooker.",
            estimatedMinutes: 3,
            phaseType: "prep",
          },
          {
            content: "Add broth, cover, and cook on low for 6 hours.",
            estimatedMinutes: 360,
            phaseType: "cook",
          },
        ],
      },
    ],
  },
};

const WITH_CAVEATS_PAYLOAD = {
  meal: {
    title: "Pasta Night",
    cuisine: "italian",
    estimatedPrepMinutes: 10,
    estimatedCookMinutes: 15,
    servingsDefault: 4,
    difficulty: "easy",
    tags: ["pasta", "weeknight"],
    subDishes: [
      {
        title: "Marinara Pasta",
        role: "main",
        positionIndex: 0,
        ingredients: [
          { name: "spaghetti", quantity: 1, unit: "lb" },
          { name: "marinara sauce", quantity: 3, unit: "cup" },
        ],
        steps: [
          {
            content: "Boil pasta until al dente.",
            estimatedMinutes: 10,
            phaseType: "cook",
          },
          {
            content: "Toss with warmed marinara and serve.",
            estimatedMinutes: 2,
            phaseType: "assemble",
          },
        ],
      },
    ],
  },
  caveats: [
    "Assumed marinara-base; specify if you'd prefer pesto.",
    "Add protein for a heartier meal.",
  ],
};

const VEGETARIAN_PAYLOAD = {
  meal: {
    title: "Hearty Vegetarian Pasta with Side Salad",
    cuisine: "italian",
    estimatedPrepMinutes: 15,
    estimatedCookMinutes: 20,
    servingsDefault: 4,
    difficulty: "medium",
    tags: ["italian", "vegetarian", "weeknight"],
    subDishes: [
      {
        title: "Roasted Vegetable Penne",
        role: "main",
        positionIndex: 0,
        ingredients: [
          { name: "penne", quantity: 1, unit: "lb" },
          { name: "zucchini", quantity: 2, unit: "each" },
          { name: "cherry tomatoes", quantity: 1, unit: "pint" },
          { name: "garlic", quantity: 4, unit: "clove" },
          { name: "extra-virgin olive oil", quantity: 0.25, unit: "cup" },
          { name: "parmesan", quantity: 0.5, unit: "cup" },
        ],
        steps: [
          {
            content: "Preheat oven to 425F.",
            estimatedMinutes: 1,
            phaseType: "preheat",
            parallelGroup: "group-1",
          },
          {
            content: "Roast zucchini and tomatoes with garlic and oil.",
            estimatedMinutes: 18,
            phaseType: "cook",
            parallelGroup: "group-1",
          },
          {
            content: "Cook penne until al dente.",
            estimatedMinutes: 10,
            phaseType: "cook",
            isTimingSensitive: true,
          },
          {
            content: "Toss pasta with roasted vegetables and parmesan.",
            estimatedMinutes: 2,
            phaseType: "assemble",
          },
        ],
      },
      {
        title: "Mixed Green Salad",
        role: "side",
        positionIndex: 1,
        ingredients: [
          { name: "mixed greens", quantity: 6, unit: "cup" },
          { name: "balsamic vinaigrette", quantity: 3, unit: "tbsp" },
        ],
        steps: [
          {
            content: "Toss greens with vinaigrette.",
            estimatedMinutes: 2,
            phaseType: "assemble",
          },
        ],
      },
    ],
  },
};

// ── env hygiene ────────────────────────────────────────────────────────

let savedKey: string | undefined;
before(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
});
after(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  _resetClientCache();
});

const TEST_USER_ID = "test-user-mode-a";

// ── tests ──────────────────────────────────────────────────────────────

describe("parseMealFromText — happy path (composite meal)", () => {
  it("returns success with 3 sub-dishes and writes LLMCallLog", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const fake = makeFakeClient([
      {
        content: [
          {
            type: "text",
            text: JSON.stringify(THREE_SUB_DISH_PAYLOAD),
            citations: null,
          } as Anthropic.ContentBlock,
        ],
      },
    ]);
    const { prisma, llmCalls } = makeStubPrisma();

    const result = await parseMealFromText({
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
      freeText: "Chicken piccata with a side arugula salad and lemon vinaigrette",
      servings: 4,
    });

    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.meal.subDishes.length, 3);
    assert.equal(result.meal.subDishes[0].role, "main");
    assert.equal(result.meal.subDishes[1].role, "side");
    assert.equal(result.meal.subDishes[2].role, "sauce");
    assert.equal(result.meal.cuisine, "italian");
    assert.equal(result.caveats, undefined);

    assert.equal(fake.callCount(), 1);

    const logs = llmCalls();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].promptKey, "meal_builder.mode_a_parse");
    assert.equal(logs[0].userId, TEST_USER_ID);
    assert.equal(logs[0].success, true);
    assert.equal(logs[0].mode, "text");
  });
});

describe("parseMealFromText — single-dish meal", () => {
  it("returns 1 sub-dish when the description is a single dish", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const fake = makeFakeClient([
      {
        content: [
          {
            type: "text",
            text: JSON.stringify(SINGLE_DISH_PAYLOAD),
            citations: null,
          } as Anthropic.ContentBlock,
        ],
      },
    ]);
    const { prisma } = makeStubPrisma();

    const result = await parseMealFromText({
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
      freeText: "Slow-cooker beef stew with carrots and potatoes",
      servings: 4,
    });

    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.meal.subDishes.length, 1);
    assert.equal(result.meal.subDishes[0].role, "main");
    assert.equal(result.meal.difficulty, "easy");
  });
});

describe("parseMealFromText — caveats forwarded", () => {
  it("forwards the caveats array when the model returns it", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const fake = makeFakeClient([
      {
        content: [
          {
            type: "text",
            text: JSON.stringify(WITH_CAVEATS_PAYLOAD),
            citations: null,
          } as Anthropic.ContentBlock,
        ],
      },
    ]);
    const { prisma } = makeStubPrisma();

    const result = await parseMealFromText({
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
      freeText: "Pasta night",
      servings: 4,
    });

    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.deepEqual(result.caveats, [
      "Assumed marinara-base; specify if you'd prefer pesto.",
      "Add protein for a heartier meal.",
    ]);
  });
});

describe("parseMealFromText — failure paths", () => {
  it("returns status='failed' when the AI client throws — does not throw", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const fake = makeThrowingClient(new Error("simulated SDK outage"));
    const { prisma, llmCalls } = makeStubPrisma();

    const result = await parseMealFromText({
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
      freeText: "Pasta with red sauce",
      servings: 4,
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(typeof result.error, "string");
    assert.ok(result.error.length > 0);

    const logs = llmCalls();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].success, false);
  });
});

describe("parseMealFromText — userHints pass-through", () => {
  it("accepts userHints.dietary and returns the vegetarian variant from the AI", async () => {
    // The unit test stubs prisma.aIPrompt.findUnique to return null, so the
    // in-memory REGISTRY placeholder body is what gets rendered — that body
    // has no {{parseMealInput}} token, so we can't assert on prompt content
    // here. Pass-through of userHints to runAICall is structurally
    // guaranteed by parseMealFromText's call signature; the live smoke
    // exercises the real prompt body.
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const fake = makeFakeClient([
      {
        content: [
          {
            type: "text",
            text: JSON.stringify(VEGETARIAN_PAYLOAD),
            citations: null,
          } as Anthropic.ContentBlock,
        ],
      },
    ]);
    const { prisma } = makeStubPrisma();

    const result = await parseMealFromText({
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
      freeText: "Hearty pasta dinner with a salad",
      servings: 4,
      userHints: { dietary: ["vegetarian"] },
    });

    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.meal.subDishes.length, 2);
    assert.ok(result.meal.tags.includes("vegetarian"));
  });
});

// ── parallelGroup schema shape (D-WS6-034 reconciliation) ─────────────

describe("AssistedStepSchema / ParsedSubDishStepSchema — parallelGroup type", () => {
  it("accepts string identifiers per sequencer convention", async () => {
    const { AssistedStepSchema, ParsedSubDishStepSchema } = await import(
      "../schemas/mealBuilder"
    );

    const baseStep = {
      content: "Bring a large pot of salted water to a boil.",
      estimatedMinutes: 8,
      phaseType: "preheat" as const,
    };
    // Sequencer convention: short string IDs like "group-1", "oven",
    // "boil_water", "passive-1". Null is allowed for sequential steps.
    for (const pg of ["group-1", "oven", "boil_water", "passive-1"]) {
      const ok = AssistedStepSchema.safeParse({ ...baseStep, parallelGroup: pg });
      assert.equal(ok.success, true, `AssistedStep should accept parallelGroup=${pg}`);
      const ok2 = ParsedSubDishStepSchema.safeParse({ ...baseStep, parallelGroup: pg });
      assert.equal(ok2.success, true, `ParsedSubDishStep should accept parallelGroup=${pg}`);
    }
    const okNull = ParsedSubDishStepSchema.safeParse({ ...baseStep, parallelGroup: null });
    assert.equal(okNull.success, true, "ParsedSubDishStep should accept parallelGroup=null");
    const okOmit = AssistedStepSchema.safeParse(baseStep);
    assert.equal(okOmit.success, true, "AssistedStep should accept omitted parallelGroup");
  });

  it("rejects integer parallelGroup (regression guard against the old shape)", async () => {
    const { AssistedStepSchema, ParsedSubDishStepSchema } = await import(
      "../schemas/mealBuilder"
    );

    const baseStep = {
      content: "Bring a large pot of salted water to a boil.",
      estimatedMinutes: 8,
      phaseType: "preheat" as const,
    };
    const bad1 = AssistedStepSchema.safeParse({ ...baseStep, parallelGroup: 1 });
    assert.equal(bad1.success, false, "AssistedStep should reject integer parallelGroup");
    const bad2 = ParsedSubDishStepSchema.safeParse({ ...baseStep, parallelGroup: 2 });
    assert.equal(bad2.success, false, "ParsedSubDishStep should reject integer parallelGroup");
  });
});

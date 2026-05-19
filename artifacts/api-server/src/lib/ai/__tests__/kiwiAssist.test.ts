// WS6 6b-4 — kiwiAssist helper unit tests.
// Run via: pnpm --filter @workspace/api-server test
// Uses node:test (built-in to Node v18+; stable on Node v25).
// SDK is mocked by injecting opts.client — no network calls.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";

import {
  assistDishIngredients,
  assistDishSteps,
} from "../../kiwiAssist";
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
}

function makeFakeClient(responses: QueuedResponse[]): FakeClient {
  let calls = 0;
  const queue = [...responses];
  const client = {
    messages: {
      create: async (
        params: Anthropic.MessageCreateParams,
      ): Promise<Anthropic.Message> => {
        calls++;
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
            input_tokens: next.inputTokens ?? 100,
            output_tokens: next.outputTokens ?? 50,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            server_tool_use: null,
            service_tier: null,
          },
        } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Pick<Anthropic, "messages">;
  return { client, callCount: () => calls };
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
  return { client, callCount: () => calls };
}

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

const TEST_USER_ID = "test-user-kiwi-assist";

// ─── assistDishIngredients ────────────────────────────────────────────

describe("assistDishIngredients — happy path", () => {
  it("returns success with parsed ingredients + writes LLMCallLog", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();

    const aiPayload = {
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
        {
          name: "pecorino romano",
          quantity: 0.5,
          unit: "cup",
          isUserProvided: false,
          addedByKiwi: true,
        },
        {
          name: "black pepper",
          quantity: 1,
          unit: "tsp",
          isUserProvided: false,
          addedByKiwi: true,
        },
      ],
    };
    const fake = makeFakeClient([
      {
        content: [
          {
            type: "text",
            text: JSON.stringify(aiPayload),
            citations: null,
          } as Anthropic.ContentBlock,
        ],
      },
    ]);
    const { prisma, llmCalls } = makeStubPrisma();

    const result = await assistDishIngredients({
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
      dishTitle: "Spaghetti Carbonara",
      cuisine: "Italian",
      existingIngredients: [{ name: "spaghetti" }, { name: "eggs" }],
      servings: 4,
    });

    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.ingredients.length, 5);

    const userProvided = result.ingredients.filter((i) => i.isUserProvided);
    assert.equal(userProvided.length, 2);
    assert.ok(userProvided.find((i) => i.name === "spaghetti"));
    assert.ok(userProvided.find((i) => i.name === "eggs"));

    const addedByKiwi = result.ingredients.filter((i) => i.addedByKiwi);
    assert.equal(addedByKiwi.length, 3);

    assert.equal(fake.callCount(), 1);

    const logs = llmCalls();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].promptKey, "meal_builder.assist_ingredients");
    assert.equal(logs[0].userId, TEST_USER_ID);
    assert.equal(logs[0].success, true);
    assert.equal(logs[0].mode, "text");
  });

  it("forwards caveats when the model returns them", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const fake = makeFakeClient([
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ingredients: [
                {
                  name: "flour",
                  quantity: 2,
                  unit: "cup",
                  isUserProvided: false,
                  addedByKiwi: true,
                },
              ],
              caveats: ["Assumed all-purpose flour"],
            }),
            citations: null,
          } as Anthropic.ContentBlock,
        ],
      },
    ]);
    const { prisma } = makeStubPrisma();

    const result = await assistDishIngredients({
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
      dishTitle: "Pizza Dough",
      existingIngredients: [],
      servings: 4,
    });

    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.deepEqual(result.caveats, ["Assumed all-purpose flour"]);
  });
});

describe("assistDishIngredients — failure paths", () => {
  it("returns status='failed' when the AI client throws — does not throw", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const fake = makeThrowingClient(new Error("simulated SDK outage"));
    const { prisma, llmCalls } = makeStubPrisma();

    const result = await assistDishIngredients({
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
      dishTitle: "Beef Tacos",
      existingIngredients: [],
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

  it("returns status='failed' on malformed JSON after retry", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const fake = makeFakeClient([
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ingredients: [] }),
            citations: null,
          } as Anthropic.ContentBlock,
        ],
      },
      {
        content: [
          {
            type: "text",
            text: "not json",
            citations: null,
          } as Anthropic.ContentBlock,
        ],
      },
    ]);
    const { prisma, llmCalls } = makeStubPrisma();

    const result = await assistDishIngredients({
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
      dishTitle: "Beef Tacos",
      existingIngredients: [],
      servings: 4,
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(fake.callCount(), 2);

    const logs = llmCalls();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].failureReason, "validation_failed");
  });
});

// ─── assistDishSteps ──────────────────────────────────────────────────

describe("assistDishSteps — happy path", () => {
  it("returns success with parsed steps and writes LLMCallLog", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const fake = makeFakeClient([
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              steps: [
                {
                  content: "Bring a large pot of salted water to a boil.",
                  estimatedMinutes: 8,
                  phaseType: "preheat",
                  parallelGroup: "group-1",
                },
                {
                  content: "Render the guanciale in a dry pan over medium heat.",
                  estimatedMinutes: 5,
                  phaseType: "cook",
                  isTimingSensitive: true,
                  parallelGroup: "group-1",
                },
                {
                  content: "Cook the spaghetti until al dente.",
                  estimatedMinutes: 9,
                  phaseType: "cook",
                  isTimingSensitive: true,
                },
                {
                  content: "Toss pasta with eggs, cheese, and rendered pork.",
                  estimatedMinutes: 2,
                  phaseType: "assemble",
                  isTimingSensitive: true,
                },
              ],
            }),
            citations: null,
          } as Anthropic.ContentBlock,
        ],
      },
    ]);
    const { prisma, llmCalls } = makeStubPrisma();

    const result = await assistDishSteps({
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
      dishTitle: "Spaghetti Carbonara",
      cuisine: "Italian",
      ingredients: [
        { name: "spaghetti", quantity: 1, unit: "lb" },
        { name: "eggs", quantity: 4, unit: "each" },
        { name: "guanciale", quantity: 4, unit: "oz" },
        { name: "pecorino romano", quantity: 0.5, unit: "cup" },
      ],
      servings: 4,
    });

    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.steps.length, 4);
    assert.equal(result.steps[0].phaseType, "preheat");
    assert.equal(result.steps[3].phaseType, "assemble");

    const logs = llmCalls();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].promptKey, "meal_builder.assist_steps");
    assert.equal(logs[0].success, true);
  });

});

describe("assistDishSteps — failure paths", () => {
  it("returns status='failed' when client throws — does not throw", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const fake = makeThrowingClient(new Error("simulated SDK outage"));
    const { prisma, llmCalls } = makeStubPrisma();

    const result = await assistDishSteps({
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
      dishTitle: "Beef Tacos",
      ingredients: [{ name: "ground beef", quantity: 1, unit: "lb" }],
      servings: 4,
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.ok(result.error.length > 0);

    const logs = llmCalls();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].success, false);
  });

  it("returns status='failed' when ANTHROPIC_API_KEY unset and no client", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    _resetClientCache();
    const { prisma, llmCalls } = makeStubPrisma();

    const result = await assistDishSteps({
      prisma,
      userId: TEST_USER_ID,
      dishTitle: "Beef Tacos",
      ingredients: [{ name: "ground beef", quantity: 1, unit: "lb" }],
      servings: 4,
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;

    const logs = llmCalls();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].failureReason, "no_api_key");
  });
});

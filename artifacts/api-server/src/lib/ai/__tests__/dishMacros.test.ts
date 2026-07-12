// WS6 6b-2 — dishMacros helper unit tests.
// Run via: pnpm --filter @workspace/api-server test
// Uses node:test (built-in to Node v18+; stable on Node v25).
// SDK is mocked by injecting opts.client — no network calls.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";

import {
  estimateDishMacros,
  shouldEstimateMacros,
} from "../../dishMacros";
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

const TEST_USER_ID = "test-user-dish-macros";

const SAMPLE_INPUT = {
  dishTitle: "Beef Tacos",
  servings: 4,
  ingredients: [
    { name: "Ground beef", quantity: 1, unit: "lb" },
    { name: "Taco shells", quantity: 12, unit: "each" },
    { name: "Cheddar", quantity: 1, unit: "cup" },
    { name: "Parsley", quantity: 1, unit: "bunch", isOptional: true },
  ],
};

// ── shouldEstimateMacros ───────────────────────────────────────────────

describe("shouldEstimateMacros", () => {
  it("returns true when all four macros are 0 and no flag", () => {
    assert.equal(
      shouldEstimateMacros({
        caloriesPerServing: 0,
        proteinGPerServing: 0,
        carbsGPerServing: 0,
        fatGPerServing: 0,
      }),
      true,
    );
  });

  it("returns false when user entered manual macros and no flag", () => {
    assert.equal(
      shouldEstimateMacros({
        caloriesPerServing: 520,
        proteinGPerServing: 28,
        carbsGPerServing: 38,
        fatGPerServing: 26,
      }),
      false,
    );
  });

  it("returns true when kiwiAssistIngredients=true even with manual macros", () => {
    assert.equal(
      shouldEstimateMacros({
        caloriesPerServing: 520,
        proteinGPerServing: 28,
        carbsGPerServing: 38,
        fatGPerServing: 26,
        kiwiAssistIngredients: true,
      }),
      true,
    );
  });

  it("returns true when macros are zero and kiwiAssistIngredients=false", () => {
    assert.equal(
      shouldEstimateMacros({
        caloriesPerServing: 0,
        proteinGPerServing: 0,
        carbsGPerServing: 0,
        fatGPerServing: 0,
        kiwiAssistIngredients: false,
      }),
      true,
    );
  });

  it("returns false when any single macro is non-zero and no flag", () => {
    assert.equal(
      shouldEstimateMacros({
        caloriesPerServing: 0,
        proteinGPerServing: 12,
        carbsGPerServing: 0,
        fatGPerServing: 0,
      }),
      false,
    );
  });
});

// ── estimateDishMacros — happy path ────────────────────────────────────

describe("estimateDishMacros — happy path", () => {
  it("returns status='success' with parsed macros and writes LLMCallLog", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const fake = makeFakeClient([
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              perServing: {
                calories: 520,
                proteinG: 28.4,
                carbsG: 38.0,
                fatG: 24.7,
              },
              confidence: "high",
            }),
            citations: null,
          } as Anthropic.ContentBlock,
        ],
      },
    ]);
    const { prisma, llmCalls } = makeStubPrisma();

    const result = await estimateDishMacros({
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
      ...SAMPLE_INPUT,
    });

    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.perServing.calories, 520);
    assert.equal(result.perServing.proteinG, 28.4);
    assert.equal(result.perServing.carbsG, 38.0);
    assert.equal(result.perServing.fatG, 24.7);
    assert.equal(result.confidence, "high");

    assert.equal(fake.callCount(), 1);

    // LLMCallLog row written on the AI path.
    const logs = llmCalls();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].promptKey, "nutrition.ingredient_estimate");
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
              perServing: {
                calories: 480,
                proteinG: 18,
                carbsG: 62,
                fatG: 18,
              },
              confidence: "medium",
              caveats: ["Used generic 'mild cheese' density for 'queso fresco'."],
            }),
            citations: null,
          } as Anthropic.ContentBlock,
        ],
      },
    ]);
    const { prisma } = makeStubPrisma();

    const result = await estimateDishMacros({
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
      ...SAMPLE_INPUT,
    });

    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.confidence, "medium");
    assert.deepEqual(result.caveats, [
      "Used generic 'mild cheese' density for 'queso fresco'.",
    ]);
  });
});

// ── estimateDishMacros — failure paths ─────────────────────────────────

describe("estimateDishMacros — failure paths", () => {
  it("returns status='failed' when the AI client throws — does not throw", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const fake = makeThrowingClient(new Error("simulated SDK outage"));
    const { prisma, llmCalls } = makeStubPrisma();

    const result = await estimateDishMacros({
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
      ...SAMPLE_INPUT,
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(typeof result.error, "string");
    assert.ok(result.error.length > 0);

    // LLMCallLog row STILL written on failure (with success=false).
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
            text: JSON.stringify({
              // Missing perServing wrapper — wrong shape.
              calories: 520,
            }),
            citations: null,
          } as Anthropic.ContentBlock,
        ],
      },
      {
        content: [
          {
            type: "text",
            // Still wrong on the retry attempt.
            text: "not even json",
            citations: null,
          } as Anthropic.ContentBlock,
        ],
      },
    ]);
    const { prisma, llmCalls } = makeStubPrisma();

    const result = await estimateDishMacros({
      prisma,
      userId: TEST_USER_ID,
      client: fake.client,
      ...SAMPLE_INPUT,
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.ok(result.error.length > 0);
    // runAICall retried once after the first invalid shape.
    assert.equal(fake.callCount(), 2);

    const logs = llmCalls();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].success, false);
    assert.equal(logs[0].failureReason, "validation_failed");
  });

  it("returns status='failed' when ANTHROPIC_API_KEY is unset and no client injected", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    _resetClientCache();
    const { prisma, llmCalls } = makeStubPrisma();

    const result = await estimateDishMacros({
      prisma,
      userId: TEST_USER_ID,
      // No `client` — runAICall falls back to env-derived client (which is null).
      ...SAMPLE_INPUT,
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.ok(result.error.length > 0);

    const logs = llmCalls();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].success, false);
    assert.equal(logs[0].failureReason, "no_api_key");
  });
});

// ── WS7-8b B2 — quantity→grams table grounding ─────────────────────────────

describe("estimateDishMacros — conversion-table grounding (D-WS6-024 Step 2)", () => {
  // A prisma stub whose active prompt body interpolates {{estimateInput}}, so
  // the captured payload actually contains the grounded ingredient JSON (the
  // in-memory fallback is a bare placeholder that drops the input).
  function makeBodyPrisma(): PrismaLike {
    return {
      aIPrompt: {
        findUnique: async (): Promise<AIPromptRow> => ({
          id: "p",
          key: "nutrition.ingredient_estimate",
          defaultModel: "claude-haiku-4-5-20251001",
          defaultMode: "text",
          versions: [{ body: "INPUT: {{estimateInput}}", version: 1, isActive: true }],
        }),
      },
      systemSetting: { findUnique: async (): Promise<SystemSettingRow | null> => null },
      lLMCallLog: { create: async ({ data }: { data: LLMCallLogCreateData }) => data },
    };
  }

  // Capturing client: records the user message so we can assert resolvedGrams
  // was threaded into the estimate payload.
  function makeCapturingClient() {
    const sent: string[] = [];
    const client = {
      messages: {
        create: async (params: Anthropic.MessageCreateParams): Promise<Anthropic.Message> => {
          sent.push(JSON.stringify(params.messages));
          return {
            id: "msg_cap",
            container: null,
            content: [{ type: "text", text: JSON.stringify({ perServing: { calories: 100, proteinG: 5, carbsG: 5, fatG: 5 } }), citations: null } as Anthropic.ContentBlock],
            model: params.model,
            role: "assistant",
            stop_details: null,
            stop_reason: "end_turn",
            stop_sequence: null,
            type: "message",
            usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null },
          } as unknown as Anthropic.Message;
        },
      },
    } as unknown as Pick<Anthropic, "messages">;
    return { client, sent };
  }

  it("threads authoritative resolvedGrams for table-covered ingredients (weight + density)", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const prisma = makeBodyPrisma();
    const { client, sent } = makeCapturingClient();

    const result = await estimateDishMacros({
      prisma,
      userId: TEST_USER_ID,
      client,
      dishTitle: "Cheesy Beef",
      servings: 4,
      ingredients: [
        // weight unit → grams with no factor: 1 lb = 453.59 g
        { name: "Ground beef", quantity: 1, unit: "lb", ingredientId: "i-beef", canonicalName: "ground beef", conversionRef: null },
        // curated density: cheddar 113 g/cup → 1 cup = 113 g
        { name: "Cheddar", quantity: 1, unit: "cup", ingredientId: "i-ched", canonicalName: "cheddar", conversionRef: null },
      ],
    });

    assert.equal(result.status, "success");
    const payload = sent.join("");
    assert.ok(payload.includes("resolvedGrams"), "resolvedGrams must be in the estimate payload");
    assert.ok(payload.includes("453.59237"), "ground beef 1 lb → 453.59 g");
    assert.ok(payload.includes("113"), "cheddar 1 cup → 113 g (curated density)");
  });

  it("omits resolvedGrams on the wizard path (no canonicalName) — falls back to the guess", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const prisma = makeBodyPrisma();
    const { client, sent } = makeCapturingClient();

    await estimateDishMacros({
      prisma,
      userId: TEST_USER_ID,
      client,
      dishTitle: "Wizard Dish",
      servings: 2,
      // No canonicalName/ingredientId (unpersisted wizard ingredients).
      ingredients: [{ name: "mystery powder", quantity: 1, unit: "cup" }],
    });

    assert.ok(!sent.join("").includes("resolvedGrams"), "wizard path must not fabricate resolvedGrams");
  });
});

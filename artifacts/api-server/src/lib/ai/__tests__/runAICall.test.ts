// WS6 6a-1 — runAICall unit tests.
// Run via: pnpm --filter @workspace/api-server test
// Uses node:test (built-in to Node v18+; stable in Node v25 we're on).
// SDK is mocked by injecting opts.client — no network calls.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { APIConnectionError } from "@anthropic-ai/sdk";
import { z } from "zod";

import { runAICall, _resetClientCache } from "../runAICall";
import {
  _resetRegistryCaches,
  estimateCostUsd,
  MODEL_HAIKU,
  MODEL_SONNET,
  resolvePromptDescriptorFromDb,
  type AIPromptRow,
  type LLMCallLogCreateData,
  type PrismaLike,
  type SystemSettingRow,
} from "../promptRegistry";
import { UnknownPromptKeyError } from "../promptRegistry";

// Tiny test schema so we don't depend on the real PRD shapes.
const PongSchema = z.object({ pong: z.literal("yes") });

// Use a registered prompt key so tests don't fight the registry.
// 'meals.find_similar' is text+haiku — useful for both modes (we override
// mode via opts when we want tool_use).
const TEXT_KEY = "meals.find_similar";
const TOOL_KEY = "wizard.set_preferences.generate";

// ── fake client factory ────────────────────────────────────────────────

interface QueuedResponse {
  content: Anthropic.ContentBlock[];
  inputTokens?: number;
  outputTokens?: number;
}

function makeFakeClient(responses: QueuedResponse[]): {
  client: Pick<Anthropic, "messages">;
  callCount: () => number;
  lastCall: () => Anthropic.MessageCreateParams | null;
} {
  let calls = 0;
  let lastParams: Anthropic.MessageCreateParams | null = null;
  const queue = [...responses];
  const client = {
    messages: {
      create: async (
        params: Anthropic.MessageCreateParams,
      ): Promise<Anthropic.Message> => {
        calls++;
        lastParams = params;
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
  return {
    client,
    callCount: () => calls,
    lastCall: () => lastParams,
  };
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

// ── tests ──────────────────────────────────────────────────────────────

describe("runAICall — happy paths", () => {
  it("tool mode returns parsed data on a valid tool_use response", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const { client, callCount } = makeFakeClient([
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "kiwi_response",
            input: { pong: "yes" },
          } as Anthropic.ContentBlock,
        ],
      },
    ]);

    const result = await runAICall(TOOL_KEY, {}, PongSchema, {
      client,
      mode: "tool",
    });

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.deepEqual(result.data, { pong: "yes" });
    assert.equal(result.metadata.retryCount, 0);
    assert.equal(result.metadata.mode, "tool");
    assert.equal(callCount(), 1);
  });

  it("text mode strips fences and parses JSON-in-text", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const { client } = makeFakeClient([
      {
        content: [
          {
            type: "text",
            text: '```json\n{"pong":"yes"}\n```',
            citations: null,
          } as Anthropic.ContentBlock,
        ],
      },
    ]);

    const result = await runAICall(TEXT_KEY, {}, PongSchema, {
      client,
      mode: "text",
    });

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.deepEqual(result.data, { pong: "yes" });
    assert.equal(result.metadata.retryCount, 0);
  });
});

describe("runAICall — validation retry", () => {
  it("retries once on invalid shape and succeeds on the second attempt", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const { client, callCount } = makeFakeClient([
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "kiwi_response",
            input: { pong: "no" }, // wrong literal
          } as Anthropic.ContentBlock,
        ],
      },
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_2",
            name: "kiwi_response",
            input: { pong: "yes" }, // correct
          } as Anthropic.ContentBlock,
        ],
      },
    ]);

    const result = await runAICall(TOOL_KEY, {}, PongSchema, {
      client,
      mode: "tool",
    });

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.deepEqual(result.data, { pong: "yes" });
    assert.equal(result.metadata.retryCount, 1);
    assert.equal(callCount(), 2);
  });

  it("returns AICallFailure with reason='validation_failed' after retry exhaustion", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const { client, callCount } = makeFakeClient([
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "kiwi_response",
            input: { pong: "no" },
          } as Anthropic.ContentBlock,
        ],
      },
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_2",
            name: "kiwi_response",
            input: { pong: "still no" },
          } as Anthropic.ContentBlock,
        ],
      },
    ]);

    const result = await runAICall(TOOL_KEY, {}, PongSchema, {
      client,
      mode: "tool",
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.reason, "validation_failed");
    assert.equal(result.userFacingMessage, "Kiwi got distracted. Try again?");
    assert.equal(callCount(), 2);
  });

  it("does not retry when retryOnValidationFailure=false", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const { client, callCount } = makeFakeClient([
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "kiwi_response",
            input: { pong: "no" },
          } as Anthropic.ContentBlock,
        ],
      },
    ]);

    const result = await runAICall(TOOL_KEY, {}, PongSchema, {
      client,
      mode: "tool",
      retryOnValidationFailure: false,
    });

    assert.equal(result.success, false);
    assert.equal(callCount(), 1);
  });
});

describe("runAICall — env / failure modes", () => {
  it("returns reason='no_api_key' and never calls SDK when env unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    _resetClientCache();
    // Don't pass opts.client — runAICall must fall back to env-derived client.
    const result = await runAICall(TOOL_KEY, {}, PongSchema, { mode: "tool" });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.reason, "no_api_key");
    assert.equal(result.userFacingMessage, "Kiwi got distracted. Try again?");
  });

  it("throws UnknownPromptKeyError on unregistered key (programmer error)", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    await assert.rejects(
      () => runAICall("not.a.real.key", {}, PongSchema),
      (err: unknown) => err instanceof UnknownPromptKeyError,
    );
  });
});

describe("runAICall — cost estimation", () => {
  it("computes USD cost from token counts at the right per-model rate", () => {
    // Sonnet: $3/Mtok input, $15/Mtok output.
    // 1000 in, 500 out → 0.001 * 3 + 0.0005 * 15 = 0.003 + 0.0075 = 0.0105
    const sonnetCost = estimateCostUsd(MODEL_SONNET, 1000, 500);
    assert.ok(Math.abs(sonnetCost - 0.0105) < 1e-9, `sonnet cost ${sonnetCost}`);

    // Haiku: $1/Mtok input, $5/Mtok output.
    // 1000 in, 500 out → 0.001 + 0.0025 = 0.0035
    const haikuCost = estimateCostUsd(MODEL_HAIKU, 1000, 500);
    assert.ok(Math.abs(haikuCost - 0.0035) < 1e-9, `haiku cost ${haikuCost}`);

    // Unknown model → 0 (don't fabricate cost).
    assert.equal(estimateCostUsd("claude-future-99", 1000, 500), 0);
  });

  it("attaches costEstimateUsd to success metadata", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const { client } = makeFakeClient([
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "kiwi_response",
            input: { pong: "yes" },
          } as Anthropic.ContentBlock,
        ],
        inputTokens: 2000,
        outputTokens: 1000,
      },
    ]);

    const result = await runAICall(TOOL_KEY, {}, PongSchema, {
      client,
      mode: "tool",
    });

    assert.equal(result.success, true);
    if (!result.success) return;
    // Sonnet 2000 in + 1000 out = 0.002*3 + 0.001*15 = 0.006 + 0.015 = 0.021
    assert.ok(
      Math.abs(result.metadata.costEstimateUsd - 0.021) < 1e-9,
      `cost ${result.metadata.costEstimateUsd}`,
    );
    assert.equal(result.metadata.inputTokens, 2000);
    assert.equal(result.metadata.outputTokens, 1000);
  });
});

// ── prisma stub factory ────────────────────────────────────────────────

interface PrismaStub extends PrismaLike {
  _findUniqueCallCount: () => number;
  _systemSettingCallCount: () => number;
  _llmLogCalls: () => LLMCallLogCreateData[];
}

function makePrismaStub(opts?: {
  promptRow?: AIPromptRow | null;
  rateRows?: Record<string, SystemSettingRow | null>;
  llmCallShouldThrow?: boolean;
}): PrismaStub {
  let promptCalls = 0;
  let settingCalls = 0;
  const llmCalls: LLMCallLogCreateData[] = [];
  return {
    aIPrompt: {
      findUnique: async () => {
        promptCalls++;
        return opts?.promptRow ?? null;
      },
    },
    systemSetting: {
      findUnique: async ({ where }) => {
        settingCalls++;
        return opts?.rateRows?.[where.key] ?? null;
      },
    },
    lLMCallLog: {
      create: async ({ data }) => {
        if (opts?.llmCallShouldThrow) {
          throw new Error("simulated DB write failure");
        }
        llmCalls.push(data);
        return { id: `log_${llmCalls.length}` };
      },
    },
    _findUniqueCallCount: () => promptCalls,
    _systemSettingCallCount: () => settingCalls,
    _llmLogCalls: () => [...llmCalls],
  };
}

describe("runAICall — SDK error mapping", () => {
  it("maps SDK status=429 to reason='rate_limited'", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const client: Pick<Anthropic, "messages"> = {
      messages: {
        create: async () => {
          const err = new Error("rate limited") as Error & { status: number };
          err.status = 429;
          throw err;
        },
      },
    } as unknown as Pick<Anthropic, "messages">;

    const result = await runAICall(TOOL_KEY, {}, PongSchema, {
      client,
      mode: "tool",
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.reason, "rate_limited");
    assert.equal(
      result.userFacingMessage,
      "Take a moment to consider these plans before generating new ones.",
    );
  });

  it("maps SDK status=401 to reason='no_api_key'", async () => {
    process.env.ANTHROPIC_API_KEY = "bad-key";
    _resetClientCache();
    const client: Pick<Anthropic, "messages"> = {
      messages: {
        create: async () => {
          const err = new Error("unauth") as Error & { status: number };
          err.status = 401;
          throw err;
        },
      },
    } as unknown as Pick<Anthropic, "messages">;

    const result = await runAICall(TOOL_KEY, {}, PongSchema, {
      client,
      mode: "tool",
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.reason, "no_api_key");
  });

  it("maps generic SDK throw to reason='sdk_error'", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    const client: Pick<Anthropic, "messages"> = {
      messages: {
        create: async () => {
          throw new Error("network down");
        },
      },
    } as unknown as Pick<Anthropic, "messages">;

    const result = await runAICall(TOOL_KEY, {}, PongSchema, {
      client,
      mode: "tool",
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.reason, "sdk_error");
  });
});

// ── D-WS6-085 — APIConnectionError retry (Block 4) ─────────────────────

describe("runAICall — connection retry", () => {
  it("retries on APIConnectionError and succeeds on a later attempt", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    let calls = 0;
    const client: Pick<Anthropic, "messages"> = {
      messages: {
        create: async (params: Anthropic.MessageCreateParams) => {
          calls++;
          if (calls === 1) {
            throw new APIConnectionError({ message: "other side closed" });
          }
          return {
            id: "msg_retry_success",
            container: null,
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "kiwi_response",
                input: { pong: "yes" },
              },
            ],
            model: params.model,
            role: "assistant",
            stop_details: null,
            stop_reason: "end_turn",
            stop_sequence: null,
            type: "message",
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
              server_tool_use: null,
              service_tier: null,
            },
          } as unknown as Anthropic.Message;
        },
      },
    } as unknown as Pick<Anthropic, "messages">;

    const result = await runAICall(TOOL_KEY, {}, PongSchema, {
      client,
      mode: "tool",
    });

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.deepEqual(result.data, { pong: "yes" });
    assert.equal(calls, 2);
    // retryCount semantically tracks validation retries only — see runAICall.ts
    // ai_call_connection_retry comment. Connection retries are observable via
    // logger.warn but do not bump metadata.retryCount.
    assert.equal(result.metadata.retryCount, 0);
  });

  it("returns reason='sdk_error' when all 4 attempts hit APIConnectionError", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    let calls = 0;
    const client: Pick<Anthropic, "messages"> = {
      messages: {
        create: async () => {
          calls++;
          throw new APIConnectionError({ message: "other side closed" });
        },
      },
    } as unknown as Pick<Anthropic, "messages">;

    const result = await runAICall(TOOL_KEY, {}, PongSchema, {
      client,
      mode: "tool",
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.reason, "sdk_error");
    assert.equal(calls, 4); // 1 initial + 3 retries
  });

  it("does NOT retry non-connection SDK errors (e.g. status=500)", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    let calls = 0;
    const client: Pick<Anthropic, "messages"> = {
      messages: {
        create: async () => {
          calls++;
          const err = new Error("internal server") as Error & { status: number };
          err.status = 500;
          throw err;
        },
      },
    } as unknown as Pick<Anthropic, "messages">;

    const result = await runAICall(TOOL_KEY, {}, PongSchema, {
      client,
      mode: "tool",
    });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.reason, "sdk_error");
    assert.equal(calls, 1); // no retries triggered
  });
});

// ── 6a-2 — DB-backed prompt resolution + LLMCallLog ────────────────────

describe("resolvePromptDescriptorFromDb — DB lookup + 60s cache", () => {
  it("returns the DB-stored body and version when an active row exists", async () => {
    _resetRegistryCaches();
    const prisma = makePrismaStub({
      promptRow: {
        id: "prompt_1",
        key: TEXT_KEY,
        defaultModel: MODEL_HAIKU,
        defaultMode: "text",
        versions: [{ body: "DB body v3", version: 3, isActive: true }],
      },
    });

    const desc = await resolvePromptDescriptorFromDb(TEXT_KEY, prisma);

    assert.equal(desc.body, "DB body v3");
    assert.equal(desc.version, 3);
    assert.equal(desc.defaultModel, MODEL_HAIKU);
    assert.equal(desc.defaultMode, "text");
    assert.equal(prisma._findUniqueCallCount(), 1);
  });

  it("caches successful lookups for 60s — second call within window does not hit DB", async () => {
    _resetRegistryCaches();
    const prisma = makePrismaStub({
      promptRow: {
        id: "prompt_1",
        key: TEXT_KEY,
        defaultModel: MODEL_HAIKU,
        defaultMode: "text",
        versions: [{ body: "cached body", version: 1, isActive: true }],
      },
    });

    await resolvePromptDescriptorFromDb(TEXT_KEY, prisma);
    await resolvePromptDescriptorFromDb(TEXT_KEY, prisma);
    await resolvePromptDescriptorFromDb(TEXT_KEY, prisma);

    assert.equal(prisma._findUniqueCallCount(), 1);
  });

  it("falls back to in-memory registry (version=null) when no DB row exists", async () => {
    _resetRegistryCaches();
    const prisma = makePrismaStub({ promptRow: null });

    const desc = await resolvePromptDescriptorFromDb(TEXT_KEY, prisma);

    assert.equal(desc.version, null);
    // In-memory body is the placeholder for this key.
    assert.match(desc.body, /\[PLACEHOLDER for meals\.find_similar/);
  });

  it("falls back when the DB query throws — does not propagate", async () => {
    _resetRegistryCaches();
    const prisma: PrismaLike = {
      aIPrompt: {
        findUnique: async () => {
          throw new Error("DB unreachable");
        },
      },
      systemSetting: { findUnique: async () => null },
      lLMCallLog: { create: async () => ({}) },
    };

    const desc = await resolvePromptDescriptorFromDb(TEXT_KEY, prisma);

    assert.equal(desc.version, null);
    assert.match(desc.body, /\[PLACEHOLDER/);
  });

  it("throws UnknownPromptKeyError for unregistered keys (programmer error)", async () => {
    _resetRegistryCaches();
    const prisma = makePrismaStub();
    await assert.rejects(
      () => resolvePromptDescriptorFromDb("not.a.real.key", prisma),
      (err: unknown) => err instanceof UnknownPromptKeyError,
    );
  });
});

describe("runAICall — LLMCallLog write", () => {
  it("writes a success row when an AI call succeeds", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    _resetRegistryCaches();
    const prisma = makePrismaStub();
    const { client } = makeFakeClient([
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "kiwi_response",
            input: { pong: "yes" },
          } as Anthropic.ContentBlock,
        ],
        inputTokens: 1500,
        outputTokens: 250,
      },
    ]);

    const result = await runAICall(TOOL_KEY, {}, PongSchema, {
      client,
      mode: "tool",
      prisma,
      userId: "user_42",
    });

    assert.equal(result.success, true);
    const logs = prisma._llmLogCalls();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].promptKey, TOOL_KEY);
    assert.equal(logs[0].success, true);
    assert.equal(logs[0].failureReason, null);
    assert.equal(logs[0].userId, "user_42");
    assert.equal(logs[0].inputTokens, 1500);
    assert.equal(logs[0].outputTokens, 250);
    assert.equal(logs[0].retryCount, 0);
    assert.ok(logs[0].costEstimateUsd > 0, "cost should be > 0");
  });

  it("writes a failure row with failureReason populated when validation fails after retry", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    _resetRegistryCaches();
    const prisma = makePrismaStub();
    const { client } = makeFakeClient([
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "kiwi_response",
            input: { pong: "no" },
          } as Anthropic.ContentBlock,
        ],
      },
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_2",
            name: "kiwi_response",
            input: { pong: "still no" },
          } as Anthropic.ContentBlock,
        ],
      },
    ]);

    const result = await runAICall(TOOL_KEY, {}, PongSchema, {
      client,
      mode: "tool",
      prisma,
    });

    assert.equal(result.success, false);
    const logs = prisma._llmLogCalls();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].success, false);
    assert.equal(logs[0].failureReason, "validation_failed");
    assert.equal(logs[0].retryCount, 1);
  });

  it("writes a failure row when the SDK throws (rate_limited)", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    _resetRegistryCaches();
    const prisma = makePrismaStub();
    const client: Pick<Anthropic, "messages"> = {
      messages: {
        create: async () => {
          const err = new Error("429") as Error & { status: number };
          err.status = 429;
          throw err;
        },
      },
    } as unknown as Pick<Anthropic, "messages">;

    const result = await runAICall(TOOL_KEY, {}, PongSchema, {
      client,
      mode: "tool",
      prisma,
    });

    assert.equal(result.success, false);
    const logs = prisma._llmLogCalls();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].success, false);
    assert.equal(logs[0].failureReason, "rate_limited");
  });

  it("does NOT propagate a Prisma write failure — call result is preserved", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    _resetRegistryCaches();
    const prisma = makePrismaStub({ llmCallShouldThrow: true });
    const { client } = makeFakeClient([
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "kiwi_response",
            input: { pong: "yes" },
          } as Anthropic.ContentBlock,
        ],
      },
    ]);

    const result = await runAICall(TOOL_KEY, {}, PongSchema, {
      client,
      mode: "tool",
      prisma,
    });

    // The AI call still succeeded even though the log write threw.
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.deepEqual(result.data, { pong: "yes" });
  });

  it("skips log writes entirely when prisma is omitted (in-memory fallback path)", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    _resetRegistryCaches();
    // Don't pass prisma — verifies that runAICall doesn't attempt log writes.
    const { client } = makeFakeClient([
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "kiwi_response",
            input: { pong: "yes" },
          } as Anthropic.ContentBlock,
        ],
      },
    ]);

    const result = await runAICall(TOOL_KEY, {}, PongSchema, {
      client,
      mode: "tool",
    });

    // Only the contract here is "doesn't blow up"; nothing to assert about
    // log calls because prisma wasn't passed. The promptVersion should be
    // null since we used the in-memory fallback.
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.metadata.promptVersion, null);
  });
});

describe("runAICall — promptVersion in metadata", () => {
  it("populates promptVersion from DB when a row is present", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    _resetClientCache();
    _resetRegistryCaches();
    const prisma = makePrismaStub({
      promptRow: {
        id: "prompt_1",
        key: TOOL_KEY,
        defaultModel: MODEL_SONNET,
        defaultMode: "tool",
        versions: [{ body: "DB body v7", version: 7, isActive: true }],
      },
    });
    const { client } = makeFakeClient([
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "kiwi_response",
            input: { pong: "yes" },
          } as Anthropic.ContentBlock,
        ],
      },
    ]);

    const result = await runAICall(TOOL_KEY, {}, PongSchema, {
      client,
      mode: "tool",
      prisma,
    });

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.metadata.promptVersion, 7);
    assert.equal(prisma._llmLogCalls()[0].promptVersion, 7);
  });
});

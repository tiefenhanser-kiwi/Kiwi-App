// WS6 6a-1 — runAICall unit tests.
// Run via: pnpm --filter @workspace/api-server test
// Uses node:test (built-in to Node v18+; stable in Node v25 we're on).
// SDK is mocked by injecting opts.client — no network calls.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { runAICall, _resetClientCache } from "../runAICall";
import { estimateCostUsd, MODEL_HAIKU, MODEL_SONNET } from "../promptRegistry";
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

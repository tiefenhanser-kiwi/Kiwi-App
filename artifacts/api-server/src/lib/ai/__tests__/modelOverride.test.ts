// Sonnet 5.5 side-by-side — AI_MODEL_OVERRIDE_SONNET + the per-model request
// shape (modelShape.ts), through both Anthropic doors. No network: fake clients.
// Run via: pnpm --filter @workspace/api-server test

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { runAICall } from "../runAICall";
import { streamPlanCandidates, type StreamCapableMessages } from "../streamPlanCandidates";
import {
  _resetRegistryCaches,
  MODEL_HAIKU,
  MODEL_SONNET,
  type LLMCallLogCreateData,
} from "../promptRegistry";

const PongSchema = z.object({ pong: z.literal("yes") });
const SONNET_TOOL_KEY = "wizard.set_preferences.generate"; // sonnet + tool
const HAIKU_TEXT_KEY = "meals.find_similar"; // haiku + text
const BODY = "Plan dinners for {{who}}.";

function makePrisma(defaultModel: string, defaultMode: "tool" | "text") {
  const logs: LLMCallLogCreateData[] = [];
  return {
    logs,
    prisma: {
      aIPrompt: {
        findUnique: async () => ({
          id: "p1",
          key: "k",
          defaultModel,
          defaultMode,
          versions: [{ body: BODY, version: 3, isActive: true }],
        }),
      },
      systemSetting: { findUnique: async () => null }, // → FALLBACK_MODEL_RATES
      lLMCallLog: {
        create: async ({ data }: { data: LLMCallLogCreateData }) => {
          logs.push(data);
          return data;
        },
      },
    } as any,
  };
}

function makeClient(content: Anthropic.ContentBlock[]) {
  const calls: any[] = [];
  const client = {
    messages: {
      create: async (params: any) => {
        calls.push(params);
        return {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: params.model,
          content,
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Pick<Anthropic, "messages">;
  return { client, calls };
}

const toolPong = [
  { type: "tool_use", id: "t1", name: "kiwi_response", input: { pong: "yes" } } as Anthropic.ContentBlock,
];
const textPong = [{ type: "text", text: '{"pong":"yes"}' } as Anthropic.ContentBlock];

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = {
    o: process.env.AI_MODEL_OVERRIDE_SONNET,
    t: process.env.AI_SONNET55_THINKING,
    k: process.env.ANTHROPIC_API_KEY,
  };
  delete process.env.AI_MODEL_OVERRIDE_SONNET;
  delete process.env.AI_SONNET55_THINKING;
  process.env.ANTHROPIC_API_KEY = "test-key";
  _resetRegistryCaches();
});
afterEach(() => {
  const put = (k: string, v: string | undefined) =>
    v === undefined ? delete process.env[k] : (process.env[k] = v);
  put("AI_MODEL_OVERRIDE_SONNET", saved.o);
  put("AI_SONNET55_THINKING", saved.t);
  put("ANTHROPIC_API_KEY", saved.k);
});

describe("AI_MODEL_OVERRIDE_SONNET — runAICall", () => {
  it("unset: the request is today's shape, byte for byte", async () => {
    const { prisma, logs } = makePrisma(MODEL_SONNET, "tool");
    const { client, calls } = makeClient(toolPong);
    const r = await runAICall(SONNET_TOOL_KEY, { who: "two" }, PongSchema, { client, prisma });
    assert.equal(r.success, true);
    // Key order is part of "byte for byte": the serialized request must match
    // the pre-override literal exactly.
    assert.equal(
      JSON.stringify(calls[0]),
      JSON.stringify({
        model: MODEL_SONNET,
        max_tokens: 4096,
        temperature: 0.7,
        messages: [{ role: "user", content: "Plan dinners for two." }],
        tools: calls[0].tools,
        tool_choice: { type: "tool", name: "kiwi_response" },
      }),
    );
    assert.equal(logs[0].model, MODEL_SONNET);
  });

  it("set: a Sonnet call runs on the override, in the shape it accepts, and the log records it", async () => {
    process.env.AI_MODEL_OVERRIDE_SONNET = "claude-sonnet-5-5";
    const { prisma, logs } = makePrisma(MODEL_SONNET, "tool");
    const { client, calls } = makeClient(toolPong);
    const r = await runAICall(SONNET_TOOL_KEY, { who: "two" }, PongSchema, { client, prisma });
    assert.equal(r.success, true);
    const p = calls[0];
    assert.equal(p.model, "claude-sonnet-5-5");
    assert.equal("temperature" in p, false, "temperature 400s on sonnet 5.5");
    assert.deepEqual(p.tool_choice, { type: "auto" });
    assert.equal("thinking" in p, false, "default = model default (adaptive)");
    assert.equal(
      p.messages[0].content,
      "Plan dinners for two.\n\nRespond by calling the kiwi_response tool. Do not reply in plain text.",
    );
    assert.equal(logs[0].model, "claude-sonnet-5-5");
    assert.equal(r.success && r.metadata.model, "claude-sonnet-5-5");
    // 1M in + 1M out at $2 / $10, not Sonnet 4.6's $3 / $15.
    assert.equal(logs[0].costEstimateUsd, 12);
  });

  it("set: an explicit temperature 0 is dropped too (deterministic callers lose it on 5.5)", async () => {
    process.env.AI_MODEL_OVERRIDE_SONNET = "claude-sonnet-5-5";
    const { prisma } = makePrisma(MODEL_SONNET, "text");
    const { client, calls } = makeClient(textPong);
    await runAICall(SONNET_TOOL_KEY, { who: "two" }, PongSchema, { client, prisma, temperature: 0, mode: "text" });
    assert.equal("temperature" in calls[0], false);
    assert.equal("tool_choice" in calls[0], false);
  });

  it("set: a Haiku key is untouched", async () => {
    process.env.AI_MODEL_OVERRIDE_SONNET = "claude-sonnet-5-5";
    const { prisma, logs } = makePrisma(MODEL_HAIKU, "text");
    const { client, calls } = makeClient(textPong);
    await runAICall(HAIKU_TEXT_KEY, { who: "two" }, PongSchema, { client, prisma });
    assert.equal(calls[0].model, MODEL_HAIKU);
    assert.equal(calls[0].temperature, 0.7);
    assert.equal(logs[0].model, MODEL_HAIKU);
  });

  it("AI_SONNET55_THINKING=between_tools sends thinking off", async () => {
    process.env.AI_MODEL_OVERRIDE_SONNET = "claude-sonnet-5-5";
    process.env.AI_SONNET55_THINKING = "between_tools";
    const { prisma } = makePrisma(MODEL_SONNET, "tool");
    const { client, calls } = makeClient(toolPong);
    await runAICall(SONNET_TOOL_KEY, { who: "two" }, PongSchema, { client, prisma });
    assert.deepEqual(calls[0].thinking, { type: "between_tools" });
  });
});

describe("AI_MODEL_OVERRIDE_SONNET — streamPlanCandidates", () => {
  function fakeStream() {
    let params: any;
    const result = {
      candidates: [
        {
          id: "c1",
          title: "T",
          tags: ["Easy"],
          whyBullets: ["b"],
          mealTitles: ["A", "B", "C"],
          dailyMacros: { calories: 500, proteinG: 30, carbsG: 50, fatG: 20 },
        },
      ],
      cannotGenerateMore: false,
    };
    const s: any = {
      on: () => s,
      finalMessage: async () =>
        ({
          model: params.model,
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(result) }],
          usage: { input_tokens: 10, output_tokens: 10 },
        }) as unknown as Anthropic.Message,
    };
    const client = { stream: (p: any) => ((params = p), s) } as unknown as StreamCapableMessages;
    return { client, params: () => params };
  }

  it("unset: model + temperature as today", async () => {
    const { prisma, logs } = makePrisma(MODEL_SONNET, "tool");
    const f = fakeStream();
    const r = await streamPlanCandidates(SONNET_TOOL_KEY, { who: "two" }, { prisma, client: f.client });
    assert.equal(r.success, true);
    assert.equal(f.params().model, MODEL_SONNET);
    assert.equal(f.params().temperature, 0.7);
    assert.equal("thinking" in f.params(), false);
    assert.equal(logs[0].model, MODEL_SONNET);
  });

  it("set: override model, no temperature, logged as the override", async () => {
    process.env.AI_MODEL_OVERRIDE_SONNET = "claude-sonnet-5-5";
    const { prisma, logs } = makePrisma(MODEL_SONNET, "tool");
    const f = fakeStream();
    const r = await streamPlanCandidates(SONNET_TOOL_KEY, { who: "two" }, { prisma, client: f.client });
    assert.equal(r.success, true);
    assert.equal(f.params().model, "claude-sonnet-5-5");
    assert.equal("temperature" in f.params(), false);
    assert.equal(logs[0].model, "claude-sonnet-5-5");
  });
});

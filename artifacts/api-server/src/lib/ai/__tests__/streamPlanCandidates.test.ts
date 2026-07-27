// Latency Block (D-WS9-076) — streamPlanCandidates orchestrator tests.
// Run via: pnpm --filter @workspace/api-server test
//
// No network: a fake `messages` resource is injected via opts.client. Its
// .stream() records params (so we can assert the cached system block) and its
// finalMessage() replays inputJson deltas to the registered listener before
// resolving — exactly how the real MessageStream drives progressive emit.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";

import { streamPlanCandidates } from "../streamPlanCandidates";
import type { StreamCapableMessages } from "../streamPlanCandidates";
import {
  _resetRegistryCaches,
  type LLMCallLogCreateData,
} from "../promptRegistry";
import type { WizardPlanCandidatesResult } from "../schemas/wizard";

const MARKER = "{{storeShortlist}}";
const STABLE_HEAD =
  "You are Kiwi's generator. " + "Follow the rules. ".repeat(50);
// A DB-shaped body with the cache marker, so the split produces a real prefix.
const DB_BODY = `${STABLE_HEAD}\nSHORTLIST:\n${MARKER}\nINPUT:\n{{wizardInput}}`;

function fullResult(): WizardPlanCandidatesResult {
  return {
    candidates: [
      {
        id: "c1",
        title: "Cozy Week",
        tags: ["Easy"],
        whyBullets: ["One-pot meals"],
        mealTitles: ["Chili", "Tacos", "Soup"],
        dailyMacros: { calories: 540, proteinG: 28, carbsG: 56, fatG: 22 },
      },
      {
        id: "c2",
        title: "Med Variety",
        tags: ["Mediterranean"],
        whyBullets: ["Lemons across meals"],
        mealTitles: ["Greek salad", "Salmon", "Pesto pasta"],
        dailyMacros: { calories: 520, proteinG: 32, carbsG: 48, fatG: 24 },
        storeSlots: [{ slotIndex: 0, storeMealId: "m12" }],
      },
      {
        id: "c3",
        title: "High Protein",
        tags: ["Protein"],
        whyBullets: [">25g protein"],
        mealTitles: ["Chicken", "Steak", "Salmon"],
        dailyMacros: { calories: 560, proteinG: 42, carbsG: 32, fatG: 24 },
      },
    ],
    cannotGenerateMore: false,
  };
}

// Build a fake `messages` client. `toolInput` is what the finalMessage's
// tool_use block carries; `deltas` are the cumulative partial-JSON strings the
// stream replays. If `deltas` is omitted, it's derived by slicing the full
// serialized JSON into N pieces (simulating token-by-token growth).
//
// ⚠️ TEXT MODE + INCREMENTAL fragments. This is the Bug-1 regression harness:
// the real SDK emits `text` deltas as INCREMENTAL fragments (not accumulated
// prefixes), so this fake does too. An orchestrator that scanned the raw
// fragment (the old bug) would surface 0 candidates here; the fixed one
// accumulates and surfaces all 3.
function fragmentsOf(s: string, n: number): string[] {
  const out: string[] = [];
  const step = Math.ceil(s.length / n);
  for (let i = 0; i < s.length; i += step) out.push(s.slice(i, i + step));
  return out;
}

function makeFakeMessages(opts: {
  toolInput: unknown;
  // Incremental text fragments to replay (default: split full JSON into 12).
  fragments?: string[];
  // Emit a leading markdown fence to prove the final extract strips it.
  fenced?: boolean;
  throwOnFinal?: boolean;
  usage?: Partial<Anthropic.Usage>;
}): { client: StreamCapableMessages; getParams: () => any } {
  const fullText = opts.fenced
    ? "```json\n" + JSON.stringify(opts.toolInput) + "\n```"
    : JSON.stringify(opts.toolInput);
  const fragments = opts.fragments ?? fragmentsOf(fullText, 12);

  let params: any;
  const listeners: Record<string, Array<(...a: any[]) => void>> = {};
  const streamObj: any = {
    on(event: string, cb: (...a: any[]) => void) {
      (listeners[event] ??= []).push(cb);
      return streamObj;
    },
    async finalMessage(): Promise<Anthropic.Message> {
      for (const d of fragments) {
        for (const cb of listeners["text"] ?? []) cb(d, undefined);
        await Promise.resolve();
      }
      if (opts.throwOnFinal) throw new Error("stream boom");
      return {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        stop_sequence: null,
        content: [{ type: "text", text: fullText }],
        usage: {
          input_tokens: 1500,
          output_tokens: 320,
          cache_read_input_tokens: 1400,
          cache_creation_input_tokens: 0,
          ...opts.usage,
        },
      } as unknown as Anthropic.Message;
    },
  };
  return {
    client: {
      stream: (p: any) => {
        params = p;
        return streamObj;
      },
    } as unknown as StreamCapableMessages,
    getParams: () => params,
  };
}

// Prisma stub: serves the DB body (with the marker) + records LLMCallLog writes.
function makeStubPrisma() {
  const llmCalls: LLMCallLogCreateData[] = [];
  return {
    prisma: {
      aIPrompt: {
        findUnique: async () => ({
          id: "p1",
          key: "wizard.set_preferences.generate",
          defaultModel: "claude-sonnet-4-6",
          defaultMode: "tool",
          versions: [{ body: DB_BODY, version: 5, isActive: true }],
        }),
      },
      systemSetting: { findUnique: async () => null },
      lLMCallLog: {
        create: async ({ data }: { data: LLMCallLogCreateData }) => {
          llmCalls.push(data);
          return data;
        },
      },
    } as any,
    llmCalls,
  };
}

describe("streamPlanCandidates", () => {
  beforeEach(() => _resetRegistryCaches());

  it("emits candidates in order, once each, then returns the full set", async () => {
    const { client } = makeFakeMessages({ toolInput: fullResult() });
    const { prisma, llmCalls } = makeStubPrisma();
    const emitted: Array<{ index: number; id: string }> = [];

    const result = await streamPlanCandidates(
      "wizard.set_preferences.generate",
      { storeShortlist: [], wizardInput: { userId: "u1" } },
      {
        prisma,
        userId: "u1",
        cacheSplitMarker: MARKER,
        client,
        onCandidate: (index, c) => emitted.push({ index, id: c.id }),
      },
    );

    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.data.candidates.length, 3);
      assert.equal(result.metadata.costEstimateUsd > 0, true);
      assert.equal(result.metadata.cacheReadInputTokens, 1400);
    }
    // Strictly in order, no duplicate index.
    assert.deepEqual(
      emitted.map((e) => e.index),
      [0, 1, 2],
    );
    assert.deepEqual(
      emitted.map((e) => e.id),
      ["c1", "c2", "c3"],
    );
    // LLMCallLog written once, success.
    assert.equal(llmCalls.length, 1);
    assert.equal(llmCalls[0].success, true);
    assert.equal(llmCalls[0].outputTokens, 320);
  });

  it("passes the stable head as a cached ephemeral system block", async () => {
    const { client, getParams } = makeFakeMessages({ toolInput: fullResult() });
    const { prisma } = makeStubPrisma();

    await streamPlanCandidates(
      "wizard.set_preferences.generate",
      { storeShortlist: [], wizardInput: { userId: "u1" } },
      { prisma, userId: "u1", cacheSplitMarker: MARKER, client },
    );

    const params = getParams();
    assert.ok(Array.isArray(params.system));
    assert.equal(params.system[0].type, "text");
    assert.equal(params.system[0].cache_control.type, "ephemeral");
    assert.equal(params.system[0].text, STABLE_HEAD + "\nSHORTLIST:\n");
    // Volatile tail stays in the user message; head is NOT duplicated there.
    assert.equal(params.messages[0].role, "user");
    assert.ok(!params.messages[0].content.includes(STABLE_HEAD));
    // Text mode: NO tools, and the JSON-only override rides in the user message
    // (not the cached prefix).
    assert.equal(params.tools, undefined);
    assert.equal(params.tool_choice, undefined);
    assert.ok(params.messages[0].content.includes("OUTPUT FORMAT (OVERRIDE)"));
    assert.ok(!params.system[0].text.includes("OUTPUT FORMAT (OVERRIDE)"));
  });

  it("Bug-1 regression: accumulates INCREMENTAL text fragments (not prefixes)", async () => {
    // The SDK emits fragments; scanning a raw fragment surfaces nothing. Split
    // into MANY tiny fragments so no single one contains a whole candidate —
    // the old (fragment-scanning) code would emit 0 here.
    const full = JSON.stringify(fullResult());
    const tiny = fragmentsOf(full, full.length); // one char per delta
    const { client } = makeFakeMessages({ toolInput: fullResult(), fragments: tiny });
    const { prisma } = makeStubPrisma();
    const emitted: number[] = [];

    const result = await streamPlanCandidates(
      "wizard.set_preferences.generate",
      { storeShortlist: [], wizardInput: {} },
      { prisma, cacheSplitMarker: MARKER, client, onCandidate: (i) => emitted.push(i) },
    );

    assert.ok(result.success);
    assert.deepEqual(emitted, [0, 1, 2], "must accumulate fragments and emit all 3");
  });

  it("emits progress on delta activity before the first candidate", async () => {
    // One char per delta → candidates complete late, so progress must fire in
    // the pre-first-candidate window.
    const full = JSON.stringify(fullResult());
    const tiny = fragmentsOf(full, full.length);
    const { client } = makeFakeMessages({ toolInput: fullResult(), fragments: tiny });
    const { prisma } = makeStubPrisma();
    const order: string[] = [];

    const result = await streamPlanCandidates(
      "wizard.set_preferences.generate",
      { storeShortlist: [], wizardInput: {} },
      {
        prisma,
        cacheSplitMarker: MARKER,
        client,
        onProgress: () => order.push("progress"),
        onCandidate: () => order.push("candidate"),
      },
    );

    assert.ok(result.success);
    assert.ok(order.includes("progress"), "progress must fire on delta activity");
    assert.equal(order[0], "progress", "progress fires before the first candidate");
    assert.ok(order.indexOf("progress") < order.indexOf("candidate"));
  });

  it("final-parses text output even when wrapped in a markdown fence", async () => {
    const { client } = makeFakeMessages({ toolInput: fullResult(), fenced: true });
    const { prisma } = makeStubPrisma();
    const result = await streamPlanCandidates(
      "wizard.set_preferences.generate",
      { storeShortlist: [], wizardInput: {} },
      { prisma, cacheSplitMarker: MARKER, client },
    );
    assert.ok(result.success);
    if (result.success) assert.equal(result.data.candidates.length, 3);
  });

  it("never emits a candidate that fails the schema (bad final input)", async () => {
    // Second candidate is missing required dailyMacros → whole result invalid.
    const bad = {
      candidates: [
        fullResult().candidates[0],
        { id: "x", title: "Broken", tags: [], whyBullets: ["b"], mealTitles: ["m"] },
      ],
    };
    const { client } = makeFakeMessages({ toolInput: bad });
    const { prisma, llmCalls } = makeStubPrisma();
    const emitted: number[] = [];

    const result = await streamPlanCandidates(
      "wizard.set_preferences.generate",
      { storeShortlist: [], wizardInput: {} },
      { prisma, cacheSplitMarker: MARKER, client, onCandidate: (i) => emitted.push(i) },
    );

    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.reason, "validation_failed");
    // c1 was valid and could stream; the invalid c2 is never emitted.
    assert.deepEqual(emitted, [0]);
    assert.equal(llmCalls[0].success, false);
    assert.equal(llmCalls[0].failureReason, "validation_failed");
  });

  it("returns sdk_error when the stream throws mid-flight", async () => {
    const { client } = makeFakeMessages({
      toolInput: fullResult(),
      throwOnFinal: true,
    });
    const { prisma, llmCalls } = makeStubPrisma();

    const result = await streamPlanCandidates(
      "wizard.set_preferences.generate",
      { storeShortlist: [], wizardInput: {} },
      { prisma, cacheSplitMarker: MARKER, client },
    );

    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.reason, "sdk_error");
    assert.equal(llmCalls[0].failureReason, "sdk_error");
  });
});

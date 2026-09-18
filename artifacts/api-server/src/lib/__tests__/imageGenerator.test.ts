// Row 5 · Block 1 (D-WS9-246 step 3) — the generator's spend-guard wiring
// and its LLMCallLog row. fetch is a recorder; prisma is a recorder; the
// guard is driven through its env seam. No network.
// Run via: pnpm --filter @workspace/api-server test

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  buildHousePrompt,
  generateMealImage,
  IMAGE_GEN_MODEL,
  IMAGES_GENERATE_KEY,
} from "../images/imageGenerator";
import type { ImageFetch, ImageFetchResponse } from "../images/types";
import type { LLMCallLogCreateData, PrismaLike } from "../ai/promptRegistry";
import { _resetSpendGuardLogSampling, ENV_AI_DAILY_CEILING_USD, ENV_AI_DISABLED } from "../spendGuard";

const JPEG_B64 = Buffer.from("ffd8ffe0", "hex").toString("base64");

function response(status: number, body: unknown): ImageFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => JSON.stringify(body),
  };
}

function recorder(status: number, body: unknown) {
  const calls: Array<{ url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  const fetch: ImageFetch = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    return response(status, body);
  };
  return { calls, fetch };
}

function makePrisma(opts: { spentToday?: number } = {}) {
  const rows: LLMCallLogCreateData[] = [];
  const aggregates: unknown[] = [];
  const prisma: PrismaLike = {
    aIPrompt: { findUnique: async () => null },
    systemSetting: { findUnique: async () => null },
    lLMCallLog: {
      create: async ({ data }) => {
        rows.push(data);
        return {};
      },
      count: async () => 0,
      aggregate: async (args) => {
        aggregates.push(args);
        return { _sum: { costEstimateUsd: opts.spentToday ?? 0 } };
      },
    },
  };
  return { prisma, rows, aggregates };
}

const subject = { mealId: "m1", title: "Birria Tacos", dishTitles: ["Birria Tacos", "Consommé"] };
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [ENV_AI_DISABLED, ENV_AI_DAILY_CEILING_USD, "AI_USER_DAILY_CALLS"];

describe("generateMealImage", () => {
  beforeEach(() => {
    _resetSpendGuardLogSampling();
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  it("POSTs the house prompt to OpenAI images with gpt-image-1-mini, and logs an `image` row with token-priced cost", async () => {
    const { calls, fetch } = recorder(200, {
      data: [{ b64_json: JPEG_B64 }],
      usage: { input_tokens: 50, output_tokens: 1000, total_tokens: 1050 },
    });
    const { prisma, rows } = makePrisma();
    const out = await generateMealImage(subject, { fetch, apiKey: "sk-test", prisma, userId: "u1" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.openai.com/v1/images/generations");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers?.Authorization, "Bearer sk-test");
    const body = JSON.parse(calls[0].init.body ?? "{}") as Record<string, unknown>;
    assert.equal(body.model, IMAGE_GEN_MODEL);
    assert.equal(body.model, "gpt-image-1-mini");
    assert.notEqual(body.model, "gpt-image-1");
    assert.equal(body.size, "1024x1024");
    assert.equal(body.n, 1);
    assert.equal(body.output_format, "jpeg");
    assert.equal(body.prompt, buildHousePrompt(subject));
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.equal(out.bytes.toString("hex"), "ffd8ffe0");
    assert.deepEqual(out.usage, { inputTokens: 50, outputTokens: 1000 });
    // Fallback rate: $2/M in, $8/M out → 50×2e-6 + 1000×8e-6 = 0.0081
    assert.ok(Math.abs(out.costEstimateUsd - 0.0081) < 1e-9);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].promptKey, IMAGES_GENERATE_KEY);
    assert.equal(rows[0].mode, "image");
    assert.equal(rows[0].model, "gpt-image-1-mini");
    assert.equal(rows[0].userId, "u1");
    assert.equal(rows[0].inputTokens, 50);
    assert.equal(rows[0].outputTokens, 1000);
    assert.equal(rows[0].success, true);
    assert.ok(Math.abs(rows[0].costEstimateUsd - 0.0081) < 1e-9);
  });

  it("the house prompt names the dish, forbids text/hands/branding, and is otherwise fixed", () => {
    const p = buildHousePrompt(subject);
    assert.match(p, /Birria Tacos/);
    assert.match(p, /Consommé/);
    assert.match(p, /No text/i);
    assert.match(p, /no hands/i);
    assert.match(p, /no branding/i);
    assert.match(p, /three-quarter angle/i);
    assert.match(p, /natural daylight/i);
    const other = buildHousePrompt({ mealId: "m2", title: "Pho", dishTitles: [] });
    // Everything after the subject sentence is identical.
    assert.equal(p.split(". ").slice(1).join(". "), other.split(". ").slice(1).join(". "));
  });

  it("🔴 kill switch: AI_DISABLED refuses BEFORE any request and writes NO row", async () => {
    process.env[ENV_AI_DISABLED] = "1";
    const { calls, fetch } = recorder(200, { data: [{ b64_json: JPEG_B64 }] });
    const { prisma, rows } = makePrisma();
    const out = await generateMealImage(subject, { fetch, apiKey: "sk", prisma, userId: "u1" });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, "ai_disabled");
    assert.equal(calls.length, 0);
    assert.equal(rows.length, 0);
  });

  it("🔴 global ceiling: today's user-attributed spend at the ceiling refuses a user call, no request, no row", async () => {
    process.env[ENV_AI_DAILY_CEILING_USD] = "10";
    const { calls, fetch } = recorder(200, { data: [{ b64_json: JPEG_B64 }] });
    const { prisma, rows, aggregates } = makePrisma({ spentToday: 10 });
    const out = await generateMealImage(subject, { fetch, apiKey: "sk", prisma, userId: "u1" });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, "spend_cap_global");
    assert.equal(aggregates.length, 1);
    assert.equal(calls.length, 0);
    assert.equal(rows.length, 0);
  });

  it("BUG-262 by ruling: a null-userId (batch) call skips the ceiling read — the script's own cap bounds it", async () => {
    process.env[ENV_AI_DAILY_CEILING_USD] = "10";
    const { calls, fetch } = recorder(200, { data: [{ b64_json: JPEG_B64 }], usage: { input_tokens: 1, output_tokens: 1 } });
    const { prisma, rows, aggregates } = makePrisma({ spentToday: 999 });
    const out = await generateMealImage(subject, { fetch, apiKey: "sk", prisma });
    assert.equal(out.ok, true);
    assert.equal(aggregates.length, 0);
    assert.equal(calls.length, 1);
    assert.equal(rows[0].userId, null);
  });

  it("an HTTP error logs a failed row (with whatever usage came back) and returns http_error", async () => {
    const { fetch } = recorder(400, { error: { message: "bad prompt", type: "invalid_request_error" } });
    const { prisma, rows } = makePrisma();
    const out = await generateMealImage(subject, { fetch, apiKey: "sk", prisma, userId: "u1" });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, "http_error");
    assert.equal(out.detail, "bad prompt");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].success, false);
    assert.equal(rows[0].failureReason, "http_400");
  });

  it("a response with no b64_json is bad_response, logged failed", async () => {
    const { fetch } = recorder(200, { data: [{}] });
    const { prisma, rows } = makePrisma();
    const out = await generateMealImage(subject, { fetch, apiKey: "sk", prisma });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, "bad_response");
    assert.equal(rows[0].failureReason, "bad_response");
  });

  it("a thrown fetch is network_error, logged failed", async () => {
    const fetch: ImageFetch = async () => {
      throw new Error("ECONNRESET");
    };
    const { prisma, rows } = makePrisma();
    const out = await generateMealImage(subject, { fetch, apiKey: "sk", prisma });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, "network_error");
    assert.equal(out.detail, "ECONNRESET");
    assert.equal(rows[0].failureReason, "network_error");
  });

  it("no api key → no_api_key, no request, no row", async () => {
    const { calls, fetch } = recorder(200, {});
    const { prisma, rows } = makePrisma();
    const out = await generateMealImage(subject, { fetch, apiKey: "", prisma });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.reason, "no_api_key");
    assert.equal(calls.length, 0);
    assert.equal(rows.length, 0);
  });

  it("a failed log write never changes the result", async () => {
    const { fetch } = recorder(200, { data: [{ b64_json: JPEG_B64 }] });
    const prisma: PrismaLike = {
      aIPrompt: { findUnique: async () => null },
      systemSetting: { findUnique: async () => null },
      lLMCallLog: {
        create: async () => {
          throw new Error("db down");
        },
      },
    };
    const out = await generateMealImage(subject, { fetch, apiKey: "sk", prisma });
    assert.equal(out.ok, true);
  });
});

// Restore env after the file's tests (node:test runs files in isolation, but
// be tidy for the in-process case).
process.on("exit", () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

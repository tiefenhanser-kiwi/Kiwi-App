// Row 5 · Block 1 (D-WS9-246 step 2) — the relevance judge. The AI call is a
// recorder; previews come from a stub fetch. No network.
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  IMAGES_RELEVANCE_JUDGE_KEY,
  judgeImageRelevance,
  RelevanceVerdictSchema,
  type JudgeAICall,
} from "../images/relevanceJudge";
import type { ImageFetch, ImageFetchResponse, StockCandidate } from "../images/types";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

function bytesResponse(ok: boolean, contentType = "image/png"): ImageFetchResponse {
  return {
    ok,
    status: ok ? 200 : 404,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? contentType : null) },
    json: async () => ({}),
    arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
    text: async () => "",
  };
}

function candidate(i: number, provider: "pexels" | "pixabay" = "pexels"): StockCandidate {
  return {
    provider,
    providerId: String(i),
    url: `https://cdn.test/${i}/full.jpg`,
    previewUrl: `https://cdn.test/${i}/preview.jpg`,
    width: 2000,
    height: 1333,
    photographer: `p${i}`,
    sourcePageUrl: `https://site.test/${i}`,
    description: `desc ${i}`,
  };
}

const subject = { mealId: "m1", title: "Birria Tacos", dishTitles: ["Birria Tacos", "Consommé"] };

function recorderAI(reply: { accepted: number | null; reason: string }, cost = 0.004) {
  const calls: Array<{ promptKey: string; vars: Record<string, unknown>; opts: Record<string, unknown> }> = [];
  const ai: JudgeAICall = async (promptKey, vars, schema, opts) => {
    calls.push({ promptKey, vars, opts: opts as Record<string, unknown> });
    const data = schema.parse(reply);
    return {
      success: true,
      data,
      metadata: {
        promptKey,
        promptVersion: 1,
        model: "m",
        mode: "tool",
        latencyMs: 1,
        inputTokens: 10,
        outputTokens: 5,
        costEstimateUsd: cost,
        retryCount: 0,
      },
    };
  };
  return { ai, calls };
}

describe("judgeImageRelevance", () => {
  it("attaches every preview in candidate order, passes the meal + dish list, and returns the pick", async () => {
    const fetched: string[] = [];
    const fetch: ImageFetch = async (url) => {
      fetched.push(url);
      return bytesResponse(true);
    };
    const { ai, calls } = recorderAI({ accepted: 1, reason: "second shows tacos" });
    const out = await judgeImageRelevance(subject, [candidate(0), candidate(1, "pixabay"), candidate(2)], {
      ai,
      fetch,
      userId: "u1",
    });
    assert.deepEqual(fetched, ["https://cdn.test/0/preview.jpg", "https://cdn.test/1/preview.jpg", "https://cdn.test/2/preview.jpg"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].promptKey, IMAGES_RELEVANCE_JUDGE_KEY);
    const input = calls[0].vars.judgeInput as { meal: unknown; candidates: unknown[] };
    assert.deepEqual(input.meal, { title: "Birria Tacos", dishes: ["Birria Tacos", "Consommé"] });
    assert.equal(input.candidates.length, 3);
    assert.deepEqual(input.candidates[1], { index: 1, provider: "pixabay", description: "desc 1", width: 2000, height: 1333 });
    const attachments = calls[0].opts.attachments as Array<{ type: string; source: { media_type: string; data: string } }>;
    assert.equal(attachments.length, 3);
    assert.equal(attachments[0].type, "image");
    assert.equal(attachments[0].source.media_type, "image/png");
    assert.equal(attachments[0].source.data, PNG.toString("base64"));
    assert.equal(calls[0].opts.temperature, 0);
    assert.equal(calls[0].opts.userId, "u1");
    assert.deepEqual(out.verdict, { accepted: 1, reason: "second shows tacos" });
    assert.equal(out.shown.length, 3);
    assert.equal(out.costEstimateUsd, 0.004);
  });

  it("a preview that fails to download is dropped BEFORE the call so indices line up", async () => {
    const fetch: ImageFetch = async (url) => bytesResponse(!url.includes("/0/"));
    const { ai, calls } = recorderAI({ accepted: 0, reason: "first shown" });
    const out = await judgeImageRelevance(subject, [candidate(0), candidate(1)], { ai, fetch });
    const input = calls[0].vars.judgeInput as { candidates: Array<{ index: number }> };
    assert.equal(input.candidates.length, 1);
    assert.equal(input.candidates[0].index, 0);
    // Index 0 of the SHOWN list is candidate 1.
    assert.equal(out.shown[0].providerId, "1");
    assert.equal(out.verdict?.accepted, 0);
  });

  it("no downloadable candidates → rejected without an AI call", async () => {
    const fetch: ImageFetch = async () => bytesResponse(false);
    const { ai, calls } = recorderAI({ accepted: 0, reason: "x" });
    const out = await judgeImageRelevance(subject, [candidate(0)], { ai, fetch });
    assert.equal(calls.length, 0);
    assert.deepEqual(out.verdict, { accepted: null, reason: "no candidates to judge" });
    assert.equal(out.costEstimateUsd, 0);
  });

  it("an out-of-range index from the model is a rejection, not a crash", async () => {
    const fetch: ImageFetch = async () => bytesResponse(true);
    const { ai } = recorderAI({ accepted: 7, reason: "nonsense" });
    const out = await judgeImageRelevance(subject, [candidate(0)], { ai, fetch });
    assert.deepEqual(out.verdict, { accepted: null, reason: "index 7 out of range" });
  });

  it("maxCandidates caps what is shown", async () => {
    const fetch: ImageFetch = async () => bytesResponse(true);
    const { ai, calls } = recorderAI({ accepted: null, reason: "none" });
    await judgeImageRelevance(subject, [candidate(0), candidate(1), candidate(2)], { ai, fetch, maxCandidates: 2 });
    assert.equal((calls[0].opts.attachments as unknown[]).length, 2);
  });

  it("an AI failure yields verdict null with the reason (caller moves to step 3)", async () => {
    const fetch: ImageFetch = async () => bytesResponse(true);
    const ai: JudgeAICall = async () => ({
      success: false,
      reason: "spend_cap_global",
      userFacingMessage: "x",
      metadata: { costEstimateUsd: 0 },
    });
    const out = await judgeImageRelevance(subject, [candidate(0)], { ai, fetch });
    assert.equal(out.verdict, null);
    assert.equal(out.failureReason, "spend_cap_global");
  });

  it("schema: accepted is a non-negative integer or null; reason is required", () => {
    assert.equal(RelevanceVerdictSchema.safeParse({ accepted: null, reason: "r" }).success, true);
    assert.equal(RelevanceVerdictSchema.safeParse({ accepted: 2, reason: "r" }).success, true);
    assert.equal(RelevanceVerdictSchema.safeParse({ accepted: -1, reason: "r" }).success, false);
    assert.equal(RelevanceVerdictSchema.safeParse({ accepted: 1.5, reason: "r" }).success, false);
    assert.equal(RelevanceVerdictSchema.safeParse({ accepted: 1 }).success, false);
  });
});

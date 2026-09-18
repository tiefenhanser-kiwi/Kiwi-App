// Row 5 · Block 1 (D-WS9-246) — the four-step chain and the store. Every
// dependency is a stub; the images are jimp-built bitmaps. No network.
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Jimp } from "jimp";

import { resolveMealImage, stockAttribution, stockStep, type PipelineDeps } from "../images/imagePipeline";
import { IMAGE_LONG_EDGE_PX, ImageStore, mealImageKey, publicUrlFor, resizeForStore } from "../images/imageStore";
import type { JudgeAICall } from "../images/relevanceJudge";
import type { ImageFetch, ImageFetchResponse, ObjectWriter, StockCandidate, StockImageProvider } from "../images/types";

async function bitmap(w: number, h: number): Promise<Buffer> {
  const img = new Jimp({ width: w, height: h, color: 0xff6600ff });
  return img.getBuffer("image/png");
}

function bytesResponse(bytes: Buffer | null, contentType = "image/png"): ImageFetchResponse {
  return {
    ok: bytes != null,
    status: bytes != null ? 200 : 404,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? contentType : null) },
    json: async () => ({}),
    arrayBuffer: async () => (bytes ?? Buffer.alloc(0)).buffer.slice(bytes?.byteOffset ?? 0, (bytes?.byteOffset ?? 0) + (bytes?.byteLength ?? 0)) as ArrayBuffer,
    text: async () => "",
  };
}

class MemoryWriter implements ObjectWriter {
  saved: Array<{ key: string; bytes: Buffer; contentType: string }> = [];
  async save(key: string, bytes: Buffer, contentType: string) {
    this.saved.push({ key, bytes, contentType });
  }
}

function provider(name: "pexels" | "pixabay", results: StockCandidate[] | Error): StockImageProvider & { queries: string[] } {
  const queries: string[] = [];
  return {
    name,
    queries,
    async search(q) {
      queries.push(q);
      if (results instanceof Error) throw results;
      return results;
    },
  };
}

function cand(provider: "pexels" | "pixabay", id: string): StockCandidate {
  return {
    provider,
    providerId: id,
    url: `https://cdn.test/${provider}/${id}/full.jpg`,
    previewUrl: `https://cdn.test/${provider}/${id}/preview.jpg`,
    width: 3000,
    height: 2000,
    photographer: `photog-${id}`,
    sourcePageUrl: `https://${provider}.test/photo/${id}`,
    description: `desc ${id}`,
  };
}

function aiReply(accepted: number | null, reason = "r"): JudgeAICall {
  return async (promptKey, _vars, schema) => ({
    success: true,
    data: schema.parse({ accepted, reason }),
    metadata: { promptKey, promptVersion: 1, model: "m", mode: "tool", latencyMs: 1, inputTokens: 1, outputTokens: 1, costEstimateUsd: 0.005, retryCount: 0 },
  });
}

const subject = { mealId: "meal-abc", title: "Birria Tacos with Consommé", dishTitles: ["Birria Tacos", "Consommé"] };

interface Harness {
  deps: PipelineDeps;
  writer: MemoryWriter;
  fetched: string[];
  openaiCalls: number;
}

async function harness(opts: {
  providers?: StockImageProvider[];
  accepted?: number | null;
  openai?: "ok" | "fail";
  pageImageBytes?: Buffer | null;
}): Promise<Harness> {
  const big = await bitmap(1600, 1000);
  const writer = new MemoryWriter();
  const fetched: string[] = [];
  const h: Harness = { deps: undefined as unknown as PipelineDeps, writer, fetched, openaiCalls: 0 };
  const fetch: ImageFetch = async (url) => {
    fetched.push(url);
    if (url.startsWith("https://api.openai.com/")) {
      h.openaiCalls++;
      if (opts.openai === "fail") return { ...bytesResponse(null), ok: false, status: 500, json: async () => ({ error: { message: "boom" } }) };
      return { ...bytesResponse(big), json: async () => ({ data: [{ b64_json: big.toString("base64") }], usage: { input_tokens: 10, output_tokens: 1000 } }) };
    }
    if (url.startsWith("https://publisher.test/")) return bytesResponse(opts.pageImageBytes === undefined ? big : opts.pageImageBytes);
    return bytesResponse(big);
  };
  h.deps = {
    fetch,
    providers: opts.providers ?? [provider("pexels", [cand("pexels", "p1")]), provider("pixabay", [cand("pixabay", "x1")])],
    judge: { ai: aiReply(opts.accepted ?? null) },
    generator: { apiKey: "sk" },
    store: new ImageStore({ writer, bucket: "test-bucket" }),
  };
  return h;
}

describe("ImageStore / resizeForStore", () => {
  it(`resizes to ${IMAGE_LONG_EDGE_PX} px on the long edge, JPEG, never upscales`, async () => {
    const wide = await resizeForStore(await bitmap(1600, 1000));
    assert.equal(wide.width, 1024);
    assert.equal(wide.height, 640);
    assert.equal(wide.contentType, "image/jpeg");
    assert.equal(wide.bytes.subarray(0, 2).toString("hex"), "ffd8");
    const tall = await resizeForStore(await bitmap(1000, 1600));
    assert.equal(tall.width, 640);
    assert.equal(tall.height, 1024);
    const small = await resizeForStore(await bitmap(600, 400));
    assert.equal(small.width, 600);
    assert.equal(small.height, 400);
  });

  it("a JPEG that already fits is stored native — byte-identical, no re-encode (Block 1b: the generator's 1024²)", async () => {
    const native = await new Jimp({ width: 1024, height: 1024, color: 0x3366ffff }).getBuffer("image/jpeg", { quality: 90 });
    const out = await resizeForStore(native);
    assert.equal(out.width, 1024);
    assert.equal(out.height, 1024);
    assert.ok(out.bytes.equals(native), "bytes must pass through untouched");
    // A PNG of the same size is still re-encoded to JPEG.
    const png = await resizeForStore(await bitmap(1024, 1024));
    assert.equal(png.bytes.subarray(0, 2).toString("hex"), "ffd8");
    assert.equal(png.width, 1024);
  });

  it("put() writes meals/<id>.jpg to the writer and returns the public bucket URL", async () => {
    const writer = new MemoryWriter();
    const store = new ImageStore({ writer, bucket: "kiwi-prod-508416-images" });
    const out = await store.put(mealImageKey("m-1"), await bitmap(1600, 1000));
    assert.equal(writer.saved[0].key, "meals/m-1.jpg");
    assert.equal(writer.saved[0].contentType, "image/jpeg");
    assert.equal(out.url, "https://storage.googleapis.com/kiwi-prod-508416-images/meals/m-1.jpg");
    assert.equal(out.url, publicUrlFor("kiwi-prod-508416-images", "meals/m-1.jpg"));
    assert.equal(out.width, 1024);
  });

  it("an undecodable input throws (the caller skips that candidate)", async () => {
    await assert.rejects(resizeForStore(Buffer.from("not an image")));
  });
});

describe("resolveMealImage — the chain", () => {
  it("step 1 wins: a page image is downloaded, stored, and stock/generate are never touched", async () => {
    const h = await harness({ accepted: 0 });
    const html = `<html><head><meta property="og:image" content="https://publisher.test/dish.jpg"></head></html>`;
    const out = await resolveMealImage(subject, { pageHtml: html, sourceUrl: "https://publisher.test/recipe" }, h.deps);
    assert.equal(out.image.source, "page_extracted");
    assert.equal(out.image.url, "https://storage.googleapis.com/test-bucket/meals/meal-abc.jpg");
    assert.equal(out.image.sourceUrl, "https://publisher.test/recipe");
    assert.equal(out.image.attribution, null);
    assert.equal(h.writer.saved.length, 1);
    assert.equal((h.deps.providers[0] as StockImageProvider & { queries: string[] }).queries.length, 0);
    assert.equal(h.openaiCalls, 0);
    assert.equal(out.trace.costEstimateUsd, 0);
  });

  it("step 1 → 2: a page image under 400 px after download is rejected and stock runs", async () => {
    const h = await harness({ accepted: 0, pageImageBytes: await bitmap(300, 200) });
    const html = `<html><head><meta property="og:image" content="https://publisher.test/tiny.jpg"></head></html>`;
    const out = await resolveMealImage(subject, { pageHtml: html }, h.deps);
    assert.equal(out.trace.page?.rejectedAfterDownload, "too_small_300x200");
    assert.equal(out.image.source, "stock_pexels");
  });

  it("step 2 wins: both providers are queried with the shaped title, the judge's pick is stored with attribution + source page", async () => {
    const h = await harness({ accepted: 1 });
    const out = await resolveMealImage(subject, {}, h.deps);
    const pexels = h.deps.providers[0] as StockImageProvider & { queries: string[] };
    const pixabay = h.deps.providers[1] as StockImageProvider & { queries: string[] };
    assert.deepEqual(pexels.queries, ["birria tacos"]);
    assert.deepEqual(pixabay.queries, ["birria tacos"]);
    assert.equal(out.image.source, "stock_pixabay");
    assert.equal(out.image.attribution, "Photo by photog-x1 on Pixabay");
    assert.equal(out.image.sourceUrl, "https://pixabay.test/photo/x1");
    assert.equal(out.image.url, "https://storage.googleapis.com/test-bucket/meals/meal-abc.jpg");
    assert.ok(h.fetched.includes("https://cdn.test/pixabay/x1/full.jpg"));
    assert.equal(h.openaiCalls, 0);
    assert.equal(out.trace.stock?.candidates.length, 2);
    assert.equal(out.trace.costEstimateUsd, 0.005);
  });

  it("step 3: the judge rejects all → generate, stored as ai_generated with the model in the attribution", async () => {
    const h = await harness({ accepted: null });
    const out = await resolveMealImage(subject, {}, h.deps);
    assert.equal(h.openaiCalls, 1);
    assert.equal(out.image.source, "ai_generated");
    assert.equal(out.image.attribution, "AI-generated (gpt-image-1-mini)");
    assert.equal(out.image.sourceUrl, null);
    assert.equal(h.writer.saved.length, 1);
    assert.equal(h.writer.saved[0].key, "meals/meal-abc.jpg");
    // judge 0.005 + generation (10×2e-6 + 1000×8e-6 = 0.00802)
    assert.ok(Math.abs(out.trace.costEstimateUsd - 0.01302) < 1e-9);
  });

  it("step 4: no stock candidates and generation fails → none, nothing stored", async () => {
    const h = await harness({ providers: [provider("pexels", []), provider("pixabay", new Error("timeout"))], openai: "fail" });
    const out = await resolveMealImage(subject, {}, h.deps);
    assert.deepEqual(out.image, { source: "none", url: null, attribution: null, sourceUrl: null });
    assert.equal(h.writer.saved.length, 0);
    assert.equal(out.trace.stock?.judge, null);
    assert.deepEqual(out.trace.stock?.providerErrors, [{ provider: "pixabay", message: "timeout" }]);
    assert.equal(out.trace.generation?.ok, false);
  });

  it("a stock candidate with a rejected filename shape never reaches the judge", async () => {
    const bad = { ...cand("pexels", "p9"), url: "https://cdn.test/pexels/p9/logo.jpg" };
    const h = await harness({ providers: [provider("pexels", [bad])], accepted: 0 });
    const out = await stockStep(subject, h.deps);
    assert.equal(out.candidates.length, 0);
    assert.equal(out.judge, null);
  });

  it("skipStock / skipGenerate seams", async () => {
    const h = await harness({ accepted: 0 });
    const out = await resolveMealImage(subject, { skipStock: true, skipGenerate: true }, h.deps);
    assert.equal(out.image.source, "none");
    assert.equal(h.openaiCalls, 0);
  });

  it("stockAttribution names the photographer and the site", () => {
    assert.equal(stockAttribution(cand("pexels", "a")), "Photo by photog-a on Pexels");
    assert.equal(stockAttribution(cand("pixabay", "b")), "Photo by photog-b on Pixabay");
  });
});

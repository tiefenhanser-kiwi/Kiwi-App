// Row 5 · Block 1 (D-WS9-246) — the chain and the store. Since Block 1c the
// chain is ONE step (generate → store) with the gradient as the fallback;
// the stock / publisher steps and their tests are deleted, not skipped.
// Every dependency is a stub; the images are jimp-built bitmaps. No network.
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Jimp } from "jimp";

import { downloadImageBytes, resolveMealImage, type PipelineDeps } from "../images/imagePipeline";
import { IMAGE_LONG_EDGE_PX, ImageStore, mealImageKey, publicUrlFor, resizeForStore } from "../images/imageStore";
import { SlidingWindowRateLimiter } from "../images/rateLimiter";
import type { ImageFetch, ImageFetchResponse, ObjectWriter } from "../images/types";

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
  failWith: Error | null = null;
  async save(key: string, bytes: Buffer, contentType: string) {
    if (this.failWith) throw this.failWith;
    this.saved.push({ key, bytes, contentType });
  }
}

const subject = { mealId: "meal-abc", title: "Birria Tacos with Consommé", dishTitles: ["Birria Tacos", "Consommé"] };

interface Harness {
  deps: PipelineDeps;
  writer: MemoryWriter;
  fetched: string[];
  openaiCalls: number;
}

async function harness(opts: { openai?: "ok" | "fail"; apiKey?: string } = {}): Promise<Harness> {
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
    return bytesResponse(big);
  };
  h.deps = {
    fetch,
    generator: { apiKey: opts.apiKey ?? "sk" },
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

describe("resolveMealImage — generate → store, else the gradient", () => {
  it("generation succeeds → stored as ai_generated at meals/<id>.jpg, one OpenAI call, nothing else fetched", async () => {
    const h = await harness();
    const out = await resolveMealImage(subject, h.deps);
    assert.equal(out.image.source, "ai_generated");
    assert.equal(out.image.url, "https://storage.googleapis.com/test-bucket/meals/meal-abc.jpg");
    assert.equal(h.openaiCalls, 1);
    assert.deepEqual(h.fetched, ["https://api.openai.com/v1/images/generations"]);
    assert.deepEqual(h.writer.saved.map((s) => s.key), ["meals/meal-abc.jpg"]);
    assert.ok(out.trace.generation?.ok);
    assert.ok(out.trace.costEstimateUsd > 0);
  });

  it("generation fails (HTTP 500) → none, nothing stored, the reason is on the trace", async () => {
    const h = await harness({ openai: "fail" });
    const out = await resolveMealImage(subject, h.deps);
    assert.equal(out.image.source, "none");
    assert.equal(out.image.url, null);
    assert.equal(h.writer.saved.length, 0);
    assert.equal(out.trace.generation?.ok, false);
    assert.equal(out.trace.generation && !out.trace.generation.ok ? out.trace.generation.reason : null, "http_error");
  });

  it("no API key → none with reason no_api_key, and OpenAI is never called", async () => {
    const h = await harness({ apiKey: "" });
    const out = await resolveMealImage(subject, h.deps);
    assert.equal(out.image.source, "none");
    assert.equal(h.openaiCalls, 0);
    assert.equal(out.trace.generation && !out.trace.generation.ok ? out.trace.generation.reason : null, "no_api_key");
  });

  it("the bucket write throws → none with storeError set (the generation itself succeeded and was paid for)", async () => {
    const h = await harness();
    h.writer.failWith = new Error("gcs down");
    const out = await resolveMealImage(subject, h.deps);
    assert.equal(out.image.source, "none");
    assert.equal(out.trace.storeError, "gcs down");
    assert.ok(out.trace.generation?.ok, "the generation was fine");
    assert.equal(h.openaiCalls, 1);
  });
});

describe("downloadImageBytes (kept for scripts/ws9-row5/rehost_templates.ts)", () => {
  it("returns the bytes on 200 and null on a non-2xx", async () => {
    const big = await bitmap(10, 10);
    const ok = await downloadImageBytes(async () => bytesResponse(big), "https://x.test/a.png");
    assert.ok(ok && ok.equals(big));
    const missing = await downloadImageBytes(async () => bytesResponse(null), "https://x.test/b.png");
    assert.equal(missing, null);
  });
});

// The limiter's consumer is now only the single-process catalog script
// (generate.ts). Its test rides here since the stock-provider file that held
// it is deleted.
describe("SlidingWindowRateLimiter (generate.ts's pacer — never the api-server's bound)", () => {
  it("allows `limit` requests in a window, then sleeps until the oldest ages out", async () => {
    let now = 1_000_000;
    const sleeps: number[] = [];
    const limiter = new SlidingWindowRateLimiter({
      limit: 3,
      windowMs: 1000,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    await limiter.acquire();
    now += 100;
    await limiter.acquire();
    now += 100;
    await limiter.acquire();
    assert.deepEqual(sleeps, []);
    assert.equal(limiter.inWindow(), 3);
    // Fourth: the oldest stamp is at t=1_000_000; window ends at +1000; now is +200.
    await limiter.acquire();
    assert.deepEqual(sleeps, [800]);
    assert.equal(limiter.inWindow(), 3);
  });
});

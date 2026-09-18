// Row 5 · Block 1 — BUG-279's class, for the image pipeline: `pnpm test`
// loads .env, so PEXELS / PIXABAY / OPENAI / ANTHROPIC keys are all present
// in the suite. If any file under src/lib/images/ could reach the real
// network on its own, a green run could be green because a live provider
// answered — and it would spend money doing it.
//
// Two guards, both of which a deliberate break turns red (§27.4):
//
//   1. STATIC — every source file under src/lib/images/ EXCEPT live.ts is
//      scanned for a bare `fetch(` call, `globalThis.fetch`, `process.env`,
//      the storage SDK, and an OpenAI SDK import. The extractor is also
//      scanned for an `img` selector (D-WS9-246: never enumerate <img>).
//   2. RUNTIME — globalThis.fetch is replaced with a trap that throws, and the
//      WHOLE chain (page → stock → judge → generate → store) runs on stubs.
//      If any path fell through to the real fetch, the trap fires. The trap
//      is proven able to fire first (§27.5 — the fixture can express the
//      failure).
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Jimp } from "jimp";

import { resolveMealImage, type PipelineDeps } from "../images/imagePipeline";
import { ImageStore } from "../images/imageStore";
import type { JudgeAICall } from "../images/relevanceJudge";
import type { ImageFetch, ImageFetchResponse, ObjectWriter, StockImageProvider } from "../images/types";

const IMAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "images");
const LIVE_FILE = "live.ts";

function sourceFiles(): string[] {
  return readdirSync(IMAGES_DIR).filter((f) => f.endsWith(".ts") && f !== LIVE_FILE);
}

// A `fetch(` that is not `.fetch(` (a property call on the injected deps) and
// not part of an identifier (`liveFetch(`, `fetchPage(`). Comments are
// stripped first so a doc line cannot trip it or hide behind it.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const BARE_FETCH = /(?<![.\w$])fetch\s*\(/;
const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: "bare fetch( call", re: BARE_FETCH },
  { name: "globalThis.fetch", re: /globalThis\s*\.\s*fetch/ },
  { name: "process.env", re: /process\s*\.\s*env/ },
  { name: "@google-cloud import", re: /from\s+["']@google-cloud\// },
  { name: "openai SDK import", re: /from\s+["']openai["']/ },
];

describe("image pipeline — network guard (static)", () => {
  it("the folder has the files this guard expects, and live.ts is the only exception", () => {
    const files = sourceFiles();
    for (const expected of ["imageGenerator.ts", "imagePipeline.ts", "imageStore.ts", "pageImageExtractor.ts", "relevanceJudge.ts", "stockProviders.ts"]) {
      assert.ok(files.includes(expected), `missing ${expected}`);
    }
    assert.ok(readdirSync(IMAGES_DIR).includes(LIVE_FILE));
  });

  it("no file except live.ts reaches fetch / env / a cloud SDK on its own", () => {
    const offenders: string[] = [];
    for (const f of sourceFiles()) {
      const src = stripComments(readFileSync(join(IMAGES_DIR, f), "utf8"));
      for (const { name, re } of FORBIDDEN) {
        if (re.test(src)) offenders.push(`${f}: ${name}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("live.ts DOES hold the real wiring (so the exception is real, not vacuous)", () => {
    const src = stripComments(readFileSync(join(IMAGES_DIR, LIVE_FILE), "utf8"));
    assert.match(src, /globalThis\s*\.\s*fetch/);
    assert.match(src, /from\s+["']@google-cloud\/storage["']/);
    assert.match(src, /new Storage\(\)/);
  });

  it("the page extractor never selects <img> elements", () => {
    const src = stripComments(readFileSync(join(IMAGES_DIR, "pageImageExtractor.ts"), "utf8"));
    assert.doesNotMatch(src, /\$\(\s*["'`][^"'`]*\bimg\b/);
    assert.doesNotMatch(src, /["'`]img(\[|\s|["'`])/);
    // And it does select the publisher tags.
    assert.match(src, /og:image/);
    assert.match(src, /twitter:image/);
    assert.match(src, /extractJsonLdRecipe/);
  });
});

// ── runtime trap ─────────────────────────────────────────────────────

class NetworkTrap extends Error {
  constructor(url: unknown) {
    super(`NETWORK CALL FROM THE HERMETIC SUITE: ${String(url)}`);
    this.name = "NetworkTrap";
  }
}

async function withTrappedFetch<T>(fn: (trips: () => number) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = ((input: unknown) => {
    count++;
    throw new NetworkTrap(input);
  }) as unknown as typeof fetch;
  try {
    return await fn(() => count);
  } finally {
    globalThis.fetch = original;
  }
}

async function bitmap(): Promise<Buffer> {
  return new Jimp({ width: 900, height: 600, color: 0x3366ffff }).getBuffer("image/png");
}

describe("image pipeline — network guard (runtime)", () => {
  it("the trap can fire (the fixture can express the failure)", async () => {
    await withTrappedFetch(async (trips) => {
      await assert.rejects(async () => globalThis.fetch("https://example.test/"), (e: unknown) => e instanceof NetworkTrap);
      assert.equal(trips(), 1);
    });
  });

  it("the whole chain runs to `none` → `ai_generated` on stubs without touching globalThis.fetch", async () => {
    const big = await bitmap();
    const stub: ImageFetch = async (url) => {
      const res: ImageFetchResponse = {
        ok: true,
        status: 200,
        headers: { get: () => "image/png" },
        json: async () =>
          url.startsWith("https://api.openai.com/")
            ? { data: [{ b64_json: big.toString("base64") }], usage: { input_tokens: 1, output_tokens: 1 } }
            : {},
        arrayBuffer: async () => big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength),
        text: async () => "",
      };
      return res;
    };
    const saved: string[] = [];
    const writer: ObjectWriter = { save: async (key) => void saved.push(key) };
    const providers: StockImageProvider[] = [
      { name: "pexels", search: async () => [] },
      { name: "pixabay", search: async () => [{ provider: "pixabay", providerId: "1", url: "https://cdn.test/1.jpg", previewUrl: "https://cdn.test/1p.jpg", width: 2000, height: 1300, photographer: "x", sourcePageUrl: "https://pixabay.test/1", description: "d" }] },
    ];
    const ai: JudgeAICall = async (promptKey, _v, schema) => ({
      success: true,
      data: schema.parse({ accepted: null, reason: "none fit" }),
      metadata: { promptKey, promptVersion: null, model: "m", mode: "tool", latencyMs: 0, inputTokens: 0, outputTokens: 0, costEstimateUsd: 0, retryCount: 0 },
    });
    const deps: PipelineDeps = {
      fetch: stub,
      providers,
      judge: { ai },
      generator: { apiKey: "sk-stub" },
      store: new ImageStore({ writer, bucket: "b" }),
    };
    const html = `<html><head><meta property="og:image" content="https://publisher.test/dish-logo.png"></head><body><img src="https://ads.test/x.jpg"></body></html>`;

    await withTrappedFetch(async (trips) => {
      const out = await resolveMealImage(
        { mealId: "guard-1", title: "Guard Meal with Rice", dishTitles: ["Guard Meal"] },
        { pageHtml: html, sourceUrl: "https://publisher.test/recipe" },
        deps,
      );
      assert.equal(trips(), 0);
      assert.equal(out.image.source, "ai_generated");
      assert.deepEqual(saved, ["meals/guard-1.jpg"]);
      // The og:image was a logo shape → rejected; the <img> was never seen.
      assert.equal(out.trace.page?.accepted, null);
      assert.equal(out.trace.page?.rejected[0]?.reason, "filename_shape");
    });
  });
});

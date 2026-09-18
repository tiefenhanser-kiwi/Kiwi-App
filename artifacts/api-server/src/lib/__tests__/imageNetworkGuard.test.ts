// Row 5 · Block 1 — BUG-279's class, for the image pipeline: `pnpm test`
// loads .env, so the OPENAI / ANTHROPIC keys are present in the suite. If any
// file under src/lib/images/ could reach the real network on its own, a
// green run could be green because a live provider answered — and it would
// spend money doing it.
//
// Two guards, both of which a deliberate break turns red (§27.4):
//
//   1. STATIC — every source file under src/lib/images/ EXCEPT live.ts is
//      scanned for a bare `fetch(` call, `globalThis.fetch`, `process.env`,
//      the storage SDK, and an OpenAI SDK import. Block 1c: the queue's
//      drain (imageQueue.ts) is in the folder and under the same scan, and
//      the deleted stock / judge / extractor files must STAY deleted.
//   2. RUNTIME — globalThis.fetch is replaced with a trap that throws, and the
//      chain (generate → store) AND a full drain tick run on stubs. If any
//      path fell through to the real fetch, the trap fires. The trap is
//      proven able to fire first (§27.5 — the fixture can express the
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
import { runImageDrain, type ClaimedImageRow, type ImageQueueStore } from "../images/imageQueue";
import { ImageStore } from "../images/imageStore";
import type { ImageFetch, ImageFetchResponse, ObjectWriter } from "../images/types";

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
    for (const expected of ["imageGenerator.ts", "imagePipeline.ts", "imageQueue.ts", "imageStore.ts", "rateLimiter.ts", "types.ts"]) {
      assert.ok(files.includes(expected), `missing ${expected}`);
    }
    assert.ok(readdirSync(IMAGES_DIR).includes(LIVE_FILE));
  });

  it("Block 1c (D-WS9-246): the stock providers, the judge and the page extractor stay DELETED", () => {
    const files = readdirSync(IMAGES_DIR);
    for (const gone of ["stockProviders.ts", "relevanceJudge.ts", "pageImageExtractor.ts"]) {
      assert.ok(!files.includes(gone), `${gone} is back — D-WS9-246 deleted it, do not re-add`);
    }
    // And no file in the folder mentions a stock provider or the judge.
    for (const f of readdirSync(IMAGES_DIR).filter((x) => x.endsWith(".ts"))) {
      const src = stripComments(readFileSync(join(IMAGES_DIR, f), "utf8"));
      assert.doesNotMatch(src, /pexels|pixabay|relevance_judge|og:image/i, `${f} references a deleted step`);
    }
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

function stubFetch(big: Buffer): ImageFetch {
  return async (url) => {
    const res: ImageFetchResponse = {
      ok: true,
      status: 200,
      headers: { get: () => "image/png" },
      json: async () =>
        url.startsWith("https://api.openai.com/")
          ? { data: [{ b64_json: big.toString("base64") }], usage: { input_tokens: 1, output_tokens: 1 } }
          : {},
      arrayBuffer: async () => big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength) as ArrayBuffer,
      text: async () => "",
    };
    return res;
  };
}

describe("image pipeline — network guard (runtime)", () => {
  it("the trap can fire (the fixture can express the failure)", async () => {
    await withTrappedFetch(async (trips) => {
      await assert.rejects(async () => globalThis.fetch("https://example.test/"), (e: unknown) => e instanceof NetworkTrap);
      assert.equal(trips(), 1);
    });
  });

  it("the chain runs to `ai_generated` on stubs without touching globalThis.fetch", async () => {
    const big = await bitmap();
    const saved: string[] = [];
    const writer: ObjectWriter = { save: async (key) => void saved.push(key) };
    const deps: PipelineDeps = {
      fetch: stubFetch(big),
      generator: { apiKey: "sk-stub" },
      store: new ImageStore({ writer, bucket: "b" }),
    };
    await withTrappedFetch(async (trips) => {
      const out = await resolveMealImage({ mealId: "guard-1", title: "Guard Meal with Rice", dishTitles: ["Guard Meal"] }, deps);
      assert.equal(trips(), 0);
      assert.equal(out.image.source, "ai_generated");
      assert.deepEqual(saved, ["meals/guard-1.jpg"]);
    });
  });

  it("a full drain tick (claim → generate → store → ready) runs on stubs without touching globalThis.fetch", async () => {
    const big = await bitmap();
    const saved: string[] = [];
    const writer: ObjectWriter = { save: async (key) => void saved.push(key) };
    const ready: string[] = [];
    const row: ClaimedImageRow = { id: "guard-q1", title: "Queued Meal", userId: "u1", imageAttempts: 1 };
    const store: ImageQueueStore = {
      claim: async () => ({ claimed: [row], requeuedStuck: 0, failedOut: 0, budget: { recentSends: 0, inFlight: 0, limit: 5 } }),
      loadSubjects: async () => [{ mealId: row.id, title: row.title, dishTitles: ["Queued Meal"] }],
      markReady: async (id) => {
        ready.push(id);
        return { forksStamped: 0 };
      },
      release: async () => "pending",
    };
    await withTrappedFetch(async (trips) => {
      const summary = await runImageDrain({
        store,
        pipeline: { fetch: stubFetch(big), generator: { apiKey: "sk-stub" }, store: new ImageStore({ writer, bucket: "b" }) },
      });
      assert.equal(trips(), 0);
      assert.equal(summary.ready, 1);
      assert.deepEqual(ready, ["guard-q1"]);
      assert.deepEqual(saved, ["meals/guard-q1.jpg"]);
    });
  });
});

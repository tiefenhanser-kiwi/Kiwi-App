// Row 5 · Block 1 (D-WS9-246 step 2) — Pexels + Pixabay behind one interface,
// the rate limiter, and the query shaping. fetch is a recorder; no network.
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PEXELS_RATE, PIXABAY_RATE, SlidingWindowRateLimiter } from "../images/rateLimiter";
import {
  buildStockQuery,
  PexelsProvider,
  PixabayProvider,
  StockProviderError,
} from "../images/stockProviders";
import type { ImageFetch, ImageFetchResponse } from "../images/types";

function jsonResponse(status: number, body: unknown): ImageFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => JSON.stringify(body),
  };
}

function recorder(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: unknown }> = [];
  const fetch: ImageFetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(status, body);
  };
  return { calls, fetch };
}

describe("PexelsProvider", () => {
  it("sends the key in Authorization, per_page + landscape, and maps candidates", async () => {
    const { calls, fetch } = recorder({
      photos: [
        {
          id: 123,
          width: 4000,
          height: 2667,
          url: "https://www.pexels.com/photo/tacos-123/",
          photographer: "Ana",
          alt: "Tacos on a plate",
          src: { original: "https://images.pexels.com/123/o.jpg", large: "https://images.pexels.com/123/l.jpg", medium: "https://images.pexels.com/123/m.jpg" },
        },
      ],
    });
    const p = new PexelsProvider({ fetch, apiKey: "PEX" });
    const out = await p.search("birria tacos", { perPage: 4 });
    assert.equal(calls.length, 1);
    const u = new URL(calls[0].url);
    assert.equal(u.origin + u.pathname, "https://api.pexels.com/v1/search");
    assert.equal(u.searchParams.get("query"), "birria tacos");
    assert.equal(u.searchParams.get("per_page"), "4");
    assert.equal(u.searchParams.get("orientation"), "landscape");
    assert.equal((calls[0].init as { headers: Record<string, string> }).headers.Authorization, "PEX");
    assert.deepEqual(out, [
      {
        provider: "pexels",
        providerId: "123",
        url: "https://images.pexels.com/123/l.jpg",
        previewUrl: "https://images.pexels.com/123/m.jpg",
        width: 4000,
        height: 2667,
        photographer: "Ana",
        sourcePageUrl: "https://www.pexels.com/photo/tacos-123/",
        description: "Tacos on a plate",
      },
    ]);
  });

  it("a non-2xx surfaces as StockProviderError with the status", async () => {
    const { fetch } = recorder({ error: "rate" }, 429);
    const p = new PexelsProvider({ fetch, apiKey: "PEX" });
    await assert.rejects(p.search("x"), (e: unknown) => e instanceof StockProviderError && e.status === 429 && e.provider === "pexels");
  });
});

describe("PixabayProvider", () => {
  it("sends key, category=food, image_type=photo, safesearch, and floors per_page at 3", async () => {
    const { calls, fetch } = recorder({
      hits: [
        {
          id: 77,
          pageURL: "https://pixabay.com/photos/tacos-77/",
          previewURL: "https://cdn.pixabay.com/77_150.jpg",
          webformatURL: "https://cdn.pixabay.com/77_640.jpg",
          largeImageURL: "https://cdn.pixabay.com/77_1280.jpg",
          imageWidth: 5000,
          imageHeight: 3333,
          user: "bob",
          tags: "tacos, mexican, food",
        },
      ],
    });
    const p = new PixabayProvider({ fetch, apiKey: "PIX" });
    const out = await p.search("birria tacos", { perPage: 1 });
    const u = new URL(calls[0].url);
    assert.equal(u.origin + u.pathname, "https://pixabay.com/api/");
    assert.equal(u.searchParams.get("key"), "PIX");
    assert.equal(u.searchParams.get("q"), "birria tacos");
    assert.equal(u.searchParams.get("category"), "food");
    assert.equal(u.searchParams.get("image_type"), "photo");
    assert.equal(u.searchParams.get("safesearch"), "true");
    assert.equal(u.searchParams.get("per_page"), "3");
    assert.equal(out[0].provider, "pixabay");
    assert.equal(out[0].url, "https://cdn.pixabay.com/77_1280.jpg");
    // The _640 → _340 preview swap.
    assert.equal(out[0].previewUrl, "https://cdn.pixabay.com/77_340.jpg");
    assert.equal(out[0].photographer, "bob");
    assert.equal(out[0].sourcePageUrl, "https://pixabay.com/photos/tacos-77/");
    assert.equal(out[0].description, "tacos, mexican, food");
  });

  it("truncates q at 100 characters", async () => {
    const { calls, fetch } = recorder({ hits: [] });
    const p = new PixabayProvider({ fetch, apiKey: "PIX" });
    await p.search("a".repeat(150));
    assert.equal(new URL(calls[0].url).searchParams.get("q")?.length, 100);
  });
});

describe("SlidingWindowRateLimiter", () => {
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

  it("the provider constants match the published limits", () => {
    assert.deepEqual(PEXELS_RATE, { limit: 200, windowMs: 3_600_000 });
    assert.deepEqual(PIXABAY_RATE, { limit: 100, windowMs: 60_000 });
  });

  it("a provider awaits its limiter before every request", async () => {
    let acquired = 0;
    const limiter = new SlidingWindowRateLimiter({ limit: 1000, windowMs: 1000 });
    const origAcquire = limiter.acquire.bind(limiter);
    limiter.acquire = async () => {
      acquired++;
      return origAcquire();
    };
    const { fetch } = recorder({ photos: [] });
    const p = new PexelsProvider({ fetch, apiKey: "k", limiter });
    await p.search("a");
    await p.search("b");
    assert.equal(acquired, 2);
  });
});

describe("buildStockQuery", () => {
  it("keeps the head clause — the dish — and drops the accompaniment", () => {
    assert.equal(buildStockQuery("Miso-Glazed Salmon with Sesame Bok Choy"), "miso-glazed salmon");
    assert.equal(buildStockQuery("Birria Tacos"), "birria tacos");
    assert.equal(buildStockQuery("Chicken Tacos with Lime Crema and Slaw"), "chicken tacos");
    assert.equal(buildStockQuery("Beef Stew over Mashed Potatoes"), "beef stew");
    assert.equal(buildStockQuery("Shrimp Scampi (Weeknight)"), "shrimp scampi");
    assert.equal(buildStockQuery("Pork Chops & Apples"), "pork chops");
    assert.equal(buildStockQuery("Pho, the Quick Way"), "pho");
  });

  it("never returns empty — falls back to the lowercased title", () => {
    assert.equal(buildStockQuery("with"), "with");
    assert.equal(buildStockQuery("(x)"), "(x)");
  });
});

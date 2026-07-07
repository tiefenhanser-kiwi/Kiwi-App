// WS7-8b USDA Block 1 — FDC client unit tests.
// Run via: pnpm --filter @workspace/api-server test
// node:test; global.fetch is stubbed — NO live USDA calls.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  searchFoods,
  getFood,
  getFoodsBatch,
  extractPer100gMacros,
  isUsdaEnabled,
  foodCategoryLabel,
  sanitizeUsdaQuery,
  type FdcFood,
} from "../usda/fdcClient";

// ── fetch stub plumbing ────────────────────────────────────────────────

interface StubResponse {
  status?: number;
  ok?: boolean;
  headers?: Record<string, string>;
  jsonBody?: unknown;
  throwErr?: Error; // when set, fetch rejects with this
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: FetchCall[] = [];
let queue: StubResponse[] = [];
const realFetch = global.fetch;

function makeResponse(stub: StubResponse): Response {
  const headers = new Headers(stub.headers ?? {});
  return {
    status: stub.status ?? 200,
    ok: stub.ok ?? (stub.status ?? 200) < 400,
    headers,
    json: async () => stub.jsonBody ?? {},
  } as unknown as Response;
}

function installFetch(responses: StubResponse[]): void {
  queue = [...responses];
  calls = [];
  global.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ url: String(url), init });
    const next = queue.shift();
    if (!next) throw new Error("fetch stub exhausted");
    if (next.throwErr) throw next.throwErr;
    return makeResponse(next);
  }) as typeof fetch;
}

const KEY = "USDA_INGREDIENTS_API_KEY";
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env[KEY];
  process.env[KEY] = "test-usda-key";
});
afterEach(() => {
  if (savedKey === undefined) delete process.env[KEY];
  else process.env[KEY] = savedKey;
  global.fetch = realFetch;
});

// ── nutrient rows ──────────────────────────────────────────────────────

function fullFood(overrides: Partial<FdcFood> = {}): FdcFood {
  return {
    fdcId: 123,
    description: "Onions, raw",
    dataType: "SR Legacy",
    foodCategory: "Vegetables and Vegetable Products",
    foodNutrients: [
      { nutrient: { number: "208", name: "Energy", unitName: "KCAL" }, amount: 40 },
      { nutrient: { number: "268", name: "Energy", unitName: "kJ" }, amount: 166 },
      { nutrient: { number: "203", name: "Protein", unitName: "G" }, amount: 1.1 },
      { nutrient: { number: "204", name: "Total lipid (fat)", unitName: "G" }, amount: 0.1 },
      { nutrient: { number: "205", name: "Carbohydrate, by difference", unitName: "G" }, amount: 9.3 },
    ],
    ...overrides,
  };
}

// ── extractPer100gMacros ───────────────────────────────────────────────

describe("extractPer100gMacros", () => {
  it("selects the KCAL energy row and skips the kJ row", () => {
    const macros = extractPer100gMacros(fullFood());
    assert.deepEqual(macros, { calories: 40, protein: 1.1, carbs: 9.3, fat: 0.1 });
  });

  it("parses the abridged nutrient shape (nutrientNumber/value)", () => {
    const food: FdcFood = {
      fdcId: 5,
      description: "Test",
      foodNutrients: [
        { nutrientNumber: "208", unitName: "KCAL", value: 100 },
        { nutrientNumber: "203", unitName: "G", value: 5 },
        { nutrientNumber: "204", unitName: "G", value: 2 },
        { nutrientNumber: "205", unitName: "G", value: 12 },
      ],
    };
    assert.deepEqual(extractPer100gMacros(food), {
      calories: 100,
      protein: 5,
      carbs: 12,
      fat: 2,
    });
  });

  it("returns null when any of the four macros is missing", () => {
    const food = fullFood({
      foodNutrients: [
        { nutrient: { number: "208", unitName: "KCAL" }, amount: 40 },
        { nutrient: { number: "203", unitName: "G" }, amount: 1.1 },
        // fat + carbs absent
      ],
    });
    assert.equal(extractPer100gMacros(food), null);
  });

  it("returns null when energy has only a kJ row (no KCAL)", () => {
    const food = fullFood({
      foodNutrients: [
        { nutrient: { number: "268", unitName: "kJ" }, amount: 166 },
        { nutrient: { number: "203", unitName: "G" }, amount: 1.1 },
        { nutrient: { number: "204", unitName: "G" }, amount: 0.1 },
        { nutrient: { number: "205", unitName: "G" }, amount: 9.3 },
      ],
    });
    assert.equal(extractPer100gMacros(food), null);
  });
});

describe("foodCategoryLabel", () => {
  it("reads a string category", () => {
    assert.equal(foodCategoryLabel(fullFood()), "Vegetables and Vegetable Products");
  });
  it("reads an object category via .description", () => {
    assert.equal(
      foodCategoryLabel(fullFood({ foodCategory: { description: "Dairy" } })),
      "Dairy",
    );
  });
  it("returns null when absent", () => {
    assert.equal(foodCategoryLabel(fullFood({ foodCategory: null })), null);
  });
});

// ── disabled mode ──────────────────────────────────────────────────────

describe("client disabled mode (no API key)", () => {
  it("isUsdaEnabled is false without a key and true with one", () => {
    delete process.env[KEY];
    assert.equal(isUsdaEnabled(), false);
    process.env[KEY] = "k";
    assert.equal(isUsdaEnabled(), true);
  });

  it("searchFoods returns {disabled} and makes NO fetch call when key absent", async () => {
    delete process.env[KEY];
    installFetch([]); // any call would throw "exhausted"
    const res = await searchFoods("onion");
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.reason, "disabled");
    assert.equal(calls.length, 0);
  });
});

// ── searchFoods happy path + filters ───────────────────────────────────

// ── BUG-028 query sanitization ─────────────────────────────────────────

describe("sanitizeUsdaQuery", () => {
  it("replaces slashes between digits with a space (the 400 case)", () => {
    assert.equal(sanitizeUsdaQuery("80/20 ground beef"), "80 20 ground beef");
    assert.equal(sanitizeUsdaQuery("half\\half"), "half half");
  });
  it("leaves normal names unchanged", () => {
    assert.equal(sanitizeUsdaQuery("ground beef"), "ground beef");
    assert.equal(sanitizeUsdaQuery("chicken breast"), "chicken breast");
  });
  it("spaces out other problem punctuation and collapses whitespace", () => {
    assert.equal(sanitizeUsdaQuery("half & half"), "half half");
    assert.equal(sanitizeUsdaQuery("9/11-style edge"), "9 11-style edge"); // intra-word hyphen kept
    assert.equal(sanitizeUsdaQuery("50% cream"), "50 cream");
    assert.equal(sanitizeUsdaQuery("mac # cheese"), "mac cheese");
  });
  it("preserves accented letters and apostrophes", () => {
    assert.equal(sanitizeUsdaQuery("jalapeño"), "jalapeño");
    assert.equal(sanitizeUsdaQuery("confectioner's sugar"), "confectioner's sugar");
  });
  it("OVER-STRIP GUARD: an all-punctuation name falls back to the original", () => {
    assert.equal(sanitizeUsdaQuery("///"), "///");
    assert.equal(sanitizeUsdaQuery("%%%"), "%%%");
  });
  it("COLLISION GUARD: genuinely-different names do not collapse together", () => {
    assert.notEqual(
      sanitizeUsdaQuery("80/20 ground beef"),
      sanitizeUsdaQuery("90/10 ground beef"),
    );
  });
});

describe("searchFoods", () => {
  it("sanitizes the outbound query so a slash-in-name never hits the 400 path", async () => {
    installFetch([{ jsonBody: { foods: [fullFood()] } }]);
    const res = await searchFoods("80/20 ground beef");
    assert.equal(res.ok, true);
    const url = calls[0].url;
    // URLSearchParams encodes spaces as '+'; the slash must be gone.
    assert.match(url, /query=80\+20\+ground\+beef/);
    assert.doesNotMatch(url, /%2F/i); // no encoded slash
    assert.doesNotMatch(url, /80%2F20|80\/20/); // no raw or encoded 80/20
  });

  it("returns the foods array and applies Foundation/SR Legacy dataType filter", async () => {
    installFetch([{ jsonBody: { foods: [fullFood()] } }]);
    const res = await searchFoods("onion");
    assert.equal(res.ok, true);
    assert.equal(res.ok === true && res.data.length, 1);
    const url = calls[0].url;
    assert.match(url, /\/foods\/search\?/);
    assert.match(url, /dataType=Foundation/);
    assert.match(url, /dataType=SR\+Legacy/);
    assert.match(url, /api_key=test-usda-key/);
  });

  it("maps HTTP 429 to rate_limited (no throw)", async () => {
    installFetch([
      { status: 429, ok: false, headers: { "x-ratelimit-remaining": "0" } },
    ]);
    const res = await searchFoods("onion");
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.reason, "rate_limited");
    assert.equal(res.ok === false && res.status, 429);
  });

  it("maps an AbortError to timeout (no throw)", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    installFetch([{ throwErr: abort }]);
    const res = await searchFoods("onion");
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.reason, "timeout");
  });

  it("maps a generic fetch throw to network (no throw)", async () => {
    installFetch([{ throwErr: new Error("ECONNRESET") }]);
    const res = await searchFoods("onion");
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.reason, "network");
  });

  it("maps a non-2xx to http_error", async () => {
    installFetch([{ status: 500, ok: false }]);
    const res = await searchFoods("onion");
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.reason, "http_error");
  });
});

describe("getFood", () => {
  it("fetches a single food by id", async () => {
    installFetch([{ jsonBody: fullFood() }]);
    const res = await getFood(123);
    assert.equal(res.ok, true);
    assert.equal(res.ok === true && res.data.fdcId, 123);
    assert.match(calls[0].url, /\/food\/123\?/);
  });
});

// ── getFoodsBatch chunking ─────────────────────────────────────────────

describe("getFoodsBatch", () => {
  it("chunks >20 ids into ≤20-id POST requests", async () => {
    installFetch([
      { jsonBody: [fullFood({ fdcId: 1 })] },
      { jsonBody: [fullFood({ fdcId: 2 })] },
    ]);
    const ids = Array.from({ length: 25 }, (_, i) => i + 1);
    const res = await getFoodsBatch(ids);
    assert.equal(res.ok, true);
    assert.equal(calls.length, 2);
    const body0 = JSON.parse(String(calls[0].init?.body)) as { fdcIds: number[] };
    const body1 = JSON.parse(String(calls[1].init?.body)) as { fdcIds: number[] };
    assert.equal(body0.fdcIds.length, 20);
    assert.equal(body1.fdcIds.length, 5);
  });

  it("empty id list makes no fetch call", async () => {
    installFetch([]);
    const res = await getFoodsBatch([]);
    assert.equal(res.ok, true);
    assert.equal(calls.length, 0);
  });

  it("fails soft on a chunk error", async () => {
    installFetch([{ status: 429, ok: false }]);
    const res = await getFoodsBatch([1, 2, 3]);
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.reason, "rate_limited");
  });
});

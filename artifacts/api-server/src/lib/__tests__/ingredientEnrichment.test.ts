// WS7-8b USDA Block 1 — enrichment + name-match guardrail unit tests.
// Run via: pnpm --filter @workspace/api-server test
// node:test; global.fetch is stubbed — NO live USDA calls.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import {
  nameMatches,
  selectMatch,
  isMatchedRef,
  enrichIngredients,
  type NutritionRefMatched,
  type NutritionRefMiss,
} from "../usda/ingredientEnrichment";
import type { FdcFood } from "../usda/fdcClient";

// ── name-match guardrail ────────────────────────────────────────────────

describe("nameMatches (guardrail)", () => {
  it("accepts when every Kiwi token is present in the USDA description", () => {
    assert.equal(
      nameMatches("chicken breast", "Chicken, broilers or fryers, breast, meat only, raw"),
      true,
    );
    assert.equal(nameMatches("yellow onion", "Onions, yellow, raw"), true);
    assert.equal(nameMatches("onions", "Onions, raw"), true); // plural ↔ singular
  });

  it("REJECTS a shared-head-noun near neighbor (adversarial)", () => {
    // "breast" absent from the bouillon description → miss.
    assert.equal(
      nameMatches("chicken breast", "Soup, chicken bouillon cube, dry"),
      false,
    );
    // "sauce" absent from raw fish → miss.
    assert.equal(nameMatches("fish sauce", "Fish, cod, Atlantic, raw"), false);
    // "powder" absent → miss.
    assert.equal(nameMatches("garlic powder", "Garlic, raw"), false);
  });

  it("rejects when the Kiwi name has no content tokens", () => {
    assert.equal(nameMatches("!!!", "Anything, raw"), false);
  });

  it("ignores filler adjectives that USDA omits (fresh/organic/large)", () => {
    assert.equal(nameMatches("fresh organic large egg", "Egg, whole, raw, fresh"), true);
  });
});

describe("selectMatch", () => {
  const onionFood: FdcFood = {
    fdcId: 42,
    description: "Onions, raw",
    dataType: "SR Legacy",
    foodCategory: "Vegetables",
    foodNutrients: [
      { nutrient: { number: "208", unitName: "KCAL" }, amount: 40 },
      { nutrient: { number: "203", unitName: "G" }, amount: 1.1 },
      { nutrient: { number: "204", unitName: "G" }, amount: 0.1 },
      { nutrient: { number: "205", unitName: "G" }, amount: 9.3 },
    ],
  };

  it("returns the first ranked food passing name + complete macros", () => {
    const picked = selectMatch("onion", [onionFood]);
    assert.ok(picked);
    assert.equal(picked?.food.fdcId, 42);
    assert.deepEqual(picked?.per100g, { calories: 40, protein: 1.1, carbs: 9.3, fat: 0.1 });
  });

  it("skips a name-matching food with incomplete macros", () => {
    const incomplete: FdcFood = {
      fdcId: 7,
      description: "Onions, raw",
      foodNutrients: [{ nutrient: { number: "208", unitName: "KCAL" }, amount: 40 }],
    };
    // First result name-matches but has no full macros → falls through → null.
    assert.equal(selectMatch("onion", [incomplete]), null);
  });

  it("returns null when nothing passes the name guardrail", () => {
    assert.equal(selectMatch("chicken breast", [onionFood]), null);
  });
});

describe("isMatchedRef", () => {
  it("true for a matched record, false for miss/null/garbage", () => {
    const matched: NutritionRefMatched = {
      basis: "per100g",
      per100g: { calories: 1, protein: 1, carbs: 1, fat: 1 },
      source: "usda",
      fdcId: 1,
      dataType: "SR Legacy",
      foodCategory: null,
      fetchedAt: "2026-07-06T00:00:00.000Z",
    };
    const miss: NutritionRefMiss = { source: "usda", matched: false, fetchedAt: "x" };
    assert.equal(isMatchedRef(matched), true);
    assert.equal(isMatchedRef(miss), false);
    assert.equal(isMatchedRef(null), false);
    assert.equal(isMatchedRef({ foo: 1 }), false);
  });
});

// ── enrichIngredients (fetch + prisma stubbed) ──────────────────────────

interface UpdateCall {
  where: { id: string };
  data: { nutritionRefPerUnit: unknown };
}

type EnrichPrisma = Pick<PrismaClient, "ingredient">;

function stubPrisma() {
  const updates: UpdateCall[] = [];
  const prisma = {
    ingredient: {
      update: async (args: UpdateCall) => {
        updates.push(args);
        return { id: args.where.id };
      },
    },
  } as unknown as EnrichPrisma;
  return { prisma, updates: () => updates };
}

const realFetch = global.fetch;
const KEY = "USDA_INGREDIENTS_API_KEY";
let savedKey: string | undefined;

function installFetch(fn: (url: string, init?: RequestInit) => Promise<Response>): void {
  global.fetch = fn as typeof fetch;
}
function jsonResponse(body: unknown): Response {
  return {
    status: 200,
    ok: true,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

const FIXED_NOW = () => new Date("2026-07-06T12:00:00.000Z");
const onionFood: FdcFood = {
  fdcId: 42,
  description: "Onions, raw",
  dataType: "SR Legacy",
  foodCategory: "Vegetables and Vegetable Products",
  foodNutrients: [
    { nutrient: { number: "208", unitName: "KCAL" }, amount: 40 },
    { nutrient: { number: "203", unitName: "G" }, amount: 1.1 },
    { nutrient: { number: "204", unitName: "G" }, amount: 0.1 },
    { nutrient: { number: "205", unitName: "G" }, amount: 9.3 },
  ],
};

beforeEach(() => {
  savedKey = process.env[KEY];
  process.env[KEY] = "test-usda-key";
});
afterEach(() => {
  if (savedKey === undefined) delete process.env[KEY];
  else process.env[KEY] = savedKey;
  global.fetch = realFetch;
});

describe("enrichIngredients", () => {
  it("writes a per-100g matched record on a good match", async () => {
    installFetch(async () => jsonResponse({ foods: [onionFood] }));
    const { prisma, updates } = stubPrisma();
    const summary = await enrichIngredients(
      prisma,
      [{ id: "ing-1", canonicalName: "onion" }],
      { now: FIXED_NOW },
    );
    assert.equal(summary.matched, 1);
    assert.equal(updates().length, 1);
    const written = updates()[0].data.nutritionRefPerUnit as NutritionRefMatched;
    assert.deepEqual(written, {
      basis: "per100g",
      per100g: { calories: 40, protein: 1.1, carbs: 9.3, fat: 0.1 },
      source: "usda",
      fdcId: 42,
      dataType: "SR Legacy",
      foodCategory: "Vegetables and Vegetable Products",
      fetchedAt: "2026-07-06T12:00:00.000Z",
    });
  });

  it("writes a miss-marker when search returns but nothing passes the guardrail", async () => {
    installFetch(async () => jsonResponse({ foods: [onionFood] }));
    const { prisma, updates } = stubPrisma();
    const summary = await enrichIngredients(
      prisma,
      [{ id: "ing-2", canonicalName: "chicken breast" }],
      { now: FIXED_NOW },
    );
    assert.equal(summary.missed, 1);
    assert.deepEqual(updates()[0].data.nutritionRefPerUnit, {
      source: "usda",
      matched: false,
      fetchedAt: "2026-07-06T12:00:00.000Z",
    });
  });

  it("writes NOTHING on a transport failure (429) — stays null for retry", async () => {
    installFetch(
      async () =>
        ({
          status: 429,
          ok: false,
          headers: new Headers(),
          json: async () => ({}),
        }) as unknown as Response,
    );
    const { prisma, updates } = stubPrisma();
    const summary = await enrichIngredients(
      prisma,
      [{ id: "ing-3", canonicalName: "onion" }],
      { now: FIXED_NOW },
    );
    assert.equal(summary.failed, 1);
    assert.equal(updates().length, 0);
  });

  it("no-ops silently (skipped) when the USDA key is absent", async () => {
    delete process.env[KEY];
    installFetch(async () => {
      throw new Error("should not fetch when disabled");
    });
    const { prisma, updates } = stubPrisma();
    const summary = await enrichIngredients(prisma, [
      { id: "ing-4", canonicalName: "onion" },
    ]);
    assert.equal(summary.skipped, 1);
    assert.equal(updates().length, 0);
  });

  it("never throws even if prisma.update rejects", async () => {
    installFetch(async () => jsonResponse({ foods: [onionFood] }));
    const prisma = {
      ingredient: {
        update: async () => {
          throw new Error("db down");
        },
      },
    } as unknown as EnrichPrisma;
    // Must resolve, not reject.
    const summary = await enrichIngredients(
      prisma,
      [{ id: "ing-5", canonicalName: "onion" }],
      { now: FIXED_NOW },
    );
    assert.equal(summary.failed, 1);
  });

  it("processes multiple targets under the concurrency cap", async () => {
    installFetch(async () => jsonResponse({ foods: [onionFood] }));
    const { prisma, updates } = stubPrisma();
    const targets = Array.from({ length: 12 }, (_, i) => ({
      id: `ing-${i}`,
      canonicalName: "onion",
    }));
    const summary = await enrichIngredients(prisma, targets, {
      now: FIXED_NOW,
      concurrency: 3,
    });
    assert.equal(summary.matched, 12);
    assert.equal(updates().length, 12);
  });
});

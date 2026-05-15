// WS6 6c-6 Block B — searchIngredientsByPrefix unit tests.
// Stubs PrismaClient.ingredient.findMany to drive in-memory ranking.
// Per Block B constraints, NO count-based assertions — Ingredient table
// row counts vary by environment (91 pre-seed, 121 post-Block-A locally).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import { searchIngredientsByPrefix } from "../ingredientSearch";

interface IngredientRow {
  id: string;
  canonicalName: string;
  displayName: string;
  category: string;
  defaultUnit: string;
  aliases: string[];
}

function makePrisma(rows: IngredientRow[]): PrismaClient {
  return {
    ingredient: {
      findMany: async () => rows,
    },
  } as unknown as PrismaClient;
}

// Representative sample modeled on Block A's HOUSEHOLD_BASIC seed.
const SAMPLE_ROWS: IngredientRow[] = [
  {
    id: "ing-bread",
    canonicalName: "sandwich bread",
    displayName: "Sandwich bread",
    category: "Bakery",
    defaultUnit: "loaf",
    aliases: ["bread", "white bread", "wheat bread"],
  },
  {
    id: "ing-bagels",
    canonicalName: "bagels",
    displayName: "Bagels",
    category: "Bakery",
    defaultUnit: "pack",
    aliases: ["bagel", "plain bagels"],
  },
  {
    id: "ing-blueberries",
    canonicalName: "blueberries",
    displayName: "Blueberries",
    category: "Produce",
    defaultUnit: "container",
    aliases: ["blueberry"],
  },
  {
    id: "ing-pb",
    canonicalName: "peanut butter",
    displayName: "Peanut butter",
    category: "Pantry",
    defaultUnit: "jar",
    aliases: ["pb", "creamy peanut butter"],
  },
  {
    id: "ing-milk",
    canonicalName: "whole milk",
    displayName: "Whole milk",
    category: "Dairy",
    defaultUnit: "gallon",
    aliases: ["milk", "skim milk", "2% milk"],
  },
  {
    id: "ing-ground-turkey",
    canonicalName: "ground turkey",
    displayName: "Ground turkey",
    category: "Protein",
    defaultUnit: "lb",
    aliases: ["turkey"],
  },
];

describe("searchIngredientsByPrefix", () => {
  it("matches by canonicalName prefix (case-insensitive)", async () => {
    const prisma = makePrisma(SAMPLE_ROWS);
    const results = await searchIngredientsByPrefix(prisma, "san");
    const names = results.map((r) => r.canonicalName);
    assert.ok(
      names.includes("sandwich bread"),
      "sandwich bread should match needle 'san'",
    );
  });

  it("matches case-insensitively (needle upper-case, canonical lower-case)", async () => {
    const prisma = makePrisma(SAMPLE_ROWS);
    const results = await searchIngredientsByPrefix(prisma, "BLUE");
    const names = results.map((r) => r.canonicalName);
    assert.ok(names.includes("blueberries"));
  });

  it("matches by alias (needle 'pb' resolves to peanut butter)", async () => {
    const prisma = makePrisma(SAMPLE_ROWS);
    const results = await searchIngredientsByPrefix(prisma, "pb");
    const names = results.map((r) => r.canonicalName);
    assert.ok(
      names.includes("peanut butter"),
      "alias 'pb' should resolve to peanut butter",
    );
  });

  it("returns the exact canonical match (needle 'blueberries' returns blueberries row)", async () => {
    const prisma = makePrisma(SAMPLE_ROWS);
    const results = await searchIngredientsByPrefix(prisma, "blueberries");
    const names = results.map((r) => r.canonicalName);
    assert.ok(names.includes("blueberries"));
  });

  it("ranks exact canonical match above prefix/alias matches", async () => {
    // 'bagels' is both an exact match and could be alias-matched elsewhere.
    // 'bagel' alias is on 'bagels' row itself, so this primarily tests that
    // exact 'milk' (alias of whole milk, rank 2) beats nothing on canonical.
    // To meaningfully test ranking, add a row where the needle is exact for
    // one row but a prefix for another.
    const rows: IngredientRow[] = [
      {
        id: "ing-milk-exact",
        canonicalName: "milk",
        displayName: "Milk",
        category: "Dairy",
        defaultUnit: "gallon",
        aliases: [],
      },
      ...SAMPLE_ROWS, // 'whole milk' has alias 'milk' → rank 2
    ];
    const prisma = makePrisma(rows);
    const results = await searchIngredientsByPrefix(prisma, "milk");
    assert.equal(
      results[0].canonicalName,
      "milk",
      "exact canonical match should rank first",
    );
  });

  it("returns empty array for empty needle", async () => {
    const prisma = makePrisma(SAMPLE_ROWS);
    const results = await searchIngredientsByPrefix(prisma, "");
    assert.deepEqual(results, []);
  });

  it("returns empty array for whitespace-only needle", async () => {
    const prisma = makePrisma(SAMPLE_ROWS);
    const results = await searchIngredientsByPrefix(prisma, "   ");
    assert.deepEqual(results, []);
  });

  it("respects the limit parameter (default 5)", async () => {
    // Build a row set where every row matches a single-char needle so the
    // unbounded match count would exceed 5.
    const manyRows: IngredientRow[] = Array.from({ length: 12 }, (_, i) => ({
      id: `ing-${i}`,
      canonicalName: `apple-${i}`,
      displayName: `Apple ${i}`,
      category: "Produce",
      defaultUnit: "each",
      aliases: [],
    }));
    const prisma = makePrisma(manyRows);
    const defaultResults = await searchIngredientsByPrefix(prisma, "apple");
    assert.ok(
      defaultResults.length <= 5,
      `default limit should cap at 5 (got ${defaultResults.length})`,
    );
    const customResults = await searchIngredientsByPrefix(prisma, "apple", 3);
    assert.ok(
      customResults.length <= 3,
      `custom limit should cap at 3 (got ${customResults.length})`,
    );
  });

  it("returns rows with all expected fields populated", async () => {
    const prisma = makePrisma(SAMPLE_ROWS);
    const results = await searchIngredientsByPrefix(prisma, "peanut");
    const pb = results.find((r) => r.canonicalName === "peanut butter");
    assert.ok(pb, "expected peanut butter row");
    assert.equal(pb.ingredientId, "ing-pb");
    assert.equal(pb.displayName, "Peanut butter");
    assert.equal(pb.category, "Pantry");
    assert.equal(pb.defaultUnit, "jar");
  });

  it("trims leading/trailing whitespace in the needle before matching", async () => {
    const prisma = makePrisma(SAMPLE_ROWS);
    const results = await searchIngredientsByPrefix(prisma, "  milk  ");
    const names = results.map((r) => r.canonicalName);
    // 'milk' alias is on 'whole milk' row → rank 2 match expected.
    assert.ok(
      names.includes("whole milk"),
      "trimmed 'milk' should alias-match whole milk",
    );
  });
});

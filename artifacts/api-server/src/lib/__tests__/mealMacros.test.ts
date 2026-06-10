// WS7-6 Fix-Block 3 — Meal-level macro aggregation helper tests.
//
// Pins Hans's formula (sum of per-serving values across linked dishes;
// dish serving counts do NOT enter) at the helper boundary so any future
// "let me weight by servings" refactor fails loudly here before touching
// the four write paths.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateMealMacrosFromDishes,
  recomputeAndPersistMealMacros,
} from "../mealMacros";

describe("aggregateMealMacrosFromDishes", () => {
  it("sums per-serving macros across dishes — Hans's 50/100/200 → 350 example", () => {
    // Lettuce 50 cal/srv + chicken 100 cal/srv + potatoes 200 cal/srv →
    // meal = 350 cal/srv. Dish serving counts (3, 5, 12 in Hans's worked
    // example) are intentionally NOT inputs — one meal serving = one
    // serving of each dish on the plate.
    const result = aggregateMealMacrosFromDishes([
      {
        caloriesPerServing: 50,
        proteinGPerServing: 2,
        carbsGPerServing: 8,
        fatGPerServing: 0.3,
      },
      {
        caloriesPerServing: 100,
        proteinGPerServing: 25,
        carbsGPerServing: 0,
        fatGPerServing: 3,
      },
      {
        caloriesPerServing: 200,
        proteinGPerServing: 4,
        carbsGPerServing: 40,
        fatGPerServing: 0.5,
      },
    ]);

    assert.equal(result.caloriesPerServing, 350);
    assert.equal(result.proteinGPerServing, 31);
    assert.equal(result.carbsGPerServing, 48);
    // 0.3 + 3 + 0.5 → 3.8 (float arithmetic; allow tiny epsilon).
    assert.ok(Math.abs(result.fatGPerServing - 3.8) < 1e-9);
  });

  it("treats a dish with zero macros as contributing zero (honest sum)", () => {
    // The Block-3 honesty constraint: when a dish has *PerServing = 0
    // (data gap — Dish macro estimation is a separate concern), the meal
    // sum includes 0 for that dish. NOT a bug; NOT a reason to bail out
    // or fabricate.
    const result = aggregateMealMacrosFromDishes([
      {
        caloriesPerServing: 400,
        proteinGPerServing: 30,
        carbsGPerServing: 35,
        fatGPerServing: 12,
      },
      {
        caloriesPerServing: 0,
        proteinGPerServing: 0,
        carbsGPerServing: 0,
        fatGPerServing: 0,
      },
    ]);
    assert.equal(result.caloriesPerServing, 400);
    assert.equal(result.proteinGPerServing, 30);
    assert.equal(result.carbsGPerServing, 35);
    assert.equal(result.fatGPerServing, 12);
  });

  it("single-dish meal: meal macros equal the dish macros (passthrough)", () => {
    const result = aggregateMealMacrosFromDishes([
      {
        caloriesPerServing: 520,
        proteinGPerServing: 28,
        carbsGPerServing: 38,
        fatGPerServing: 26,
      },
    ]);
    assert.equal(result.caloriesPerServing, 520);
    assert.equal(result.proteinGPerServing, 28);
    assert.equal(result.carbsGPerServing, 38);
    assert.equal(result.fatGPerServing, 26);
  });

  it("empty dish list → all-zero result (defensive default for in-progress edits)", () => {
    const result = aggregateMealMacrosFromDishes([]);
    assert.equal(result.caloriesPerServing, 0);
    assert.equal(result.proteinGPerServing, 0);
    assert.equal(result.carbsGPerServing, 0);
    assert.equal(result.fatGPerServing, 0);
  });
});

describe("recomputeAndPersistMealMacros", () => {
  it("reads the meal's linked dishes, sums per-serving macros, writes them to the Meal row", async () => {
    const mealUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
    const linkRows = [
      {
        dish: {
          caloriesPerServing: 50,
          proteinGPerServing: 2,
          carbsGPerServing: 8,
          fatGPerServing: 0.3,
        },
      },
      {
        dish: {
          caloriesPerServing: 100,
          proteinGPerServing: 25,
          carbsGPerServing: 0,
          fatGPerServing: 3,
        },
      },
      {
        dish: {
          caloriesPerServing: 200,
          proteinGPerServing: 4,
          carbsGPerServing: 40,
          fatGPerServing: 0.5,
        },
      },
    ];

    let findManyCallCount = 0;
    const stub = {
      mealDishLink: {
        findMany: async (args: { where: { mealId: string } }) => {
          findManyCallCount++;
          assert.equal(args.where.mealId, "meal-target");
          return linkRows;
        },
      },
      meal: {
        update: async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          mealUpdates.push({ id: args.where.id, data: args.data });
          return { id: args.where.id, ...args.data };
        },
      },
    };

    const result = await recomputeAndPersistMealMacros(
      stub as unknown as Parameters<typeof recomputeAndPersistMealMacros>[0],
      "meal-target",
    );

    assert.equal(findManyCallCount, 1);
    assert.equal(mealUpdates.length, 1);
    assert.equal(mealUpdates[0].id, "meal-target");
    assert.equal(mealUpdates[0].data.caloriesPerServing, 350);
    assert.equal(result.caloriesPerServing, 350);
    assert.equal(result.proteinGPerServing, 31);
    assert.equal(result.carbsGPerServing, 48);
    assert.ok(Math.abs((result.fatGPerServing as number) - 3.8) < 1e-9);
  });

  it("a meal with all-zero dish macros writes an all-zero sum (honest backfill behavior)", async () => {
    const mealUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
    const stub = {
      mealDishLink: {
        findMany: async () => [
          {
            dish: {
              caloriesPerServing: 0,
              proteinGPerServing: 0,
              carbsGPerServing: 0,
              fatGPerServing: 0,
            },
          },
          {
            dish: {
              caloriesPerServing: 0,
              proteinGPerServing: 0,
              carbsGPerServing: 0,
              fatGPerServing: 0,
            },
          },
        ],
      },
      meal: {
        update: async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          mealUpdates.push({ id: args.where.id, data: args.data });
          return { id: args.where.id, ...args.data };
        },
      },
    };

    const result = await recomputeAndPersistMealMacros(
      stub as unknown as Parameters<typeof recomputeAndPersistMealMacros>[0],
      "meal-zero",
    );

    assert.equal(mealUpdates[0].data.caloriesPerServing, 0);
    assert.equal(result.caloriesPerServing, 0);
  });
});

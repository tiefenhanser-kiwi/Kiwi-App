// WS7-4-D c4 — Unit tests for createMealWithDishes.
// In-memory stub tx that records writes; verifies helper plumbing without
// standing up a DB.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createMealWithDishes,
  IngredientResolutionError,
  type RecipeOverrideForCreate,
} from "../mealCreate";

interface CreateMealRecorder {
  mealCreates: Array<{ data: Record<string, unknown> }>;
  dishCreates: Array<{ data: Record<string, unknown> }>;
  mealDishLinkCreates: Array<{ data: Record<string, unknown> }>;
  dishIngredientCreates: Array<{ data: Record<string, unknown> }>;
  stepCreates: Array<{ data: Record<string, unknown> }>;
}

function makeTx(opts: {
  sourceMealExists?: boolean;
  ingredients: Array<{ id: string; canonicalName: string }>;
  recorder: CreateMealRecorder;
  /** Throw on first dish.create — exercises mid-tx rollback. */
  throwOnFirstDishCreate?: boolean;
}) {
  const recorder = opts.recorder;
  let mealCounter = 0;
  let dishCounter = 0;
  let dishCreateCalls = 0;

  return {
    meal: {
      findUnique: async () =>
        opts.sourceMealExists !== false
          ? {
              title: "Source Meal",
              description: "src desc",
              cuisineType: "Italian",
              mealType: "dinner",
              imageUrl: null,
              servingsDefault: 4,
              estimatedTimeMinutes: 45,
              difficulty: "medium",
              tags: ["a"],
            }
          : null,
      create: async (args: { data: Record<string, unknown> }) => {
        recorder.mealCreates.push(args);
        mealCounter += 1;
        return { id: `new-meal-${mealCounter}` };
      },
    },
    mealDishLink: {
      findFirst: async () => ({
        dish: {
          estimatedTimeMinutes: 22,
          difficulty: "easy",
          servingsDefault: 4,
        },
      }),
      create: async (args: { data: Record<string, unknown> }) => {
        recorder.mealDishLinkCreates.push(args);
        return { id: "mdl-1" };
      },
    },
    dish: {
      create: async (args: { data: Record<string, unknown> }) => {
        dishCreateCalls += 1;
        if (opts.throwOnFirstDishCreate && dishCreateCalls === 1) {
          throw new Error("dish-create-failed");
        }
        recorder.dishCreates.push(args);
        dishCounter += 1;
        return { id: `new-dish-${dishCounter}` };
      },
    },
    ingredient: {
      findFirst: async (args: {
        where: { canonicalName: { equals: string; mode: string } };
      }) => {
        const target = args.where.canonicalName.equals;
        const hit = opts.ingredients.find(
          (i) => i.canonicalName === target,
        );
        return hit ? { id: hit.id } : null;
      },
    },
    dishIngredient: {
      create: async (args: { data: Record<string, unknown> }) => {
        recorder.dishIngredientCreates.push(args);
        return { id: "di-1" };
      },
    },
    recipeInstructionStep: {
      create: async (args: { data: Record<string, unknown> }) => {
        recorder.stepCreates.push(args);
        return { id: "step-1" };
      },
    },
  };
}

function emptyRecorder(): CreateMealRecorder {
  return {
    mealCreates: [],
    dishCreates: [],
    mealDishLinkCreates: [],
    dishIngredientCreates: [],
    stepCreates: [],
  };
}

const OVERRIDE_HAPPY: RecipeOverrideForCreate = {
  titleOverride: "Tweaked Pasta",
  dishes: [
    {
      name: "Tweaked Sauce",
      ingredients: [
        { name: "Salt", quantity: 1, unit: "tsp" },
        { name: "tomato", quantity: 200, unit: "g" },
      ],
    },
  ],
  steps: ["Boil water", "Add salt"],
  createdAt: "2026-05-26T00:00:00Z",
};

describe("createMealWithDishes (WS7-4-D c4 helper)", () => {
  it("happy: creates Meal + Dish + MealDishLink + DishIngredient + Step rows", async () => {
    const recorder = emptyRecorder();
    const tx = makeTx({
      recorder,
      ingredients: [
        { id: "ing-salt", canonicalName: "salt" },
        { id: "ing-tomato", canonicalName: "tomato" },
      ],
    });
    const result = await createMealWithDishes(tx as never, {
      userId: "u-1",
      sourceMealId: "src",
      override: OVERRIDE_HAPPY,
    });

    assert.equal(result.mealId, "new-meal-1");
    assert.equal(recorder.mealCreates.length, 1);
    assert.equal(recorder.mealCreates[0].data.title, "Tweaked Pasta");
    assert.equal(recorder.mealCreates[0].data.userId, "u-1");
    assert.equal(recorder.mealCreates[0].data.sourceType, "manual");
    assert.equal(recorder.mealCreates[0].data.isPublic, false);

    assert.equal(recorder.dishCreates.length, 1);
    assert.equal(recorder.dishCreates[0].data.title, "Tweaked Sauce");

    assert.equal(recorder.mealDishLinkCreates.length, 1);
    assert.equal(recorder.mealDishLinkCreates[0].data.mealId, "new-meal-1");
    assert.equal(recorder.mealDishLinkCreates[0].data.dishId, "new-dish-1");
    assert.equal(recorder.mealDishLinkCreates[0].data.positionIndex, 0);

    assert.equal(recorder.dishIngredientCreates.length, 2);
    assert.equal(recorder.dishIngredientCreates[0].data.ingredientId, "ing-salt");
    assert.equal(recorder.dishIngredientCreates[1].data.ingredientId, "ing-tomato");
    assert.equal(recorder.dishIngredientCreates[0].data.quantity, 1);
    assert.equal(recorder.dishIngredientCreates[0].data.unit, "tsp");

    // Q-P1-3: stepTextTranslated == stepTextRaw
    assert.equal(recorder.stepCreates.length, 2);
    assert.equal(recorder.stepCreates[0].data.stepTextRaw, "Boil water");
    assert.equal(recorder.stepCreates[0].data.stepTextTranslated, "Boil water");
    assert.equal(recorder.stepCreates[0].data.ownerType, "dish");
    assert.equal(recorder.stepCreates[0].data.ownerId, "new-dish-1");
    assert.equal(recorder.stepCreates[0].data.stepIndex, 0);
    assert.equal(recorder.stepCreates[1].data.stepIndex, 1);
  });

  it("override without steps creates zero RecipeInstructionStep rows", async () => {
    const recorder = emptyRecorder();
    const tx = makeTx({
      recorder,
      ingredients: [{ id: "ing-salt", canonicalName: "salt" }],
    });
    await createMealWithDishes(tx as never, {
      userId: "u-1",
      sourceMealId: "src",
      override: {
        dishes: [
          {
            name: "Stepless Dish",
            ingredients: [{ name: "Salt", quantity: 1, unit: "tsp" }],
          },
        ],
        createdAt: "2026-05-26T00:00:00Z",
      },
    });
    assert.equal(recorder.stepCreates.length, 0);
  });

  it("ingredient name unresolved throws IngredientResolutionError carrying the unresolved name", async () => {
    const recorder = emptyRecorder();
    const tx = makeTx({
      recorder,
      ingredients: [{ id: "ing-salt", canonicalName: "salt" }],
    });
    await assert.rejects(
      createMealWithDishes(tx as never, {
        userId: "u-1",
        sourceMealId: "src",
        override: {
          dishes: [
            {
              name: "D1",
              ingredients: [
                { name: "Salt", quantity: 1, unit: "tsp" },
                { name: "Mystery Spice", quantity: 1, unit: "tsp" },
              ],
            },
          ],
          createdAt: "2026-05-26T00:00:00Z",
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof IngredientResolutionError);
        assert.equal(err.ingredientName, "Mystery Spice");
        return true;
      },
    );
  });
});

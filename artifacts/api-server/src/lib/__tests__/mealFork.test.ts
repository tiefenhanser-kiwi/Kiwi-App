// WS7-7-A B5 fix2 (D-WS7-139) — forkMealForUser deep-clone unit tests.
//
// Verifies a faithful, independent clone: the new meal is user-owned and
// private; dishes, ingredients (ingredientId refs preserved), dish-owned and
// meal-owned steps are all copied; and the SOURCE graph is never mutated
// (read-only) — so other plans referencing the source keep their binding.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { forkMealForUser } from "../mealFork";

// A minimal source-meal graph: 2 dishes, one with 2 ingredients + dish-owned
// steps, plus meal-owned steps (the curated/seed shape).
function makeSource() {
  return {
    id: "src-meal",
    userId: null, // curated / null-owner (the r-pasta shape)
    title: "Creamy Mushroom Pasta",
    description: "Comfort",
    mealType: "dinner",
    sourceType: "curated",
    cuisineType: "Italian",
    difficulty: "easy",
    estimatedTimeMinutes: 30,
    imageUrl: null,
    servingsDefault: 4,
    tags: ["vegetarian"],
    caloriesPerServing: 620,
    proteinGPerServing: 18,
    carbsGPerServing: 78,
    fatGPerServing: 26,
    dishLinks: [
      {
        positionIndex: 0,
        roleLabel: "main",
        dish: {
          id: "src-dish-0",
          userId: null,
          title: "Pasta",
          description: null,
          sourceType: "curated",
          estimatedTimeMinutes: 30,
          difficulty: "easy",
          imageUrl: null,
          servingsDefault: 4,
          tags: [],
          caloriesPerServing: 0,
          proteinGPerServing: 0,
          carbsGPerServing: 0,
          fatGPerServing: 0,
          dishIngredients: [
            {
              ingredientId: "ing-pappardelle",
              quantity: 1,
              unit: "lb",
              preparationNote: null,
              isOptional: false,
              positionIndex: 0,
            },
            {
              ingredientId: "ing-cream",
              quantity: 1,
              unit: "cup",
              preparationNote: "warmed",
              isOptional: false,
              positionIndex: 1,
            },
          ],
        },
      },
      {
        positionIndex: 1,
        roleLabel: "side",
        dish: {
          id: "src-dish-1",
          userId: null,
          title: "Side Salad",
          description: null,
          sourceType: "curated",
          estimatedTimeMinutes: 10,
          difficulty: "easy",
          imageUrl: null,
          servingsDefault: 4,
          tags: [],
          caloriesPerServing: 0,
          proteinGPerServing: 0,
          carbsGPerServing: 0,
          fatGPerServing: 0,
          dishIngredients: [],
        },
      },
    ],
  };
}

// Records every write; serves source reads. Mutating writes on the source
// (update/delete) are absent by construction — the test asserts none occur by
// only exposing create/createMany/findMany/findUnique.
function makeTxStub(source: ReturnType<typeof makeSource>) {
  const rec = {
    mealCreates: [] as Record<string, unknown>[],
    dishCreates: [] as Record<string, unknown>[],
    linkCreates: [] as Record<string, unknown>[],
    ingredientCreateMany: [] as Record<string, unknown>[][],
    stepCreateMany: [] as Record<string, unknown>[][],
    stepFindManyWhere: [] as { ownerType: string; ownerId: string }[],
  };
  // Dish-owned steps for src-dish-0; meal-owned steps for src-meal.
  const steps = [
    { ownerType: "dish", ownerId: "src-dish-0", stepIndex: 0, stepTextRaw: "Boil", stepTextTranslated: "Boil", estimatedMinutes: 5, phaseType: "cook", parallelGroup: null, requiresPreheat: false, requiresRest: false, requiresMarination: false, isTimingSensitive: false },
    { ownerType: "meal", ownerId: "src-meal", stepIndex: 0, stepTextRaw: "Plate", stepTextTranslated: "Plate", estimatedMinutes: 1, phaseType: "cook", parallelGroup: null, requiresPreheat: false, requiresRest: false, requiresMarination: false, isTimingSensitive: false },
  ];
  let dishCounter = 0;
  const tx = {
    meal: {
      findUnique: async () => source,
      create: async (args: { data: Record<string, unknown> }) => {
        rec.mealCreates.push(args.data);
        return { id: "new-meal" };
      },
    },
    dish: {
      create: async (args: { data: Record<string, unknown> }) => {
        rec.dishCreates.push(args.data);
        dishCounter += 1;
        return { id: `new-dish-${dishCounter}` };
      },
    },
    mealDishLink: {
      create: async (args: { data: Record<string, unknown> }) => {
        rec.linkCreates.push(args.data);
        return { id: "link" };
      },
    },
    dishIngredient: {
      createMany: async (args: { data: Record<string, unknown>[] }) => {
        rec.ingredientCreateMany.push(args.data);
        return { count: args.data.length };
      },
    },
    recipeInstructionStep: {
      findMany: async (args: {
        where: { ownerType: string; ownerId: string };
      }) => {
        rec.stepFindManyWhere.push(args.where);
        return steps.filter(
          (s) =>
            s.ownerType === args.where.ownerType &&
            s.ownerId === args.where.ownerId,
        );
      },
      createMany: async (args: { data: Record<string, unknown>[] }) => {
        rec.stepCreateMany.push(args.data);
        return { count: args.data.length };
      },
    },
  };
  return { tx, rec };
}

describe("forkMealForUser", () => {
  it("clones into a user-owned, private copy with dishes, ingredients, and steps", async () => {
    const source = makeSource();
    const { tx, rec } = makeTxStub(source);

    const { mealId } = await forkMealForUser(tx as never, "src-meal", "user-1");
    assert.equal(mealId, "new-meal");

    // Meal row: owned by the requester, private, scalars + macros copied.
    assert.equal(rec.mealCreates.length, 1);
    const meal = rec.mealCreates[0];
    assert.equal(meal.userId, "user-1");
    assert.equal(meal.isPublic, false);
    assert.equal(meal.title, "Creamy Mushroom Pasta");
    assert.equal(meal.cuisineType, "Italian");
    assert.equal(meal.caloriesPerServing, 620);

    // Both dishes cloned, user-owned, linked at the same position + role.
    assert.equal(rec.dishCreates.length, 2);
    assert.equal(rec.dishCreates[0].userId, "user-1");
    assert.equal(rec.dishCreates[0].title, "Pasta");
    assert.equal(rec.linkCreates.length, 2);
    assert.deepEqual(
      rec.linkCreates.map((l) => l.positionIndex),
      [0, 1],
    );
    assert.equal(rec.linkCreates[0].roleLabel, "main");
    assert.equal(rec.linkCreates[1].roleLabel, "side");

    // Ingredients: ingredientId refs + prep/qty/unit preserved (dish 0 only).
    assert.equal(rec.ingredientCreateMany.length, 1);
    const ings = rec.ingredientCreateMany[0];
    assert.equal(ings.length, 2);
    assert.equal(ings[0].ingredientId, "ing-pappardelle");
    assert.equal(ings[1].ingredientId, "ing-cream");
    assert.equal(ings[1].preparationNote, "warmed");

    // Steps: dish-owned step re-owned to the new dish; meal-owned step re-owned
    // to the new meal. Two createMany batches (one dish, one meal).
    const stepBatches = rec.stepCreateMany;
    const dishStepBatch = stepBatches.find(
      (b) => b[0]?.ownerType === "dish",
    );
    const mealStepBatch = stepBatches.find(
      (b) => b[0]?.ownerType === "meal",
    );
    assert.ok(dishStepBatch, "dish-owned steps copied");
    assert.equal(dishStepBatch![0].ownerId, "new-dish-1");
    assert.equal(dishStepBatch![0].stepTextRaw, "Boil");
    assert.ok(mealStepBatch, "meal-owned steps copied");
    assert.equal(mealStepBatch![0].ownerId, "new-meal");
    assert.equal(mealStepBatch![0].stepTextRaw, "Plate");
  });

  it("never mutates the source meal (other plans keep their binding)", async () => {
    const source = makeSource();
    const before = JSON.stringify(source);
    const { tx } = makeTxStub(source);
    // The stub exposes no update/delete on meal/dish — a fork that tried to
    // mutate the source would throw on the missing method. It completing
    // proves the fork is read-only on the source.
    await forkMealForUser(tx as never, "src-meal", "user-1");
    assert.equal(JSON.stringify(source), before, "source graph unchanged");
  });

  it("throws when the source meal is missing", async () => {
    const tx = { meal: { findUnique: async () => null } };
    await assert.rejects(
      () => forkMealForUser(tx as never, "ghost", "user-1"),
      /Source meal not found/,
    );
  });
});

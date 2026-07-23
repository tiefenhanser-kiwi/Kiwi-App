// WS7-7-A B5 fix2 (D-WS7-139) — forkMealForUser deep-clone unit tests.
//
// Verifies a faithful, independent clone: the new meal is user-owned and
// private; dishes, ingredients (ingredientId refs preserved), dish-owned and
// meal-owned steps are all copied; and the SOURCE graph is never mutated
// (read-only) — so other plans referencing the source keep their binding.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Prisma } from "@prisma/client";

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
              // D-WS9-066 — BASE ingredient (present regardless of any swap).
              componentKey: null,
              pathKey: null,
            },
            {
              ingredientId: "ing-cream",
              quantity: 1,
              unit: "cup",
              preparationNote: "warmed",
              isOptional: false,
              positionIndex: 1,
              // D-WS9-066 — scratch ingredient the jarred-alfredo product replaces.
              componentKey: "sauce",
              pathKey: "scratch",
            },
          ],
          // D-WS9-064 — a dish carrying a store-bought substitution (as a Prisma
          // Json read: the parsed array). The fork MUST copy this intact.
          substitutions: [
            {
              product: "jarred alfredo sauce",
              quantity: 1,
              unit: "jar",
              replaces: ["heavy cream", "parmesan", "butter"],
            },
          ],
          // D-WS9-066 — the swappable-component registry (label/order metadata).
          componentRegistry: [{ key: "sauce", label: "Sauce", order: 0 }],
          // D-WS7-215 — a saved per-user selection ("bought forever"). The fork
          // must carry it verbatim so the user's choice survives acquire.
          componentSelections: { sauce: "bought" },
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
          // D-WS9-064 — a dish with no substitutions reads back as null; the
          // fork must pass that through as a DB NULL, not crash.
          substitutions: null,
          // D-WS9-066 / D-WS7-215 — a plain dish carries no component metadata;
          // both read back null and must fork through as DB NULL (the Json?
          // DbNull rule), not a stray literal null.
          componentRegistry: null,
          componentSelections: null,
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
  // D-WS9-066 — the dish carries a BASE step (boil, untagged) plus a two-path
  // "sauce" component: a scratch step (make the sauce) and a bought step (use
  // the jar). All three must fork with their tags intact.
  const steps = [
    { ownerType: "dish", ownerId: "src-dish-0", stepIndex: 0, stepTextRaw: "Boil", stepTextTranslated: "Boil", estimatedMinutes: 5, phaseType: "cook", parallelGroup: null, requiresPreheat: false, requiresRest: false, requiresMarination: false, isTimingSensitive: false, componentKey: null, pathKey: null },
    { ownerType: "dish", ownerId: "src-dish-0", stepIndex: 1, stepTextRaw: "Simmer cream and parmesan into a sauce", stepTextTranslated: "Simmer cream and parmesan into a sauce", estimatedMinutes: 12, phaseType: "cook", parallelGroup: null, requiresPreheat: false, requiresRest: false, requiresMarination: false, isTimingSensitive: false, componentKey: "sauce", pathKey: "scratch" },
    { ownerType: "dish", ownerId: "src-dish-0", stepIndex: 2, stepTextRaw: "Warm the jarred alfredo sauce", stepTextTranslated: "Warm the jarred alfredo sauce", estimatedMinutes: 3, phaseType: "cook", parallelGroup: null, requiresPreheat: false, requiresRest: false, requiresMarination: false, isTimingSensitive: false, componentKey: "sauce", pathKey: "bought" },
    { ownerType: "meal", ownerId: "src-meal", stepIndex: 0, stepTextRaw: "Plate", stepTextTranslated: "Plate", estimatedMinutes: 1, phaseType: "cook", parallelGroup: null, requiresPreheat: false, requiresRest: false, requiresMarination: false, isTimingSensitive: false, componentKey: null, pathKey: null },
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

  it("D-WS9-064: substitutions survive the fork intact (present + null)", async () => {
    const source = makeSource();
    const { tx, rec } = makeTxStub(source);

    await forkMealForUser(tx as never, "src-meal", "user-1");

    // Dish 0 carried a substitution — the clone must copy it verbatim:
    // product, quantity, unit, and the FULL replaces[] array.
    const dish0 = rec.dishCreates[0];
    assert.deepEqual(dish0.substitutions, [
      {
        product: "jarred alfredo sauce",
        quantity: 1,
        unit: "jar",
        replaces: ["heavy cream", "parmesan", "butter"],
      },
    ]);

    // Dish 1 had no substitutions (null) — the clone passes DB NULL, not a crash
    // or a stray literal null (which Prisma rejects on a Json? column).
    const dish1 = rec.dishCreates[1];
    assert.equal(dish1.substitutions, Prisma.DbNull);
  });

  it("D-WS9-066/D-WS7-215: swappable-component tags, registry, and selection survive the fork (present + null)", async () => {
    const source = makeSource();
    const { tx, rec } = makeTxStub(source);

    await forkMealForUser(tx as never, "src-meal", "user-1");

    // --- Component registry + per-user selection (present on dish 0) ---
    const dish0 = rec.dishCreates[0];
    assert.deepEqual(dish0.componentRegistry, [
      { key: "sauce", label: "Sauce", order: 0 },
    ]);
    assert.deepEqual(dish0.componentSelections, { sauce: "bought" });

    // --- Both null on dish 1 → DB NULL, not a literal null or a crash ---
    const dish1 = rec.dishCreates[1];
    assert.equal(dish1.componentRegistry, Prisma.DbNull);
    assert.equal(dish1.componentSelections, Prisma.DbNull);

    // --- Ingredient tags: base ingredient stays null; scratch ingredient keeps
    //     its (componentKey, pathKey) through the fork ---
    const ings = rec.ingredientCreateMany[0];
    assert.equal(ings[0].componentKey, null); // pappardelle = base
    assert.equal(ings[0].pathKey, null);
    assert.equal(ings[1].componentKey, "sauce"); // cream = scratch sauce
    assert.equal(ings[1].pathKey, "scratch");

    // --- Step tags: base, scratch, and bought all survive with tags intact ---
    const dishStepBatch = rec.stepCreateMany.find(
      (b) => b[0]?.ownerType === "dish",
    );
    assert.ok(dishStepBatch, "dish-owned steps copied");
    assert.equal(dishStepBatch!.length, 3);
    const byText = (t: string) =>
      dishStepBatch!.find((s) => s.stepTextRaw === t)!;
    // base
    assert.equal(byText("Boil").componentKey, null);
    assert.equal(byText("Boil").pathKey, null);
    // scratch path
    const scratch = byText("Simmer cream and parmesan into a sauce");
    assert.equal(scratch.componentKey, "sauce");
    assert.equal(scratch.pathKey, "scratch");
    // bought path
    const bought = byText("Warm the jarred alfredo sauce");
    assert.equal(bought.componentKey, "sauce");
    assert.equal(bought.pathKey, "bought");
    // all re-owned to the new dish
    for (const s of dishStepBatch!) {
      assert.equal(s.ownerId, "new-dish-1");
      assert.equal(s.ownerType, "dish");
    }
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

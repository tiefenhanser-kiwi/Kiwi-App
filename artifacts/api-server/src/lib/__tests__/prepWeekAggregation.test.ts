// WS6 6d-2 — loadPrepWeekInput loader unit tests.
// Mocked Prisma (ad-hoc stub keyed by planId). No DB.
// Mirrors the cookingSequence.test.ts / planMacros.test.ts harness style.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import {
  loadPrepWeekInput,
  PrepWeekEmptyPlanError,
  PrepWeekNotFoundError,
} from "../prepWeekAggregation";

const USER_ID = "user-prep-week-test";
const OTHER_USER_ID = "user-prep-week-other";

interface IngredientFixture {
  id: string;
  displayName: string;
  canonicalName?: string;
  category?: string;
}

interface DishIngredientFixture {
  quantity: number;
  unit: string;
  preparationNote: string | null;
  ingredient: IngredientFixture;
  positionIndex: number;
}

interface DishFixture {
  id: string;
  title: string;
  servingsDefault: number;
  // WS7-8 BUG-003 — immutable authored anchor; null = legacy/seed row.
  authoredServingsDefault: number | null;
  dishIngredients: DishIngredientFixture[];
}

interface DishLinkFixture {
  dishId: string;
  positionIndex: number;
  dish: DishFixture;
}

interface MealFixture {
  id: string;
  title: string;
  cuisineType: string | null;
  servingsDefault: number;
  dishLinks: DishLinkFixture[];
}

interface ItemFixture {
  id: string;
  mealId: string;
  positionIndex: number;
  servingsOverride: number | null;
  meal: MealFixture;
}

interface PlanFixture {
  id: string;
  userId: string;
  revisionId: number;
  titleOverride: string | null;
  items: ItemFixture[];
}

interface StepFixture {
  ownerType: "dish" | "meal";
  ownerId: string;
  stepIndex: number;
  stepTextRaw: string;
}

function makePrismaStub(
  plans: PlanFixture[],
  steps: StepFixture[] = [],
): PrismaClient {
  return {
    mealPlanInstance: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const p = plans.find((pp) => pp.id === where.id);
        return p ?? null;
      },
    },
    recipeInstructionStep: {
      findMany: async ({
        where,
      }: {
        where: { ownerType: string; ownerId: { in: string[] } };
      }) =>
        steps
          .filter(
            (s) =>
              s.ownerType === where.ownerType &&
              where.ownerId.in.includes(s.ownerId),
          )
          .sort((a, b) => a.stepIndex - b.stepIndex)
          .map((s) => ({ ownerId: s.ownerId, stepTextRaw: s.stepTextRaw })),
    },
  } as unknown as PrismaClient;
}

const PLAN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEAL_A = "11111111-1111-4111-8111-111111111111";
const MEAL_B = "22222222-2222-4222-8222-222222222222";
const DISH_A1 = "33333333-3333-4333-8333-333333333333";
const DISH_B1 = "44444444-4444-4444-8444-444444444444";
const ING_ONION = "55555555-5555-4555-8555-555555555555";
const ING_GARLIC = "66666666-6666-4666-8666-666666666666";

function plan(opts?: Partial<PlanFixture>): PlanFixture {
  return {
    id: PLAN_ID,
    userId: USER_ID,
    revisionId: 1,
    titleOverride: "Test Week",
    items: [
      {
        id: "item-a",
        mealId: MEAL_A,
        positionIndex: 0,
        servingsOverride: null,
        meal: {
          id: MEAL_A,
          title: "Tacos",
          cuisineType: "Mexican",
          servingsDefault: 4,
          dishLinks: [
            {
              dishId: DISH_A1,
              positionIndex: 0,
              dish: {
                id: DISH_A1,
                title: "Beef tacos",
                servingsDefault: 4,
                // Legacy/seed row — no anchor; loader carries null through.
                authoredServingsDefault: null,
                dishIngredients: [
                  {
                    quantity: 2,
                    unit: "medium",
                    preparationNote: "diced",
                    positionIndex: 0,
                    ingredient: {
                      id: ING_ONION,
                      displayName: "yellow onion",
                      category: "Produce",
                    },
                  },
                  {
                    quantity: 3,
                    unit: "cloves",
                    preparationNote: "minced",
                    positionIndex: 1,
                    ingredient: {
                      id: ING_GARLIC,
                      displayName: "garlic",
                      category: "Produce",
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      {
        id: "item-b",
        mealId: MEAL_B,
        positionIndex: 1,
        servingsOverride: 6,
        meal: {
          id: MEAL_B,
          title: "Stir Fry",
          cuisineType: null,
          servingsDefault: 4,
          dishLinks: [
            {
              dishId: DISH_B1,
              positionIndex: 0,
              dish: {
                id: DISH_B1,
                title: "Chicken stir fry",
                servingsDefault: 4,
                // Fresh row — anchor set at create (== servingsDefault).
                authoredServingsDefault: 4,
                dishIngredients: [
                  {
                    quantity: 1,
                    unit: "medium",
                    preparationNote: "diced",
                    positionIndex: 0,
                    ingredient: {
                      id: ING_ONION,
                      displayName: "yellow onion",
                      category: "Produce",
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
    ...opts,
  };
}

describe("loadPrepWeekInput — access checks", () => {
  it("throws NotFoundError when the plan does not exist", async () => {
    const prisma = makePrismaStub([]);
    await assert.rejects(
      loadPrepWeekInput({ planId: "missing", userId: USER_ID, prisma }),
      (err) => err instanceof PrepWeekNotFoundError,
    );
  });

  it("throws NotFoundError when the plan belongs to a different user (no leak)", async () => {
    const prisma = makePrismaStub([plan({ userId: OTHER_USER_ID })]);
    await assert.rejects(
      loadPrepWeekInput({ planId: PLAN_ID, userId: USER_ID, prisma }),
      (err) => err instanceof PrepWeekNotFoundError,
    );
  });
});

describe("loadPrepWeekInput — empty-plan paths", () => {
  it("throws EmptyPlanError when items is empty", async () => {
    const prisma = makePrismaStub([plan({ items: [] })]);
    await assert.rejects(
      loadPrepWeekInput({ planId: PLAN_ID, userId: USER_ID, prisma }),
      (err) => err instanceof PrepWeekEmptyPlanError,
    );
  });

  it("throws EmptyPlanError when every meal has no dishes/ingredients", async () => {
    const p = plan();
    // Strip every dish's ingredients — loader filters such dishes, then the
    // whole meal, then the whole plan, surfacing EmptyPlanError.
    for (const it of p.items) {
      for (const link of it.meal.dishLinks) {
        link.dish.dishIngredients = [];
      }
    }
    const prisma = makePrismaStub([p]);
    await assert.rejects(
      loadPrepWeekInput({ planId: PLAN_ID, userId: USER_ID, prisma }),
      (err) => err instanceof PrepWeekEmptyPlanError,
    );
  });
});

describe("loadPrepWeekInput — payload shape", () => {
  it("returns input + planRevisionId on the happy path", async () => {
    const prisma = makePrismaStub([plan({ revisionId: 7 })]);
    const { input, planRevisionId } = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma,
    });
    assert.equal(planRevisionId, 7);
    assert.equal(input.planId, PLAN_ID);
    assert.equal(input.meals.length, 2);
  });

  it("carries servingsOverride through un-applied (scaling is the adapter's job)", async () => {
    const prisma = makePrismaStub([plan()]);
    const { input } = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma,
    });
    const stirFry = input.meals.find((m) => m.mealId === MEAL_B);
    assert.ok(stirFry);
    // item-b sets servingsOverride: 6 — carried verbatim, not pre-applied.
    assert.equal(stirFry.servingsOverride, 6);
    // Dish base servings = dish.servingsDefault (the adapter's scaling base).
    assert.equal(stirFry.dishes[0].baseServings, 4);
    // WS7-8 BUG-003 — anchor carried through verbatim (fresh row → 4).
    assert.equal(stirFry.dishes[0].authoredBaseServings, 4);
    // Quantity stays RAW (1), NOT scaled to 1.5 — the loader never scales.
    const onion = stirFry.dishes[0].ingredients.find(
      (i) => i.ingredientId === ING_ONION,
    );
    assert.ok(onion);
    assert.equal(onion.quantity, 1);
  });

  it("carries servingsOverride=null when the plan-item has no override", async () => {
    const prisma = makePrismaStub([plan()]);
    const { input } = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma,
    });
    const tacos = input.meals.find((m) => m.mealId === MEAL_A);
    assert.ok(tacos);
    // item-a leaves servingsOverride null — carried as null (adapter falls
    // back to the dish base when scaling).
    assert.equal(tacos.servingsOverride, null);
    assert.equal(tacos.dishes[0].baseServings, 4);
    // WS7-8 BUG-003 — legacy row's null anchor carried through verbatim.
    assert.equal(tacos.dishes[0].authoredBaseServings, null);
  });

  it("carries Ingredient.category onto each ingredient", async () => {
    const prisma = makePrismaStub([plan()]);
    const { input } = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma,
    });
    const tacos = input.meals.find((m) => m.mealId === MEAL_A);
    assert.ok(tacos);
    const onion = tacos.dishes[0].ingredients.find(
      (i) => i.ingredientId === ING_ONION,
    );
    assert.ok(onion);
    assert.equal(onion.category, "Produce");
  });

  it("carries preparationNote (singular) — value when present, null when absent", async () => {
    const prisma = makePrismaStub([plan()]);
    const { input } = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma,
    });
    const tacos = input.meals.find((m) => m.mealId === MEAL_A);
    assert.ok(tacos);
    const onion = tacos.dishes[0].ingredients.find(
      (i) => i.ingredientId === ING_ONION,
    );
    assert.ok(onion);
    assert.equal(onion.preparationNote, "diced");

    // Force a null prepNote and re-run.
    const p2 = plan();
    p2.items[0].meal.dishLinks[0].dish.dishIngredients[0].preparationNote = null;
    const prisma2 = makePrismaStub([p2]);
    const { input: input2 } = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma: prisma2,
    });
    const tacos2 = input2.meals.find((m) => m.mealId === MEAL_A);
    assert.ok(tacos2);
    const onion2 = tacos2.dishes[0].ingredients.find(
      (i) => i.ingredientId === ING_ONION,
    );
    assert.ok(onion2);
    // Present as null (not omitted) on no-prep ingredients.
    assert.equal(onion2.preparationNote, null);
  });

  it("threads cuisineType into the meal payload when present", async () => {
    const prisma = makePrismaStub([plan()]);
    const { input } = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma,
    });
    const tacos = input.meals.find((m) => m.mealId === MEAL_A);
    const stirFry = input.meals.find((m) => m.mealId === MEAL_B);
    assert.ok(tacos && stirFry);
    assert.equal(tacos.cuisine, "Mexican");
    // cuisine is now always present as a field; null when the meal has none.
    assert.equal(stirFry.cuisine, null);
  });
});

describe("loadPrepWeekInput — step text (WS7-8a B2b)", () => {
  it("folds BOTH dish-owned and meal-owned steps into a dish's stepTexts", async () => {
    const steps: StepFixture[] = [
      // dish-owned (multi-dish path)
      { ownerType: "dish", ownerId: DISH_A1, stepIndex: 1, stepTextRaw: "Dice the onion." },
      { ownerType: "dish", ownerId: DISH_A1, stepIndex: 0, stepTextRaw: "Mince the garlic." },
      // meal-owned (single-dish path) on the SAME meal
      { ownerType: "meal", ownerId: MEAL_A, stepIndex: 0, stepTextRaw: "Season the beef and brown it." },
      // dish-owned on the other meal's dish
      { ownerType: "dish", ownerId: DISH_B1, stepIndex: 0, stepTextRaw: "Stir-fry everything." },
    ];
    const prisma = makePrismaStub([plan()], steps);
    const { input } = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma,
    });
    const tacos = input.meals.find((m) => m.mealId === MEAL_A);
    assert.ok(tacos);
    // dish-owned steps (stepIndex order) THEN the meal-owned step.
    assert.deepEqual(tacos.dishes[0].stepTexts, [
      "Mince the garlic.",
      "Dice the onion.",
      "Season the beef and brown it.",
    ]);

    const stirFry = input.meals.find((m) => m.mealId === MEAL_B);
    assert.ok(stirFry);
    // MEAL_B has no meal-owned steps → only its dish-owned step.
    assert.deepEqual(stirFry.dishes[0].stepTexts, ["Stir-fry everything."]);
  });

  it("leaves stepTexts empty when no steps exist", async () => {
    const prisma = makePrismaStub([plan()], []);
    const { input } = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma,
    });
    for (const meal of input.meals) {
      for (const dish of meal.dishes) {
        assert.deepEqual(dish.stepTexts, []);
      }
    }
  });
});

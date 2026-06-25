// WS7-3 A1 — GET /meals + GET /meals/:id catalog endpoint tests.
//
// These endpoints moved from recipes.ts (GET /recipes, /recipes/:id) into
// createMealsRouter in WS7-3 A1 and gained the multi-dish read shape. They
// had zero prior coverage — this is net-new.
//
// HTTP transport: same lightweight Express harness as meals.test.ts /
// me-favorites.test.ts (node:test, real signed JWT, prisma stubbed at the
// factory deps boundary).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { createMealsRouter } from "../meals";

// ── fixtures ───────────────────────────────────────────────────────────

const USER_ID = "test-user-meals-catalog";

interface ListMealOpts {
  isPublic?: boolean;
  isArchived?: boolean;
}

// A GET /meals list row — only the columns toListShape reads.
function listMeal(id: string, title: string, opts: ListMealOpts = {}) {
  return {
    id,
    title,
    cuisineType: "Testian",
    estimatedTimeMinutes: 30,
    servingsDefault: 4,
    caloriesPerServing: 500,
    proteinGPerServing: 30,
    carbsGPerServing: 40,
    fatGPerServing: 20,
    tags: ["weeknight"],
    imageUrl: null,
    isPublic: opts.isPublic ?? true,
    isArchived: opts.isArchived ?? false,
  };
}

function step(
  ownerType: "meal" | "dish",
  ownerId: string,
  stepIndex: number,
  text: string,
) {
  return {
    ownerType,
    ownerId,
    stepIndex,
    stepTextRaw: text,
    stepTextTranslated: text,
    estimatedMinutes: 5,
    phaseType: "cook",
    parallelGroup: null,
    requiresPreheat: false,
    requiresRest: false,
    requiresMarination: false,
    isTimingSensitive: false,
  };
}

function dishIngredient(
  name: string,
  category: string,
  quantity: number,
  unit: string,
  positionIndex: number,
  isOptional = false,
) {
  return {
    quantity,
    unit,
    positionIndex,
    isOptional,
    preparationNote: null,
    ingredient: { displayName: name, category },
  };
}

interface DishIngredientFixture {
  quantity: number;
  unit: string;
  positionIndex: number;
  isOptional: boolean;
  preparationNote: string | null;
  ingredient: { displayName: string; category: string };
}

function dish(
  id: string,
  title: string,
  dishIngredients: DishIngredientFixture[],
) {
  return {
    id,
    title,
    difficulty: "medium",
    estimatedTimeMinutes: 20,
    servingsDefault: 4,
    dishIngredients,
  };
}

interface DishLinkFixture {
  positionIndex: number;
  roleLabel: string;
  dish: ReturnType<typeof dish>;
}

interface DetailMealFixture {
  id: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  cuisineType: string | null;
  difficulty: string;
  estimatedTimeMinutes: number;
  servingsDefault: number;
  mealType: string;
  sourceType: string;
  tags: string[];
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
  isPublic: boolean;
  isArchived: boolean;
  userId: string | null;
  dishLinks: DishLinkFixture[];
}

function detailMeal(
  id: string,
  title: string,
  dishLinks: DishLinkFixture[],
  opts: { isArchived?: boolean } = {},
): DetailMealFixture {
  return {
    id,
    title,
    description: "A test meal.",
    imageUrl: null,
    cuisineType: "American",
    difficulty: "medium",
    estimatedTimeMinutes: 35,
    servingsDefault: 4,
    mealType: "dinner",
    sourceType: "manual",
    tags: ["test"],
    caloriesPerServing: 600,
    proteinGPerServing: 35,
    carbsGPerServing: 45,
    fatGPerServing: 25,
    isPublic: true,
    isArchived: opts.isArchived ?? false,
    userId: "owner-1",
    dishLinks,
  };
}

// ── prisma stub ────────────────────────────────────────────────────────
// Honors the query shapes the catalog routes actually issue: keyset
// pagination on meal.findMany, nested include + orderBy on meal.findUnique,
// and the polymorphic ownerType/ownerId filter on recipeInstructionStep.

type StepFixture = ReturnType<typeof step>;

// WS7-7-A B5 — a plan item carrying a per-instance recipeOverrideJson, for the
// GET /meals/:id?planItemId override-read tests.
interface PlanItemFixture {
  id: string;
  mealId: string;
  userId: string;
  recipeOverrideJson: unknown;
  // WS7-8b (D-WS7-169 keystone) — per-instance servings override. Omitted →
  // null (effectiveServings falls back to the meal's servingsDefault).
  servingsOverride?: number | null;
}

function makeStubPrisma(opts: {
  listMeals?: ReturnType<typeof listMeal>[];
  detailMeals?: DetailMealFixture[];
  steps?: StepFixture[];
  planItems?: PlanItemFixture[];
}) {
  const listMeals = opts.listMeals ?? [];
  const detailMeals = opts.detailMeals ?? [];
  const steps = opts.steps ?? [];
  const planItems = opts.planItems ?? [];
  let lastFindManyArgs: { take?: number } | null = null;

  return {
    _lastFindManyArgs: () => lastFindManyArgs,
    meal: {
      findMany: async (args: {
        where: { isArchived: boolean; isPublic: boolean };
        take?: number;
        cursor?: { id: string };
        skip?: number;
      }) => {
        lastFindManyArgs = { take: args.take };
        let rows = listMeals.filter(
          (m) =>
            m.isArchived === args.where.isArchived &&
            m.isPublic === args.where.isPublic,
        );
        rows = rows.slice().sort((a, b) => a.title.localeCompare(b.title));
        if (args.cursor) {
          const idx = rows.findIndex((r) => r.id === args.cursor!.id);
          rows = idx >= 0 ? rows.slice(idx + (args.skip ?? 0)) : [];
        }
        if (typeof args.take === "number") rows = rows.slice(0, args.take);
        return rows;
      },
      findUnique: async (args: { where: { id: string } }) => {
        const m = detailMeals.find((r) => r.id === args.where.id);
        if (!m) return null;
        // Honor include.dishLinks.orderBy + dishIngredients.orderBy so the
        // route's reliance on positionIndex ordering is genuinely exercised.
        const dishLinks = m.dishLinks
          .slice()
          .sort((a, b) => a.positionIndex - b.positionIndex)
          .map((link) => ({
            ...link,
            dish: {
              ...link.dish,
              dishIngredients: link.dish.dishIngredients
                .slice()
                .sort((a, b) => a.positionIndex - b.positionIndex),
            },
          }));
        return { ...m, dishLinks };
      },
    },
    recipeInstructionStep: {
      findMany: async (args: {
        where: { ownerType: string; ownerId: string | { in: string[] } };
      }) => {
        const { ownerType, ownerId } = args.where;
        const matchOwner =
          typeof ownerId === "string"
            ? (s: StepFixture) => s.ownerId === ownerId
            : (s: StepFixture) => ownerId.in.includes(s.ownerId);
        return steps
          .filter((s) => s.ownerType === ownerType && matchOwner(s))
          .slice()
          .sort((a, b) => a.stepIndex - b.stepIndex);
      },
    },
    // Honors the route's ownership-scoped item read: id + mealId + the parent
    // plan's userId must all match, else null (→ canonical recipe served).
    mealPlanItem: {
      findFirst: async (args: {
        where: {
          id: string;
          mealId: string;
          planInstance: { userId: string };
        };
      }) => {
        const { id, mealId, planInstance } = args.where;
        const item = planItems.find(
          (p) =>
            p.id === id &&
            p.mealId === mealId &&
            p.userId === planInstance.userId,
        );
        return item
          ? {
              recipeOverrideJson: item.recipeOverrideJson,
              servingsOverride: item.servingsOverride ?? null,
            }
          : null;
      },
    },
  };
}

// ── server harness ─────────────────────────────────────────────────────

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function spinUp(prisma: unknown): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use(createMealsRouter({ prisma: prisma as never }));

  return await new Promise<Harness>((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("server did not bind"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((r, j) =>
            server.close((err) => (err ? j(err) : r())),
          ),
      });
    });
  });
}

function authGet(harness: Harness, path: string, withAuth = true) {
  return fetch(`${harness.baseUrl}${path}`, {
    headers: withAuth
      ? { Authorization: `Bearer ${signToken(USER_ID)}` }
      : {},
  });
}

// ── GET /meals ─────────────────────────────────────────────────────────

const CATALOG = [
  listMeal("m-apple", "Apple Bake"),
  listMeal("m-banana", "Banana Bread"),
  listMeal("m-cherry", "Cherry Pie"),
  listMeal("m-date", "Date Loaf"),
  listMeal("m-egg", "Egg Tart"),
  listMeal("m-arch", "Zucchini Archived", { isArchived: true }),
  listMeal("m-priv", "Quiet Private", { isPublic: false }),
];

describe("GET /meals", () => {
  it("returns a { meals, nextCursor } envelope", async () => {
    const harness = await spinUp(makeStubPrisma({ listMeals: CATALOG }));
    try {
      const res = await authGet(harness, "/meals");
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        meals: { id: string; title: string; cuisine: string }[];
        nextCursor: string | null;
      };
      assert.ok(Array.isArray(body.meals));
      assert.ok("nextCursor" in body);
      // toListShape rename: cuisineType -> cuisine.
      assert.equal(body.meals[0].cuisine, "Testian");
    } finally {
      await harness.close();
    }
  });

  it("clamps limit above 100 down to 100", async () => {
    const stub = makeStubPrisma({ listMeals: CATALOG });
    const harness = await spinUp(stub);
    try {
      await authGet(harness, "/meals?limit=500");
      // Route fetches take = limit + 1; clamped limit 100 -> take 101.
      assert.equal(stub._lastFindManyArgs()?.take, 101);
    } finally {
      await harness.close();
    }
  });

  it("clamps limit below 1 up to 1", async () => {
    const stub = makeStubPrisma({ listMeals: CATALOG });
    const harness = await spinUp(stub);
    try {
      // A negative limit is the genuine "< 1" case. (limit=0 is falsy and
      // falls through the `|| 20` default — a pre-existing route quirk
      // inherited verbatim from recipes.ts.)
      await authGet(harness, "/meals?limit=-3");
      // Clamped limit 1 -> take 2.
      assert.equal(stub._lastFindManyArgs()?.take, 2);
    } finally {
      await harness.close();
    }
  });

  it("clamps limit=0 to 1 (not the falsy-default 20)", async () => {
    const harness = await spinUp(makeStubPrisma({ listMeals: CATALOG }));
    try {
      const res = await authGet(harness, "/meals?limit=0");
      assert.equal(res.status, 200);
      const body = (await res.json()) as { meals: unknown[] };
      // 5 public meals are available; clamp-to-1 yields a single-meal page,
      // not the 5 that a falsy-default limit of 20 would return.
      assert.equal(body.meals.length, 1);
    } finally {
      await harness.close();
    }
  });

  it("defaults limit to 20 when omitted", async () => {
    const stub = makeStubPrisma({ listMeals: CATALOG });
    const harness = await spinUp(stub);
    try {
      await authGet(harness, "/meals");
      // Default limit 20 -> take 21.
      assert.equal(stub._lastFindManyArgs()?.take, 21);
    } finally {
      await harness.close();
    }
  });

  it("round-trips the cursor: page 1's nextCursor yields a valid page 2", async () => {
    const harness = await spinUp(makeStubPrisma({ listMeals: CATALOG }));
    try {
      const r1 = await authGet(harness, "/meals?limit=2");
      const p1 = (await r1.json()) as {
        meals: { id: string }[];
        nextCursor: string | null;
      };
      assert.deepEqual(
        p1.meals.map((m) => m.id),
        ["m-apple", "m-banana"],
      );
      assert.equal(p1.nextCursor, "m-banana");

      const r2 = await authGet(
        harness,
        `/meals?limit=2&cursor=${p1.nextCursor}`,
      );
      const p2 = (await r2.json()) as {
        meals: { id: string }[];
        nextCursor: string | null;
      };
      assert.deepEqual(
        p2.meals.map((m) => m.id),
        ["m-cherry", "m-date"],
      );
      assert.equal(p2.nextCursor, "m-date");
    } finally {
      await harness.close();
    }
  });

  it("returns only public, non-archived meals", async () => {
    const harness = await spinUp(makeStubPrisma({ listMeals: CATALOG }));
    try {
      const res = await authGet(harness, "/meals?limit=100");
      const body = (await res.json()) as { meals: { id: string }[] };
      const ids = body.meals.map((m) => m.id).sort();
      assert.deepEqual(ids, [
        "m-apple",
        "m-banana",
        "m-cherry",
        "m-date",
        "m-egg",
      ]);
      assert.ok(!ids.includes("m-arch"), "archived meal must be excluded");
      assert.ok(!ids.includes("m-priv"), "private meal must be excluded");
    } finally {
      await harness.close();
    }
  });

  it("returns { meals: [], nextCursor: null } for an unrealistic cursor", async () => {
    const harness = await spinUp(makeStubPrisma({ listMeals: CATALOG }));
    try {
      const res = await authGet(harness, "/meals?cursor=does-not-exist");
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        meals: unknown[];
        nextCursor: string | null;
      };
      assert.deepEqual(body.meals, []);
      assert.equal(body.nextCursor, null);
    } finally {
      await harness.close();
    }
  });

  it("rejects 401 when no auth header is present", async () => {
    const harness = await spinUp(makeStubPrisma({ listMeals: CATALOG }));
    try {
      const res = await authGet(harness, "/meals", false);
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });
});

// ── GET /meals/:id ─────────────────────────────────────────────────────

// Single-dish meal with meal-owned steps — exercises the legacy fallback:
// the dish has no dish-owned steps, so it inherits the meal-owned steps.
const SINGLE_DISH_MEAL = detailMeal("meal-single", "Roast Chicken", [
  {
    positionIndex: 0,
    roleLabel: "main",
    dish: dish("dish-rc", "Roast Chicken", [
      dishIngredient("Whole chicken", "Protein", 1, "each", 0),
      dishIngredient("Rosemary", "Produce", 2, "sprigs", 1, true),
    ]),
  },
]);
const SINGLE_DISH_STEPS = [
  step("meal", "meal-single", 0, "Preheat oven to 425F."),
  step("meal", "meal-single", 1, "Roast for 60 minutes."),
];

// Multi-dish meal with dish-owned steps — dishLinks stored scrambled
// (positionIndex 1 before 0) to prove the route orders by positionIndex.
const MULTI_DISH_MEAL = detailMeal("meal-multi", "Salmon Plate", [
  {
    positionIndex: 1,
    roleLabel: "side",
    dish: dish("dish-pilaf", "Rice Pilaf", [
      dishIngredient("Basmati rice", "Pantry", 1, "cup", 0),
      dishIngredient("Yellow onion", "Produce", 1, "each", 1),
      dishIngredient("Vegetable broth", "Pantry", 2, "cups", 2),
    ]),
  },
  {
    positionIndex: 0,
    roleLabel: "main",
    dish: dish("dish-salmon", "Seared Salmon", [
      dishIngredient("Salmon fillets", "Protein", 4, "6 oz", 0),
      dishIngredient("Lemon", "Produce", 1, "each", 1),
    ]),
  },
]);
const MULTI_DISH_STEPS = [
  step("dish", "dish-salmon", 0, "Pat salmon dry and season."),
  step("dish", "dish-salmon", 1, "Sear 4 minutes per side."),
  step("dish", "dish-pilaf", 0, "Sauté onion in butter."),
  step("dish", "dish-pilaf", 1, "Toast rice, then add broth."),
  step("dish", "dish-pilaf", 2, "Simmer 15 minutes covered."),
];

const ARCHIVED_MEAL = detailMeal("meal-archived", "Old Meal", [], {
  isArchived: true,
});

describe("GET /meals/:id", () => {
  it("returns 200 with a single-dish meal; the dish falls back to meal-owned steps", async () => {
    const harness = await spinUp(
      makeStubPrisma({
        detailMeals: [SINGLE_DISH_MEAL],
        steps: SINGLE_DISH_STEPS,
      }),
    );
    try {
      const res = await authGet(harness, "/meals/meal-single");
      assert.equal(res.status, 200);
      const { meal } = (await res.json()) as { meal: Record<string, unknown> };

      assert.equal(meal.id, "meal-single");
      // Shared meal-meta fields use the GET /meals list-style renamed names.
      assert.equal(meal.cuisine, "American");
      assert.equal(meal.minutes, 35);
      assert.equal(meal.servings, 4);
      assert.equal(meal.calories, 600);
      assert.equal(meal.image, null);
      assert.equal(meal.notes, null);

      const dishes = meal.dishes as {
        dishId: string;
        positionIndex: number;
        minutes: number;
        servings: number;
        ingredients: { name: string; quantity: number; isOptional: boolean }[];
        steps: { stepIndex: number; text: string }[];
      }[];
      assert.equal(dishes.length, 1);
      assert.equal(dishes[0].dishId, "dish-rc");
      // Shared dish-meta fields renamed too (estimatedTimeMinutes -> minutes).
      assert.equal(dishes[0].minutes, 20);
      assert.equal(dishes[0].servings, 4);
      assert.equal(dishes[0].ingredients.length, 2);
      assert.equal(dishes[0].ingredients[0].name, "Whole chicken");
      assert.equal(dishes[0].ingredients[1].isOptional, true);
      // No dish-owned steps -> fall back to the 2 meal-owned steps.
      assert.deepEqual(
        dishes[0].steps.map((s) => s.text),
        ["Preheat oven to 425F.", "Roast for 60 minutes."],
      );
      // Top-level steps mirror the meal-owned steps in the fallback case.
      const topSteps = meal.steps as { text: string }[];
      assert.equal(topSteps.length, 2);
    } finally {
      await harness.close();
    }
  });

  // WS7-7-A B5 (D-WS7-090 read-side) — ?planItemId applies the plan item's
  // per-instance recipeOverrideJson so a "just this time" edit is visible here.
  // r-pasta-shaped fixture: a curated (userId null) 3-ingredient single-dish
  // meal; the override REMOVES "Heavy cream" and bumps pasta quantity.
  const PASTA_MEAL = {
    ...detailMeal("r-pasta", "Creamy Mushroom Pasta", [
      {
        positionIndex: 0,
        roleLabel: "main",
        dish: dish("d-pasta", "Creamy Mushroom Pasta", [
          dishIngredient("Pappardelle", "Pantry", 1, "lb", 0),
          dishIngredient("Cremini mushrooms", "Produce", 1, "lb", 1),
          dishIngredient("Heavy cream", "Dairy", 1, "cup", 2),
        ]),
      },
    ]),
    userId: null,
  };
  const PASTA_OVERRIDE = {
    titleOverride: "Creamy Mushroom Pasta",
    dishes: [
      {
        name: "Creamy Mushroom Pasta",
        // Heavy cream omitted (removed "just this time"); pasta bumped to 2 lb.
        ingredients: [
          { name: "Pappardelle", quantity: 2, unit: "lb" },
          { name: "Cremini mushrooms", quantity: 1, unit: "lb" },
        ],
      },
    ],
    createdAt: "2026-06-14T00:00:00.000Z",
  };

  it("applies the plan item override: a removed ingredient stays absent and quantities reflect the override", async () => {
    const harness = await spinUp(
      makeStubPrisma({
        detailMeals: [PASTA_MEAL],
        planItems: [
          {
            id: "item-1",
            mealId: "r-pasta",
            userId: USER_ID,
            recipeOverrideJson: PASTA_OVERRIDE,
          },
        ],
      }),
    );
    try {
      const res = await authGet(harness, "/meals/r-pasta?planItemId=item-1");
      assert.equal(res.status, 200);
      const { meal } = (await res.json()) as { meal: Record<string, unknown> };
      const dishes = meal.dishes as {
        ingredients: { name: string; quantity: number; unit: string }[];
      }[];
      const names = dishes[0].ingredients.map((i) => i.name);
      // Removal honored: Heavy cream is gone, not merged back from the base.
      assert.deepEqual(names, ["Pappardelle", "Cremini mushrooms"]);
      assert.equal(dishes[0].ingredients[0].quantity, 2);
    } finally {
      await harness.close();
    }
  });

  it("without ?planItemId serves the canonical recipe (override not applied)", async () => {
    const harness = await spinUp(
      makeStubPrisma({
        detailMeals: [PASTA_MEAL],
        planItems: [
          {
            id: "item-1",
            mealId: "r-pasta",
            userId: USER_ID,
            recipeOverrideJson: PASTA_OVERRIDE,
          },
        ],
      }),
    );
    try {
      const res = await authGet(harness, "/meals/r-pasta");
      assert.equal(res.status, 200);
      const { meal } = (await res.json()) as { meal: Record<string, unknown> };
      const dishes = meal.dishes as { ingredients: { name: string }[] }[];
      const names = dishes[0].ingredients.map((i) => i.name);
      assert.deepEqual(names, [
        "Pappardelle",
        "Cremini mushrooms",
        "Heavy cream",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("a foreign-owned plan item is ignored: canonical recipe served (no cross-user override read)", async () => {
    const harness = await spinUp(
      makeStubPrisma({
        detailMeals: [PASTA_MEAL],
        planItems: [
          {
            id: "item-1",
            mealId: "r-pasta",
            userId: "someone-else",
            recipeOverrideJson: PASTA_OVERRIDE,
          },
        ],
      }),
    );
    try {
      const res = await authGet(harness, "/meals/r-pasta?planItemId=item-1");
      assert.equal(res.status, 200);
      const { meal } = (await res.json()) as { meal: Record<string, unknown> };
      const dishes = meal.dishes as { ingredients: { name: string }[] }[];
      // Heavy cream still present — the foreign item's override was not read.
      assert.equal(dishes[0].ingredients.length, 3);
    } finally {
      await harness.close();
    }
  });

  // WS7-8b (D-WS7-169 keystone) — composeMealDetail resolves the plan item's
  // servingsOverride into a DISTINCT effectiveServings field; the authored
  // `servings` (= servingsDefault, the mobile scaling denominator) is untouched.
  it("resolves effectiveServings from the item's servingsOverride; authored servings stays the denominator", async () => {
    const harness = await spinUp(
      makeStubPrisma({
        detailMeals: [PASTA_MEAL], // servingsDefault: 4
        planItems: [
          {
            id: "item-1",
            mealId: "r-pasta",
            userId: USER_ID,
            recipeOverrideJson: null,
            servingsOverride: 8,
          },
        ],
      }),
    );
    try {
      const res = await authGet(harness, "/meals/r-pasta?planItemId=item-1");
      assert.equal(res.status, 200);
      const { meal } = (await res.json()) as {
        meal: { servings: number; effectiveServings: number };
      };
      // Denominator integrity: authored servings unchanged at the default…
      assert.equal(meal.servings, 4);
      // …while effectiveServings reflects the per-instance override.
      assert.equal(meal.effectiveServings, 8);
    } finally {
      await harness.close();
    }
  });

  it("effectiveServings falls back to servingsDefault when the item has no servingsOverride", async () => {
    const harness = await spinUp(
      makeStubPrisma({
        detailMeals: [PASTA_MEAL], // servingsDefault: 4
        planItems: [
          {
            id: "item-1",
            mealId: "r-pasta",
            userId: USER_ID,
            recipeOverrideJson: null,
            // servingsOverride omitted → null
          },
        ],
      }),
    );
    try {
      const res = await authGet(harness, "/meals/r-pasta?planItemId=item-1");
      assert.equal(res.status, 200);
      const { meal } = (await res.json()) as {
        meal: { servings: number; effectiveServings: number };
      };
      assert.equal(meal.servings, 4);
      assert.equal(meal.effectiveServings, 4);
    } finally {
      await harness.close();
    }
  });

  it("without ?planItemId effectiveServings === servings (canonical/deep-link read)", async () => {
    const harness = await spinUp(
      makeStubPrisma({ detailMeals: [PASTA_MEAL] }),
    );
    try {
      const res = await authGet(harness, "/meals/r-pasta");
      assert.equal(res.status, 200);
      const { meal } = (await res.json()) as {
        meal: { servings: number; effectiveServings: number };
      };
      assert.equal(meal.effectiveServings, meal.servings);
      assert.equal(meal.effectiveServings, 4);
    } finally {
      await harness.close();
    }
  });

  it("returns 200 with a multi-dish meal: both dishes ordered, each with own ingredients + steps", async () => {
    const harness = await spinUp(
      makeStubPrisma({
        detailMeals: [MULTI_DISH_MEAL],
        steps: MULTI_DISH_STEPS,
      }),
    );
    try {
      const res = await authGet(harness, "/meals/meal-multi");
      assert.equal(res.status, 200);
      const { meal } = (await res.json()) as { meal: Record<string, unknown> };

      const dishes = meal.dishes as {
        dishId: string;
        positionIndex: number;
        roleLabel: string;
        ingredients: { name: string }[];
        steps: { text: string }[];
      }[];
      // Both dishes returned, ordered by positionIndex (fixture is scrambled).
      assert.equal(dishes.length, 2);
      assert.deepEqual(
        dishes.map((d) => d.positionIndex),
        [0, 1],
      );
      assert.equal(dishes[0].dishId, "dish-salmon");
      assert.equal(dishes[0].roleLabel, "main");
      assert.equal(dishes[1].dishId, "dish-pilaf");

      // Each dish carries its own ingredients.
      assert.deepEqual(
        dishes[0].ingredients.map((i) => i.name),
        ["Salmon fillets", "Lemon"],
      );
      assert.equal(dishes[1].ingredients.length, 3);

      // Each dish carries its own dish-owned steps.
      assert.deepEqual(
        dishes[0].steps.map((s) => s.text),
        ["Pat salmon dry and season.", "Sear 4 minutes per side."],
      );
      assert.equal(dishes[1].steps.length, 3);

      // No meal-owned steps -> top-level steps array stays empty.
      assert.deepEqual(meal.steps, []);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 for a non-existent meal id", async () => {
    const harness = await spinUp(makeStubPrisma({ detailMeals: [] }));
    try {
      const res = await authGet(harness, "/meals/ghost-meal");
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 for an archived meal", async () => {
    const harness = await spinUp(
      makeStubPrisma({ detailMeals: [ARCHIVED_MEAL] }),
    );
    try {
      const res = await authGet(harness, "/meals/meal-archived");
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("returns 400 for an over-length meal id", async () => {
    const harness = await spinUp(makeStubPrisma({ detailMeals: [] }));
    try {
      const res = await authGet(harness, `/meals/${"x".repeat(101)}`);
      assert.equal(res.status, 400);
    } finally {
      await harness.close();
    }
  });

  it("rejects 401 when no auth header is present", async () => {
    const harness = await spinUp(
      makeStubPrisma({ detailMeals: [SINGLE_DISH_MEAL] }),
    );
    try {
      const res = await authGet(harness, "/meals/meal-single", false);
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });
});

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
import { withSessionUser } from "./fixtures/sessionUserStub";

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
  activeTimeMinutes?: number | null;
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
  // WS9 D-WS9-235 — activeTimeMinutes: the detail row comes from an `include`
  // query (every scalar present), so the fixture carries the column like
  // Prisma would; undefined here models a pre-migration row → null on the wire.
  opts: { isArchived?: boolean; activeTimeMinutes?: number | null } = {},
): DetailMealFixture {
  return {
    id,
    title,
    description: "A test meal.",
    imageUrl: null,
    cuisineType: "American",
    difficulty: "medium",
    estimatedTimeMinutes: 35,
    activeTimeMinutes: opts.activeTimeMinutes,
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
      // BUG-312 (Block 1b Part E) — the visibility gate's read, modelled off
      // the WHERE the route actually sends rather than hard-coded to agree
      // with it. Two predicate shapes reach here:
      //   the GUEST branch  { id, isPublic, userId: null, isArchived }
      //   the USER branch   { id, OR: [{userId}, {isPublic,isArchived},
      //                                {planItems:{some:{planInstance:{userId}}}}] }
      findFirst: async (args: {
        where: {
          id: string;
          isPublic?: boolean;
          userId?: string | null;
          isArchived?: boolean;
          OR?: Array<{
            userId?: string;
            isPublic?: boolean;
            isArchived?: boolean;
            planItems?: { some: { planInstance: { userId: string } } };
          }>;
        };
      }) => {
        const w = args.where;
        const m = detailMeals.find((r) => r.id === w.id);
        if (!m) return null;
        const onCallersPlan = (userId: string): boolean =>
          planItems.some((p) => p.mealId === m.id && p.userId === userId);
        if (w.OR) {
          const ok = w.OR.some((clause) => {
            if (clause.planItems) {
              return onCallersPlan(clause.planItems.some.planInstance.userId);
            }
            if (clause.userId !== undefined) return m.userId === clause.userId;
            if (clause.isPublic !== undefined) {
              return (
                m.isPublic === clause.isPublic &&
                (clause.isArchived === undefined ||
                  m.isArchived === clause.isArchived)
              );
            }
            return false;
          });
          return ok ? { id: m.id } : null;
        }
        // The guest branch: every named field must match, `userId: null`
        // included (catalog only — never a community member's published meal).
        if (w.isPublic !== undefined && m.isPublic !== w.isPublic) return null;
        if (w.userId !== undefined && m.userId !== w.userId) return null;
        if (w.isArchived !== undefined && m.isArchived !== w.isArchived) {
          return null;
        }
        return { id: m.id };
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
  app.use(createMealsRouter({ prisma: withSessionUser(prisma) as never }));

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

  // WS9 D-WS9-235 (BUG-245) — the derived hands-on figure rides the detail
  // payload at the top level, beside `minutes`, through the same toListShape
  // spread the list uses. A stamped 22 reaches the wire as 22; an unstamped
  // meal serialises an explicit null (present, not absent).
  it("emits activeTimeMinutes at the top level beside minutes — 22 stays 22, null stays null", async () => {
    const harness = await spinUp(
      makeStubPrisma({
        detailMeals: [
          detailMeal("meal-derived", "Stamped Roast", [], { activeTimeMinutes: 22 }),
          detailMeal("meal-stepless", "Claim Only", [], { activeTimeMinutes: null }),
        ],
        steps: [],
      }),
    );
    try {
      const derived = await authGet(harness, "/meals/meal-derived");
      assert.equal(derived.status, 200);
      const { meal: d } = (await derived.json()) as { meal: Record<string, unknown> };
      assert.equal(d.minutes, 35);
      assert.equal(d.activeTimeMinutes, 22);

      const stepless = await authGet(harness, "/meals/meal-stepless");
      assert.equal(stepless.status, 200);
      const { meal: n } = (await stepless.json()) as { meal: Record<string, unknown> };
      assert.ok("activeTimeMinutes" in n, "null must be present on the wire, not dropped");
      assert.equal(n.activeTimeMinutes, null);
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


// ── BUG-312 (Block 1b Part E) — GET /meals/:id visibility ────────────────
//
// Before this, an authenticated caller got NO check at all: the handler
// composed its answer from an id-only findUnique, so any signed-in user could
// read any other user's private meal — full recipe, ingredients, steps.
//
// Three ways in and no fourth: own, public-and-not-archived, or on one of the
// caller's own plans. Every miss is 404, never 403 — a 403 confirms the id
// exists, which is the probe the guest branch already refuses to be.

/** One dish, one ingredient — enough body to prove a recipe did or did not leak. */
const ONE_DISH: DishLinkFixture[] = [
  {
    positionIndex: 0,
    roleLabel: "main",
    dish: dish("d-1", "The Dish", [
      dishIngredient("Salt", "Pantry", 1, "tsp", 0),
    ]),
  },
];

/** A meal owned by someone else, unpublished. The row Block 1 leaked. */
function privateForeignMeal(id: string): DetailMealFixture {
  return {
    ...detailMeal(id, "Someone Else's Dinner", ONE_DISH),
    isPublic: false,
    userId: "owner-1",
  };
}

describe("GET /meals/:id — BUG-312 visibility for an authenticated caller", () => {
  it("MY OWN meal: 200, even unpublished", async () => {
    const mine: DetailMealFixture = {
      ...privateForeignMeal("m-mine"),
      userId: USER_ID,
    };
    const harness = await spinUp(makeStubPrisma({ detailMeals: [mine] }));
    try {
      const res = await authGet(harness, "/meals/m-mine");
      assert.equal(res.status, 200);
      const body = (await res.json()) as { meal: { id: string } };
      assert.equal(body.meal.id, "m-mine");
    } finally {
      await harness.close();
    }
  });

  it("a PUBLIC, non-archived meal: 200", async () => {
    // detailMeal() defaults to isPublic true / userId "owner-1" — NOT mine, so
    // this passes on the public clause alone, which is the point.
    const harness = await spinUp(
      makeStubPrisma({
        detailMeals: [detailMeal("m-pub", "Catalog Dinner", ONE_DISH)],
      }),
    );
    try {
      assert.equal((await authGet(harness, "/meals/m-pub")).status, 200);
    } finally {
      await harness.close();
    }
  });

  it("🔴 ANOTHER USER'S PRIVATE meal: 404 — the leak, closed", async () => {
    const harness = await spinUp(
      makeStubPrisma({ detailMeals: [privateForeignMeal("m-theirs")] }),
    );
    try {
      const res = await authGet(harness, "/meals/m-theirs");
      assert.equal(res.status, 404, "not 403 — the id is not confirmed");
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.meal, undefined, "and no recipe leaks in the body");
    } finally {
      await harness.close();
    }
  });

  it("another user's private meal that is ON MY PLAN: 200", async () => {
    // The third clause, and the reason the two-clause rule open-coded elsewhere
    // could not be reused: a forked or shared meal legitimately in my week is
    // someone else's private row, and 404ing it would break Plan Review.
    const harness = await spinUp(
      makeStubPrisma({
        detailMeals: [privateForeignMeal("m-onplan")],
        planItems: [
          {
            id: "pi-1",
            mealId: "m-onplan",
            userId: USER_ID,
            recipeOverrideJson: null,
          },
        ],
      }),
    );
    try {
      assert.equal((await authGet(harness, "/meals/m-onplan")).status, 200);
    } finally {
      await harness.close();
    }
  });

  it("the same meal on SOMEBODY ELSE'S plan does not let me in: 404", async () => {
    const harness = await spinUp(
      makeStubPrisma({
        detailMeals: [privateForeignMeal("m-onplan")],
        planItems: [
          {
            id: "pi-1",
            mealId: "m-onplan",
            userId: "some-other-user",
            recipeOverrideJson: null,
          },
        ],
      }),
    );
    try {
      assert.equal((await authGet(harness, "/meals/m-onplan")).status, 404);
    } finally {
      await harness.close();
    }
  });

  it("a PUBLIC but ARCHIVED meal is not public content: 404", async () => {
    const harness = await spinUp(
      makeStubPrisma({
        detailMeals: [
          detailMeal("m-arch-detail", "Retired Dinner", ONE_DISH, {
            isArchived: true,
          }),
        ],
      }),
    );
    try {
      assert.equal(
        (await authGet(harness, "/meals/m-arch-detail")).status,
        404,
      );
    } finally {
      await harness.close();
    }
  });
});

// ── the GUEST pre-check, unchanged by Part E ─────────────────────────────
//
// Block 1's guest rule is strictly NARROWER than the authenticated one — the
// catalog only, meaning isPublic AND userId null — and Part E must not have
// widened it by collapsing the two branches into one predicate. There was no
// test on it before; there is now, so the next change to this handler cannot
// quietly promote a guest to the three-clause rule.
describe("GET /meals/:id — the guest pre-check (Block 1, re-pinned by 1b)", () => {
  const GUEST_ID = "gs-meal-detail";

  /** makeStubPrisma + the one model requireGuestOrAuth reads. */
  function withGuestSession(stub: ReturnType<typeof makeStubPrisma>) {
    return {
      ...stub,
      guestSession: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id === GUEST_ID
            ? {
                id: GUEST_ID,
                expiresAt: new Date(Date.now() + 3_600_000),
                claimedAt: null,
              }
            : null,
      },
    };
  }

  const guestGet = (harness: Harness, path: string) =>
    fetch(`${harness.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${signToken(GUEST_ID, {
          purpose: "guest",
          expiresIn: "1h",
        })}`,
      },
    });

  it("a CATALOG meal (isPublic, userId null): 200", async () => {
    const catalog: DetailMealFixture = {
      ...detailMeal("m-catalog", "Kiwi Dinner", ONE_DISH),
      userId: null,
    };
    const harness = await spinUp(
      withGuestSession(makeStubPrisma({ detailMeals: [catalog] })),
    );
    try {
      assert.equal((await guestGet(harness, "/meals/m-catalog")).status, 200);
    } finally {
      await harness.close();
    }
  });

  it("🔴 a PUBLIC meal owned by a USER is still 404 for a guest — catalog, not 'public'", async () => {
    // detailMeal() defaults to userId "owner-1", isPublic true. An
    // authenticated caller gets 200 on this row; a guest must not.
    const harness = await spinUp(
      withGuestSession(
        makeStubPrisma({
          detailMeals: [detailMeal("m-published", "Community Dinner", ONE_DISH)],
        }),
      ),
    );
    try {
      assert.equal(
        (await guestGet(harness, "/meals/m-published")).status,
        404,
        "the guest rule stays narrower than the user rule",
      );
      // Same fixture, authenticated → 200. The two branches really do differ.
      assert.equal((await authGet(harness, "/meals/m-published")).status, 200);
    } finally {
      await harness.close();
    }
  });
});

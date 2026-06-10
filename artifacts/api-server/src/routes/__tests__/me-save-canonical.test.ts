// WS7-6 Block 2 — POST /me/meals + POST /me/dishes endpoint tests.
//
// Three threads of coverage:
//   1. POST /me/meals manual-built (all "new" dishes) writes the row graph
//      through the shared resolver.
//   2. POST /me/meals Mode-C link path (dishes[].kind === "link") creates
//      MealDishLink rows pointing at the supplied dish ids without
//      cloning. Asserts the Q1 link-not-clone contract.
//   3. POST /me/dishes standalone — Dish + DishIngredients +
//      polymorphic ownerType="dish" steps.
//
// Same lightweight harness as me-meals-dishes.test.ts: real signed JWT,
// prisma stubbed at the factory deps boundary, no DB.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { createMeRouter } from "../me";

const USER_ID = "test-user-save-canonical";

// ── stub builder ────────────────────────────────────────────────────────
// Captures every write so each test can assert on the exact shape that
// reached Prisma. Models a single $transaction call as fn(tx) where tx
// is the same object as the top-level prisma stub — the materializer's
// only tx surface is .meal / .dish / .mealDishLink / .dishIngredient /
// .recipeInstructionStep.create, all of which are no-op-with-capture.

interface Captured {
  ingredientUpserts: Array<{
    canonicalName: string;
    create: Record<string, unknown>;
  }>;
  mealCreates: Array<Record<string, unknown>>;
  // WS7-6 Fix-Block 3: capture meal-row updates so the Block-3 aggregation
  // assertion can pin the per-serving sum landing on the Meal row.
  mealUpdates: Array<{ id: string; data: Record<string, unknown> }>;
  dishCreates: Array<Record<string, unknown>>;
  linkCreates: Array<Record<string, unknown>>;
  dishIngredientCreates: Array<Record<string, unknown>>;
  stepCreates: Array<Record<string, unknown>>;
  dishFindMany: Array<{
    where: { id: { in: string[] }; isArchived?: boolean };
  }>;
}

interface StubOpts {
  // For the link-path test: pre-existing Dish rows that pass the
  // route's findMany lookup.
  existingDishes?: Array<{ id: string; userId: string | null }>;
  // WS7-6 Fix-Block 3: dish per-serving macros keyed by dish id, returned
  // by tx.mealDishLink.findMany during recomputeAndPersistMealMacros.
  // Defaults to all-zero so the existing tests can ignore macros entirely
  // (mealUpdates still capture the all-zero sum, which is the correct
  // honest aggregation when the dishes themselves are 0).
  dishMacrosById?: Record<
    string,
    {
      caloriesPerServing: number;
      proteinGPerServing: number;
      carbsGPerServing: number;
      fatGPerServing: number;
    }
  >;
}

function makeStub(opts: StubOpts = {}) {
  const captured: Captured = {
    ingredientUpserts: [],
    mealCreates: [],
    mealUpdates: [],
    dishCreates: [],
    linkCreates: [],
    dishIngredientCreates: [],
    stepCreates: [],
    dishFindMany: [],
  };

  // Track which dishes have been linked to which meal so the
  // recomputeAndPersistMealMacros findMany can return the right rows.
  const linksByMealId = new Map<string, string[]>();

  let nextMealId = 1;
  let nextDishId = 1;

  const surface = {
    ingredient: {
      upsert: async (args: {
        where: { canonicalName: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        captured.ingredientUpserts.push({
          canonicalName: args.where.canonicalName,
          create: args.create,
        });
        return { id: `ing-${args.where.canonicalName.replace(/\s+/g, "-")}` };
      },
    },
    dish: {
      findMany: async (args: {
        where: { id: { in: string[] }; isArchived?: boolean };
        select: Record<string, boolean>;
      }) => {
        captured.dishFindMany.push({ where: args.where });
        const ids = args.where.id.in;
        const rows = (opts.existingDishes ?? []).filter((d) =>
          ids.includes(d.id),
        );
        return rows;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        captured.dishCreates.push(args.data);
        return { id: `dish-${nextDishId++}` };
      },
    },
    meal: {
      create: async (args: { data: Record<string, unknown> }) => {
        captured.mealCreates.push(args.data);
        return { id: `meal-${nextMealId++}` };
      },
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        captured.mealUpdates.push({ id: args.where.id, data: args.data });
        return { id: args.where.id, ...args.data };
      },
    },
    mealDishLink: {
      // WS7-6 Fix-Block 3: recomputeAndPersistMealMacros calls findMany on
      // the live link table. Replay the captured link writes for this meal
      // and join in the configured per-dish macros (default 0).
      findMany: async (args: {
        where: { mealId: string };
        select: { dish: { select: Record<string, boolean> } };
      }) => {
        const dishIds = linksByMealId.get(args.where.mealId) ?? [];
        return dishIds.map((dishId) => ({
          dish: {
            caloriesPerServing:
              opts.dishMacrosById?.[dishId]?.caloriesPerServing ?? 0,
            proteinGPerServing:
              opts.dishMacrosById?.[dishId]?.proteinGPerServing ?? 0,
            carbsGPerServing:
              opts.dishMacrosById?.[dishId]?.carbsGPerServing ?? 0,
            fatGPerServing:
              opts.dishMacrosById?.[dishId]?.fatGPerServing ?? 0,
          },
        }));
      },
      create: async (args: { data: Record<string, unknown> }) => {
        captured.linkCreates.push(args.data);
        const mealId = args.data.mealId as string;
        const dishId = args.data.dishId as string;
        const list = linksByMealId.get(mealId) ?? [];
        list.push(dishId);
        linksByMealId.set(mealId, list);
        return {};
      },
    },
    dishIngredient: {
      create: async (args: { data: Record<string, unknown> }) => {
        captured.dishIngredientCreates.push(args.data);
        return {};
      },
    },
    recipeInstructionStep: {
      create: async (args: { data: Record<string, unknown> }) => {
        captured.stepCreates.push(args.data);
        return {};
      },
    },
    // $transaction(fn) — call fn with `this` as the tx (a clone of
    // surface for typing; same object works because the materializer
    // only uses the .{model}.create methods that are no-ops).
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      return fn(surface);
    },
  };

  return { prisma: surface, captured };
}

// ── harness ────────────────────────────────────────────────────────────

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function spinUp(prisma: unknown): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use(createMeRouter({ prisma: prisma as never }));

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

function authPost(harness: Harness, path: string, body: unknown) {
  return fetch(`${harness.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${signToken(USER_ID)}`,
    },
    body: JSON.stringify(body),
  });
}

// ── POST /me/meals — manual-built (all "new" dishes) ───────────────────

describe("POST /me/meals (manual-built)", () => {
  it("creates Meal + Dish + MealDishLink + DishIngredient + steps", async () => {
    const { prisma, captured } = makeStub();
    const harness = await spinUp(prisma);
    try {
      const res = await authPost(harness, "/me/meals", {
        title: "Sheet-pan chicken with arugula salad",
        cuisineType: "American",
        dishes: [
          {
            kind: "new",
            title: "Sheet-pan chicken",
            role: "main",
            positionIndex: 0,
            ingredients: [
              { name: "Chicken thighs", quantity: 2, unit: "lb" },
              { name: "Olive oil", quantity: 2, unit: "tbsp" },
            ],
            steps: [
              { text: "Roast at 425F until 165F internal." },
            ],
          },
          {
            kind: "new",
            title: "Arugula salad",
            role: "side",
            positionIndex: 1,
            ingredients: [
              { name: "Arugula", quantity: 4, unit: "cup" },
            ],
            steps: [{ text: "Toss with vinaigrette." }],
          },
        ],
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as {
        meal: { id: string; dishIds: string[]; linksCreated: number };
      };
      assert.equal(body.meal.id, "meal-1");
      assert.equal(body.meal.linksCreated, 2);
      assert.deepEqual(body.meal.dishIds, ["dish-1", "dish-2"]);

      // Row-graph assertions.
      assert.equal(captured.mealCreates.length, 1);
      assert.equal(captured.dishCreates.length, 2);
      assert.equal(captured.linkCreates.length, 2);
      assert.equal(captured.dishIngredientCreates.length, 3);
      assert.equal(captured.stepCreates.length, 2);

      // Q2: no mealType in payload → default "dinner".
      assert.equal(captured.mealCreates[0].mealType, "dinner");
      assert.equal(captured.mealCreates[0].cuisineType, "American");
      assert.equal(captured.mealCreates[0].userId, USER_ID);
      assert.equal(captured.mealCreates[0].sourceType, "manual");

      // 3 unique ingredients → 3 upserts (resolver dedupe path).
      assert.equal(captured.ingredientUpserts.length, 3);

      // Steps are polymorphic ownerType="dish".
      for (const step of captured.stepCreates) {
        assert.equal(step.ownerType, "dish");
      }
    } finally {
      await harness.close();
    }
  });

  it("honors an explicit mealType when supplied (Q2 default only applies on omit)", async () => {
    const { prisma, captured } = makeStub();
    const harness = await spinUp(prisma);
    try {
      const res = await authPost(harness, "/me/meals", {
        title: "Yogurt parfait",
        mealType: "breakfast",
        dishes: [
          {
            kind: "new",
            title: "Yogurt parfait",
            role: "main",
            positionIndex: 0,
            ingredients: [{ name: "Greek yogurt", quantity: 1, unit: "cup" }],
            steps: [{ text: "Layer in glass." }],
          },
        ],
      });
      assert.equal(res.status, 201);
      assert.equal(captured.mealCreates[0].mealType, "breakfast");
    } finally {
      await harness.close();
    }
  });

  it("rejects invalid body shapes with 400 and Zod details", async () => {
    const { prisma } = makeStub();
    const harness = await spinUp(prisma);
    try {
      const res = await authPost(harness, "/me/meals", {
        // missing title + dishes
      });
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "invalid body");
    } finally {
      await harness.close();
    }
  });

  it("returns 401 without an auth header", async () => {
    const { prisma } = makeStub();
    const harness = await spinUp(prisma);
    try {
      const res = await fetch(`${harness.baseUrl}/me/meals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x", dishes: [] }),
      });
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });
});

// ── POST /me/meals — Mode-C link path (Q1: link, not clone) ────────────

describe("POST /me/meals (Mode-C link path)", () => {
  it("creates MealDishLink rows pointing at existing dish ids without writing new Dish rows", async () => {
    const { prisma, captured } = makeStub({
      existingDishes: [
        { id: "dish-existing-A", userId: USER_ID },
        { id: "dish-existing-B", userId: null }, // catalog dish — owner null
      ],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPost(harness, "/me/meals", {
        title: "Combined plate",
        dishes: [
          {
            kind: "link",
            dishId: "dish-existing-A",
            role: "main",
            positionIndex: 0,
          },
          {
            kind: "link",
            dishId: "dish-existing-B",
            role: "side",
            positionIndex: 1,
          },
        ],
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as {
        meal: { id: string; dishIds: string[]; linksCreated: number };
      };
      // Q1 contract: link rows reference the SUPPLIED ids exactly.
      assert.deepEqual(body.meal.dishIds, [
        "dish-existing-A",
        "dish-existing-B",
      ]);
      assert.equal(body.meal.linksCreated, 2);

      // No Dish.create — link path must not clone.
      assert.equal(captured.dishCreates.length, 0);
      // No DishIngredient.create — link path reuses the existing dish's
      // ingredients in place.
      assert.equal(captured.dishIngredientCreates.length, 0);
      // No step.create — same reason.
      assert.equal(captured.stepCreates.length, 0);
      // No ingredient.upsert — there are no free-text ingredients to
      // resolve on the link path.
      assert.equal(captured.ingredientUpserts.length, 0);

      // The Meal was still created.
      assert.equal(captured.mealCreates.length, 1);

      // Two MealDishLink rows with the right dishIds.
      assert.equal(captured.linkCreates.length, 2);
      assert.equal(captured.linkCreates[0].dishId, "dish-existing-A");
      assert.equal(captured.linkCreates[0].mealId, "meal-1");
      assert.equal(captured.linkCreates[1].dishId, "dish-existing-B");
      assert.equal(captured.linkCreates[1].mealId, "meal-1");
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when a linked dish does not exist", async () => {
    const { prisma } = makeStub({ existingDishes: [] });
    const harness = await spinUp(prisma);
    try {
      const res = await authPost(harness, "/me/meals", {
        title: "Broken combined",
        dishes: [
          {
            kind: "link",
            dishId: "dish-missing",
            role: "main",
            positionIndex: 0,
          },
        ],
      });
      assert.equal(res.status, 404);
      const body = (await res.json()) as { missing: string[] };
      assert.deepEqual(body.missing, ["dish-missing"]);
    } finally {
      await harness.close();
    }
  });

  it("returns 403 when a linked dish belongs to another user", async () => {
    const { prisma } = makeStub({
      existingDishes: [{ id: "dish-foreign", userId: "other-user" }],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPost(harness, "/me/meals", {
        title: "Forbidden combined",
        dishes: [
          {
            kind: "link",
            dishId: "dish-foreign",
            role: "main",
            positionIndex: 0,
          },
        ],
      });
      assert.equal(res.status, 403);
      const body = (await res.json()) as { forbidden: string[] };
      assert.deepEqual(body.forbidden, ["dish-foreign"]);
    } finally {
      await harness.close();
    }
  });

  it("mixed new+link payload writes Dish rows only for new, links for both", async () => {
    const { prisma, captured } = makeStub({
      existingDishes: [{ id: "dish-existing-A", userId: USER_ID }],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPost(harness, "/me/meals", {
        title: "Half-link half-new",
        dishes: [
          {
            kind: "link",
            dishId: "dish-existing-A",
            role: "main",
            positionIndex: 0,
          },
          {
            kind: "new",
            title: "Fresh side",
            role: "side",
            positionIndex: 1,
            ingredients: [{ name: "Garlic", quantity: 2, unit: "clove" }],
            steps: [{ text: "Mince." }],
          },
        ],
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as {
        meal: { dishIds: string[] };
      };
      // First id is the existing-by-link; second is the freshly created dish.
      assert.equal(body.meal.dishIds[0], "dish-existing-A");
      assert.equal(body.meal.dishIds[1], "dish-1");
      assert.equal(captured.dishCreates.length, 1);
      assert.equal(captured.linkCreates.length, 2);
      assert.equal(captured.ingredientUpserts.length, 1);
    } finally {
      await harness.close();
    }
  });
});

// ── POST /me/dishes — standalone ───────────────────────────────────────

describe("POST /me/dishes (standalone)", () => {
  it("creates a Dish + DishIngredients + polymorphic ownerType='dish' steps", async () => {
    const { prisma, captured } = makeStub();
    const harness = await spinUp(prisma);
    try {
      const res = await authPost(harness, "/me/dishes", {
        title: "Charred broccoli",
        estimatedTimeMinutes: 20,
        difficulty: "easy",
        servingsDefault: 4,
        ingredients: [
          { name: "Broccoli", quantity: 1, unit: "head" },
          { name: "Olive oil", quantity: 2, unit: "tbsp" },
        ],
        steps: [
          { text: "Cut into florets." },
          { text: "Roast at 450F for 18 minutes.", estimatedMinutes: 18 },
        ],
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as { dish: { id: string } };
      assert.equal(body.dish.id, "dish-1");

      assert.equal(captured.mealCreates.length, 0, "no Meal row written");
      assert.equal(captured.dishCreates.length, 1);
      assert.equal(captured.dishIngredientCreates.length, 2);
      assert.equal(captured.stepCreates.length, 2);
      for (const step of captured.stepCreates) {
        assert.equal(step.ownerType, "dish");
      }
      // Optional step field flows through.
      assert.equal(captured.stepCreates[1].estimatedMinutes, 18);

      // Ingredients are upserted via the shared resolver.
      assert.equal(captured.ingredientUpserts.length, 2);
      const broccoli = captured.ingredientUpserts.find(
        (u) => u.canonicalName === "broccoli",
      );
      assert.ok(broccoli);
      assert.equal(broccoli.create.category, "Produce");
    } finally {
      await harness.close();
    }
  });

  it("rejects invalid body with 400", async () => {
    const { prisma } = makeStub();
    const harness = await spinUp(prisma);
    try {
      const res = await authPost(harness, "/me/dishes", { title: "" });
      assert.equal(res.status, 400);
    } finally {
      await harness.close();
    }
  });

  it("returns 401 without auth", async () => {
    const { prisma } = makeStub();
    const harness = await spinUp(prisma);
    try {
      const res = await fetch(`${harness.baseUrl}/me/dishes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "x",
          ingredients: [{ name: "x", quantity: 1, unit: "g" }],
          steps: [],
        }),
      });
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });
});

// ── WS7-6 Fix-Block 3 — meal-row macros are the simple sum of dish macros ──
//
// Bug 3 background: Meal.*PerServing was 0 on every meal in the DB because
// no write path summed dish macros up to the meal row. The aggregation
// helper now runs at the end of materializeMeal + rematerializeMeal +
// wizardActivation + computePlanMacros (Hans's ruling: simple per-serving
// sum across linked dishes; dish serving counts NOT in the formula).
//
// This test pins the write-path: a POST /me/meals that creates 3 dishes
// (no macros in payload — server doesn't trust client values for this) but
// where each freshly-created dish has known per-serving macros must end
// with a Meal row whose macros are the sum.

describe("WS7-6 Fix-Block 3: meal-row macros = Σ dish per-serving macros", () => {
  it("POST /me/meals writes Meal.*PerServing = sum of linked dishes' per-serving values", async () => {
    // Stub configures per-dish macros keyed by the synthetic dish id the
    // stub assigns in order (dish-1, dish-2, dish-3). Hans's example:
    // 50 + 100 + 200 → 350.
    const { prisma, captured } = makeStub({
      dishMacrosById: {
        "dish-1": {
          caloriesPerServing: 50,
          proteinGPerServing: 2,
          carbsGPerServing: 8,
          fatGPerServing: 0.3,
        },
        "dish-2": {
          caloriesPerServing: 100,
          proteinGPerServing: 25,
          carbsGPerServing: 0,
          fatGPerServing: 3,
        },
        "dish-3": {
          caloriesPerServing: 200,
          proteinGPerServing: 4,
          carbsGPerServing: 40,
          fatGPerServing: 0.5,
        },
      },
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPost(harness, "/me/meals", {
        title: "Lettuce + chicken + potatoes",
        dishes: [
          {
            kind: "new",
            title: "Lettuce",
            role: "side",
            positionIndex: 0,
            ingredients: [{ name: "Lettuce", quantity: 1, unit: "head" }],
            steps: [{ text: "Wash." }],
          },
          {
            kind: "new",
            title: "Chicken",
            role: "main",
            positionIndex: 1,
            ingredients: [{ name: "Chicken breast", quantity: 1, unit: "lb" }],
            steps: [{ text: "Grill." }],
          },
          {
            kind: "new",
            title: "Potatoes",
            role: "side",
            positionIndex: 2,
            ingredients: [{ name: "Potato", quantity: 1, unit: "lb" }],
            steps: [{ text: "Roast." }],
          },
        ],
      });
      assert.equal(res.status, 201);

      // One Meal.update must land — recomputeAndPersistMealMacros.
      assert.equal(captured.mealUpdates.length, 1, "exactly one Meal.update after dish writes");
      const update = captured.mealUpdates[0];
      assert.equal(update.id, "meal-1");
      assert.equal(update.data.caloriesPerServing, 350, "Hans's 50+100+200 = 350");
      assert.equal(update.data.proteinGPerServing, 31);
      assert.equal(update.data.carbsGPerServing, 48);
      const fat = update.data.fatGPerServing as number;
      assert.ok(
        Math.abs(fat - 3.8) < 1e-9,
        `fatGPerServing ${fat} should ≈ 3.8 (0.3 + 3 + 0.5)`,
      );
    } finally {
      await harness.close();
    }
  });

  it("a meal whose dishes have 0-macro rows writes an honest 0-sum (no fabrication)", async () => {
    // Default opts → dishMacrosById is empty → every dish lookup returns
    // {0,0,0,0}. The meal update should write all-zero — that is the
    // honest aggregation, not a bug. Dish macro ESTIMATION is a separate
    // concern (USDA/AI; out of scope for Block 3).
    const { prisma, captured } = makeStub();
    const harness = await spinUp(prisma);
    try {
      const res = await authPost(harness, "/me/meals", {
        title: "Zero-macro meal",
        dishes: [
          {
            kind: "new",
            title: "Plain rice",
            role: "main",
            positionIndex: 0,
            ingredients: [{ name: "Rice", quantity: 1, unit: "cup" }],
            steps: [{ text: "Cook." }],
          },
        ],
      });
      assert.equal(res.status, 201);
      assert.equal(captured.mealUpdates.length, 1);
      assert.equal(captured.mealUpdates[0].data.caloriesPerServing, 0);
    } finally {
      await harness.close();
    }
  });
});

// ── WS7-6 Fix-Block 1A — ingredient resolution happens BEFORE $transaction ─
//
// Regression: in the pre-fix code, materializeMeal/Dish/etc called
// resolveIngredients (N serial ingredient.upsert roundtrips) as the first
// operation INSIDE the prisma.$transaction(...) callback in routes/me.ts.
// The upserts used the outer client but their wall-clock time still
// counted against the 5000ms tx budget — cold paths blew it (5045ms /
// 5000ms in the device-test cluster).
//
// The fix hoists Pass 1 out of $transaction. These tests pin the new
// call ORDER: every ingredient.upsert MUST settle before $transaction
// opens. A stub that logs events gives us a deterministic ordering
// assertion that survives any future internal refactor.
//
// Coverage: all four routes that materialize sub-graphs:
//   - POST /me/meals      → materializeMeal
//   - POST /me/dishes     → materializeDish
//   - PATCH /me/meals/:id → rematerializeMeal
//   - PATCH /me/dishes/:id → rematerializeDish

interface OrderingHarnessOpts {
  // When set, makes the dish.findUnique / meal.findUnique calls return a
  // pre-existing row for the PATCH routes (used by both rematerialize
  // tests).
  existingMeal?: { id: string; userId: string };
  existingDish?: { id: string; userId: string; isArchived?: boolean };
}

function makeOrderingStub(opts: OrderingHarnessOpts = {}) {
  const events: string[] = [];
  let nextMealId = 1;
  let nextDishId = 1;

  const surface = {
    ingredient: {
      upsert: async (args: {
        where: { canonicalName: string };
        create: Record<string, unknown>;
      }) => {
        events.push(`upsert:${args.where.canonicalName}`);
        return {
          id: `ing-${args.where.canonicalName.replace(/\s+/g, "-")}`,
        };
      },
    },
    dish: {
      findUnique: async (args: { where: { id: string } }) => {
        events.push(`dish.findUnique:${args.where.id}`);
        if (opts.existingDish && opts.existingDish.id === args.where.id) {
          return opts.existingDish;
        }
        return null;
      },
      findMany: async () => {
        events.push(`dish.findMany`);
        return [];
      },
      create: async () => {
        events.push(`dish.create`);
        return { id: `dish-${nextDishId++}` };
      },
      deleteMany: async () => {
        events.push(`dish.deleteMany`);
        return { count: 0 };
      },
    },
    meal: {
      findUnique: async (args: { where: { id: string } }) => {
        events.push(`meal.findUnique:${args.where.id}`);
        if (opts.existingMeal && opts.existingMeal.id === args.where.id) {
          return opts.existingMeal;
        }
        return null;
      },
      create: async () => {
        events.push(`meal.create`);
        return { id: `meal-${nextMealId++}` };
      },
      update: async () => {
        events.push(`meal.update`);
        return {};
      },
    },
    mealDishLink: {
      findMany: async () => {
        events.push(`mealDishLink.findMany`);
        return [];
      },
      create: async () => {
        events.push(`mealDishLink.create`);
        return {};
      },
      deleteMany: async () => {
        events.push(`mealDishLink.deleteMany`);
        return { count: 0 };
      },
    },
    dishIngredient: {
      create: async () => {
        events.push(`dishIngredient.create`);
        return {};
      },
      deleteMany: async () => {
        events.push(`dishIngredient.deleteMany`);
        return { count: 0 };
      },
    },
    recipeInstructionStep: {
      create: async () => {
        events.push(`recipeInstructionStep.create`);
        return {};
      },
      deleteMany: async () => {
        events.push(`recipeInstructionStep.deleteMany`);
        return { count: 0 };
      },
    },
    $transaction: async <T>(
      fn: (tx: unknown) => Promise<T>,
      _opts?: { timeout?: number },
    ): Promise<T> => {
      events.push("tx:start");
      const result = await fn(surface);
      events.push("tx:end");
      return result;
    },
  };

  return { prisma: surface, events };
}

function assertAllUpsertsBeforeTx(events: string[]): void {
  const txStart = events.indexOf("tx:start");
  assert.ok(
    txStart > -1,
    `expected tx:start in event log; got: ${events.join(", ")}`,
  );
  const upsertIndices = events
    .map((e, i) => (e.startsWith("upsert:") ? i : -1))
    .filter((i) => i !== -1);
  for (const idx of upsertIndices) {
    assert.ok(
      idx < txStart,
      `ingredient.upsert at index ${idx} ran INSIDE $transaction ` +
        `(tx:start at ${txStart}) — Pass 1 was not hoisted. ` +
        `Events: ${events.join(", ")}`,
    );
  }
}

describe("WS7-6 Fix-Block 1A: ingredient resolution happens before $transaction", () => {
  it("POST /me/meals: all ingredient.upserts settle before tx:start", async () => {
    const { prisma, events } = makeOrderingStub();
    const harness = await spinUp(prisma);
    try {
      const res = await authPost(harness, "/me/meals", {
        title: "Order-check meal",
        dishes: [
          {
            kind: "new",
            title: "Dish A",
            role: "main",
            positionIndex: 0,
            ingredients: [
              { name: "Salt", quantity: 1, unit: "tsp" },
              { name: "Pepper", quantity: 1, unit: "tsp" },
              { name: "Garlic", quantity: 2, unit: "clove" },
            ],
            steps: [{ text: "Mix." }],
          },
        ],
      });
      assert.equal(res.status, 201);
      assertAllUpsertsBeforeTx(events);
      // Sanity: at least the upserts we expected fired.
      const upserts = events.filter((e) => e.startsWith("upsert:"));
      assert.equal(upserts.length, 3);
    } finally {
      await harness.close();
    }
  });

  it("POST /me/dishes: all ingredient.upserts settle before tx:start", async () => {
    const { prisma, events } = makeOrderingStub();
    const harness = await spinUp(prisma);
    try {
      const res = await authPost(harness, "/me/dishes", {
        title: "Order-check dish",
        ingredients: [
          { name: "Flour", quantity: 1, unit: "cup" },
          { name: "Sugar", quantity: 1, unit: "cup" },
        ],
        steps: [{ text: "Combine." }],
      });
      assert.equal(res.status, 201);
      assertAllUpsertsBeforeTx(events);
      const upserts = events.filter((e) => e.startsWith("upsert:"));
      assert.equal(upserts.length, 2);
    } finally {
      await harness.close();
    }
  });

  it("PATCH /me/meals/:id: all ingredient.upserts settle before tx:start (the device-test bug surface)", async () => {
    const { prisma, events } = makeOrderingStub({
      existingMeal: { id: "meal-existing", userId: USER_ID },
    });
    const harness = await spinUp(prisma);
    try {
      const res = await fetch(`${harness.baseUrl}/me/meals/meal-existing`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${signToken(USER_ID)}`,
        },
        body: JSON.stringify({
          dishes: [
            {
              kind: "new",
              title: "Patched dish",
              role: "main",
              positionIndex: 0,
              ingredients: [
                { name: "Olive oil", quantity: 2, unit: "tbsp" },
                { name: "Lemon", quantity: 1, unit: "whole" },
                { name: "Parsley", quantity: 1, unit: "bunch" },
              ],
              steps: [{ text: "Drizzle." }],
            },
          ],
        }),
      });
      assert.equal(res.status, 200);
      assertAllUpsertsBeforeTx(events);
      const upserts = events.filter((e) => e.startsWith("upsert:"));
      assert.equal(upserts.length, 3);
    } finally {
      await harness.close();
    }
  });

  it("PATCH /me/dishes/:id: all ingredient.upserts settle before tx:start", async () => {
    const { prisma, events } = makeOrderingStub({
      existingDish: { id: "dish-existing", userId: USER_ID, isArchived: false },
    });
    const harness = await spinUp(prisma);
    try {
      const res = await fetch(`${harness.baseUrl}/me/dishes/dish-existing`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${signToken(USER_ID)}`,
        },
        body: JSON.stringify({
          ingredients: [
            { name: "Butter", quantity: 2, unit: "tbsp" },
            { name: "Garlic", quantity: 3, unit: "clove" },
          ],
        }),
      });
      assert.equal(res.status, 200);
      assertAllUpsertsBeforeTx(events);
      const upserts = events.filter((e) => e.startsWith("upsert:"));
      assert.equal(upserts.length, 2);
    } finally {
      await harness.close();
    }
  });

  it("PATCH /me/dishes/:id without an ingredients patch skips the upsert pass entirely", async () => {
    const { prisma, events } = makeOrderingStub({
      existingDish: { id: "dish-existing", userId: USER_ID, isArchived: false },
    });
    const harness = await spinUp(prisma);
    try {
      const res = await fetch(`${harness.baseUrl}/me/dishes/dish-existing`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${signToken(USER_ID)}`,
        },
        // steps-only patch: ingredients not present, mentions list stays
        // empty, so the route MUST NOT call resolveIngredients at all.
        body: JSON.stringify({
          steps: [{ text: "Updated step." }],
        }),
      });
      assert.equal(res.status, 200);
      const upserts = events.filter((e) => e.startsWith("upsert:"));
      assert.equal(upserts.length, 0);
      // tx:start still fires because the steps patch triggers subgraph work.
      assert.ok(events.includes("tx:start"));
    } finally {
      await harness.close();
    }
  });
});

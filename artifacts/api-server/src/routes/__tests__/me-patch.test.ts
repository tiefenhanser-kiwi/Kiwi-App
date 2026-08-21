// WS7-6 1A — PATCH /me/meals/:id + PATCH /me/dishes/:id endpoint tests.
//
// Coverage threads:
//   1. Owner gate: 404 missing, 404 archived, 403 foreign, 403 catalog
//      (userId: null). Both endpoints.
//   2. At-least-one-field: empty body → 400.
//   3. Scalar-only patch: no sub-graph wipe (no deleteMany calls), just
//      meal.update / dish.update.
//   4. Sub-graph patch: full wipe-and-recreate. Asserts the
//      no-orphan-RecipeInstructionStep contract by counting deleteMany
//      calls for ownerType="dish" (over the exclusive dish ids) AND
//      ownerType="meal" (defensive).
//   5. Shared-dish guard: a dish linked to another meal is NOT deleted
//      from the Dish table; only the MealDishLink to the patched meal
//      is dropped.
//   6. Catalog-dish guard: a userId:null dish currently linked is NOT
//      deleted by the wipe.
//
// Same lightweight harness as me-save-canonical.test.ts (real JWT,
// prisma stubbed at the factory deps boundary, no DB). The stub here
// extends the save-canonical stub with findUnique/findMany/update/
// deleteMany capture surfaces so the wipe path can be asserted.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { createMeRouter } from "../me";

const USER_ID = "test-user-patch";

interface Captured {
  ingredientUpserts: Array<{ canonicalName: string }>;
  mealCreates: Array<Record<string, unknown>>;
  mealUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  dishCreates: Array<Record<string, unknown>>;
  dishUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  linkCreates: Array<Record<string, unknown>>;
  linkFindMany: Array<{ where: Record<string, unknown> }>;
  linkDeleteMany: Array<{ where: Record<string, unknown> }>;
  dishIngredientCreates: Array<Record<string, unknown>>;
  dishIngredientDeleteMany: Array<{ where: Record<string, unknown> }>;
  stepCreates: Array<Record<string, unknown>>;
  // Each entry is one tx.recipeInstructionStep.deleteMany call. Tests
  // assert on { ownerType, ownerId } shape per call to prove every
  // (ownerType, ownerId) row is covered.
  stepDeleteMany: Array<{ where: Record<string, unknown> }>;
  dishFindMany: Array<{ where: Record<string, unknown> }>;
  dishDeleteMany: Array<{ where: Record<string, unknown> }>;
  // WS7-7-A Block 5 — captures each mealPlanInstance.update (the bumpPlanId
  // revision bump) so apply-every-time tests can assert WHICH plan moved.
  planBumps: Array<{ id: string }>;
}

interface PlanRow {
  id: string;
  userId: string;
  revisionId: number;
}

interface MealRow {
  id: string;
  userId: string | null;
  isArchived: boolean;
}
interface DishRow {
  id: string;
  userId: string | null;
  isArchived: boolean;
}
interface LinkRow {
  mealId: string;
  dishId: string;
}

interface StubOpts {
  meals?: MealRow[];
  dishes?: DishRow[];
  // Pre-existing MealDishLink rows. Used by the wipe path to discover
  // which dishes are linked to the meal being patched (and which of
  // those are shared with other meals).
  links?: LinkRow[];
  // WS7-7-A Block 5 — plans the bumpPlanId path can target.
  plans?: PlanRow[];
}

function makeStub(opts: StubOpts = {}) {
  const captured: Captured = {
    ingredientUpserts: [],
    mealCreates: [],
    mealUpdates: [],
    dishCreates: [],
    dishUpdates: [],
    linkCreates: [],
    linkFindMany: [],
    linkDeleteMany: [],
    dishIngredientCreates: [],
    dishIngredientDeleteMany: [],
    stepCreates: [],
    stepDeleteMany: [],
    dishFindMany: [],
    dishDeleteMany: [],
    planBumps: [],
  };

  const meals = [...(opts.meals ?? [])];
  const dishes = [...(opts.dishes ?? [])];
  let links = [...(opts.links ?? [])];
  const plans = [...(opts.plans ?? [])];

  let nextMealId = 1;
  let nextDishId = 1;

  const surface = {
    // WS9 BUG-096 — the alias-aware lookup consults this after a canonical
    // miss. Empty = "no aliases in this fixture" (the pre-merge state);
    // alias BEHAVIOUR is covered in ingredientLookup.test.ts.
    ingredientAlias: {
      findUnique: async () => null,
      findMany: async () => [],
    },
    ingredient: {
      // WS9 BUG-096 — resolveIngredients now batch-checks for existing rows
      // before upserting. Empty = "the catalog has none of these yet", which is
      // exactly what this fixture asserts by expecting an upsert per mention.
      findMany: async () => [],
      upsert: async (args: {
        where: { canonicalName: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        captured.ingredientUpserts.push({ canonicalName: args.where.canonicalName });
        return { id: `ing-${args.where.canonicalName.replace(/\s+/g, "-")}` };
      },
    },
    meal: {
      findUnique: async (args: {
        where: { id: string };
        select?: Record<string, boolean>;
      }) => {
        const m = meals.find((row) => row.id === args.where.id);
        return m ? { ...m } : null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        captured.mealCreates.push(args.data);
        return { id: `meal-${nextMealId++}` };
      },
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        captured.mealUpdates.push({ where: args.where, data: args.data });
        return { id: args.where.id };
      },
    },
    dish: {
      findUnique: async (args: {
        where: { id: string };
        select?: Record<string, boolean>;
      }) => {
        const d = dishes.find((row) => row.id === args.where.id);
        return d ? { ...d } : null;
      },
      findMany: async (args: { where: Record<string, unknown> }) => {
        captured.dishFindMany.push({ where: args.where });
        const where = args.where as {
          id?: { in: string[] };
          isArchived?: boolean;
        };
        const ids = where.id?.in ?? [];
        return dishes
          .filter((d) => ids.includes(d.id))
          .filter((d) =>
            where.isArchived === undefined ? true : d.isArchived === where.isArchived,
          )
          .map((d) => ({ id: d.id, userId: d.userId }));
      },
      create: async (args: { data: Record<string, unknown> }) => {
        captured.dishCreates.push(args.data);
        const id = `dish-new-${nextDishId++}`;
        dishes.push({ id, userId: USER_ID, isArchived: false });
        return { id };
      },
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        captured.dishUpdates.push({ where: args.where, data: args.data });
        return { id: args.where.id };
      },
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        captured.dishDeleteMany.push({ where: args.where });
        const where = args.where as { id?: { in: string[] } };
        const ids = new Set(where.id?.in ?? []);
        const removed = dishes.filter((d) => ids.has(d.id));
        for (let i = dishes.length - 1; i >= 0; i--) {
          if (ids.has(dishes[i].id)) dishes.splice(i, 1);
        }
        return { count: removed.length };
      },
    },
    mealDishLink: {
      findMany: async (args: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
        captured.linkFindMany.push({ where: args.where });
        const where = args.where as {
          mealId?: string | { not: string };
          dishId?: { in: string[] };
        };
        const matched = links.filter((l) => {
          if (typeof where.mealId === "string") {
            if (l.mealId !== where.mealId) return false;
          } else if (where.mealId && typeof where.mealId === "object") {
            if (l.mealId === (where.mealId as { not: string }).not) return false;
          }
          if (where.dishId?.in) {
            if (!where.dishId.in.includes(l.dishId)) return false;
          }
          return true;
        });
        // WS7-6 Fix-Block 3: recomputeAndPersistMealMacros selects
        // { dish: { select: <macros> } }. Other callers (the wipe paths
        // above) select dishId only. Branch on whether the caller asked
        // for the dish join and synthesize the row shape accordingly. No
        // configured per-dish macros in this test file → default to 0.
        const wantsDish =
          args.select !== undefined &&
          (args.select as Record<string, unknown>).dish !== undefined;
        if (wantsDish) {
          return matched.map(() => ({
            dish: {
              caloriesPerServing: 0,
              proteinGPerServing: 0,
              carbsGPerServing: 0,
              fatGPerServing: 0,
            },
          }));
        }
        return matched.map((l) => ({ ...l }));
      },
      create: async (args: { data: Record<string, unknown> }) => {
        captured.linkCreates.push(args.data);
        links.push({
          mealId: args.data.mealId as string,
          dishId: args.data.dishId as string,
        });
        return {};
      },
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        captured.linkDeleteMany.push({ where: args.where });
        const where = args.where as { mealId?: string };
        const remaining = links.filter((l) => l.mealId !== where.mealId);
        const removed = links.length - remaining.length;
        links = remaining;
        return { count: removed };
      },
    },
    dishIngredient: {
      create: async (args: { data: Record<string, unknown> }) => {
        captured.dishIngredientCreates.push(args.data);
        return {};
      },
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        captured.dishIngredientDeleteMany.push({ where: args.where });
        return { count: 0 };
      },
    },
    recipeInstructionStep: {
      create: async (args: { data: Record<string, unknown> }) => {
        captured.stepCreates.push(args.data);
        return {};
      },
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        captured.stepDeleteMany.push({ where: args.where });
        return { count: 0 };
      },
    },
    // WS7-7-A Block 5 — apply-every-time current-plan bump. findFirst is the
    // ownership gate; update is bumpPlanRevision's increment.
    mealPlanInstance: {
      findFirst: async (args: {
        where: { id: string; userId: string };
        select?: Record<string, boolean>;
      }) => {
        const p = plans.find(
          (row) => row.id === args.where.id && row.userId === args.where.userId,
        );
        return p ? { id: p.id } : null;
      },
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
        select?: Record<string, boolean>;
      }) => {
        captured.planBumps.push({ id: args.where.id });
        const p = plans.find((row) => row.id === args.where.id);
        if (!p) throw new Error("plan not found");
        p.revisionId += 1;
        return { revisionId: p.revisionId };
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(surface),
  };

  return { prisma: surface, captured, getPlans: () => plans, getLinks: () => links };
}

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

function authPatch(harness: Harness, path: string, body: unknown) {
  return fetch(`${harness.baseUrl}${path}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${signToken(USER_ID)}`,
    },
    body: JSON.stringify(body),
  });
}

// ── PATCH /me/meals/:id — owner gate ────────────────────────────────────

describe("PATCH /me/meals/:id (owner gate)", () => {
  it("returns 404 when the meal does not exist", async () => {
    const { prisma } = makeStub();
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/meals/meal-missing", {
        title: "Updated",
      });
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when the meal is archived", async () => {
    const { prisma } = makeStub({
      meals: [{ id: "meal-archived", userId: USER_ID, isArchived: true }],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/meals/meal-archived", {
        title: "Updated",
      });
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("returns 403 when the meal belongs to another user", async () => {
    const { prisma } = makeStub({
      meals: [{ id: "meal-foreign", userId: "other-user", isArchived: false }],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/meals/meal-foreign", {
        title: "Updated",
      });
      assert.equal(res.status, 403);
    } finally {
      await harness.close();
    }
  });

  it("returns 403 for a curated/null-owner meal (not patchable by user)", async () => {
    const { prisma } = makeStub({
      meals: [{ id: "meal-catalog", userId: null, isArchived: false }],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/meals/meal-catalog", {
        title: "Updated",
      });
      assert.equal(res.status, 403);
    } finally {
      await harness.close();
    }
  });

  it("returns 401 without an auth header", async () => {
    const { prisma } = makeStub({
      meals: [{ id: "meal-1", userId: USER_ID, isArchived: false }],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await fetch(`${harness.baseUrl}/me/meals/meal-1`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      });
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });
});

// ── PATCH /me/meals/:id — body validation ───────────────────────────────

describe("PATCH /me/meals/:id (body validation)", () => {
  it("rejects an empty patch with 400 (at-least-one-field)", async () => {
    const { prisma } = makeStub({
      meals: [{ id: "meal-1", userId: USER_ID, isArchived: false }],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/meals/meal-1", {});
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "invalid body");
    } finally {
      await harness.close();
    }
  });

  it("rejects unknown fields (.strict)", async () => {
    const { prisma } = makeStub({
      meals: [{ id: "meal-1", userId: USER_ID, isArchived: false }],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/meals/meal-1", {
        title: "ok",
        bogus: 1,
      });
      assert.equal(res.status, 400);
    } finally {
      await harness.close();
    }
  });
});

// ── PATCH /me/meals/:id — scalar-only patch ─────────────────────────────

describe("PATCH /me/meals/:id (scalar-only)", () => {
  it("updates only the Meal row with no sub-graph wipe", async () => {
    const { prisma, captured } = makeStub({
      meals: [{ id: "meal-1", userId: USER_ID, isArchived: false }],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/meals/meal-1", {
        title: "Renamed",
        description: "New description",
        difficulty: "medium",
      });
      assert.equal(res.status, 200);
      assert.equal(captured.mealUpdates.length, 1);
      assert.equal(captured.mealUpdates[0].where.id, "meal-1");
      assert.equal(captured.mealUpdates[0].data.title, "Renamed");
      assert.equal(captured.mealUpdates[0].data.description, "New description");
      assert.equal(captured.mealUpdates[0].data.difficulty, "medium");

      // No wipe — none of the deleteMany surfaces should have been hit.
      assert.equal(captured.linkDeleteMany.length, 0);
      assert.equal(captured.dishDeleteMany.length, 0);
      assert.equal(captured.dishIngredientDeleteMany.length, 0);
      assert.equal(captured.stepDeleteMany.length, 0);
      // And no recreate writes either.
      assert.equal(captured.dishCreates.length, 0);
      assert.equal(captured.linkCreates.length, 0);
      assert.equal(captured.stepCreates.length, 0);
    } finally {
      await harness.close();
    }
  });
});

// ── PATCH /me/meals/:id — Block 5 apply-every-time (bumpPlanId) ──────────

describe("PATCH /me/meals/:id (bumpPlanId / apply-every-time)", () => {
  it("bumps ONLY the named plan's revision; other plans keep their snapshot", async () => {
    const { prisma, captured, getPlans } = makeStub({
      meals: [{ id: "meal-1", userId: USER_ID, isArchived: false }],
      plans: [
        { id: "plan-current", userId: USER_ID, revisionId: 3 },
        { id: "plan-other", userId: USER_ID, revisionId: 9 },
      ],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/meals/meal-1", {
        title: "Edited globally",
        bumpPlanId: "plan-current",
      });
      assert.equal(res.status, 200);
      assert.equal(captured.mealUpdates.length, 1); // global meal edited
      // Exactly one plan bumped — the current one.
      assert.deepEqual(captured.planBumps, [{ id: "plan-current" }]);
      const plans = getPlans();
      assert.equal(plans.find((p) => p.id === "plan-current")!.revisionId, 4);
      // The OTHER plan that also contains this meal is untouched (boundary).
      assert.equal(plans.find((p) => p.id === "plan-other")!.revisionId, 9);
    } finally {
      await harness.close();
    }
  });

  it("absent bumpPlanId touches no plan (D-WS7-136 forward-only for library edits)", async () => {
    const { prisma, captured } = makeStub({
      meals: [{ id: "meal-1", userId: USER_ID, isArchived: false }],
      plans: [{ id: "plan-x", userId: USER_ID, revisionId: 1 }],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/meals/meal-1", {
        title: "Plain library edit",
      });
      assert.equal(res.status, 200);
      assert.equal(captured.planBumps.length, 0);
    } finally {
      await harness.close();
    }
  });

  it("a foreign-owned bumpPlanId is silently skipped; the meal edit still succeeds", async () => {
    const { prisma, captured } = makeStub({
      meals: [{ id: "meal-1", userId: USER_ID, isArchived: false }],
      plans: [{ id: "plan-foreign", userId: "someone-else", revisionId: 2 }],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/meals/meal-1", {
        title: "Edit",
        bumpPlanId: "plan-foreign",
      });
      assert.equal(res.status, 200);
      assert.equal(captured.mealUpdates.length, 1);
      assert.equal(captured.planBumps.length, 0); // ownership gate held
    } finally {
      await harness.close();
    }
  });
});

// ── PATCH /me/meals/:id — wipe-and-recreate ─────────────────────────────

describe("PATCH /me/meals/:id (dishes wipe-and-recreate)", () => {
  it("wipes and recreates the sub-graph, with explicit (ownerType, ownerId) step deletion (no orphans)", async () => {
    const { prisma, captured, getLinks } = makeStub({
      meals: [{ id: "meal-1", userId: USER_ID, isArchived: false }],
      dishes: [
        { id: "dish-old-1", userId: USER_ID, isArchived: false },
        { id: "dish-old-2", userId: USER_ID, isArchived: false },
      ],
      links: [
        { mealId: "meal-1", dishId: "dish-old-1" },
        { mealId: "meal-1", dishId: "dish-old-2" },
      ],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/meals/meal-1", {
        title: "Patched",
        dishes: [
          {
            kind: "new",
            title: "Replacement dish",
            role: "main",
            positionIndex: 0,
            ingredients: [{ name: "Garlic", quantity: 2, unit: "clove" }],
            steps: [{ text: "Mince." }],
          },
        ],
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        meal: { id: string; dishIds: string[]; linksCreated: number };
      };
      assert.equal(body.meal.id, "meal-1");
      assert.equal(body.meal.linksCreated, 1);
      assert.equal(body.meal.dishIds.length, 1);

      // Old dish rows are deleted (exclusive to meal-1, owned by user).
      assert.equal(captured.dishDeleteMany.length, 1);
      const deletedIds = (captured.dishDeleteMany[0].where as {
        id: { in: string[] };
      }).id.in;
      assert.deepEqual(deletedIds.sort(), ["dish-old-1", "dish-old-2"].sort());

      // RecipeInstructionStep deleted by (ownerType, ownerId) — TWO calls:
      // one for ownerType="dish" (over the exclusive dish ids), one for
      // ownerType="meal" (defensive). This is the no-orphan contract.
      assert.equal(captured.stepDeleteMany.length, 2);
      const dishStepDel = captured.stepDeleteMany.find(
        (c) =>
          (c.where as { ownerType?: string }).ownerType === "dish" &&
          (c.where as { ownerId?: { in?: string[] } }).ownerId !== undefined,
      );
      assert.ok(dishStepDel, "must deleteMany RecipeInstructionStep for ownerType=dish");
      const mealStepDel = captured.stepDeleteMany.find(
        (c) =>
          (c.where as { ownerType?: string }).ownerType === "meal" &&
          (c.where as { ownerId?: string }).ownerId === "meal-1",
      );
      assert.ok(mealStepDel, "must deleteMany RecipeInstructionStep for ownerType=meal");

      // DishIngredient deletion covers the exclusive dish ids.
      assert.equal(captured.dishIngredientDeleteMany.length, 1);

      // Link deletion (all current links for the meal) + 1 new link recreated.
      assert.equal(captured.linkDeleteMany.length, 1);
      assert.equal(captured.linkCreates.length, 1);

      // Scalar update on the meal row also happened. WS7-6 Fix-Block 3
      // adds a SECOND meal.update at the end of rematerializeMeal that
      // writes the aggregated per-serving macros (sum of dish macros).
      // First update = scalar patch; second = Block-3 macro aggregation.
      assert.equal(captured.mealUpdates.length, 2);
      assert.equal(captured.mealUpdates[0].data.title, "Patched");
      // The second update writes per-serving macro fields; with default
      // 0-macro dish rows in this stub it lands as 0 (honest aggregation).
      assert.equal(captured.mealUpdates[1].data.caloriesPerServing, 0);

      // New dish written.
      assert.equal(captured.dishCreates.length, 1);
      assert.equal(captured.stepCreates.length, 1);

      // Final link state: one fresh link from meal-1 to the new dish.
      const finalLinks = getLinks();
      assert.equal(finalLinks.length, 1);
      assert.equal(finalLinks[0].mealId, "meal-1");
    } finally {
      await harness.close();
    }
  });

  it("does NOT delete a dish linked to another meal (shared-dish guard)", async () => {
    const { prisma, captured } = makeStub({
      meals: [{ id: "meal-1", userId: USER_ID, isArchived: false }],
      dishes: [
        { id: "dish-shared", userId: USER_ID, isArchived: false },
        { id: "dish-exclusive", userId: USER_ID, isArchived: false },
      ],
      links: [
        { mealId: "meal-1", dishId: "dish-shared" },
        { mealId: "meal-1", dishId: "dish-exclusive" },
        // dish-shared is also linked to meal-OTHER — must survive the wipe.
        { mealId: "meal-OTHER", dishId: "dish-shared" },
      ],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/meals/meal-1", {
        dishes: [
          {
            kind: "new",
            title: "Replacement",
            role: "main",
            positionIndex: 0,
            ingredients: [{ name: "Salt", quantity: 1, unit: "tsp" }],
            steps: [{ text: "Sprinkle." }],
          },
        ],
      });
      assert.equal(res.status, 200);

      // Only dish-exclusive should be deleted; dish-shared must survive.
      assert.equal(captured.dishDeleteMany.length, 1);
      const deletedIds = (captured.dishDeleteMany[0].where as {
        id: { in: string[] };
      }).id.in;
      assert.deepEqual(deletedIds, ["dish-exclusive"]);
      assert.ok(
        !deletedIds.includes("dish-shared"),
        "shared dish must not be deleted",
      );

      // The step/ingredient wipe is scoped to the exclusive ids only —
      // dish-shared's sub-rows stay intact.
      const dishStepDel = captured.stepDeleteMany.find(
        (c) => (c.where as { ownerType?: string }).ownerType === "dish",
      );
      assert.ok(dishStepDel);
      const owners = (dishStepDel.where as { ownerId: { in: string[] } })
        .ownerId.in;
      assert.deepEqual(owners, ["dish-exclusive"]);
    } finally {
      await harness.close();
    }
  });

  it("does NOT delete a catalog (userId: null) dish", async () => {
    const { prisma, captured } = makeStub({
      meals: [{ id: "meal-1", userId: USER_ID, isArchived: false }],
      dishes: [
        { id: "dish-catalog", userId: null, isArchived: false },
      ],
      links: [{ mealId: "meal-1", dishId: "dish-catalog" }],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/meals/meal-1", {
        dishes: [
          {
            kind: "new",
            title: "Replacement",
            role: "main",
            positionIndex: 0,
            ingredients: [{ name: "Olive oil", quantity: 1, unit: "tbsp" }],
            steps: [],
          },
        ],
      });
      assert.equal(res.status, 200);

      // No dish deletions: catalog dish must survive.
      // (The wipe will still call dishDeleteMany with an empty id list,
      // OR skip the call entirely — both are acceptable. Check that
      // dish-catalog was NOT in any delete batch.)
      for (const del of captured.dishDeleteMany) {
        const ids =
          (del.where as { id?: { in?: string[] } }).id?.in ?? [];
        assert.ok(
          !ids.includes("dish-catalog"),
          "catalog dish must not be deleted",
        );
      }
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when a linked dish in the new payload does not exist", async () => {
    const { prisma } = makeStub({
      meals: [{ id: "meal-1", userId: USER_ID, isArchived: false }],
      dishes: [],
      links: [],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/meals/meal-1", {
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
    } finally {
      await harness.close();
    }
  });
});

// ── PATCH /me/dishes/:id ────────────────────────────────────────────────

describe("PATCH /me/dishes/:id (owner gate)", () => {
  it("returns 404 when the dish does not exist", async () => {
    const { prisma } = makeStub();
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/dishes/dish-missing", {
        title: "Updated",
      });
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 when the dish is archived", async () => {
    const { prisma } = makeStub({
      dishes: [{ id: "dish-1", userId: USER_ID, isArchived: true }],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/dishes/dish-1", {
        title: "Updated",
      });
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("returns 403 when the dish belongs to another user", async () => {
    const { prisma } = makeStub({
      dishes: [{ id: "dish-1", userId: "other-user", isArchived: false }],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/dishes/dish-1", {
        title: "Updated",
      });
      assert.equal(res.status, 403);
    } finally {
      await harness.close();
    }
  });

  it("returns 403 for a curated (userId: null) dish", async () => {
    const { prisma } = makeStub({
      dishes: [{ id: "dish-1", userId: null, isArchived: false }],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/dishes/dish-1", {
        title: "Updated",
      });
      assert.equal(res.status, 403);
    } finally {
      await harness.close();
    }
  });
});

describe("PATCH /me/dishes/:id (body validation)", () => {
  it("rejects an empty patch with 400 (at-least-one-field)", async () => {
    const { prisma } = makeStub({
      dishes: [{ id: "dish-1", userId: USER_ID, isArchived: false }],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/dishes/dish-1", {});
      assert.equal(res.status, 400);
    } finally {
      await harness.close();
    }
  });
});

describe("PATCH /me/dishes/:id (scalar-only)", () => {
  it("updates only the Dish row with no sub-graph wipe", async () => {
    const { prisma, captured } = makeStub({
      dishes: [{ id: "dish-1", userId: USER_ID, isArchived: false }],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/dishes/dish-1", {
        title: "Renamed dish",
        difficulty: "medium",
      });
      assert.equal(res.status, 200);
      assert.equal(captured.dishUpdates.length, 1);
      assert.equal(captured.dishUpdates[0].data.title, "Renamed dish");

      // No wipe.
      assert.equal(captured.dishIngredientDeleteMany.length, 0);
      assert.equal(captured.stepDeleteMany.length, 0);
      assert.equal(captured.dishIngredientCreates.length, 0);
      assert.equal(captured.stepCreates.length, 0);
    } finally {
      await harness.close();
    }
  });
});

describe("PATCH /me/dishes/:id (sub-graph wipe-and-recreate)", () => {
  it("wipes DishIngredient and ownerType=dish steps before recreating (no-orphan)", async () => {
    const { prisma, captured } = makeStub({
      dishes: [{ id: "dish-1", userId: USER_ID, isArchived: false }],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/dishes/dish-1", {
        ingredients: [{ name: "Salt", quantity: 1, unit: "tsp" }],
        steps: [{ text: "Sprinkle." }, { text: "Serve." }],
      });
      assert.equal(res.status, 200);

      // Wipes ran.
      assert.equal(captured.dishIngredientDeleteMany.length, 1);
      assert.equal(captured.stepDeleteMany.length, 1);
      const stepWhere = captured.stepDeleteMany[0].where as {
        ownerType?: string;
        ownerId?: string;
      };
      assert.equal(stepWhere.ownerType, "dish");
      assert.equal(stepWhere.ownerId, "dish-1");

      // Recreate writes.
      assert.equal(captured.dishIngredientCreates.length, 1);
      assert.equal(captured.stepCreates.length, 2);
      for (const step of captured.stepCreates) {
        assert.equal(step.ownerType, "dish");
        assert.equal(step.ownerId, "dish-1");
      }
    } finally {
      await harness.close();
    }
  });

  it("ingredients-only patch wipes ingredients but NOT steps", async () => {
    const { prisma, captured } = makeStub({
      dishes: [{ id: "dish-1", userId: USER_ID, isArchived: false }],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/dishes/dish-1", {
        ingredients: [{ name: "Pepper", quantity: 1, unit: "tsp" }],
      });
      assert.equal(res.status, 200);
      assert.equal(captured.dishIngredientDeleteMany.length, 1);
      assert.equal(captured.stepDeleteMany.length, 0);
      assert.equal(captured.dishIngredientCreates.length, 1);
      assert.equal(captured.stepCreates.length, 0);
    } finally {
      await harness.close();
    }
  });
});

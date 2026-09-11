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

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { createMeRouter } from "../me";
import { withSessionUser } from "./fixtures/sessionUserStub";
import { __clearRateLimitStoreForTests } from "../../lib/rateLimit";

const USER_ID = "test-user-patch";

// saveMutationLimiter (me.ts) is a module-global token bucket keyed by
// IP+method+path with capacity 12 — every PATCH /me/meals/meal-1 in this file
// drains one shared bucket. Clear it before each case (as me-save-canonical
// does) so the file is robust to added cases instead of 429-ing the 13th.
beforeEach(() => {
  __clearRateLimitStoreForTests();
});

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
  // D-WS9-235 (step-field preservation) — rematerializeMeal keys the wiped
  // steps by the link's positionIndex. Optional: the older fixtures never
  // configure pre-existing steps, so the position is irrelevant to them.
  positionIndex?: number;
}

// D-WS9-235 (step-field preservation) — a PRE-EXISTING RecipeInstructionStep
// row the wipe paths read before deleting. Only the preserved fields matter.
interface ExistingStepRow {
  ownerId: string;
  stepIndex: number;
  phaseType: string;
  isTimingSensitive: boolean;
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
  // D-WS9-235 — pre-existing dish-owned steps. Answered by
  // recipeInstructionStep.findMany until this request's deleteMany removes
  // their owner; the re-create then reads what it wrote.
  existingSteps?: ExistingStepRow[];
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
  let existingSteps = [...(opts.existingSteps ?? [])];

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
        // D-WS9-214 — rematerializeMeal ends with stampAllergens, whose two
        // reads are told apart from the route's own meal lookups by `select`.
        // Answered explicitly rather than falling through to the meal row: that
        // returned an object with no `dishLinks`, which stampAllergens correctly
        // treats as a partial graph and warns about on every patch test.
        if (args.select && "dishLinks" in args.select) return { dishLinks: [] };
        if (args.select && "allergens" in args.select) {
          return { allergens: [], allergenSources: null, allergensStampedAt: null };
        }
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
          dishId?: string | { in: string[] };
        };
        const matched = links.filter((l) => {
          if (typeof where.mealId === "string") {
            if (l.mealId !== where.mealId) return false;
          } else if (where.mealId && typeof where.mealId === "object") {
            if (l.mealId === (where.mealId as { not: string }).not) return false;
          }
          // D-WS9-235 follow-up: rematerializeDish asks "which meals link this
          // dish" with a plain-string dishId.
          if (typeof where.dishId === "string") {
            if (l.dishId !== where.dishId) return false;
          } else if (where.dishId?.in) {
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
      // D-WS9-235 stampMealTiming reads steps back. Answer from the steps this
      // request CREATED, plus any configured pre-existing steps whose owner has
      // not been wiped yet (the step-field preservation read happens BEFORE the
      // deleteMany; the re-stamp read happens after), so a dish whose steps
      // were just rewritten derives from exactly those steps.
      findMany: async (args: {
        where: { ownerType: string; ownerId: string | { in: string[] } };
      }) => {
        const owners = new Set(
          typeof args.where.ownerId === "string"
            ? [args.where.ownerId]
            : args.where.ownerId.in,
        );
        const pre = existingSteps
          .filter((s) => owners.has(s.ownerId))
          .map((s) => ({ ...s, estimatedMinutes: 1 }));
        const created = captured.stepCreates
          .filter((s) => owners.has(s.ownerId as string))
          .map((s) => ({
            ownerId: s.ownerId,
            stepIndex: s.stepIndex,
            estimatedMinutes: (s.estimatedMinutes as number | undefined) ?? 1,
            phaseType: (s.phaseType as string | undefined) ?? "cook",
            isTimingSensitive: (s.isTimingSensitive as boolean | undefined) ?? false,
          }));
        return [...pre, ...created];
      },
      create: async (args: { data: Record<string, unknown> }) => {
        captured.stepCreates.push(args.data);
        return {};
      },
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        captured.stepDeleteMany.push({ where: args.where });
        // Apply the wipe to the configured pre-existing set so the re-stamp
        // read (after the re-create) sees only the new steps.
        const where = args.where as { ownerId?: string | { in: string[] } };
        const ids =
          typeof where.ownerId === "string"
            ? new Set([where.ownerId])
            : new Set(where.ownerId?.in ?? []);
        const before = existingSteps.length;
        existingSteps = existingSteps.filter((s) => !ids.has(s.ownerId));
        return { count: before - existingSteps.length };
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
  app.use(createMeRouter({ prisma: withSessionUser(prisma) as never }));

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

  // D-WS9-235 follow-up — a user-typed time is a CLAIM. `activeTimeMinutes`
  // non-null is the "derived" marker D-WS7-166's capped shelves key on, so the
  // scalar path must clear it in the SAME update, or a patched meal keeps the
  // marker over a number the scheduler never produced.
  it("a scalar estimatedTimeMinutes patch clears the derived marker (activeTimeMinutes → null) in the same update", async () => {
    const { prisma, captured } = makeStub({
      meals: [{ id: "meal-1", userId: USER_ID, isArchived: false }],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/meals/meal-1", {
        estimatedTimeMinutes: 25,
      });
      assert.equal(res.status, 200);
      assert.equal(captured.mealUpdates.length, 1);
      assert.equal(captured.mealUpdates[0].data.estimatedTimeMinutes, 25);
      assert.ok(
        "activeTimeMinutes" in captured.mealUpdates[0].data,
        "the update must write activeTimeMinutes, not leave it untouched",
      );
      assert.equal(captured.mealUpdates[0].data.activeTimeMinutes, null);
    } finally {
      await harness.close();
    }
  });

  it("a scalar patch that does NOT touch the time leaves the marker alone", async () => {
    const { prisma, captured } = makeStub({
      meals: [{ id: "meal-1", userId: USER_ID, isArchived: false }],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/meals/meal-1", { title: "Renamed" });
      assert.equal(res.status, 200);
      assert.equal(captured.mealUpdates.length, 1);
      assert.ok(!("activeTimeMinutes" in captured.mealUpdates[0].data));
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

      // Scalar update on the meal row also happened. rematerializeMeal appends
      // its own writes after it: WS7-6 Fix-Block 3 added the macro aggregation,
      // and D-WS9-214 added the allergen re-stamp (an edit is exactly what
      // invalidates a stamp — a user adding cheese must not leave a stale
      // dairy-free one behind).
      //
      // ⚠️ SELECTED BY CONTENT, NOT BY POSITION. This assertion has now been
      // broken twice by a new write landing in the same array — the comment it
      // replaces was itself the patch for the first time. Indexing
      // `mealUpdates[1]` encodes "how many writes exist today", which is not
      // what the test is about.
      const scalarUpdate = captured.mealUpdates.find((u) => "title" in u.data);
      const macroUpdate = captured.mealUpdates.find(
        (u) => "caloriesPerServing" in u.data,
      );
      const stampUpdate = captured.mealUpdates.find(
        (u) => "allergensStampedAt" in u.data,
      );
      assert.ok(scalarUpdate, "the scalar patch must land");
      assert.equal(scalarUpdate.data.title, "Patched");
      // The macro update writes per-serving fields; with default 0-macro dish
      // rows in this stub it lands as 0 (honest aggregation).
      assert.ok(macroUpdate, "the Block-3 macro aggregation must land");
      assert.equal(macroUpdate.data.caloriesPerServing, 0);
      assert.ok(stampUpdate, "the D-WS9-214 allergen re-stamp must land on edit");

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
      // No step change → no meal re-stamped (D-WS9-235 follow-up).
      assert.equal(captured.mealUpdates.length, 0);
    } finally {
      await harness.close();
    }
  });

  // D-WS9-235 follow-up — a dish step edit re-stamps every meal the dish is
  // linked to, from the NEW steps, in the same transaction. Before this, the
  // Dish Builder (which sends steps on every edit) left each linked meal on a
  // time derived from steps that no longer existed.
  it("a steps patch re-stamps every linked meal's derived time from the new steps", async () => {
    const { prisma, captured } = makeStub({
      dishes: [{ id: "dish-1", userId: USER_ID, isArchived: false }],
      links: [
        { mealId: "meal-a", dishId: "dish-1" },
        { mealId: "meal-b", dishId: "dish-1" },
        { mealId: "meal-c", dishId: "dish-other" }, // not linked → untouched
      ],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/dishes/dish-1", {
        steps: [
          { text: "Chop.", estimatedMinutes: 10, phaseType: "prep" },
          { text: "Bake.", estimatedMinutes: 45, phaseType: "cook" },
        ],
      });
      assert.equal(res.status, 200);
      const stamped = captured.mealUpdates.filter(
        (u) => "estimatedTimeMinutes" in u.data && "activeTimeMinutes" in u.data,
      );
      assert.deepEqual(
        stamped.map((u) => u.where.id).sort(),
        ["meal-a", "meal-b"],
        "exactly the meals linked to the edited dish are re-stamped",
      );
      for (const u of stamped) {
        // 10 prep + 45 cook, serial single dish → 55 start-to-plate; hands-on
        // is the prep only (an unattended cook step is not active time).
        assert.equal(u.data.estimatedTimeMinutes, 55, `${u.where.id} total`);
        assert.equal(u.data.activeTimeMinutes, 10, `${u.where.id} active`);
      }
    } finally {
      await harness.close();
    }
  });
});

// D-WS9-235 (step-field preservation) — the Dish Builder and the meal-builder
// send steps as { text, estimatedMinutes, isTimingSensitive? } with no
// phaseType, and the wipe-and-recreate used to reset every re-created step to
// the column default `cook` (live DB, September 11: 9 of 9 dishes re-created
// by a meal save carried 50/50 steps `cook` against the catalog's 36%). Now an
// omitted field inherits the wiped step's value at the same stepIndex; a
// genuinely new step still falls to the column default.
describe("PATCH /me/dishes/:id (steps keep phaseType / isTimingSensitive when omitted — D-WS9-235)", () => {
  it("a steps patch omitting phaseType leaves step 2's `rest` as `rest`; an appended step defaults", async () => {
    const { prisma, captured } = makeStub({
      dishes: [{ id: "dish-1", userId: USER_ID, isArchived: false }],
      links: [{ mealId: "meal-a", dishId: "dish-1", positionIndex: 0 }],
      existingSteps: [
        { ownerId: "dish-1", stepIndex: 0, phaseType: "prep", isTimingSensitive: false },
        { ownerId: "dish-1", stepIndex: 1, phaseType: "cook", isTimingSensitive: true },
        { ownerId: "dish-1", stepIndex: 2, phaseType: "rest", isTimingSensitive: false },
      ],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/dishes/dish-1", {
        // The Dish Builder's edit shape: no phaseType anywhere; isTimingSensitive
        // sent on step 1 as false (the client's toggle), omitted elsewhere.
        steps: [
          { text: "Chop the onion.", estimatedMinutes: 5 },
          { text: "Sear the steak.", estimatedMinutes: 8, isTimingSensitive: false },
          { text: "Rest the steak.", estimatedMinutes: 10 },
          { text: "Slice and serve.", estimatedMinutes: 3 },
        ],
      });
      assert.equal(res.status, 200);
      // The preservation read happens BEFORE the wipe: exactly one deleteMany
      // on the dish's steps, and it came after the read (the read returned the
      // three pre-existing rows — proven by the phases below).
      assert.equal(captured.stepDeleteMany.length, 1);
      const created = captured.stepCreates
        .filter((s) => s.ownerId === "dish-1")
        .sort((a, b) => (a.stepIndex as number) - (b.stepIndex as number));
      assert.equal(created.length, 4);
      assert.deepEqual(
        created.map((s) => s.phaseType ?? "(default)"),
        ["prep", "cook", "rest", "(default)"],
        "steps 0–2 inherit the wiped step's phaseType at the same index; the appended step 3 falls to the column default",
      );
      assert.deepEqual(
        created.map((s) => s.isTimingSensitive ?? "(default)"),
        [false, false, false, "(default)"],
        "omitted isTimingSensitive inherits (step 0 false, step 2 false); a SENT false on step 1 wins over the existing true; the new step defaults",
      );
      // And the re-stamp derived from the preserved phases: the 10-minute rest
      // and the unattended-by-client sear are not hands-on. 5 prep + 8 cook +
      // 10 rest + 3 assemble-by-default(cook) serial = 26 total.
      const stamped = captured.mealUpdates.filter((u) => u.where.id === "meal-a");
      assert.equal(stamped.length, 1);
      assert.equal(stamped[0].data.estimatedTimeMinutes, 26);
    } finally {
      await harness.close();
    }
  });

  it("a sent phaseType always wins over the existing step's", async () => {
    const { prisma, captured } = makeStub({
      dishes: [{ id: "dish-1", userId: USER_ID, isArchived: false }],
      existingSteps: [
        { ownerId: "dish-1", stepIndex: 0, phaseType: "rest", isTimingSensitive: false },
      ],
    });
    const harness = await spinUp(prisma);
    try {
      const res = await authPatch(harness, "/me/dishes/dish-1", {
        steps: [{ text: "Whisk.", estimatedMinutes: 2, phaseType: "prep", isTimingSensitive: true }],
      });
      assert.equal(res.status, 200);
      assert.equal(captured.stepCreates[0].phaseType, "prep");
      assert.equal(captured.stepCreates[0].isTimingSensitive, true);
    } finally {
      await harness.close();
    }
  });
});

describe("PATCH /me/meals/:id (re-created dishes keep phaseType / isTimingSensitive when omitted — D-WS9-235)", () => {
  it("the meal-builder's dish re-create (no phaseType sent) keeps each step's phase by dish position + stepIndex", async () => {
    const { prisma, captured } = makeStub({
      meals: [{ id: "meal-1", userId: USER_ID, isArchived: false }],
      dishes: [
        { id: "dish-old-main", userId: USER_ID, isArchived: false },
        { id: "dish-old-side", userId: USER_ID, isArchived: false },
      ],
      links: [
        { mealId: "meal-1", dishId: "dish-old-main", positionIndex: 0 },
        { mealId: "meal-1", dishId: "dish-old-side", positionIndex: 1 },
      ],
      existingSteps: [
        { ownerId: "dish-old-main", stepIndex: 0, phaseType: "prep", isTimingSensitive: false },
        { ownerId: "dish-old-main", stepIndex: 1, phaseType: "preheat", isTimingSensitive: false },
        { ownerId: "dish-old-main", stepIndex: 2, phaseType: "cook", isTimingSensitive: false },
        { ownerId: "dish-old-main", stepIndex: 3, phaseType: "rest", isTimingSensitive: false },
        { ownerId: "dish-old-side", stepIndex: 0, phaseType: "prep", isTimingSensitive: false },
        { ownerId: "dish-old-side", stepIndex: 1, phaseType: "assemble", isTimingSensitive: true },
      ],
    });
    const harness = await spinUp(prisma);
    try {
      // serializeNewDishesForSave's shape: { text, estimatedMinutes, isTimingSensitive }.
      const res = await authPatch(harness, "/me/meals/meal-1", {
        title: "Roast chicken with slaw",
        dishes: [
          {
            kind: "new",
            title: "Roast chicken",
            role: "main",
            positionIndex: 0,
            ingredients: [{ name: "Chicken", quantity: 1, unit: "pound" }],
            steps: [
              { text: "Season.", estimatedMinutes: 5 },
              { text: "Oven to 425.", estimatedMinutes: 10 },
              { text: "Roast.", estimatedMinutes: 35 },
              { text: "Rest.", estimatedMinutes: 5 },
              { text: "Carve and plate.", estimatedMinutes: 3 }, // new — no step 4 existed
            ],
          },
          {
            kind: "new",
            title: "Slaw",
            role: "side",
            positionIndex: 1,
            ingredients: [{ name: "Cabbage", quantity: 1, unit: "head" }],
            steps: [
              { text: "Shred.", estimatedMinutes: 5 },
              { text: "Toss and serve.", estimatedMinutes: 2, isTimingSensitive: false },
            ],
          },
        ],
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { meal: { dishIds: string[] } };
      const [mainId, sideId] = body.meal.dishIds;
      const phases = (id: string) =>
        captured.stepCreates
          .filter((s) => s.ownerId === id)
          .sort((a, b) => (a.stepIndex as number) - (b.stepIndex as number))
          .map((s) => s.phaseType ?? "(default)");
      assert.deepEqual(
        phases(mainId),
        ["prep", "preheat", "cook", "rest", "(default)"],
        "the main at position 0 keeps prep/preheat/cook/rest by stepIndex; the appended 5th step defaults",
      );
      assert.deepEqual(
        phases(sideId),
        ["prep", "assemble"],
        "the side at position 1 keeps its own phases — matched by position, not by the main's",
      );
      const sideSteps = captured.stepCreates
        .filter((s) => s.ownerId === sideId)
        .sort((a, b) => (a.stepIndex as number) - (b.stepIndex as number));
      assert.equal(sideSteps[1].isTimingSensitive, false, "a SENT false wins over the existing true");
    } finally {
      await harness.close();
    }
  });
});

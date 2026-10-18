// FIX-6 (BUG-435) — "Use this plan" must not copy inside one long transaction.
//
// It used to: the template copy forked meal by meal inside the interactive
// transaction (~6 queries per dish), and a 15-dish featured week overran
// Prisma's 5 s default (P2028) in 5 of 24 dev runs. The copy now reads
// everything first and writes with one createMany per table.
//
// These tests pin that shape for both callers (use-template and the sign-up
// adopt): no read runs inside the transaction, and the number of statements
// inside it does not grow with the template. A copy that goes back to forking
// per meal in the transaction fails both.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import { adoptTemplateForUser } from "../guestClaim";
import { copyTemplateForUser } from "../planFromTemplate";

const USER = "fix6-user";

interface Op {
  inTx: boolean;
  op: string; // "model.method"
}

/** A template of `mealCount` foreign meals, each with `dishesPerMeal` dishes. */
function fixture(mealCount: number, dishesPerMeal: number) {
  const meals = Array.from({ length: mealCount }, (_, m) => ({
    id: `src-${m}`,
    userId: null,
    title: `Meal ${m}`,
    displayTitle: null,
    description: null,
    mealType: "dinner",
    sourceType: "batch_generated",
    cuisineType: null,
    difficulty: "easy",
    estimatedTimeMinutes: 30,
    activeTimeMinutes: 20,
    imageUrl: null,
    imageSource: null,
    imageGeneratedAt: null,
    imageStatus: "pending",
    servingsDefault: 4,
    authoredServingsDefault: 4,
    tags: [],
    caloriesPerServing: 0,
    proteinGPerServing: 0,
    carbsGPerServing: 0,
    fatGPerServing: 0,
    allergens: [],
    allergenSources: null,
    allergensStampedAt: new Date("2026-10-01T00:00:00Z"),
    dishLinks: Array.from({ length: dishesPerMeal }, (_, d) => ({
      positionIndex: d,
      roleLabel: d === 0 ? "main" : "side",
      dish: {
        id: `src-${m}-d${d}`,
        userId: null,
        title: `Dish ${m}.${d}`,
        displayTitle: null,
        description: null,
        sourceType: "batch_generated",
        estimatedTimeMinutes: 20,
        difficulty: "easy",
        imageUrl: null,
        servingsDefault: 4,
        authoredServingsDefault: 4,
        tags: [],
        caloriesPerServing: 0,
        proteinGPerServing: 0,
        carbsGPerServing: 0,
        fatGPerServing: 0,
        macroGroundedPct: null,
        substitutions: null,
        componentRegistry: null,
        componentSelections: null,
        dishIngredients: Array.from({ length: 6 }, (_, i) => ({
          ingredientId: `ing-${i}`,
          quantity: 1,
          unit: "cup",
          preparationNote: null,
          isOptional: false,
          positionIndex: i,
          componentKey: null,
          pathKey: null,
          fromLeftovers: false,
        })),
      },
    })),
  }));
  const steps = meals.flatMap((m) =>
    m.dishLinks.flatMap((l) =>
      Array.from({ length: 5 }, (_, i) => ({
        ownerType: "dish",
        ownerId: l.dish.id,
        stepIndex: i,
        stepTextRaw: `Step ${i}`,
        stepTextTranslated: null,
        estimatedMinutes: 5,
        phaseType: "cook",
        requiresPreheat: false,
        requiresRest: false,
        requiresMarination: false,
        isTimingSensitive: false,
        amountRefs: null,
        componentKey: null,
        pathKey: null,
        parallelGroup: null,
      })),
    ),
  );
  const template = {
    id: "t-big",
    userId: "kiwi-kitchen-editorial",
    isPublic: true,
    isArchived: false,
    anchorDate: null,
    optimizationNotes: null,
    items: meals.map((m, i) => ({
      id: `ti-${i}`,
      mealId: m.id,
      positionIndex: i,
      assignedDayOfWeek: null,
      servingsOverride: null,
      isBreakfast: false,
      isLunch: false,
      isDinner: true,
    })),
  };
  return { meals, steps, template };
}

/**
 * A recording client. Every delegate call is logged with whether it ran inside
 * `$transaction`; reads serve the fixture, writes record their row counts.
 */
function recordingClient(fx: ReturnType<typeof fixture>) {
  const ops: Op[] = [];
  const rows: Record<string, number> = {};
  let inTx = false;
  const rec = (op: string) => ops.push({ inTx, op });
  const createMany = (model: string) => async (args: { data: unknown[] }) => {
    rec(`${model}.createMany`);
    rows[model] = (rows[model] ?? 0) + args.data.length;
    return { count: args.data.length };
  };
  const client = {
    mealPlanTemplate: {
      findUnique: async () => (rec("mealPlanTemplate.findUnique"), fx.template),
      update: async () => (rec("mealPlanTemplate.update"), {}),
    },
    meal: {
      findMany: async (args: { where: { id: { in: string[] } }; include?: unknown }) => {
        rec("meal.findMany");
        const hit = fx.meals.filter((m) => args.where.id.in.includes(m.id));
        return args.include ? hit : hit.map((m) => ({ id: m.id, userId: m.userId }));
      },
      findUnique: async (args: { where: { id: string } }) => {
        rec("meal.findUnique");
        return fx.meals.find((m) => m.id === args.where.id) ?? null;
      },
      create: async () => (rec("meal.create"), { id: `m-${ops.length}` }),
      createMany: createMany("meal"),
    },
    dish: {
      create: async () => (rec("dish.create"), { id: `d-${ops.length}` }),
      createMany: createMany("dish"),
    },
    mealDishLink: {
      create: async () => (rec("mealDishLink.create"), {}),
      createMany: createMany("mealDishLink"),
    },
    dishIngredient: { createMany: createMany("dishIngredient") },
    recipeInstructionStep: {
      findMany: async (args: { where: { ownerType?: string; ownerId?: string | { in: string[] }; OR?: unknown[] }; select?: Record<string, boolean> }) => {
        rec("recipeInstructionStep.findMany");
        const clauses = (args.where.OR ?? [args.where]) as { ownerType: string; ownerId: string | { in: string[] } }[];
        const hit = fx.steps.filter((s) =>
          clauses.some((c) =>
            c.ownerType === s.ownerType &&
            (typeof c.ownerId === "string" ? c.ownerId === s.ownerId : c.ownerId.in.includes(s.ownerId)),
          ),
        );
        if (!args.select) return hit;
        return hit.map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => args.select![k] === true)));
      },
      createMany: createMany("recipeInstructionStep"),
    },
    userPreferences: {
      findUnique: async () => (rec("userPreferences.findUnique"), { householdSize: 2 }),
    },
    mealPlanInstance: {
      create: async () => (rec("mealPlanInstance.create"), { id: "inst-1", revisionId: 1 }),
      update: async () => (rec("mealPlanInstance.update"), { id: "inst-1" }),
    },
    mealPlanItem: { createMany: createMany("mealPlanItem") },
    userActivity: { create: async () => (rec("userActivity.create"), { id: "act" }) },
    user: { updateMany: async () => (rec("user.updateMany"), { count: 1 }) },
    $transactionCalls: 0,
    $transaction: async <T,>(cb: (tx: unknown) => Promise<T>) => {
      client.$transactionCalls += 1;
      inTx = true;
      try {
        return await cb(client);
      } finally {
        inTx = false;
      }
    },
  };
  return { client, ops, rows };
}

const isRead = (op: string) => /\.(find\w*|count|aggregate|groupBy)$/.test(op);
const markFirst = async (tx: { user: { updateMany: (a: unknown) => Promise<unknown> } }, userId: string) => {
  await tx.user.updateMany({ where: { id: userId, firstPlanCreatedAt: null }, data: {} });
};

async function useTemplate(mealCount: number, dishesPerMeal: number) {
  const fx = fixture(mealCount, dishesPerMeal);
  const r = recordingClient(fx);
  const out = await copyTemplateForUser(r.client as never, "t-big", USER, markFirst as never, {});
  return { ...r, out };
}

describe("FIX-6 (BUG-435) — use-template copies outside one long transaction", () => {
  it("runs no read inside the transaction", async () => {
    const { ops, out, client } = await useTemplate(5, 8);
    assert.equal(out.kind, "created");
    assert.equal(client.$transactionCalls, 1);
    const readsInTx = ops.filter((o) => o.inTx && isRead(o.op)).map((o) => o.op);
    assert.deepEqual(readsInTx, [], `reads inside the transaction: ${readsInTx.join(", ")}`);
  });

  it("the statements inside the transaction do not grow with the template (1 dish vs 8 dishes × 5 meals)", async () => {
    const small = await useTemplate(1, 1);
    const big = await useTemplate(5, 8);
    const inTx = (ops: Op[]) => ops.filter((o) => o.inTx).map((o) => o.op);
    assert.deepEqual(inTx(big.ops), inTx(small.ops));
    assert.ok(inTx(big.ops).length <= 12, `${inTx(big.ops).length} statements in the transaction`);
  });

  it("still writes every row of every fork (5 meals, 40 dishes, 240 ingredients, 200 steps, 5 items)", async () => {
    const { rows } = await useTemplate(5, 8);
    assert.deepEqual(rows, {
      meal: 5,
      dish: 40,
      mealDishLink: 40,
      dishIngredient: 240,
      recipeInstructionStep: 200,
      mealPlanItem: 5,
    });
  });
});

describe("FIX-6 (BUG-435) — the sign-up adopt copies the same way", () => {
  it("runs no read inside its transaction, and a fixed number of statements", async () => {
    const run = async (meals: number, dishes: number) => {
      const r = recordingClient(fixture(meals, dishes));
      const id = await adoptTemplateForUser({
        prisma: r.client as unknown as PrismaClient,
        userId: USER,
        templateId: "t-big",
        localDate: "2026-10-18",
      });
      assert.equal(id, "inst-1");
      return r.ops.filter((o) => o.inTx);
    };
    const small = await run(1, 1);
    const big = await run(5, 8);
    assert.deepEqual(big.filter((o) => isRead(o.op)).map((o) => o.op), []);
    assert.deepEqual(big.map((o) => o.op), small.map((o) => o.op));
  });
});

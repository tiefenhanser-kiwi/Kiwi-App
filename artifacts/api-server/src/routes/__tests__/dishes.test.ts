// WS7-3 A2 — GET /dishes/:id tests.
//
// node:test + real signed JWT + prisma stubbed at the factory deps boundary.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { createDishesRouter } from "../dishes";
import { withSessionUser } from "./fixtures/sessionUserStub";

const USER_ID = "test-user-dishes";

// ── fixtures ───────────────────────────────────────────────────────────

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
    preparationNote: null as string | null,
    ingredient: { displayName: name, category },
  };
}

function dishRow(
  id: string,
  title: string,
  opts: { isArchived?: boolean; userId?: string | null; meals?: MealLinkFixture[] } = {},
) {
  return {
    id,
    title,
    description: "A tasty test dish.",
    sourceType: "manual",
    estimatedTimeMinutes: 20,
    difficulty: "medium",
    imageUrl: null as string | null,
    servingsDefault: 4,
    tags: ["side"],
    caloriesPerServing: 320,
    proteinGPerServing: 18,
    carbsGPerServing: 30,
    fatGPerServing: 12,
    isArchived: opts.isArchived ?? false,
    userId: opts.userId ?? "owner-1",
    // SEC-2 #11 — the meals this dish sits in, for the readability gate. By
    // default a published catalog meal, so every pre-SEC-2 case stays readable.
    meals: opts.meals ?? [{ userId: null, isPublic: true, isArchived: false }],
    dishIngredients: [
      dishIngredient("Basmati rice", "Pantry", 1, "cup", 0),
      dishIngredient("Fresh dill", "Produce", 1, "bunch", 1, true),
    ],
  };
}

function step(stepIndex: number, text: string) {
  return {
    ownerType: "dish",
    ownerId: "x",
    stepIndex,
    stepTextRaw: text,
    stepTextTranslated: text,
    estimatedMinutes: 5,
    phaseType: "cook",
    parallelGroup: null as string | null,
    requiresPreheat: false,
    requiresRest: false,
    requiresMarination: false,
    isTimingSensitive: false,
  };
}

type DishRow = ReturnType<typeof dishRow>;

interface MealLinkFixture {
  userId: string | null;
  isPublic: boolean;
  isArchived: boolean;
  /** Users whose plan instances hold this meal. */
  onPlansOf?: string[];
}

// Evaluates the readability where-clause's own SHAPE (lib/mealVisibility.ts
// isDishReadableByUser), clause by clause, so dropping or loosening a clause
// changes the answer here too.
type MealCond = {
  userId?: string;
  isPublic?: boolean;
  isArchived?: boolean;
  planItems?: { some: { planInstance: { userId: string } } };
};
function mealMatches(m: MealLinkFixture, c: MealCond): boolean {
  if (c.userId !== undefined && m.userId !== c.userId) return false;
  if (c.isPublic !== undefined && m.isPublic !== c.isPublic) return false;
  if (c.isArchived !== undefined && m.isArchived !== c.isArchived) return false;
  if (c.planItems && !(m.onPlansOf ?? []).includes(c.planItems.some.planInstance.userId)) return false;
  return true;
}
function dishMatches(
  d: DishRow,
  c: { userId?: string; mealLinks?: { some: { meal: { OR: MealCond[] } } } },
): boolean {
  if (c.userId !== undefined && d.userId !== c.userId) return false;
  if (c.mealLinks && !d.meals.some((m) => c.mealLinks!.some.meal.OR.some((mc) => mealMatches(m, mc)))) return false;
  return true;
}
type StepRow = ReturnType<typeof step>;

function makeStubPrisma(opts: { dishes?: DishRow[]; steps?: StepRow[] }) {
  const dishes = opts.dishes ?? [];
  const steps = opts.steps ?? [];
  return {
    dish: {
      findFirst: async (args: { where: { id: string; OR: Parameters<typeof dishMatches>[1][] } }) => {
        const d = dishes.find((r) => r.id === args.where.id);
        return d && args.where.OR.some((c) => dishMatches(d, c)) ? { id: d.id } : null;
      },
      findUnique: async (args: { where: { id: string } }) => {
        const d = dishes.find((r) => r.id === args.where.id);
        if (!d) return null;
        return {
          ...d,
          dishIngredients: d.dishIngredients
            .slice()
            .sort((a, b) => a.positionIndex - b.positionIndex),
        };
      },
    },
    recipeInstructionStep: {
      findMany: async (args: {
        where: { ownerType: string; ownerId: string };
      }) =>
        steps
          .filter(
            (s) =>
              s.ownerType === args.where.ownerType &&
              s.ownerId === args.where.ownerId,
          )
          .slice()
          .sort((a, b) => a.stepIndex - b.stepIndex),
    },
  };
}

// ── harness ────────────────────────────────────────────────────────────

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
}

async function spinUp(prisma: unknown): Promise<Harness> {
  const app: Express = express();
  app.use(express.json());
  app.use(createDishesRouter({ prisma: withSessionUser(prisma) as never }));

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
    headers: withAuth ? { Authorization: `Bearer ${signToken(USER_ID)}` } : {},
  });
}

// ── tests ──────────────────────────────────────────────────────────────

describe("GET /dishes/:id", () => {
  it("returns 200 with the full dish shape: meta, ordered ingredients, steps", async () => {
    const d = dishRow("dish-1", "Rice Pilaf");
    const steps = [
      { ...step(1, "Toast the rice."), ownerId: "dish-1" },
      { ...step(0, "Sauté the onion."), ownerId: "dish-1" },
    ];
    const harness = await spinUp(makeStubPrisma({ dishes: [d], steps }));
    try {
      const res = await authGet(harness, "/dishes/dish-1");
      assert.equal(res.status, 200);
      const { dish } = (await res.json()) as { dish: Record<string, unknown> };
      assert.equal(dish.id, "dish-1");
      assert.equal(dish.title, "Rice Pilaf");
      // renamed flat meta fields
      assert.equal(dish.minutes, 20);
      assert.equal(dish.servings, 4);
      assert.equal(dish.calories, 320);
      assert.equal(dish.image, null);
      assert.equal(dish.difficulty, "medium");

      const ingredients = dish.ingredients as {
        name: string;
        isOptional: boolean;
      }[];
      assert.deepEqual(
        ingredients.map((i) => i.name),
        ["Basmati rice", "Fresh dill"],
      );
      assert.equal(ingredients[1].isOptional, true);

      // steps come back ordered by stepIndex
      const stepsOut = dish.steps as { stepIndex: number; text: string }[];
      assert.deepEqual(
        stepsOut.map((s) => s.text),
        ["Sauté the onion.", "Toast the rice."],
      );
    } finally {
      await harness.close();
    }
  });

  it("returns 404 for a non-existent dish id", async () => {
    const harness = await spinUp(makeStubPrisma({ dishes: [] }));
    try {
      const res = await authGet(harness, "/dishes/ghost-dish");
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("returns 404 for an archived dish", async () => {
    const harness = await spinUp(
      makeStubPrisma({
        dishes: [dishRow("dish-arch", "Old Dish", { isArchived: true })],
      }),
    );
    try {
      const res = await authGet(harness, "/dishes/dish-arch");
      assert.equal(res.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("returns 400 for an over-length dish id", async () => {
    const harness = await spinUp(makeStubPrisma({ dishes: [] }));
    try {
      const res = await authGet(harness, `/dishes/${"x".repeat(101)}`);
      assert.equal(res.status, 400);
    } finally {
      await harness.close();
    }
  });

  it("rejects 401 when no auth header is present", async () => {
    const harness = await spinUp(
      makeStubPrisma({ dishes: [dishRow("dish-1", "Rice Pilaf")] }),
    );
    try {
      const res = await authGet(harness, "/dishes/dish-1", false);
      assert.equal(res.status, 401);
    } finally {
      await harness.close();
    }
  });
});

// ── SEC-2 #11 — only readable dishes, and never another member's id ──────
describe("GET /dishes/:id — SEC-2 #11 readability", () => {
  const cases: Array<[string, Parameters<typeof dishRow>[2], number, string | null | undefined]> = [
    ["another member's dish in their PRIVATE meal", { userId: "owner-1", meals: [{ userId: "owner-1", isPublic: false, isArchived: false }] }, 404, undefined],
    ["another member's dish in no meal at all", { userId: "owner-1", meals: [] }, 404, undefined],
    ["a dish in an ARCHIVED public meal", { userId: null, meals: [{ userId: null, isPublic: true, isArchived: true }] }, 404, undefined],
    ["a dish in a published catalog meal (owner's id withheld)", { userId: "owner-1" }, 200, null],
    ["the caller's own dish", { userId: USER_ID, meals: [] }, 200, USER_ID],
    ["a dish in the caller's own meal", { userId: "owner-1", meals: [{ userId: USER_ID, isPublic: false, isArchived: false }] }, 200, null],
    ["another member's private meal that is ON the caller's plan", { userId: "owner-1", meals: [{ userId: "owner-1", isPublic: false, isArchived: false, onPlansOf: [USER_ID] }] }, 200, null],
  ];
  for (const [label, opts, status, userIdOut] of cases) {
    it(`${label} → ${status}`, async () => {
      const harness = await spinUp(makeStubPrisma({ dishes: [dishRow("dish-x", "X", opts)] }));
      try {
        const res = await authGet(harness, "/dishes/dish-x");
        assert.equal(res.status, status);
        if (status === 200) {
          const { dish } = (await res.json()) as { dish: { userId: string | null } };
          assert.equal(dish.userId, userIdOut);
        }
      } finally {
        await harness.close();
      }
    });
  }
});

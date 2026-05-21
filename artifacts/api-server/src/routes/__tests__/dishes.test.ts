// WS7-3 A2 — GET /dishes/:id tests.
//
// node:test + real signed JWT + prisma stubbed at the factory deps boundary.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { createDishesRouter } from "../dishes";

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
  opts: { isArchived?: boolean; userId?: string | null } = {},
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
type StepRow = ReturnType<typeof step>;

function makeStubPrisma(opts: { dishes?: DishRow[]; steps?: StepRow[] }) {
  const dishes = opts.dishes ?? [];
  const steps = opts.steps ?? [];
  return {
    dish: {
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
  app.use(createDishesRouter({ prisma: prisma as never }));

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

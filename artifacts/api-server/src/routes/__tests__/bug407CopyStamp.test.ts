// BUG-407 — a copy keeps its allergen stamp.
//
// cloneMealInto (lib/mealFork.ts) copied the whole meal graph but neither
// `allergens` nor `allergensStampedAt`, so every user copy was born
// "never evaluated". The conservative allergen rule (store/allergenFilter.ts)
// excludes exactly that for any user with an allergy: 304 of 448 user copies on
// dev, 2026-10-14, invisible to every allergic user's Playlist shelf.
//
// The store below is relational on purpose — meals, dishes, links, ingredient
// rows and ingredients — so a fork writes real rows, stampAllergens reads them
// back, and the shelf's playlist read is evaluated against the copy's actual
// columns by the strict `where` evaluator (fixtures/mealWhere.ts). A stub that
// ignored the `where` could not go red when the stamp was dropped.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { forkMealForUser } from "../../lib/mealFork";
import { createWizardRouter } from "../wizard";
import { matchesWhere } from "./fixtures/mealWhere";
import { withSessionUser } from "./fixtures/sessionUserStub";

/* eslint-disable @typescript-eslint/no-explicit-any */

const USER = "allergic-user";
const STAMPED_AT = new Date("2026-09-04T12:00:00Z");

interface Store {
  meals: Map<string, Record<string, any>>;
  dishes: Map<string, Record<string, any>>;
  links: Array<{ mealId: string; dishId: string; positionIndex: number; roleLabel: string | null }>;
  dishIngredients: Array<Record<string, any>>;
  ingredients: Map<string, { id: string; displayName: string; canonicalName: string }>;
  playlist: Array<{ userId: string; mealId: string; createdAt: Date }>;
  mealUpdates: Array<{ id: string; data: Record<string, unknown> }>;
}

/** A catalog dinner: one dish, two ingredients, neither a dairy allergen. */
function makeStore(source: { stamped: boolean }): Store {
  const s: Store = {
    meals: new Map(),
    dishes: new Map(),
    links: [],
    dishIngredients: [],
    ingredients: new Map([
      ["ing-rice", { id: "ing-rice", displayName: "jasmine rice", canonicalName: "jasmine rice" }],
      ["ing-soy", { id: "ing-soy", displayName: "soy sauce", canonicalName: "soy sauce" }],
    ]),
    playlist: [],
    mealUpdates: [],
  };
  s.meals.set("cat-1", {
    id: "cat-1",
    userId: null,
    title: "Soy Fried Rice",
    displayTitle: null,
    description: "Weeknight rice",
    mealType: "dinner",
    sourceType: "batch_generated",
    cuisineType: "Chinese",
    difficulty: "easy",
    estimatedTimeMinutes: 25,
    activeTimeMinutes: 15,
    imageUrl: null,
    imageSource: null,
    imageGeneratedAt: null,
    imageStatus: "pending",
    servingsDefault: 4,
    authoredServingsDefault: 4,
    tags: [],
    caloriesPerServing: 400,
    proteinGPerServing: 10,
    carbsGPerServing: 70,
    fatGPerServing: 8,
    dishFamilyKey: null,
    // Soy and wheat (soy sauce), no dairy: safe for a dairy-free user.
    allergens: source.stamped ? ["soy", "wheat"] : [],
    allergenSources: source.stamped ? { soy: ["soy sauce"], wheat: ["soy sauce"] } : null,
    allergensStampedAt: source.stamped ? STAMPED_AT : null,
    sourceStoreMealId: null,
    isPublic: true,
    isArchived: false,
  });
  s.dishes.set("cat-dish-1", {
    id: "cat-dish-1",
    userId: null,
    title: "Fried Rice",
    displayTitle: null,
    description: null,
    sourceType: "batch_generated",
    estimatedTimeMinutes: 25,
    difficulty: "easy",
    imageUrl: null,
    servingsDefault: 4,
    authoredServingsDefault: 4,
    tags: [],
    caloriesPerServing: 400,
    proteinGPerServing: 10,
    carbsGPerServing: 70,
    fatGPerServing: 8,
    macroGroundedPct: null,
    substitutions: null,
    componentRegistry: null,
    componentSelections: null,
  });
  s.links.push({ mealId: "cat-1", dishId: "cat-dish-1", positionIndex: 0, roleLabel: "main" });
  for (const [i, ingredientId] of ["ing-rice", "ing-soy"].entries()) {
    s.dishIngredients.push({
      dishId: "cat-dish-1",
      ingredientId,
      quantity: 1,
      unit: "cup",
      preparationNote: null,
      isOptional: false,
      positionIndex: i,
      componentKey: null,
      pathKey: null,
    });
  }
  return s;
}

/** The meal as Prisma would hand it back with its relations loaded (a superset
 *  of every include/select the fork, the stamp and the shelf ask for). */
function graph(s: Store, mealId: string): Record<string, any> | null {
  const m = s.meals.get(mealId);
  if (!m) return null;
  const dishLinks = s.links
    .filter((l) => l.mealId === mealId)
    .sort((a, b) => a.positionIndex - b.positionIndex)
    .map((l) => ({
      ...l,
      dish: {
        ...s.dishes.get(l.dishId),
        dishIngredients: s.dishIngredients
          .filter((di) => di.dishId === l.dishId)
          .map((di) => ({ ...di, ingredient: s.ingredients.get(di.ingredientId) })),
      },
    }));
  return { ...m, dishLinks, _count: { dishLinks: dishLinks.length } };
}

function makeClient(s: Store) {
  let n = 0;
  const id = (p: string) => `${p}-${++n}`;
  const dbNull = (v: unknown) =>
    v !== null && typeof v === "object" && (v as any).constructor?.name === "NullTypes" ? null : v;
  const client = {
    userPreferences: {
      findUnique: async () => ({ householdSize: 2, allergiesAndAvoidances: ["Dairy-free"], discoveryLevel: "none" }),
    },
    meal: {
      findUnique: async (args: { where: { id: string } }) => graph(s, args.where.id),
      findMany: async (args: { where: Record<string, unknown> }) =>
        [...s.meals.keys()].map((k) => graph(s, k)!).filter((m) => matchesWhere(m, args.where)),
      create: async (args: { data: Record<string, any> }) => {
        const mealId = id("meal");
        s.meals.set(mealId, {
          id: mealId,
          dishFamilyKey: null,
          ...Object.fromEntries(Object.entries(args.data).map(([k, v]) => [k, dbNull(v)])),
          // Prisma applies the column defaults for anything the create omits.
          allergens: args.data.allergens ?? [],
          allergenSources: dbNull(args.data.allergenSources) ?? null,
          allergensStampedAt: args.data.allergensStampedAt ?? null,
        });
        return { id: mealId };
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        s.mealUpdates.push({ id: args.where.id, data: args.data });
        Object.assign(s.meals.get(args.where.id)!, args.data);
        return {};
      },
    },
    dish: {
      create: async (args: { data: Record<string, any> }) => {
        const dishId = id("dish");
        s.dishes.set(dishId, { id: dishId, ...args.data });
        return { id: dishId };
      },
    },
    mealDishLink: {
      create: async (args: { data: any }) => {
        s.links.push(args.data);
        return { id: id("link") };
      },
    },
    dishIngredient: {
      createMany: async (args: { data: any[] }) => {
        s.dishIngredients.push(...args.data);
        return { count: args.data.length };
      },
    },
    recipeInstructionStep: {
      findMany: async () => [],
      createMany: async (args: { data: unknown[] }) => ({ count: args.data.length }),
    },
    playlistMeal: {
      count: async (args: { where: { userId: string } }) =>
        s.playlist.filter((p) => p.userId === args.where.userId).length,
      // The shelf's playlist read: the `meal` clause carries the allergen
      // conditions, evaluated here against the copy's real columns.
      findMany: async (args: { where: { userId: string; meal?: Record<string, unknown> } }) =>
        s.playlist
          .filter((p) => p.userId === args.where.userId)
          .filter((p) => matchesWhere(graph(s, p.mealId)!, args.where.meal))
          .map((p) => ({ mealId: p.mealId, meal: { sourceStoreMealId: s.meals.get(p.mealId)!.sourceStoreMealId } })),
    },
  };
  return client;
}

async function spinUpWizard(prisma: unknown): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app: Express = express();
  app.use(express.json());
  app.use(
    "/api",
    createWizardRouter({
      prisma: withSessionUser(prisma) as never,
      runAICall: (async () => {
        throw new Error("no AI call expected");
      }) as never,
      subscriptionService: { can: async () => ({ allowed: true }) } as never,
      rateLimiterOpts: { capacity: 1000, refillPerSec: 1000 },
    }),
  );
  return await new Promise((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) return reject(new Error("no bind"));
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/api`,
        close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

describe("BUG-407 — cloneMealInto carries the allergen stamp", () => {
  it("a copied catalog meal carries allergens, sources and the stamp date, and writes no re-stamp", async () => {
    const s = makeStore({ stamped: true });
    const { mealId } = await forkMealForUser(makeClient(s) as never, "cat-1", USER);

    const copy = s.meals.get(mealId)!;
    assert.equal(copy.userId, USER);
    assert.equal(copy.sourceStoreMealId, "cat-1");
    assert.deepEqual(copy.allergens, ["soy", "wheat"]);
    assert.deepEqual(copy.allergenSources, { soy: ["soy sauce"], wheat: ["soy sauce"] });
    assert.equal(copy.allergensStampedAt?.getTime(), STAMPED_AT.getTime(), "the copy is stamped");
    assert.deepEqual(s.mealUpdates, [], "a stamped source's copy needs no re-derive");
  });

  it("an UNSTAMPED source's copy is stamped from the copy's own graph", async () => {
    const s = makeStore({ stamped: false });
    const { mealId } = await forkMealForUser(makeClient(s) as never, "cat-1", USER);

    const copy = s.meals.get(mealId)!;
    assert.notEqual(copy.allergensStampedAt, null, "the copy is stamped");
    assert.deepEqual([...copy.allergens].sort(), ["soy", "wheat"]);
    assert.equal(s.mealUpdates.length, 1);
    assert.equal(s.mealUpdates[0].id, mealId, "only the copy is written, never the source");
    assert.equal(s.meals.get("cat-1")!.allergensStampedAt, null, "the source row is untouched");
  });
});

describe("BUG-407 — an allergic user's shelf keeps a copied Playlist meal that is safe for them", () => {
  it("POST /wizard/shelf { source: playlist } for a dairy-free user returns the copy of a dairy-free catalog meal", async () => {
    const s = makeStore({ stamped: true });
    const client = makeClient(s);
    // Save the catalog meal to the Playlist the way POST /me/playlist does: fork, store the copy.
    const { mealId: copyId } = await forkMealForUser(client as never, "cat-1", USER);
    s.playlist.push({ userId: USER, mealId: copyId, createdAt: new Date("2026-10-01T00:00:00Z") });

    const h = await spinUpWizard(client);
    try {
      const res = await fetch(`${h.baseUrl}/wizard/shelf`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${signToken(USER)}` },
        body: JSON.stringify({
          planDurationDays: 5,
          householdSize: 2,
          cuisines: [],
          eatingStyles: [],
          allergiesAndAvoidances: ["Dairy-free"],
          difficulty: "easy",
          weeklyPacing: "mixed",
          source: "playlist",
        }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { meals: Array<{ id: string }> };
      assert.deepEqual(
        body.meals.map((m) => m.id),
        [copyId],
        "the safe copy stays on the allergic user's Playlist shelf",
      );
    } finally {
      await h.close();
    }
  });
});

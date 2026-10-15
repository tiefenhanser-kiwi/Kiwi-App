// THX-2S Part G (D-WS9-313) — POST /me/meals/:mealId/dishes/from-catalog.
//
// Runs the real route → copyCatalogDishIntoMeal → cloneDishForUser →
// finishMealGraphWrite (macros, allergen stamp, timing) against a small
// in-memory store that models exactly the call shapes this path issues and
// throws on anything else — so the allergen stamp is DERIVED from the copied
// graph, not asserted from a recorded call.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import { signToken } from "../auth";
import { createMeRouter } from "../../routes/me";
import { withSessionUser } from "../../routes/__tests__/fixtures/sessionUserStub";

const USER = "thx2s-g-user";

type Row = Record<string, unknown>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      const c = cond as Row;
      if ("in" in c) return (c.in as unknown[]).includes(v);
      if ("not" in c) return v !== c.not;
      throw new Error(`store: unsupported where on ${k}: ${JSON.stringify(cond)}`);
    }
    return v === cond;
  });
}

function makeStore() {
  let seq = 0;
  const id = (p: string) => `${p}-${++seq}`;
  const t = {
    meals: [] as Row[],
    dishes: [] as Row[],
    links: [] as Row[],
    ingredients: [] as Row[],
    dishIngredients: [] as Row[],
    steps: [] as Row[],
    plans: [] as Row[],
  };
  const byPos = (a: Row, b: Row) => (a.positionIndex as number) - (b.positionIndex as number);
  const hydrateDish = (d: Row) => ({
    ...d,
    dishIngredients: t.dishIngredients
      .filter((di) => di.dishId === d.id)
      .sort(byPos)
      .map((di) => ({ ...di, ingredient: t.ingredients.find((i) => i.id === di.ingredientId) })),
  });
  const hydrateLink = (l: Row) => ({ ...l, dish: hydrateDish(t.dishes.find((d) => d.id === l.dishId)!) });
  const prisma = {
    meal: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const m = t.meals.find((x) => x.id === where.id);
        if (!m) return null;
        return { ...m, dishLinks: t.links.filter((l) => l.mealId === m.id).sort(byPos).map(hydrateLink) };
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const m = t.meals.find((x) => x.id === where.id)!;
        Object.assign(m, data);
        return m;
      },
    },
    dish: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: id("dish"), ...data };
        t.dishes.push(row);
        return { id: row.id };
      },
      findMany: async ({ where }: { where: Row }) => t.dishes.filter((d) => matches(d, where)),
      update: async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(t.dishes.find((d) => d.id === where.id)!, data),
      delete: async ({ where }: { where: { id: string } }) => {
        t.dishes = t.dishes.filter((d) => d.id !== where.id);
        return {};
      },
    },
    mealDishLink: {
      findMany: async ({ where }: { where: Row }) =>
        t.links.filter((l) => matches(l, where)).sort(byPos).map(hydrateLink),
      create: async ({ data }: { data: Row }) => {
        t.links.push({ ...data });
        return data;
      },
      deleteMany: async ({ where }: { where: Row }) => {
        const before = t.links.length;
        t.links = t.links.filter((l) => !matches(l, where));
        return { count: before - t.links.length };
      },
    },
    dishIngredient: {
      createMany: async ({ data }: { data: Row[] }) => {
        for (const d of data) t.dishIngredients.push({ id: id("di"), ...d });
        return { count: data.length };
      },
      deleteMany: async ({ where }: { where: Row }) => {
        t.dishIngredients = t.dishIngredients.filter((di) => !matches(di, where));
        return {};
      },
    },
    recipeInstructionStep: {
      findMany: async ({ where }: { where: Row }) =>
        t.steps.filter((s) => matches(s, where)).sort((a, b) => (a.stepIndex as number) - (b.stepIndex as number)),
      count: async ({ where }: { where: Row }) => t.steps.filter((s) => matches(s, where)).length,
      createMany: async ({ data }: { data: Row[] }) => {
        t.steps.push(...data.map((d) => ({ ...d })));
        return { count: data.length };
      },
      deleteMany: async ({ where }: { where: Row }) => {
        t.steps = t.steps.filter((s) => !matches(s, where));
        return {};
      },
    },
    mealPlanInstance: {
      findFirst: async ({ where }: { where: Row }) => t.plans.find((p) => matches(p, where)) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { revisionId: { increment: number } } }) => {
        const p = t.plans.find((x) => x.id === where.id)!;
        p.revisionId = (p.revisionId as number) + data.revisionId.increment;
        return { revisionId: p.revisionId };
      },
    },
    $transaction: async <T,>(cb: (tx: unknown) => Promise<T>) => cb(prisma),
  };

  const ing = (name: string) => {
    const row = { id: `ing-${name}`, canonicalName: name, displayName: name };
    if (!t.ingredients.some((i) => i.id === row.id)) t.ingredients.push(row);
    return row.id;
  };
  /** A meal with dishes; each dish [title, [[ingredient, qty, unit]...]]. */
  function addMeal(m: {
    id: string; userId: string | null; isPublic?: boolean; isArchived?: boolean;
    servingsDefault: number; authoredServingsDefault: number;
    dishes: Array<{ title: string; role?: string; ings: Array<[string, number, string]> }>;
  }) {
    t.meals.push({
      id: m.id, userId: m.userId, isPublic: m.isPublic ?? false, isArchived: m.isArchived ?? false,
      servingsDefault: m.servingsDefault, authoredServingsDefault: m.authoredServingsDefault,
      allergens: [], allergenSources: null, allergensStampedAt: new Date(0),
    });
    m.dishes.forEach((d, pos) => {
      const dishId = `${m.id}-d${pos}`;
      t.dishes.push({
        id: dishId, userId: m.userId, title: d.title, displayTitle: null, description: null,
        sourceType: "batch_generated", estimatedTimeMinutes: 30, difficulty: "medium", imageUrl: null,
        servingsDefault: m.authoredServingsDefault, authoredServingsDefault: m.authoredServingsDefault,
        tags: [], caloriesPerServing: 100, proteinGPerServing: 10, carbsGPerServing: 5, fatGPerServing: 3,
        macroGroundedPct: null, substitutions: null, componentRegistry: null, componentSelections: null,
      });
      t.links.push({ mealId: m.id, dishId, positionIndex: pos, roleLabel: d.role ?? (pos === 0 ? "main" : "side") });
      d.ings.forEach(([name, quantity, unit], i) =>
        t.dishIngredients.push({
          id: `${dishId}-i${i}`, dishId, ingredientId: ing(name), quantity, unit, preparationNote: null,
          isOptional: false, positionIndex: i, componentKey: null, pathKey: null, fromLeftovers: false,
        }),
      );
      t.steps.push({
        ownerType: "dish", ownerId: dishId, stepIndex: 0,
        stepTextRaw: `Roast the ${d.ings[0][0]}.`, stepTextTranslated: `Roast the ${d.ings[0][0]}.`,
        estimatedMinutes: 60, phaseType: "cook", parallelGroup: null, requiresPreheat: false, requiresRest: false,
        requiresMarination: false, isTimingSensitive: false, componentKey: null, pathKey: null,
        amountRefs: [{ ingredientId: ing(d.ings[0][0]), quantity: d.ings[0][1], unit: d.ings[0][2], charStart: 0, charEnd: 4 }],
      });
    });
  }
  return { prisma, t, addMeal };
}

/** The Classic feast fork (authored 10, household 2) + catalog sources. */
function scenario(targetAnchor = 10) {
  const s = makeStore();
  s.addMeal({
    id: "feast", userId: USER, servingsDefault: 2, authoredServingsDefault: targetAnchor,
    dishes: [
      { title: "Herb-Roasted Whole Turkey", ings: [["whole turkey", 12, "pound"]] },
      { title: "Pan Gravy", role: "sauce", ings: [["turkey stock", 4, "cup"]] },
      { title: "Pumpkin Pie", ings: [["pumpkin puree", 15, "ounce"]] },
    ],
  });
  s.addMeal({
    id: "alt-turkey", userId: null, isPublic: true, servingsDefault: 10, authoredServingsDefault: 10,
    dishes: [{ title: "Buttermilk-Brined Roast Turkey", ings: [["whole turkey", 12, "pound"], ["buttermilk", 8, "cup"]] }],
  });
  s.addMeal({
    id: "private-turkey", userId: null, isPublic: false, servingsDefault: 10, authoredServingsDefault: 10,
    dishes: [{ title: "Unreviewed Turkey", ings: [["whole turkey", 12, "pound"]] }],
  });
  s.addMeal({
    id: "classic-feast-catalog", userId: null, isPublic: true, servingsDefault: 10, authoredServingsDefault: 10,
    dishes: [{ title: "Turkey", ings: [["whole turkey", 12, "pound"]] }, { title: "Gravy", ings: [["turkey stock", 4, "cup"]] }],
  });
  s.t.plans.push({ id: "plan-1", userId: USER, revisionId: 3 });
  return s;
}

async function post(prisma: unknown, body: unknown, mealId = "feast") {
  const app = express();
  app.use(express.json());
  app.use(createMeRouter({
    prisma: withSessionUser(prisma) as never,
    estimateDishMacros: (async () => ({ status: "failed", error: "test stub" })) as never,
  }));
  const server: Server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/me/meals/${mealId}/dishes/from-catalog`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${signToken(USER)}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  } finally {
    await new Promise((r) => server.close(() => r(null)));
  }
}

describe("POST /me/meals/:mealId/dishes/from-catalog (THX-2S G)", () => {
  it("replace keeps the position; the replaced dish is deleted; the stamp picks up the dish's allergens", async () => {
    const s = scenario();
    const res = await post(s.prisma, { sourceMealId: "alt-turkey", replaceDishId: "feast-d0" });
    assert.equal(res.status, 201);
    const newId = res.body.dish.id as string;
    assert.equal(res.body.dish.positionIndex, 0);
    assert.deepEqual(res.body.meal.dishIds, [newId, "feast-d1", "feast-d2"]);
    assert.ok(!s.t.dishes.some((d) => d.id === "feast-d0"), "the user's own replaced dish is gone");
    const feast = s.t.meals.find((m) => m.id === "feast")!;
    assert.deepEqual(feast.allergens, ["dairy"]);
    assert.deepEqual(feast.allergenSources, { dairy: ["buttermilk"] });
    // 10 → 10: copied as written, at the target's anchor and household.
    const dish = s.t.dishes.find((d) => d.id === newId)!;
    assert.equal(dish.authoredServingsDefault, 10);
    assert.equal(dish.servingsDefault, 2);
    assert.equal(dish.userId, USER);
    // The source is untouched.
    assert.equal(s.t.dishIngredients.filter((di) => di.dishId === "alt-turkey-d0").length, 2);
  });

  it("scaling 10 → 4: ingredient quantities and step amountRefs × 0.4, written at the target's anchor", async () => {
    const s = scenario(4); // the Small feast, authored for 4
    const res = await post(s.prisma, { sourceMealId: "alt-turkey" });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.scaling, { targetServings: 4, sourceServings: 10, factor: 0.4 });
    assert.equal(res.body.dish.positionIndex, 3, "added last");
    const newId = res.body.dish.id as string;
    const lines = s.t.dishIngredients.filter((di) => di.dishId === newId).map((di) => [di.ingredientId, di.quantity, di.unit]);
    assert.deepEqual(lines, [["ing-whole turkey", 4.8, "pound"], ["ing-buttermilk", 3.2, "cup"]]);
    const step = s.t.steps.find((st) => st.ownerId === newId)!;
    assert.equal((step.amountRefs as Array<{ quantity: number }>)[0].quantity, 4.8);
    assert.equal(s.t.dishes.find((d) => d.id === newId)!.authoredServingsDefault, 4);
  });

  it("bumpPlanId bumps that plan's revision (grocery reconcile), as PATCH does", async () => {
    const s = scenario();
    const res = await post(s.prisma, { sourceMealId: "alt-turkey", bumpPlanId: "plan-1" });
    assert.equal(res.status, 201);
    assert.equal(s.t.plans[0].revisionId, 4);
  });

  it("a non-public source → 404; a multi-dish source → 400; nothing is written", async () => {
    const s = scenario();
    const before = s.t.dishes.length;
    const priv = await post(s.prisma, { sourceMealId: "private-turkey" });
    assert.equal(priv.status, 404);
    const multi = await post(s.prisma, { sourceMealId: "classic-feast-catalog" });
    assert.equal(multi.status, 400);
    assert.equal(multi.body.dishCount, 2);
    assert.equal(s.t.dishes.length, before);
  });

  it("the 8-dish cap: a 9th add → 409; a replace on a full meal is allowed", async () => {
    const s = scenario();
    for (let i = 3; i < 8; i++) {
      s.t.links.push({ mealId: "feast", dishId: `feast-d1`, positionIndex: i, roleLabel: "side" });
    }
    const add = await post(s.prisma, { sourceMealId: "alt-turkey" });
    assert.equal(add.status, 409);
    const swap = await post(s.prisma, { sourceMealId: "alt-turkey", replaceDishId: "feast-d0" });
    assert.equal(swap.status, 201);
  });

  it("someone else's meal → 403; a catalog target → 403; a dish not in the meal → 404", async () => {
    const s = scenario();
    s.addMeal({ id: "theirs", userId: "someone-else", servingsDefault: 4, authoredServingsDefault: 4, dishes: [{ title: "X", ings: [["salt", 1, "tsp"]] }] });
    assert.equal((await post(s.prisma, { sourceMealId: "alt-turkey" }, "theirs")).status, 403);
    assert.equal((await post(s.prisma, { sourceMealId: "alt-turkey" }, "alt-turkey")).status, 403);
    assert.equal((await post(s.prisma, { sourceMealId: "alt-turkey", replaceDishId: "nope" })).status, 404);
  });
});

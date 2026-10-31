// SERVER-13 A (BUG-472) — /me/staples: mark a grocery row's food as a staple, list,
// remove; the user's open lists' rows of that food take (and lose) the generator's mark.
//
// The stub evaluates the where clauses the library writes (user scope, open statuses,
// the ingredient's canonical name), so a dropped clause is a red test, not a pass.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import { signToken } from "../../lib/auth";
import { normalizeIngredientName } from "../../lib/groceryNormalization";
import { createMeRouter } from "../me";
import { withSessionUser } from "./fixtures/sessionUserStub";

const U = "user-staples";
const OTHER = "user-other";

interface Ing { id: string; canonicalName: string; displayName: string }
interface List { id: string; userId: string; status: string }
interface Item { id: string; groceryListId: string; ingredientId: string | null; isUserPantryStaple: boolean }
interface Staple { id: string; userId: string; ingredientName: string; isActive: boolean; createdAt: Date }

function world() {
  const ingredients: Ing[] = [
    { id: "ing-gp", canonicalName: "garlic powder", displayName: "Garlic powder" },
    { id: "ing-op", canonicalName: "onion powder", displayName: "Onion powder" },
  ];
  const lists: List[] = [
    { id: "L-active", userId: U, status: "active" },
    { id: "L-draft", userId: U, status: "draft" },
    { id: "L-done", userId: U, status: "completed" },
    { id: "L-other", userId: OTHER, status: "active" },
  ];
  const items: Item[] = [
    { id: "i-gp-active", groceryListId: "L-active", ingredientId: "ing-gp", isUserPantryStaple: false },
    { id: "i-gp-draft", groceryListId: "L-draft", ingredientId: "ing-gp", isUserPantryStaple: false },
    { id: "i-gp-done", groceryListId: "L-done", ingredientId: "ing-gp", isUserPantryStaple: false },
    { id: "i-op-active", groceryListId: "L-active", ingredientId: "ing-op", isUserPantryStaple: false },
    { id: "i-gp-other", groceryListId: "L-other", ingredientId: "ing-gp", isUserPantryStaple: false },
    { id: "i-extra", groceryListId: "L-active", ingredientId: null, isUserPantryStaple: false },
  ];
  const staples: Staple[] = [];
  let clock = Date.parse("2026-10-30T12:00:00Z");
  const listOf = (it: Item) => lists.find((l) => l.id === it.groceryListId)!;
  const ingOf = (it: Item) => ingredients.find((i) => i.id === it.ingredientId) ?? null;

  const db = {
    groceryListItem: {
      findFirst: async ({ where }: any) => {
        const it = items.find((x) => x.id === where.id && listOf(x).userId === where.groceryList.userId);
        if (!it) return null;
        const ing = ingOf(it);
        return { ingredient: ing ? { ...ing } : null };
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const it of items) {
          const l = listOf(it);
          const ing = ingOf(it);
          if (l.userId !== where.groceryList.userId) continue;
          if (!where.groceryList.status.in.includes(l.status)) continue;
          if (!ing || ing.canonicalName.toLowerCase() !== where.ingredient.canonicalName.equals.toLowerCase()) continue;
          if (it.isUserPantryStaple !== where.isUserPantryStaple) continue;
          it.isUserPantryStaple = data.isUserPantryStaple;
          count++;
        }
        return { count };
      },
    },
    pantryStaple: {
      findUnique: async ({ where }: any) => staples.find((s) => s.userId === where.userId_ingredientName.userId && s.ingredientName === where.userId_ingredientName.ingredientName) ?? null,
      findFirst: async ({ where }: any) => staples.find((s) => s.id === where.id && s.userId === where.userId) ?? null,
      create: async ({ data }: any) => {
        const row: Staple = { id: `st-${staples.length + 1}`, userId: data.userId, ingredientName: data.ingredientName, isActive: true, createdAt: new Date((clock += 60_000)) };
        staples.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = staples.find((s) => s.id === where.id)!;
        Object.assign(row, data, { createdAt: new Date((clock += 60_000)) });
        return row;
      },
      delete: async ({ where }: any) => staples.splice(staples.findIndex((s) => s.id === where.id), 1)[0],
      findMany: async ({ where, orderBy }: any) => {
        const dir = orderBy?.[0]?.createdAt === "desc" ? -1 : 1;
        return staples
          .filter((s) => s.userId === where.userId && s.isActive === where.isActive)
          .sort((a, b) => dir * (a.createdAt.getTime() - b.createdAt.getTime()) || dir * (a.id < b.id ? -1 : 1));
      },
    },
    ingredient: {
      findMany: async ({ where }: any) => ingredients.filter((i) => where.canonicalName.in.includes(i.canonicalName)),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    $executeRaw: async () => 0,
  };
  return { db, items, staples, mark: (id: string) => items.find((i) => i.id === id)!.isUserPantryStaple };
}

async function serve(db: unknown) {
  const app = express();
  app.use(express.json());
  app.use(createMeRouter({ prisma: withSessionUser(db) as never }));
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: string, path: string, body?: unknown, user = U) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${signToken(user)}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("SERVER-13 A — POST /me/staples", () => {
  it("201 with { id, ingredientId, name, createdAt }; the row's food is the staple, by its canonical name", async () => {
    const w = world();
    const h = await serve(w.db);
    try {
      const r = await h.call("POST", "/me/staples", { groceryItemId: "i-gp-active" });
      assert.equal(r.status, 201);
      assert.deepEqual(Object.keys(r.body).sort(), ["createdAt", "id", "ingredientId", "name"]);
      assert.equal(r.body.ingredientId, "ing-gp");
      assert.equal(r.body.name, "Garlic powder");
      assert.equal(w.staples.length, 1);
      // The generator's comparison (groceryList.ts): normalised staple name vs the bucket's canonical name.
      assert.equal(normalizeIngredientName(w.staples[0].ingredientName), normalizeIngredientName("garlic powder"));
    } finally {
      await h.close();
    }
  });

  it("the user's open lists' rows of that food take the mark; a completed list, another food and another user's list do not", async () => {
    const w = world();
    const h = await serve(w.db);
    try {
      await h.call("POST", "/me/staples", { groceryItemId: "i-gp-draft" });
      assert.equal(w.mark("i-gp-active"), true, "active list");
      assert.equal(w.mark("i-gp-draft"), true, "draft list (the tapped row)");
      assert.equal(w.mark("i-gp-done"), false, "a completed list is a record of a shop");
      assert.equal(w.mark("i-op-active"), false, "another food");
      assert.equal(w.mark("i-gp-other"), false, "another user's list");
    } finally {
      await h.close();
    }
  });

  it("409 when the food is already a staple (with the staple); 404 another user's row; 422 a row with no catalog food; 400 no id", async () => {
    const w = world();
    const h = await serve(w.db);
    try {
      const first = await h.call("POST", "/me/staples", { groceryItemId: "i-gp-active" });
      const again = await h.call("POST", "/me/staples", { groceryItemId: "i-gp-draft" });
      assert.equal(again.status, 409);
      assert.equal(again.body.reason, "staple_exists");
      assert.equal(again.body.staple.id, first.body.id);
      assert.equal(w.staples.length, 1);
      assert.equal((await h.call("POST", "/me/staples", { groceryItemId: "i-gp-other" })).status, 404);
      const extra = await h.call("POST", "/me/staples", { groceryItemId: "i-extra" });
      assert.equal(extra.status, 422);
      assert.equal(extra.body.reason, "no_catalog_ingredient");
      assert.equal((await h.call("POST", "/me/staples", {})).status, 400);
    } finally {
      await h.close();
    }
  });
});

describe("SERVER-13 A — GET /me/staples", () => {
  it("{ items } newest first, the user's own, each with its catalog id and name", async () => {
    const w = world();
    const h = await serve(w.db);
    try {
      await h.call("POST", "/me/staples", { groceryItemId: "i-gp-active" });
      await h.call("POST", "/me/staples", { groceryItemId: "i-op-active" });
      w.staples.push({ id: "st-other", userId: OTHER, ingredientName: "salt", isActive: true, createdAt: new Date() });
      w.staples.push({ id: "st-off", userId: U, ingredientName: "pepper", isActive: false, createdAt: new Date() });
      const r = await h.call("GET", "/me/staples");
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.items.map((s: any) => [s.name, s.ingredientId]), [["Onion powder", "ing-op"], ["Garlic powder", "ing-gp"]]);
    } finally {
      await h.close();
    }
  });
});

describe("SERVER-13 A — DELETE /me/staples/:id", () => {
  it("204; the open lists' rows lose the mark, the completed list keeps what it had; 404 for another user's staple", async () => {
    const w = world();
    const h = await serve(w.db);
    try {
      const made = await h.call("POST", "/me/staples", { groceryItemId: "i-gp-active" });
      w.items.find((i) => i.id === "i-gp-done")!.isUserPantryStaple = true; // marked when it was generated
      w.staples.push({ id: "st-other", userId: OTHER, ingredientName: "garlic powder", isActive: true, createdAt: new Date() });
      assert.equal((await h.call("DELETE", "/me/staples/st-other")).status, 404);
      const del = await h.call("DELETE", `/me/staples/${made.body.id}`);
      assert.equal(del.status, 204);
      assert.equal(w.staples.some((s) => s.id === made.body.id), false);
      assert.equal(w.mark("i-gp-active"), false);
      assert.equal(w.mark("i-gp-draft"), false);
      assert.equal(w.mark("i-gp-done"), true);
      assert.equal(w.staples.some((s) => s.id === "st-other"), true);
      assert.equal((await h.call("DELETE", `/me/staples/${made.body.id}`)).status, 404);
    } finally {
      await h.close();
    }
  });
});

// CAT-Q1 — one meal's FULL row graph (every column of the Meal row, its links,
// its dishes, their ingredient lines and their steps, plus meal-owned steps),
// a canonical hash of it, and the restore that puts a graph back exactly.
//
// Every write in this lane (A archive, B deterministic edits, C AI patches)
// saves the pre-image read INSIDE its transaction, and the post-image hash
// after the write. revert.ts restores the pre-image only when the row graph
// still hashes to that post-image (nobody wrote since), and proves the restore
// by re-hashing to the pre-image inside the same transaction.
import { createHash } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

export type Tx = Prisma.TransactionClient | PrismaClient;
type Row = Record<string, unknown>;

export interface MealGraph {
  meal: Row;
  links: Row[];
  dishes: Row[];
  ingredients: Row[];
  steps: Row[];
}

/** Every column of every row, rows sorted by id. Null when the meal is absent. */
export async function readGraph(tx: Tx, mealId: string): Promise<MealGraph | null> {
  const meal = await tx.meal.findUnique({ where: { id: mealId } });
  if (!meal) return null;
  const links = await tx.mealDishLink.findMany({ where: { mealId }, orderBy: { id: "asc" } });
  const dishIds = links.map((l) => l.dishId);
  const [dishes, ingredients, steps] = await Promise.all([
    tx.dish.findMany({ where: { id: { in: dishIds } }, orderBy: { id: "asc" } }),
    tx.dishIngredient.findMany({ where: { dishId: { in: dishIds } }, orderBy: { id: "asc" } }),
    tx.recipeInstructionStep.findMany({
      where: { OR: [{ ownerType: "dish", ownerId: { in: dishIds } }, { ownerType: "meal", ownerId: mealId }] },
      orderBy: { id: "asc" },
    }),
  ]);
  return { meal: meal as Row, links: links as Row[], dishes: dishes as Row[], ingredients: ingredients as Row[], steps: steps as Row[] };
}

/** Stable JSON: object keys sorted, Dates as ISO strings. JSONB does not keep key order. */
export function canon(v: unknown): string {
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Row;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export const graphHash = (g: MealGraph | null) => createHash("sha256").update(canon(g)).digest("hex");

/** A saved graph round-trips through JSON: Date columns come back as strings. */
const DATE_COLS: Record<string, string[]> = {
  meal: ["imageGeneratedAt", "allergensStampedAt", "lastUsedAt", "createdAt", "updatedAt"],
  dish: ["lastUsedAt", "createdAt", "updatedAt"],
};
export function reviveGraph(g: MealGraph): MealGraph {
  const fix = (r: Row, cols: string[]) => {
    const o = { ...r };
    for (const c of cols) if (typeof o[c] === "string") o[c] = new Date(o[c] as string);
    return o;
  };
  return { ...g, meal: fix(g.meal, DATE_COLS.meal), dishes: g.dishes.map((d) => fix(d, DATE_COLS.dish)) };
}

/** Prisma rejects SQL NULL for a Json column in `data`; it wants Prisma.DbNull. */
const JSON_COLS = new Set(["allergenSources", "substitutions", "componentRegistry", "componentSelections", "amountRefs"]);
function data(r: Row, dbNull: unknown): Row {
  const o: Row = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === "id") continue;
    o[k] = v === null && JSON_COLS.has(k) ? dbNull : v;
  }
  return o;
}

/**
 * Put `pre` back. Rows that differ are updated with every column (updatedAt
 * included — Prisma writes an explicit @updatedAt value as given); ingredient
 * lines and steps present now but absent from `pre` are deleted, absent now but
 * present in `pre` re-created with their original id. Links and the dish set
 * are never changed by this lane, so a link difference is an error.
 */
export async function restoreGraph(tx: Prisma.TransactionClient, pre: MealGraph, dbNull: unknown): Promise<{ updated: number; created: number; deleted: number }> {
  const now = await readGraph(tx, String(pre.meal.id));
  if (!now) throw new Error(`restore: meal ${pre.meal.id} is gone`);
  if (canon(now.links) !== canon(pre.links)) throw new Error(`restore: meal ${pre.meal.id} links changed — not a graph this lane wrote`);
  let updated = 0, created = 0, deleted = 0;
  const sync = async (
    nowRows: Row[], preRows: Row[],
    ops: { update: (id: string, d: Row) => Promise<unknown>; create: (d: Row) => Promise<unknown>; del: (id: string) => Promise<unknown> },
  ) => {
    const preById = new Map(preRows.map((r) => [String(r.id), r]));
    const nowById = new Map(nowRows.map((r) => [String(r.id), r]));
    for (const [id, r] of nowById) if (!preById.has(id)) { await ops.del(id); deleted++; }
    for (const [id, r] of preById) {
      const cur = nowById.get(id);
      if (!cur) { await ops.create({ id, ...data(r, dbNull) }); created++; }
      else if (canon(cur) !== canon(r)) { await ops.update(id, data(r, dbNull)); updated++; }
    }
  };
  await sync(now.ingredients, pre.ingredients, {
    update: (id, d) => tx.dishIngredient.update({ where: { id }, data: d as Prisma.DishIngredientUncheckedUpdateInput }),
    create: (d) => tx.dishIngredient.create({ data: d as Prisma.DishIngredientUncheckedCreateInput }),
    del: (id) => tx.dishIngredient.delete({ where: { id } }),
  });
  await sync(now.steps, pre.steps, {
    update: (id, d) => tx.recipeInstructionStep.update({ where: { id }, data: d as Prisma.RecipeInstructionStepUncheckedUpdateInput }),
    create: (d) => tx.recipeInstructionStep.create({ data: d as Prisma.RecipeInstructionStepUncheckedCreateInput }),
    del: (id) => tx.recipeInstructionStep.delete({ where: { id } }),
  });
  // Dishes and the meal last: nothing after them may touch their updatedAt.
  await sync(now.dishes, pre.dishes, {
    update: (id, d) => tx.dish.update({ where: { id }, data: d as Prisma.DishUncheckedUpdateInput }),
    create: () => { throw new Error("restore: a dish row is missing"); },
    del: () => { throw new Error("restore: an extra dish row"); },
  });
  if (canon(now.meal) !== canon(pre.meal)) {
    await tx.meal.update({ where: { id: String(pre.meal.id) }, data: data(pre.meal, dbNull) as Prisma.MealUncheckedUpdateInput });
    updated++;
  }
  return { updated, created, deleted };
}

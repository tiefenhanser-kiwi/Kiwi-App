// SERVER-13 A (BUG-472) — A USER'S STAPLES: "Mark as staple" on a grocery-list row.
//
// PantryStaple (D-WS4-003) has existed since WS4 and list generation already honours
// it: groceryList.ts flags a bucket `isUserPantryStaple` when its canonical name is an
// active staple's `ingredientName` (normalised both sides). Only the routes were
// missing. A staple is keyed by the catalog ingredient's CANONICAL name, because that
// is what the generator compares; the table has no ingredientId column, and the wire's
// `ingredientId` is read back from Ingredient.canonicalName (unique), so no migration.
//
// On create and delete the user's OPEN lists (draft, active) take the same mark the
// generator sets, on every row of that ingredient — so the row the cook tapped dims at
// once, and so does the same food on their other open lists. A completed or archived
// list is a record of a shop and is left as it was.

import type { PrismaClient } from "@prisma/client";

export const OPEN_LIST_STATUSES = ["draft", "active"] as const;

export interface StapleWire {
  id: string;
  ingredientId: string | null;
  name: string;
  createdAt: string;
}

type StapleDb = Pick<PrismaClient, "pantryStaple" | "groceryListItem" | "ingredient" | "$transaction">;

export class StapleItemNotFoundError extends Error {}
export class StapleNotCatalogError extends Error {}
export class StapleExistsError extends Error {
  constructor(readonly staple: StapleWire) {
    super("staple exists");
  }
}

/** The user's open lists' rows of this canonical ingredient take (or lose) the staple mark. */
async function markOpenLists(db: Pick<PrismaClient, "groceryListItem">, userId: string, canonicalName: string, on: boolean): Promise<number> {
  const { count } = await db.groceryListItem.updateMany({
    where: {
      groceryList: { userId, status: { in: [...OPEN_LIST_STATUSES] } },
      ingredient: { canonicalName: { equals: canonicalName, mode: "insensitive" } },
      isUserPantryStaple: !on,
    },
    data: { isUserPantryStaple: on },
  });
  return count;
}

/** POST /me/staples — the row's catalog ingredient becomes a staple. */
export async function createStapleFromItem(
  db: StapleDb,
  userId: string,
  groceryItemId: string,
): Promise<{ staple: StapleWire; marked: number }> {
  const item = await db.groceryListItem.findFirst({
    where: { id: groceryItemId, groceryList: { userId } },
    select: { ingredient: { select: { id: true, canonicalName: true, displayName: true } } },
  });
  if (!item) throw new StapleItemNotFoundError(groceryItemId);
  const ing = item.ingredient;
  if (!ing) throw new StapleNotCatalogError(groceryItemId);
  const wire = (row: { id: string; createdAt: Date }): StapleWire => ({ id: row.id, ingredientId: ing.id, name: ing.displayName, createdAt: row.createdAt.toISOString() });

  const existing = await db.pantryStaple.findUnique({
    where: { userId_ingredientName: { userId, ingredientName: ing.canonicalName } },
    select: { id: true, isActive: true, createdAt: true },
  });
  if (existing?.isActive) throw new StapleExistsError(wire(existing));

  try {
    return await db.$transaction(async (tx) => {
      // An inactive row (none is written by these routes; D-WS4-003's model allows it)
      // comes back as a new staple: newest first means newly marked.
      const row = existing
        ? await tx.pantryStaple.update({ where: { id: existing.id }, data: { isActive: true, createdAt: new Date() }, select: { id: true, createdAt: true } })
        : await tx.pantryStaple.create({ data: { userId, ingredientName: ing.canonicalName }, select: { id: true, createdAt: true } });
      const marked = await markOpenLists(tx, userId, ing.canonicalName, true);
      return { staple: wire(row), marked };
    });
  } catch (err) {
    // Two taps at once: the unique (userId, ingredientName) refuses the second.
    if ((err as { code?: string }).code === "P2002") {
      const row = await db.pantryStaple.findUnique({ where: { userId_ingredientName: { userId, ingredientName: ing.canonicalName } }, select: { id: true, createdAt: true } });
      if (row) throw new StapleExistsError(wire(row));
    }
    throw err;
  }
}

/** GET /me/staples — the user's active staples, newest first. */
export async function listStaples(db: Pick<PrismaClient, "pantryStaple" | "ingredient">, userId: string): Promise<StapleWire[]> {
  const rows = await db.pantryStaple.findMany({
    where: { userId, isActive: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, ingredientName: true, createdAt: true },
  });
  if (rows.length === 0) return [];
  const ings = await db.ingredient.findMany({
    where: { canonicalName: { in: rows.map((r) => r.ingredientName) } },
    select: { id: true, canonicalName: true, displayName: true },
  });
  const byName = new Map(ings.map((i) => [i.canonicalName, i]));
  return rows.map((r) => {
    const ing = byName.get(r.ingredientName);
    return { id: r.id, ingredientId: ing?.id ?? null, name: ing?.displayName ?? r.ingredientName, createdAt: r.createdAt.toISOString() };
  });
}

/** DELETE /me/staples/:id — false when the user has no such staple. */
export async function deleteStaple(db: StapleDb, userId: string, id: string): Promise<{ deleted: boolean; unmarked: number }> {
  const row = await db.pantryStaple.findFirst({ where: { id, userId }, select: { id: true, ingredientName: true } });
  if (!row) return { deleted: false, unmarked: 0 };
  return db.$transaction(async (tx) => {
    await tx.pantryStaple.delete({ where: { id: row.id } });
    const unmarked = await markOpenLists(tx, userId, row.ingredientName, false);
    return { deleted: true, unmarked };
  });
}

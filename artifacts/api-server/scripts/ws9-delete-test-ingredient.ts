// WS9 catalog cleanup — delete the hand-entered test Ingredient
// "yellow pooping onion" (dfef6d3a-64a5-47aa-82f5-64fa45447a5b).
//
// Surfaced by the BUG-125 Phase 0 catalog dump: a real row in `ingredients`,
// `pu=each pq=2 pd="2 medium onions"`, category Produce. Hans entered it by
// hand while testing and has ruled it removed. No user ever saw it — zero
// GroceryListItem rows carry it.
//
// ── WHY A GATED SCRIPT AND NOT A ONE-LINER ──────────────────────────────────
// BUG-096 established that an Ingredient has EIGHT carriers, and only two of
// them are declared foreign keys:
//   DishIngredient.ingredientId               FK, ON DELETE RESTRICT
//   GroceryListItem.ingredientId              FK, ON DELETE SET NULL  ← silent
//   IngredientAlias.ingredientId              FK, ON DELETE CASCADE   ← silent
//   RecipeInstructionStep.amountRefs[].ingredientId   no FK, JSON
//   PrepStepCompletion.stepKey                no FK, `${phase}#${ingredientId}`
//   PrepWeekStructure.structureJson           no FK, persisted stepKeys
//   ...plus the three name-carrying paths BUG-096 enumerated.
// Two of the three FKs delete SILENTLY rather than blocking, and three carriers
// have no FK at all. So the gate below does not trust referential integrity: it
// re-runs a brute-force scan of every text/json/uuid/array column in the public
// schema for the id AND the canonical name, and refuses to delete on any hit
// outside the `ingredients` row itself.
//
// Idempotent: a second run finds no row and exits 0 without writing.
// Usage: node --env-file=.env --import tsx scripts/ws9-delete-test-ingredient.ts [--apply]

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const TARGET_ID = "dfef6d3a-64a5-47aa-82f5-64fa45447a5b";
const TARGET_NAME = "yellow pooping onion";
const APPLY = process.argv.includes("--apply");

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
}

async function main(): Promise<void> {
  const row = await prisma.ingredient.findUnique({ where: { id: TARGET_ID } });
  if (!row) {
    console.log(`[ok] ${TARGET_ID} is already absent — nothing to do.`);
    return;
  }
  if (row.canonicalName !== TARGET_NAME) {
    throw new Error(
      `refusing: id ${TARGET_ID} holds canonicalName "${row.canonicalName}", expected "${TARGET_NAME}"`,
    );
  }
  console.log(`[found] "${row.canonicalName}" / "${row.displayName}" (${row.category})`);

  // Gate 1 — the declared FKs.
  const [dishIngredients, groceryItems, aliasRows] = await Promise.all([
    prisma.dishIngredient.count({ where: { ingredientId: TARGET_ID } }),
    prisma.groceryListItem.count({ where: { ingredientId: TARGET_ID } }),
    prisma.ingredientAlias.count({ where: { ingredientId: TARGET_ID } }),
  ]);
  console.log(
    `[fk] dishIngredients=${dishIngredients} groceryItems=${groceryItems} aliasRows=${aliasRows}`,
  );

  // Gate 2 — every text-ish column in the schema, FK-declared or not. This is
  // the gate that covers the three carriers with no foreign key.
  const columns = await prisma.$queryRawUnsafe<ColumnRow[]>(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('text','character varying','json','jsonb','ARRAY','uuid')
      ORDER BY table_name, column_name`,
  );
  const stray: string[] = [];
  let scanned = 0;
  for (const c of columns) {
    // The target row's own columns are the expected hit, not a reference.
    if (c.table_name === "ingredients") continue;
    const cast = `CAST("${c.column_name}" AS TEXT)`;
    const hits = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT COUNT(*)::int AS n FROM "${c.table_name}"
        WHERE ${cast} ILIKE $1 OR ${cast} ILIKE $2`,
      `%${TARGET_NAME}%`,
      `%${TARGET_ID}%`,
    );
    scanned++;
    if (hits[0].n > 0) stray.push(`${c.table_name}.${c.column_name} (${hits[0].n})`);
  }
  console.log(`[scan] ${scanned} columns scanned; stray references: ${stray.length}`);

  const blocked = dishIngredients + groceryItems + aliasRows + stray.length;
  if (blocked > 0) {
    throw new Error(
      `refusing to delete — ${blocked} reference(s) remain: ${stray.join(", ") || "(FK only)"}`,
    );
  }

  if (!APPLY) {
    console.log("[dry-run] zero references. Re-run with --apply to delete.");
    return;
  }
  await prisma.ingredient.delete({ where: { id: TARGET_ID } });
  console.log(`[applied] deleted ${TARGET_ID} ("${TARGET_NAME}").`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

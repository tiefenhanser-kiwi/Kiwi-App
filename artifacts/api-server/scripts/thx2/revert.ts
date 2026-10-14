// THX-2G — REVERT the Thanksgiving generation: hard-delete exactly the meals
// generate.ts created (sourceType batch_generated, dishFamilyKey `thx2-…`), each
// with its dishes, dish ingredients, steps and links — km30's revert
// (scripts/ws9-30min/revert.ts), plus assertScriptDatabase and a fork check.
// Refuses if any plan item, template item or user copy (sourceStoreMealId)
// references a meal: that is a user's data, not this run's. Dry by default.
//
//   node --env-file=.env --import tsx scripts/thx2/revert.ts                          # list, no deletes
//   node --env-file=.env --import tsx scripts/thx2/revert.ts --apply                  # delete all thx2- meals
//   node --env-file=.env --import tsx scripts/thx2/revert.ts --apply --keys <k,k,…>   # only these keys
//
// The GCS image object (meals/<id>.jpg) is left in the bucket: write-once by
// key, unreferenced once the row is gone.
import { PrismaClient } from "@prisma/client";

import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import { KEY_PREFIX } from "./thx2Core";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const keysIdx = argv.indexOf("--keys");
const ONLY = keysIdx >= 0 ? (argv[keysIdx + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : null;

const { host, mode } = assertScriptDatabase("thx2/revert");
console.log(`database: ${host} (${mode})`);
if (ONLY?.some((k) => !k.startsWith(KEY_PREFIX))) { console.error(`--keys: every key must start with ${KEY_PREFIX}`); process.exit(2); }

const prisma = new PrismaClient();
const meals = await prisma.meal.findMany({
  where: { sourceType: "batch_generated", dishFamilyKey: ONLY ? { in: ONLY } : { startsWith: KEY_PREFIX } },
  select: { id: true, title: true, dishFamilyKey: true, createdAt: true, isPublic: true },
  orderBy: { createdAt: "asc" },
});
const ids = meals.map((m) => m.id);
const planRefs = await prisma.mealPlanItem.count({ where: { mealId: { in: ids } } });
const tmplRefs = await prisma.mealPlanTemplateItem.count({ where: { mealId: { in: ids } } });
const forks = await prisma.meal.count({ where: { sourceStoreMealId: { in: ids } } });
console.log(`thx2- meals: ${meals.length}${ONLY ? ` (filtered to ${ONLY.length} keys)` : ""} · referenced by plan items: ${planRefs} · by template items: ${tmplRefs} · user copies: ${forks}`);
for (const m of meals) console.log(`  ${m.id} ${m.createdAt.toISOString()} ${m.dishFamilyKey} public=${m.isPublic} "${m.title.slice(0, 60)}"`);
if (planRefs || tmplRefs || forks) { console.log("🔴 REFUSING: a plan, a template or a user copy references at least one of these meals — remove those references first."); await prisma.$disconnect(); process.exit(2); }
if (!APPLY) { console.log("DRY — nothing deleted. Re-run with --apply."); await prisma.$disconnect(); process.exit(0); }

let deleted = 0;
for (const m of meals) {
  await prisma.$transaction(async (tx) => {
    const links = await tx.mealDishLink.findMany({ where: { mealId: m.id }, select: { dishId: true } });
    const dishIds = links.map((l) => l.dishId);
    await tx.recipeInstructionStep.deleteMany({ where: { ownerType: "dish", ownerId: { in: dishIds } } });
    await tx.dishIngredient.deleteMany({ where: { dishId: { in: dishIds } } });
    await tx.mealDishLink.deleteMany({ where: { mealId: m.id } });
    await tx.dish.deleteMany({ where: { id: { in: dishIds } } });
    await tx.meal.delete({ where: { id: m.id } });
  });
  deleted++;
}
const left = await prisma.meal.count({ where: { dishFamilyKey: ONLY ? { in: ONLY } : { startsWith: KEY_PREFIX } } });
console.log(`deleted ${deleted} meals · thx2- meals left: ${left}`);
await prisma.$disconnect();

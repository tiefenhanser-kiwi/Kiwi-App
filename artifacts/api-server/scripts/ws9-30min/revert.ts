// D-WS9-240 item 6 — REVERT the 30-minute supplement: hard-delete exactly the meals generate.ts
// created (sourceType batch_generated, dishFamilyKey `km30-…`), each with its dishes, dish
// ingredients, steps and links — the deleteMealGraph shape Block 3's purge used. Refuses any meal a
// plan or template already references (that is a user's data, not this run's). Dry by default.
//
//   node --env-file=.env --import tsx scripts/ws9-30min/revert.ts            # list, no deletes
//   node --env-file=.env --import tsx scripts/ws9-30min/revert.ts --apply    # delete
//   node --env-file=.env --import tsx scripts/ws9-30min/revert.ts --apply --ids <id,id,…>   # only these
import { PrismaClient } from "@prisma/client";

const KEY_PREFIX = "km30-";
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const idsIdx = argv.indexOf("--ids");
const ONLY = idsIdx >= 0 ? new Set(argv[idsIdx + 1].split(",").map((s) => s.trim()).filter(Boolean)) : null;

const prisma = new PrismaClient();
const meals = await prisma.meal.findMany({ where: { sourceType: "batch_generated", dishFamilyKey: { startsWith: KEY_PREFIX }, ...(ONLY ? { id: { in: [...ONLY] } } : {}) }, select: { id: true, title: true, dishFamilyKey: true, createdAt: true }, orderBy: { createdAt: "asc" } });
const ids = meals.map((m) => m.id);
const planRefs = await prisma.mealPlanItem.count({ where: { mealId: { in: ids } } });
const tmplRefs = await prisma.mealPlanTemplateItem.count({ where: { mealId: { in: ids } } });
console.log(`km30- meals in the DB: ${meals.length}${ONLY ? ` (filtered to ${ONLY.size} ids)` : ""} · referenced by plan items: ${planRefs} · by template items: ${tmplRefs}`);
for (const m of meals) console.log(`  ${m.id} ${m.createdAt.toISOString()} ${m.dishFamilyKey} "${m.title.slice(0, 60)}"`);
if (planRefs || tmplRefs) { console.log("🔴 REFUSING: a plan or template references at least one of these meals — remove those references first."); await prisma.$disconnect(); process.exit(2); }
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
const left = await prisma.meal.count({ where: { dishFamilyKey: { startsWith: KEY_PREFIX }, ...(ONLY ? { id: { in: [...ONLY] } } : {}) } });
console.log(`deleted ${deleted} meals · km30- meals left: ${left}`);
await prisma.$disconnect();

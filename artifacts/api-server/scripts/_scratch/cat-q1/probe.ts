// CAT-Q1 — a shape probe (READ-ONLY, findMany only): which pilot ids exist on
// this database, whether catalog dishes are shared between meals, how swaps
// relate to bought-path rows, and the seed meals' references.
//   node --env-file=.env --import tsx scripts/_scratch/cat-q1/probe.ts
import { Prisma, PrismaClient } from "@prisma/client";

import { assertScriptDatabase } from "../../../src/lib/scripts/requireDatabaseHost";
import { CATALOG_WHERE } from "../cat-q0/catalogDb";
import { pilotIds, readIssues, SEED_IDS } from "./issues";

const { host, mode } = assertScriptDatabase("cat-q1/probe");
console.log(`database: ${host} (${mode})`);
const prisma = new PrismaClient();

const issues = readIssues();
const pilot = pilotIds(issues);
const have = new Set((await prisma.meal.findMany({ where: { ...CATALOG_WHERE, id: { in: pilot } }, select: { id: true } })).map((m) => m.id));
console.log(`pilot ${pilot.length} ids · on this database (catalog) ${have.size} · missing: ${pilot.filter((id) => !have.has(id)).join(", ")}`);

// Shared dishes: a catalog meal's dish linked by any other meal.
const links = await prisma.mealDishLink.findMany({ where: { meal: CATALOG_WHERE }, select: { mealId: true, dishId: true } });
const dishIds = [...new Set(links.map((l) => l.dishId))];
const all = await prisma.mealDishLink.findMany({ where: { dishId: { in: dishIds } }, select: { dishId: true, mealId: true, meal: { select: { isPublic: true, isArchived: true, userId: true } } } });
const byDish = new Map<string, typeof all>();
for (const l of all) byDish.set(l.dishId, [...(byDish.get(l.dishId) ?? []), l]);
const shared = [...byDish.values()].filter((ls) => ls.length > 1);
console.log(`catalog dishes ${dishIds.length} · linked by >1 meal ${shared.length} · of those with a non-catalog meal ${shared.filter((ls) => ls.some((l) => !l.meal.isPublic || l.meal.isArchived)).length}`);
for (const ls of shared.slice(0, 5)) console.log(`  ${ls[0].dishId}: ${ls.map((l) => `${l.mealId}${l.meal.isPublic ? "" : " (private)"}${l.meal.userId ? " user" : ""}`).join(", ")}`);

// Swaps vs components.
const dishes = await prisma.dish.findMany({ where: { id: { in: dishIds }, NOT: { substitutions: { equals: Prisma.DbNull } } }, select: { id: true, substitutions: true, componentRegistry: true }, take: 400 });
const withSubs = dishes.filter((d) => Array.isArray(d.substitutions) && (d.substitutions as unknown[]).length);
console.log(`dishes with substitutions (sample ≤400): ${withSubs.length}`);
for (const d of withSubs.slice(0, 3)) console.log(`  ${d.id}\n    subs ${JSON.stringify(d.substitutions)}\n    registry ${JSON.stringify(d.componentRegistry)}`);

// Seed meals.
for (const id of SEED_IDS) {
  const m = await prisma.meal.findUnique({
    where: { id },
    select: { id: true, title: true, isPublic: true, isArchived: true, _count: { select: { planItems: true, templateItems: true, favorites: true, playlistMeals: true, dishLinks: true } }, templateItems: { select: { mealPlanTemplateId: true } } },
  });
  console.log(`  ${id}: ${m ? `${m.title} public=${m.isPublic} archived=${m.isArchived} ${JSON.stringify(m._count)} templates=${m.templateItems.map((t) => t.mealPlanTemplateId).join(",")}` : "absent"}`);
}
await prisma.$disconnect();

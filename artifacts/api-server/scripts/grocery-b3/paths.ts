// [grocery] B3 · Part A — RULE 3's POPULATION. READ-ONLY.
//
//   node --env-file=.env --import tsx scripts/grocery-b3/paths.ts -> out/paths.txt
//
// Confirms (or refutes) §1 Job 2's counts and NAMES the only-bought components.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const host = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
const prisma = new PrismaClient();

const L: string[] = [];
const say = (s = "") => { L.push(s); console.log(s); };

async function main() {
  const steps = await prisma.recipeInstructionStep.findMany({
    where: { componentKey: { not: null } },
    select: { id: true, ownerType: true, ownerId: true, componentKey: true, pathKey: true, stepIndex: true, stepTextTranslated: true },
  });
  say(`tagged RecipeInstructionStep rows: ${steps.length}`);
  const byPath: Record<string, number> = {};
  for (const s of steps) byPath[String(s.pathKey)] = (byPath[String(s.pathKey)] ?? 0) + 1;
  say(`  by pathKey: ${JSON.stringify(byPath)}`);
  const byOwnerType: Record<string, number> = {};
  for (const s of steps) byOwnerType[s.ownerType] = (byOwnerType[s.ownerType] ?? 0) + 1;
  say(`  by ownerType: ${JSON.stringify(byOwnerType)}`);

  // a COMPONENT is (ownerType, ownerId, componentKey)
  const comps = new Map<string, { scratch: number; bought: number; other: number; ownerType: string; ownerId: string; key: string }>();
  for (const s of steps) {
    const k = `${s.ownerType}|${s.ownerId}|${s.componentKey}`;
    let c = comps.get(k);
    if (!c) { c = { scratch: 0, bought: 0, other: 0, ownerType: s.ownerType, ownerId: s.ownerId, key: s.componentKey! }; comps.set(k, c); }
    if (s.pathKey === "scratch") c.scratch++;
    else if (s.pathKey === "bought") c.bought++;
    else c.other++;
  }
  const both = [...comps.values()].filter((c) => c.scratch > 0 && c.bought > 0);
  const onlyBought = [...comps.values()].filter((c) => c.scratch === 0 && c.bought > 0);
  const onlyScratch = [...comps.values()].filter((c) => c.bought === 0 && c.scratch > 0);
  say(`components (ownerType,ownerId,componentKey): ${comps.size}`);
  say(`  both paths:   ${both.length}`);
  say(`  only bought:  ${onlyBought.length}`);
  say(`  only scratch: ${onlyScratch.length}`);

  const dishIds = new Set(steps.filter((s) => s.ownerType === "dish").map((s) => s.ownerId));
  const mealIds = new Set(steps.filter((s) => s.ownerType === "meal").map((s) => s.ownerId));
  say(`distinct tagged dish owners: ${dishIds.size}   meal owners: ${mealIds.size}`);

  // meals reached through those dishes
  const links = await prisma.mealDishLink.findMany({
    where: { dishId: { in: [...dishIds] } }, select: { mealId: true },
  });
  const reachedMeals = new Set([...links.map((l) => l.mealId), ...mealIds]);
  say(`meals reached (via MealDishLink + meal-owned): ${reachedMeals.size}`);

  say("");
  say("## THE ONLY-BOUGHT COMPONENTS — these come out EMPTY in the scheduler today");
  for (const c of onlyBought) {
    const owner = c.ownerType === "dish"
      ? await prisma.dish.findUnique({ where: { id: c.ownerId }, select: { title: true, userId: true, componentRegistry: true } })
      : await prisma.meal.findUnique({ where: { id: c.ownerId }, select: { title: true, userId: true } });
    const compSteps = steps.filter((s) => s.ownerType === c.ownerType && s.ownerId === c.ownerId && s.componentKey === c.key);
    const totalSteps = await prisma.recipeInstructionStep.count({ where: { ownerType: c.ownerType, ownerId: c.ownerId } });
    const survivors = await prisma.recipeInstructionStep.count({
      where: { ownerType: c.ownerType, ownerId: c.ownerId, OR: [{ pathKey: null }, { pathKey: { not: "bought" } }] },
    });
    say(`  ${c.ownerType} ${c.ownerId}  "${owner?.title ?? "?"}"  user ${(owner as {userId?:string|null})?.userId?.slice(0,8) ?? "PUBLIC"}`);
    say(`      componentKey "${c.key}"  bought steps ${c.bought}  scratch 0`);
    say(`      owner has ${totalSteps} steps; ${survivors} survive selectDefaultPathSteps  (${totalSteps - survivors} dropped)`);
    for (const s of compSteps) say(`        [${s.stepIndex}] ${s.stepTextTranslated.slice(0, 110)}`);
  }

  // DishIngredient tagging
  const diTotal = await prisma.dishIngredient.count();
  const diTagged = await prisma.dishIngredient.count({ where: { componentKey: { not: null } } });
  const diPath = await prisma.dishIngredient.count({ where: { pathKey: { not: null } } });
  say("");
  say(`DishIngredient rows: ${diTotal}   componentKey tagged: ${diTagged}   pathKey tagged: ${diPath}`);

  // componentRegistry population
  const withRegistry = await prisma.dish.count({ where: { componentRegistry: { not: Prisma_null() } } });
  say(`dishes with a componentRegistry: ${withRegistry}`);

  // how many PLAN-REACHABLE meals carry an only-bought component
  say("");
  say("## do any of the 20 census plans reach an only-bought component?");
  const obDishIds = onlyBought.filter((c) => c.ownerType === "dish").map((c) => c.ownerId);
  const obMealIds = onlyBought.filter((c) => c.ownerType === "meal").map((c) => c.ownerId);
  const obLinks = await prisma.mealDishLink.findMany({ where: { dishId: { in: obDishIds } }, select: { mealId: true, dishId: true } });
  const targetMeals = new Set([...obLinks.map((l) => l.mealId), ...obMealIds]);
  const items = await prisma.mealPlanItem.findMany({
    where: { mealId: { in: [...targetMeals] } },
    select: { mealId: true, mealPlanInstanceId: true },
  });
  say(`  MealPlanItem rows pointing at a meal with an only-bought component: ${items.length}`);
  const planIds = [...new Set(items.map((i) => i.mealPlanInstanceId))];
  say(`  distinct plans: ${planIds.length}${planIds.length ? " -> " + planIds.map((p) => p.slice(0, 8)).join(", ") : ""}`);

  writeFileSync(join(OUT, "paths.txt"), L.join("\n") + "\n");
}

function Prisma_null() {
  // Prisma's JSON-null filter sentinel, avoided as an import for brevity.
  return null as unknown as never;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());

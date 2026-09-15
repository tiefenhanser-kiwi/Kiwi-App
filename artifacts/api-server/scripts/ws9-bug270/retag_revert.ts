// WS9 BUG-270 Phase E — REVERT the re-tag: restores every listed step's parallelGroup (old values, nulls
// included) and writes the meal/dish stamps back from retag_before.json (= the Phase D state). Asserts one row
// per id; re-reads and checks after applying. No API. Dry by default.
//   node --env-file=.env --import tsx scripts/ws9-bug270/retag_revert.ts          # dry
//   node --env-file=.env --import tsx scripts/ws9-bug270/retag_revert.ts --apply
import { PrismaClient, type Prisma } from "@prisma/client";
import { readFileSync } from "node:fs";

const OUT = "scripts/output/ws9-bug270";
const APPLY = process.argv.includes("--apply");
const b = JSON.parse(readFileSync(`${OUT}/retag_before.json`, "utf8")) as { recordedAt: string; steps: { dishId: string; stepIndex: number; parallelGroup: string | null }[]; meals: { id: string; estimatedTimeMinutes: number; activeTimeMinutes: number | null }[]; dishes: { id: string; estimatedTimeMinutes: number | null }[] };
if (new Set(b.steps.map((s) => `${s.dishId}#${s.stepIndex}`)).size !== b.steps.length) throw new Error("duplicate step row");
if (new Set(b.meals.map((m) => m.id)).size !== b.meals.length || new Set(b.dishes.map((d) => d.id)).size !== b.dishes.length) throw new Error("duplicate meal/dish row");
console.log(`retag_before.json (${b.recordedAt}): ${b.steps.length} step rows · ${b.meals.length} meals · ${b.dishes.length} dishes · one row per id ✓ · MODE = ${APPLY ? "APPLY" : "DRY"}`);
const prisma = new PrismaClient();
console.log(`DB HOST = ${new URL(process.env.DATABASE_URL!).host}`);
if (!APPLY) { console.log("DRY — nothing reverted. Re-run with --apply."); await prisma.$disconnect(); process.exit(0); }
await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
  for (const s of b.steps) { const r = await tx.recipeInstructionStep.updateMany({ where: { ownerType: "dish", ownerId: s.dishId, stepIndex: s.stepIndex }, data: { parallelGroup: s.parallelGroup } }); if (r.count !== 1) throw new Error(`step ${s.dishId}#${s.stepIndex}: ${r.count} rows`); }
  for (const m of b.meals) await tx.meal.update({ where: { id: m.id }, data: { estimatedTimeMinutes: m.estimatedTimeMinutes, activeTimeMinutes: m.activeTimeMinutes } });
  for (const d of b.dishes) await tx.dish.update({ where: { id: d.id }, data: { estimatedTimeMinutes: d.estimatedTimeMinutes } });
}, { timeout: 120_000 });
const steps = await prisma.recipeInstructionStep.findMany({ where: { ownerType: "dish", ownerId: { in: [...new Set(b.steps.map((s) => s.dishId))] } }, select: { ownerId: true, stepIndex: true, parallelGroup: true } });
const badS = b.steps.filter((s) => steps.find((x) => x.ownerId === s.dishId && x.stepIndex === s.stepIndex)?.parallelGroup !== s.parallelGroup).length;
const meals = await prisma.meal.findMany({ where: { id: { in: b.meals.map((m) => m.id) } }, select: { id: true, estimatedTimeMinutes: true, activeTimeMinutes: true } });
const badM = b.meals.filter((m) => { const x = meals.find((y) => y.id === m.id)!; return x.estimatedTimeMinutes !== m.estimatedTimeMinutes || x.activeTimeMinutes !== m.activeTimeMinutes; }).length;
const dishes = await prisma.dish.findMany({ where: { id: { in: b.dishes.map((d) => d.id) } }, select: { id: true, estimatedTimeMinutes: true } });
const badD = b.dishes.filter((d) => dishes.find((y) => y.id === d.id)!.estimatedTimeMinutes !== d.estimatedTimeMinutes).length;
console.log(`after revert: steps back ${b.steps.length - badS}/${b.steps.length} · meals ${b.meals.length - badM}/${b.meals.length} · dishes ${b.dishes.length - badD}/${b.dishes.length}${badS || badM || badD ? " 🔴" : " ✓"}`);
await prisma.$disconnect();

// WS9 BUG-270 Phase D — REVERT the public re-stamp. Writes restamp_before.json's values back DIRECTLY
// (meal estimatedTimeMinutes + activeTimeMinutes, dish estimatedTimeMinutes): the old numbers came from
// the pre-fix scheduler and cannot be regenerated from the steps. Asserts one row per id, then re-reads
// and checks every row against the dump. No API. Dry by default.
//   node --env-file=.env --import tsx scripts/ws9-bug270/restamp_revert.ts          # dry: counts + assertions only
//   node --env-file=.env --import tsx scripts/ws9-bug270/restamp_revert.ts --apply  # write back + verify
import { PrismaClient, type Prisma } from "@prisma/client";
import { readFileSync } from "node:fs";

const OUT = "scripts/output/ws9-bug270";
const APPLY = process.argv.includes("--apply");
const before = JSON.parse(readFileSync(`${OUT}/restamp_before.json`, "utf8")) as { recordedAt: string; meals: { id: string; estimatedTimeMinutes: number; activeTimeMinutes: number | null }[]; dishes: { id: string; estimatedTimeMinutes: number | null }[] };
if (new Set(before.meals.map((m) => m.id)).size !== before.meals.length) throw new Error("restamp_before.json: duplicate meal id");
if (new Set(before.dishes.map((d) => d.id)).size !== before.dishes.length) throw new Error("restamp_before.json: duplicate dish id");
console.log(`restamp_before.json (${before.recordedAt}): ${before.meals.length} meals · ${before.dishes.length} dishes · one row per id ✓ · MODE = ${APPLY ? "APPLY" : "DRY"}`);
const prisma = new PrismaClient();
console.log(`DB HOST = ${new URL(process.env.DATABASE_URL!).host}`);
if (!APPLY) { console.log("DRY — nothing reverted. Re-run with --apply."); await prisma.$disconnect(); process.exit(0); }
for (let b = 0; b < before.meals.length; b += 100) {
  const batch = before.meals.slice(b, b + 100);
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const m of batch) await tx.meal.update({ where: { id: m.id }, data: { estimatedTimeMinutes: m.estimatedTimeMinutes, activeTimeMinutes: m.activeTimeMinutes } });
  }, { timeout: 120_000 });
  console.log(`  meals ${b + 1}–${b + batch.length} reverted`);
}
for (let b = 0; b < before.dishes.length; b += 200) {
  const batch = before.dishes.slice(b, b + 200);
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const d of batch) await tx.dish.update({ where: { id: d.id }, data: { estimatedTimeMinutes: d.estimatedTimeMinutes } });
  }, { timeout: 120_000 });
  console.log(`  dishes ${b + 1}–${b + batch.length} reverted`);
}
const meals = await prisma.meal.findMany({ where: { id: { in: before.meals.map((m) => m.id) } }, select: { id: true, estimatedTimeMinutes: true, activeTimeMinutes: true } });
const dishes = await prisma.dish.findMany({ where: { id: { in: before.dishes.map((d) => d.id) } }, select: { id: true, estimatedTimeMinutes: true } });
const mb = new Map(before.meals.map((m) => [m.id, m])), db = new Map(before.dishes.map((d) => [d.id, d]));
const badM = meals.filter((m) => m.estimatedTimeMinutes !== mb.get(m.id)!.estimatedTimeMinutes || m.activeTimeMinutes !== mb.get(m.id)!.activeTimeMinutes).length;
const badD = dishes.filter((d) => d.estimatedTimeMinutes !== db.get(d.id)!.estimatedTimeMinutes).length;
console.log(`after revert: meals back at pre-write ${meals.length - badM}/${before.meals.length} · dishes ${dishes.length - badD}/${before.dishes.length}${badM || badD ? " 🔴" : " ✓"}`);
await prisma.$disconnect();

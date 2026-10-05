// [prepcook] Part J.1c — Hans's newest plan, found by createdAt on his own account
// (the owner of e55a9305). READ-ONLY: prints the plan, its meals and days, and the
// cache row's stamp. No writes of any kind.
//
//   node --env-file=.env --import tsx scripts/prep-cook-census/part-j1c/hans-newest.ts
import { PrismaClient } from "@prisma/client";

import { FORBIDDEN_PLAN } from "../part-i/corpus";

const prisma = new PrismaClient();

async function main() {
  const { userId } = await prisma.mealPlanInstance.findUniqueOrThrow({ where: { id: FORBIDDEN_PLAN }, select: { userId: true } });
  const plans = await prisma.mealPlanInstance.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 3,
    select: { id: true, titleOverride: true, createdAt: true, startDate: true, endDate: true, status: true },
  });
  for (const p of plans) console.log(`${p.id}  ${p.createdAt.toISOString()}  ${p.titleOverride ?? ""} [${p.status}]  ${p.startDate?.toISOString().slice(0, 10) ?? "-"}..${p.endDate?.toISOString().slice(0, 10) ?? "-"}`);
  const newest = plans[0];
  const items = await prisma.mealPlanItem.findMany({
    where: { mealPlanInstanceId: newest.id },
    select: { assignedDayOfWeek: true, assignedDate: true, meal: { select: { id: true, title: true } } },
  });
  console.log(`\nNEWEST ${newest.id} — ${items.length} meals`);
  for (const i of items) console.log(`  ${i.assignedDayOfWeek ?? "-"}  ${i.assignedDate?.toISOString().slice(0, 10) ?? "-"}  ${i.meal.title}  (${i.meal.id.slice(0, 8)})`);
  const row = await prisma.prepWeekStructure.findUnique({ where: { planId: newest.id }, select: { promptVersion: true, lastGeneratedAt: true, compositionFingerprint: true } });
  console.log(`\ncache row: ${row ? `v${row.promptVersion} at ${row.lastGeneratedAt.toISOString()} fp ${row.compositionFingerprint?.slice(0, 12)}` : "none"}`);
}
main().finally(() => prisma.$disconnect());

import { PrismaClient } from "@prisma/client";
import { loadPrepWeekInput } from "../../../src/lib/prepWeekAggregation";
import { buildPrepWeekPlan } from "../../../src/lib/prepWeekBuild";
import { TEST_USER_ID, loadCorpus } from "../part-i/corpus";
const prisma = new PrismaClient();
const codes = process.argv.slice(2);
(async () => {
  for (const row of await loadCorpus(prisma)) {
    if (codes.length && !codes.includes(row.code)) continue;
    const b = buildPrepWeekPlan(await loadPrepWeekInput({ planId: row.planId, userId: TEST_USER_ID, prisma }));
    for (const s of b.stepPlan.steps) {
      if (!s.portionLines) continue;
      const len = s.portionLines.join("\n").length;
      if (len < Number(process.env.MINLEN ?? 450)) continue;
      console.log(`\n${row.code} ${s.stepKey} len=${len} portions=${s.portionsByApp?.portionCount} total=${s.portionsByApp?.total}`);
      for (const l of s.portionLines) console.log("   ", l);
    }
  }
})().finally(() => prisma.$disconnect());

// [prepcook] Part J.1c item 3 — every single-dish lid still named with " — ", by why. FREE, READ-ONLY.
//   node --env-file=.env --import tsx scripts/prep-cook-census/part-j1c/lids.ts
import { PrismaClient } from "@prisma/client";

import { loadPrepWeekInput } from "../../../src/lib/prepWeekAggregation";
import { buildPrepWeekPlan } from "../../../src/lib/prepWeekBuild";
import { FORBIDDEN_PLAN, loadCorpus } from "../part-i/corpus";

const prisma = new PrismaClient();
async function main() {
  const rows = [...(await loadCorpus(prisma)), { code: "HANS-e55a9305", planId: FORBIDDEN_PLAN }, { code: "HANS-f49f5209", planId: "f49f5209-54c6-428b-a66e-a8b6ff9d2488" }];
  const byTail = new Map<string, number>();
  const samples: string[] = [];
  for (const row of rows) {
    const { userId } = await prisma.mealPlanInstance.findUniqueOrThrow({ where: { id: row.planId }, select: { userId: true } });
    const b = buildPrepWeekPlan(await loadPrepWeekInput({ planId: row.planId, userId, prisma, now: new Date("2026-10-04T12:00:00Z") }));
    const kinds = b.stepPlan.labelKinds ?? new Map();
    const lids = new Set<string>();
    for (const st of b.stepPlan.steps) {
      if (st.demoted || st.fixedProse) continue;
      if (st.bowlName) lids.add(st.bowlName);
      for (const c of st.components) for (const m of c.measures) if (m.destination) lids.add(m.destination);
    }
    for (const n of lids) {
      if (!n.includes(" — ") || kinds.get(n) === "shared") continue;
      const tail = n.split(" — ").slice(1).join(" — ");
      const why = /^(greens|herbs|aromatics)$/.test(tail) ? `class: ${tail}` : kinds.get(n) === "own-container" ? "two vegetable containers of one dish (H6.1)" : "a lone cut at another moment";
      byTail.set(why, (byTail.get(why) ?? 0) + 1);
      if (samples.length < 40 && !/^class/.test(why)) samples.push(`${row.code}  ${n}   [${why}]`);
    }
  }
  console.log([...byTail].map(([k, v]) => `${v}  ${k}`).join("\n"));
  console.log(samples.join("\n"));
}
main().finally(() => prisma.$disconnect());

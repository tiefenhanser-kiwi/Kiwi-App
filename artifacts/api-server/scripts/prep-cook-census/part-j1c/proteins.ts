// [prepcook] Part J.1c item 4 — every rendered protein step on the 27 plans: its verbs
// (what the title says), its amounts and notes, and how the time table charges it.
// FREE, READ-ONLY.
//
//   node --env-file=.env --import tsx scripts/prep-cook-census/part-j1c/proteins.ts [--date 2026-10-04]
import { PrismaClient } from "@prisma/client";

import { loadPrepWeekInput } from "../../../src/lib/prepWeekAggregation";
import { buildPrepWeekPlan } from "../../../src/lib/prepWeekBuild";
import { timeStep } from "../../../src/lib/prepStepMinutes";
import { timeStep as headTimeStep } from "./out/_head/src/lib/prepStepMinutes";
import { FORBIDDEN_PLAN, loadCorpus } from "../part-i/corpus";

const prisma = new PrismaClient();
const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const now = new Date(`${arg("date", "2026-10-04")}T12:00:00Z`);

async function main() {
  const rows = [...(await loadCorpus(prisma)), { code: "HANS-e55a9305", planId: FORBIDDEN_PLAN }, { code: "HANS-f49f5209", planId: "f49f5209-54c6-428b-a66e-a8b6ff9d2488" }];
  for (const row of rows) {
    const { userId } = await prisma.mealPlanInstance.findUniqueOrThrow({ where: { id: row.planId }, select: { userId: true } });
    const b = buildPrepWeekPlan(await loadPrepWeekInput({ planId: row.planId, userId, prisma, now }));
    for (const st of b.stepPlan.steps) {
      if (st.phase !== "proteins" || st.demoted || st.fixedProse) continue;
      const t = timeStep({ components: st.components, bowlName: st.bowlName, verbs: st.knifeVerbs });
      const what = st.components.map((c) => `${c.measures.map((m) => m.amount).join("+")} ${c.ingredientName}${c.preparationNote ? ` [${c.preparationNote}]` : ""}`).join("; ");
      const before = headTimeStep({ components: st.components, bowlName: st.bowlName }).minutes;
      console.log(`${row.code.padEnd(14)} ${String(before).padStart(2)} → ${String(st.estimatedMinutes).padStart(2)} min  verbs=${(st.knifeVerbs ?? []).join("+") || "-"}  ${what}  rows=${t.rows.map((r) => `${r.action}:${r.minutes.toFixed(2)}`).join(",")}${t.overCap ? "  OVERCAP" : ""}`);
    }
  }
}
main().finally(() => prisma.$disconnect());

// Part J.0 A4 — on the census's 14 prepped-path meals: prep-tagged cook steps vs
// the ones coversCookSteps marks done-in-prep. Read-only.
import { readFileSync, readdirSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { loadPrepWeekInput } from "../../../src/lib/prepWeekAggregation";
import { buildPrepWeekPlan, isTickable } from "../../../src/lib/prepWeekBuild";
import { TEST_USER_ID } from "../part-i/corpus";
const prisma = new PrismaClient();
const DIR = "scripts/prep-cook-census/part-i/out";
(async () => {
  let prepTagged = 0, covered = 0, uncoveredRefless = 0;
  const rows: string[] = [];
  for (const f of readdirSync(DIR).filter((x) => /^[0-9a-f]{8}\.json$/.test(x))) {
    const rec = JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));
    if (!rec.prepped) continue;
    const load = await loadPrepWeekInput({ planId: rec.planId, userId: TEST_USER_ID, prisma });
    const b = buildPrepWeekPlan(load);
    const meal = load.input.meals.find((m) => m.mealId === rec.prepped.mealId)!;
    const cov = new Set(b.stepPlan.steps.filter((s) => isTickable(s, b.storageContexts.get(s.stepKey))).flatMap((s) => (s.coversCookSteps ?? []).filter((c) => c.mealId === meal.mealId).map((c) => `${c.dishId}#${c.stepIndex}`)));
    let p = 0, c = 0, nr = 0;
    for (const d of meal.dishes) for (const s of d.componentSteps) {
      if (s.phaseType !== "prep") continue;
      p++; if (cov.has(`${d.dishId}#${s.stepIndex}`)) c++; else if (s.ingredientIds.length === 0) nr++;
    }
    prepTagged += p; covered += c; uncoveredRefless += nr;
    rows.push(`${rec.code.padEnd(10)} ${meal.mealName.slice(0, 44).padEnd(44)} prep-tagged ${p} · done-in-prep ${c} · no amountRefs ${nr}`);
  }
  console.log(rows.join("\n"));
  console.log(`TOTAL prep-tagged ${prepTagged} · done-in-prep ${covered} · stay in the cook flow ${prepTagged - covered} (of which ${uncoveredRefless} carry no amountRefs)`);
})().finally(() => prisma.$disconnect());

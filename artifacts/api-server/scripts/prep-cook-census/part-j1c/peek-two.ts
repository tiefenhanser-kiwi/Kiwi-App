// [prepcook] Part J.1c — READ-ONLY: A20's per-step minutes on both engines, and
// f49f5209's one-portion step that still prints its amount twice.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { PrismaClient } from "@prisma/client";

import { loadCorpus } from "../part-i/corpus";

const prisma = new PrismaClient();
const now = new Date("2026-10-04T12:00:00Z");
async function render(root: string, planId: string) {
  const imp = (p: string) => import(pathToFileURL(join(root, p)).href);
  const { loadPrepWeekInput } = await imp("lib/prepWeekAggregation.ts");
  const { buildPrepWeekPlan, finishPrepWeek } = await imp("lib/prepWeekBuild.ts");
  const { assemblePrepWeekResult, summarizePrepWeek } = await imp("lib/prepWeekAssembly.ts");
  const { userId } = await prisma.mealPlanInstance.findUniqueOrThrow({ where: { id: planId }, select: { userId: true } });
  const b = buildPrepWeekPlan(await loadPrepWeekInput({ planId, userId, prisma, now }));
  const narration = { steps: b.stepPlan.narrationInput.steps.map((s: { stepId: string; portionsByApp?: { total: string; food: string } }) => ({ stepId: s.stepId, title: "T", instructions: s.portionsByApp ? `Cut ${s.portionsByApp.total} ${s.portionsByApp.food}.` : "Do it." })) };
  return summarizePrepWeek(finishPrepWeek(assemblePrepWeekResult(b.stepPlan, narration), b));
}
async function main() {
  const head = join(import.meta.dirname, "out", "_head", "src");
  const work = join(import.meta.dirname, "..", "..", "..", "src");
  const a20 = (await loadCorpus(prisma)).find((r) => r.code === "A20")!.planId;
  const [x, y] = [await render(head, a20), await render(work, a20)];
  const mins = (r: { phases: { steps: { stepKey: string; estimatedMinutes: number; skipSuggested?: boolean; title: string }[] }[] }) =>
    new Map(r.phases.flatMap((p) => p.steps.filter((s) => !s.skipSuggested).map((s) => [s.stepKey, `${s.estimatedMinutes}`] as [string, string])));
  const mx = mins(x), my = mins(y);
  for (const k of new Set([...mx.keys(), ...my.keys()])) if (mx.get(k) !== my.get(k)) {
    const s = [...x.phases, ...y.phases].flatMap((p) => p.steps).filter((t) => t.stepKey === k);
    console.log(`A20 ${k} ${mx.get(k) ?? "-"} → ${my.get(k) ?? "-"}`);
    for (const t of s) console.log(`   ${t.skipSuggested ? "×" : " "} ${t.title} :: ${t.instructions.split("\n").join(" / ")}`);
  }
  const f = await render(work, "f49f5209-54c6-428b-a66e-a8b6ff9d2488");
  for (const s of f.phases.flatMap((p) => p.steps)) if (!s.skipSuggested && s.instructions.split("\n").length === 2 && !/^Into /.test(s.instructions.split("\n")[1])) console.log(`f49f5209 ${s.stepKey}\n  ${s.instructions.replace(/\n/g, "\n  ")}`);
}
main().finally(() => prisma.$disconnect());

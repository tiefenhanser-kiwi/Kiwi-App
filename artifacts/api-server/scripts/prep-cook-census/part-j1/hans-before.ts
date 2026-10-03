// Part J.1 — READ-ONLY: the header Hans's cached e55a9305 blob carries (v19), before regeneration.
import { PrismaClient } from "@prisma/client";
import { summarizePrepWeek } from "../../../src/lib/prepWeekAssembly";
import type { PrepWeekResult } from "../../../src/lib/ai/schemas/prepWeek";
const prisma = new PrismaClient();
(async () => {
  const row = await prisma.prepWeekStructure.findUnique({ where: { planId: "e55a9305-2695-4c16-a25e-effcc03fc109" }, select: { structureJson: true, promptVersion: true } });
  if (!row) return console.log("no cache row");
  const s = summarizePrepWeek(row.structureJson as unknown as PrepWeekResult);
  const steps = s.phases.flatMap((p) => p.steps);
  console.log(JSON.stringify({ promptVersion: row.promptVersion, containerCount: s.containerCount, estimatedMinutes: s.estimatedMinutes, steps: steps.length, rendered: steps.filter((x) => !x.skipSuggested).length }));
})().finally(() => prisma.$disconnect());

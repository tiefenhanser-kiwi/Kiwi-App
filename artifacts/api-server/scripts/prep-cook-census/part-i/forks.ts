// [prepcook] Part I — BUG-342: user-owned copies whose stored minute stamps
// disagree with a fresh derivation. READ-ONLY (no write path exists here).
// Same derivation as ../restamp.ts --scan, restricted to `Meal.userId != null`.
//
//   node --env-file=.env --import tsx scripts/prep-cook-census/part-i/forks.ts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { deriveMealTiming } from "../../../src/lib/mealTiming";
import type { SchedulerPhase } from "../../../src/lib/cookingScheduler";

const prisma = new PrismaClient();
if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) throw new Error("REFUSING: not the dev branch");

async function main() {
  const meals = await prisma.meal.findMany({
    where: { isArchived: false, userId: { not: null } },
    select: {
      id: true, title: true, userId: true, sourceStoreMealId: true, sourceType: true, updatedAt: true,
      estimatedTimeMinutes: true, activeTimeMinutes: true,
      dishLinks: { select: { dishId: true, positionIndex: true, dish: { select: { title: true } } } },
    },
  });
  const dishIds = meals.flatMap((m) => m.dishLinks.map((l) => l.dishId));
  const steps = await prisma.recipeInstructionStep.findMany({
    where: { ownerType: "dish", ownerId: { in: dishIds } },
    orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }],
    select: { ownerId: true, stepIndex: true, estimatedMinutes: true, phaseType: true, isTimingSensitive: true, parallelGroup: true, componentKey: true, pathKey: true },
  });
  const byDish = new Map<string, typeof steps>();
  for (const s of steps) { const l = byDish.get(s.ownerId) ?? []; l.push(s); byDish.set(s.ownerId, l); }
  const rows: { mealId: string; title: string; fork: boolean; stored: number; derived: number; storedActive: number | null; derivedActive: number | null }[] = [];
  let derivable = 0;
  for (const m of meals) {
    const t = deriveMealTiming(m.dishLinks.map((l) => ({
      dishId: l.dishId, title: l.dish.title, positionIndex: l.positionIndex,
      steps: (byDish.get(l.dishId) ?? []).map((s) => ({
        stepIndex: s.stepIndex, estimatedMinutes: s.estimatedMinutes <= 0 ? 1 : s.estimatedMinutes, phaseType: s.phaseType as SchedulerPhase,
        isTimingSensitive: s.isTimingSensitive, parallelGroup: s.parallelGroup, componentKey: s.componentKey, pathKey: s.pathKey,
      })),
    })));
    if (t.totalMinutes === null) continue;
    derivable++;
    if (t.totalMinutes !== m.estimatedTimeMinutes || t.activeMinutes !== m.activeTimeMinutes) {
      rows.push({ mealId: m.id, title: m.title, fork: m.sourceStoreMealId !== null, stored: m.estimatedTimeMinutes, derived: t.totalMinutes, storedActive: m.activeTimeMinutes, derivedActive: t.activeMinutes });
    }
  }
  const totalOnly = rows.filter((r) => r.stored !== r.derived);
  const forks = rows.filter((r) => r.fork);
  const out = {
    userOwned: meals.length, derivable, stale: rows.length, staleTotal: totalOnly.length,
    forksWithSource: meals.filter((m) => m.sourceStoreMealId !== null).length, staleForks: forks.length,
    examples: totalOnly.sort((a, b) => Math.abs(b.stored - b.derived) - Math.abs(a.stored - a.derived)).slice(0, 6),
  };
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "out", "forks.json"), JSON.stringify({ ...out, rows }, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().finally(() => prisma.$disconnect());

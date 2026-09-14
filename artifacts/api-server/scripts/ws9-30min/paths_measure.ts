// D-WS9-240 item 6 — evidence for the path double-count finding: derive every km30- meal three ways
// (all steps as the shipped derivation walks them; scratch path only; bought path only). Read-only.
//   node --env-file=.env --import tsx scripts/ws9-30min/paths_measure.ts
import { PrismaClient } from "@prisma/client";
import { type SchedulerDish, type SchedulerPhase } from "../../src/lib/cookingScheduler";
import { deriveMealTiming } from "../../src/lib/mealTiming";
const p = new PrismaClient();
const meals = await p.meal.findMany({ where: { dishFamilyKey: { startsWith: "km30-" } }, select: { id: true, title: true, dishFamilyKey: true, estimatedTimeMinutes: true, dishLinks: { select: { dishId: true, positionIndex: true, dish: { select: { title: true } } } } }, orderBy: { createdAt: "asc" } });
const dishIds = meals.flatMap((m) => m.dishLinks.map((l) => l.dishId));
const steps = await p.recipeInstructionStep.findMany({ where: { ownerType: "dish", ownerId: { in: dishIds } }, select: { ownerId: true, stepIndex: true, estimatedMinutes: true, phaseType: true, isTimingSensitive: true, parallelGroup: true, componentKey: true, pathKey: true }, orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }] });
const build = (m: typeof meals[number], keep: (pk: string | null) => boolean): SchedulerDish[] => m.dishLinks.map((l) => ({ dishId: l.dishId, title: l.dish.title, positionIndex: l.positionIndex, steps: steps.filter((s) => s.ownerId === l.dishId && keep(s.pathKey)).map((s) => ({ stepIndex: s.stepIndex, estimatedMinutes: s.estimatedMinutes, phaseType: s.phaseType as SchedulerPhase, isTimingSensitive: s.isTimingSensitive, parallelGroup: s.parallelGroup, componentKey: s.componentKey, pathKey: s.pathKey })) }));
let both30 = 0, scratch30 = 0, bought30 = 0, dual = 0;
for (const m of meals) {
  const all = deriveMealTiming(build(m, () => true));
  const scratch = deriveMealTiming(build(m, (pk) => pk !== "bought"));
  const bought = deriveMealTiming(build(m, (pk) => pk !== "scratch"));
  const hasDual = steps.some((s) => m.dishLinks.some((l) => l.dishId === s.ownerId) && s.pathKey === "bought");
  if (hasDual) dual++;
  if ((all.totalMinutes ?? 99) <= 30) both30++; if ((scratch.totalMinutes ?? 99) <= 30) scratch30++; if ((bought.totalMinutes ?? 99) <= 30) bought30++;
  console.log(`${m.dishFamilyKey!.slice(5, 11)} ${m.title.slice(0, 52).padEnd(52)} stored ${String(m.estimatedTimeMinutes).padStart(3)} · both-paths ${all.totalMinutes} · scratch-only ${scratch.totalMinutes}${scratch.ignoredTags.length ? `(ign ${scratch.ignoredTags.length})` : ""} · bought-only ${bought.totalMinutes}${bought.ignoredTags.length ? `(ign ${bought.ignoredTags.length})` : ""} · dual-path ${hasDual ? "yes" : "no"}`);
}
console.log(`n=${meals.length} dual-path meals=${dual} · ≤30: both-paths ${both30} · scratch-only ${scratch30} · bought-only ${bought30}`);
await p.$disconnect();

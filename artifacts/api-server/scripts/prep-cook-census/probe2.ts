// [prepcook] B1 — scheduler internals probe. Read-only, no AI, no cost.
//
// Dumps, for one meal, what `scheduleCookingSequence` computes at each stage:
// per-dish critical paths, the anchor, each step's idealStart vs actualStart,
// and what pushed it. Ruling 1 (the max-lag bound) is a change to the
// single-cook pass, so the pass has to be legible before it is edited.
//
//   node --env-file=.env --import tsx scripts/prep-cook-census/probe2.ts \
//     --meal <mealId|prefix>
import { PrismaClient } from "@prisma/client";

import {
  isUnattended,
  selectDefaultPathSteps,
  scheduleCookingSequence,
  type SchedulerDish,
  type SchedulerPhase,
} from "../../src/lib/cookingScheduler";

const prisma = new PrismaClient();
if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) {
  throw new Error("REFUSING: not the dev branch");
}
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const prefix = arg("meal")!;
  const meals = await prisma.meal.findMany({
    where: { id: { startsWith: prefix } },
    select: {
      id: true, title: true, estimatedTimeMinutes: true,
      dishLinks: {
        orderBy: { positionIndex: "asc" },
        select: { dishId: true, positionIndex: true, dish: { select: { title: true } } },
      },
    },
  });
  if (meals.length !== 1) throw new Error(`${meals.length} meals match ${prefix}`);
  const meal = meals[0];
  const rows = await prisma.recipeInstructionStep.findMany({
    where: { ownerType: "dish", ownerId: { in: meal.dishLinks.map((l) => l.dishId) } },
    orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }],
  });
  const byDish = new Map<string, typeof rows>();
  for (const r of rows) {
    const l = byDish.get(r.ownerId);
    if (l) l.push(r); else byDish.set(r.ownerId, [r]);
  }
  const dishes: SchedulerDish[] = meal.dishLinks
    .filter((l) => byDish.has(l.dishId))
    .map((l) => ({
      dishId: l.dishId,
      title: l.dish.title,
      positionIndex: l.positionIndex,
      steps: (byDish.get(l.dishId) ?? []).map((s) => ({
        stepIndex: s.stepIndex,
        estimatedMinutes: s.estimatedMinutes <= 0 ? 1 : s.estimatedMinutes,
        phaseType: s.phaseType as SchedulerPhase,
        isTimingSensitive: s.isTimingSensitive,
        // D-WS9-297 ruling 2 — the cue reads this. Omitting it made the probe
        // print "resting" where the real path prints "chilling": the state fell
        // back to the PHASE because the probe supplied no prose. A probe that
        // renders less than the product misreports the product.
        text: s.stepTextTranslated,
        parallelGroup: s.parallelGroup,
        componentKey: s.componentKey,
        pathKey: s.pathKey,
      })),
    }));

  const res = scheduleCookingSequence(dishes);
  console.log(`${meal.title}\n  total ${res.totalEstimatedMinutes}  active ${res.activeEstimatedMinutes}  card ${meal.estimatedTimeMinutes}`);
  console.log(`  anchor (max dish duration) = ${Math.max(...Object.values(res.dishDurations))}`);
  console.log("  dish durations:");
  for (const d of dishes) {
    const kept = selectDefaultPathSteps(d.steps);
    console.log(`    ${String(res.dishDurations[d.dishId] ?? 0).padStart(4)}  ${d.title}  (${kept.length} steps, Σ=${kept.reduce((s, x) => s + x.estimatedMinutes, 0)})`);
  }
  console.log("\n  seq  dish                            idx  off   start  fin  phase          att  tag  text-ish");
  const titleOf = new Map(dishes.map((d) => [d.dishId, d.title]));
  const stepOf = new Map<string, (typeof dishes)[0]["steps"][0]>();
  for (const d of dishes) for (const s of d.steps) stepOf.set(`${d.dishId}#${s.stepIndex}`, s);
  const textOf = new Map(rows.map((r) => [`${r.ownerId}#${r.stepIndex}`, r.stepTextRaw]));
  for (const e of res.steps) {
    const k = `${e.dishId}#${e.originalStepIndex}`;
    const st = stepOf.get(k)!;
    const start = e.startOffsetMinutes;
    console.log(
      `  ${String(e.sequenceIndex + 1).padStart(3)}  ${(titleOf.get(e.dishId) ?? "").slice(0, 30).padEnd(30)}  ${String(e.originalStepIndex).padStart(3)}  T${String(start).padStart(4)}  ${String(res.totalEstimatedMinutes + start).padStart(5)}  ${String(res.totalEstimatedMinutes + start + st.estimatedMinutes).padStart(3)}  ${st.phaseType.padEnd(8)}${st.isTimingSensitive ? "!" : " "}  ${isUnattended(st) ? "U" : "A"}    ${(st.parallelGroup ?? "-").slice(0, 3).padEnd(3)}  ${(textOf.get(k) ?? "").slice(0, 52)}`,
    );
    if (e.reason) console.log(`       ⟶ ${e.reason}`);
  }
  if (res.ignoredTags.length) {
    console.log("\n  ignored tags:");
    for (const t of res.ignoredTags) console.log(`    ${(titleOf.get(t.dishId) ?? "").slice(0, 28)} #${t.stepIndex} "${t.token}" → ${t.reason}`);
  }
}
main().finally(() => prisma.$disconnect());

// [prepcook] Part J.1c — REPLAY a plan's Prep the Week as the device saw it, on a
// pinned date. The route's cache-hit path, without the route: loadPrepWeekInput
// (with `now`), buildPrepWeekPlan, the cached blob, finishPrepWeek,
// summarizePrepWeek. READ-ONLY — the blob is read, nothing is written, no AI.
//
//   node --env-file=.env --import tsx scripts/prep-cook-census/part-j1c/device.ts <planId> <YYYY-MM-DD> [--holds] [--raw]
//
// --holds  prints the cook-day derivation: every meal, its day and lag, and every
//          step portion held for it (item 6).
// --raw    prints the cached narrator text for each step before finishPrepWeek
//          (item 5: what the narrator wrote vs what the code renders).
import { PrismaClient } from "@prisma/client";

import { loadPrepWeekInput } from "../../../src/lib/prepWeekAggregation";
import { buildPrepWeekPlan, finishPrepWeek } from "../../../src/lib/prepWeekBuild";
import { summarizePrepWeek } from "../../../src/lib/prepWeekAssembly";
import type { PrepWeekResult } from "../../../src/lib/ai/schemas/prepWeek";

const prisma = new PrismaClient();
const [planId, day] = process.argv.slice(2);
const HOLDS = process.argv.includes("--holds");
const RAW = process.argv.includes("--raw");

async function main() {
  const owner = await prisma.mealPlanInstance.findUniqueOrThrow({ where: { id: planId }, select: { userId: true } });
  const now = new Date(`${day}T12:00:00Z`);
  const loaded = await loadPrepWeekInput({ planId, userId: owner.userId, prisma, now });
  const build = buildPrepWeekPlan(loaded);
  const row = await prisma.prepWeekStructure.findUniqueOrThrow({ where: { planId } });
  const blob = row.structureJson as unknown as PrepWeekResult;
  const r = summarizePrepWeek(finishPrepWeek(blob, build));
  const L: string[] = [`PLAN ${planId} as of ${day} (cache v${row.promptVersion}, written ${row.lastGeneratedAt.toISOString()})`];
  L.push(`  HEADER: ${r.containerCount} containers · about ${r.estimatedMinutes} min`);
  const rawByKey = new Map(blob.phases.flatMap((p) => p.steps).map((s) => [s.stepKey, s.instructions]));
  for (const ph of r.phases) {
    L.push("", `  ── ${ph.phase} ──`);
    if (ph.note) L.push(`     » ${ph.note}`);
    for (const h of ph.heldForCookDay ?? []) L.push(`     HELD: ${h}`);
    for (const s of ph.steps) {
      L.push(`  ${s.skipSuggested ? "×" : " "} ${String(s.number).padStart(2)}. ${s.title}   (${s.estimatedMinutes} min)`);
      for (const line of s.instructions.split("\n")) L.push(`        ${line}`);
      if (s.storageNote) L.push(`        » storage: ${s.storageNote}`);
      if (RAW && s.stepKey) L.push(`        ‹narrator› ${(rawByKey.get(s.stepKey) ?? "").split("\n")[0]}`);
    }
  }
  if (HOLDS) {
    L.push("", "  ── cook-day derivation ──");
    const stepByKey = new Map(build.stepPlan.steps.map((s) => [s.stepKey, s]));
    for (const m of loaded.input.meals) {
      const lag = loaded.cookDays.lagByMealId.get(m.mealId);
      L.push(`  ${m.mealName} — ${loaded.cookDays.dayNameByMealId.get(m.mealId) ?? "?"}, lag ${lag ?? "-"}`);
      let any = false;
      for (const [key, h] of build.holds) {
        for (const p of h.heldPortions.filter((x) => x.mealId === m.mealId)) {
          any = true;
          L.push(`      held: ${p.ingredientName}${p.cut ? ` (${p.cut})` : ""} — window ${p.window} d < lag ${p.lag} · step ${stepByKey.get(key)?.phase ?? "?"} ${key.slice(0, 40)}${p.dest ? ` · → ${p.dest}` : ""}`);
        }
      }
      // The two other sources heldLinesFor reads: produce held for its CLASS, and a
      // marinade's cook-day join.
      for (const st of build.stepPlan.steps) {
        if (st.demoted?.reason !== "does-not-hold") continue;
        for (const c of st.components) {
          if (c.measures.some((x) => x.mealId === m.mealId)) { any = true; L.push(`      class: ${c.ingredientName} — does not hold once cut`); }
        }
      }
      for (const [name, extra] of build.stepPlan.containerExtras ?? new Map()) {
        if (!extra.joins?.length) continue;
        if (!build.stepPlan.steps.some((s) => s.bowlName === name && s.contributesToMealIds.includes(m.mealId))) continue;
        for (const j of extra.joins) { any = true; L.push(`      marinade: ${name} ← ${JSON.stringify(j)}`); }
      }
      if (!any) L.push("      nothing held, nothing for cook day");
    }
    L.push(`  list: ${JSON.stringify(build.heldLines)}`);
  }
  console.log(L.join("\n"));
}
main().finally(() => prisma.$disconnect());

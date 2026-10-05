// [prepcook] Part J.1c — the corpus table, before → after, FREE (no AI, no writes).
//
//   node --env-file=.env --import tsx scripts/prep-cook-census/part-j1c/census.ts --engine head --date 2026-10-04
//   node --env-file=.env --import tsx scripts/prep-cook-census/part-j1c/census.ts --engine work --date 2026-10-04
//
// --engine head  reads the engine from out/_head/src — HEAD's src, extracted read-only
//                with `git archive HEAD src | tar -x -C out/_head` (engine v4);
// --engine work  reads the working tree's src (engine v5).
// --date         pins "today" for every plan, so before and after are the same day.
//
// Per plan (the 25 census plans, plus Hans's two newest, read only): the header the
// route would serve (containers, minutes — stand-in prose; neither depends on prose),
// the minutes per phase, the cook-day list length, and the BUG-355 shapes: "same tub"
// lines, single-portion steps printed twice, and single-dish contents-named lids.
// Writes out/census_<engine>.json.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PrismaClient } from "@prisma/client";

import { FORBIDDEN_PLAN, loadCorpus } from "../part-i/corpus";

if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) throw new Error("REFUSING: not the dev branch");
const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const ENGINE = arg("engine", "work")!;
const DATE = arg("date", "2026-10-04")!;
const HANS_NEWEST = "f49f5209-54c6-428b-a66e-a8b6ff9d2488";
const ROOT = ENGINE === "head" ? join(HERE, "out", "_head", "src") : join(HERE, "..", "..", "..", "src");

const WRITE_OPS = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const base = new PrismaClient();
const prisma = base.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
  if (WRITE_OPS.has(operation)) throw new Error(`WRITE BLOCKED: ${model}.${operation}`);
  return query(args);
} } } }) as unknown as PrismaClient;

async function main() {
  const imp = (p: string) => import(pathToFileURL(join(ROOT, p)).href);
  const { loadPrepWeekInput } = await imp("lib/prepWeekAggregation.ts");
  const { buildPrepWeekPlan, finishPrepWeek } = await imp("lib/prepWeekBuild.ts");
  const { assemblePrepWeekResult, summarizePrepWeek } = await imp("lib/prepWeekAssembly.ts");
  const now = new Date(`${DATE}T12:00:00Z`);
  const corpus = await loadCorpus(prisma);
  const rows = [...corpus, { code: "HANS-e55a9305", planId: FORBIDDEN_PLAN }, { code: "HANS-f49f5209", planId: HANS_NEWEST }];
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const { userId } = await prisma.mealPlanInstance.findUniqueOrThrow({ where: { id: row.planId }, select: { userId: true } });
    const loaded = await loadPrepWeekInput({ planId: row.planId, userId, prisma, now });
    const b = buildPrepWeekPlan(loaded);
    // Stand-in prose that states the code's amount, so a one-portion step can fold
    // the way a real opening does ("Slice 3 celery stalks…" → one sentence).
    const narration = {
      steps: b.stepPlan.narrationInput.steps.map((s: { stepId: string; portionsByApp?: { total: string; food: string } }) => ({
        stepId: s.stepId,
        title: "T",
        instructions: s.portionsByApp ? `Cut ${s.portionsByApp.total} ${s.portionsByApp.food}.` : "Do it.",
      })),
    };
    const w = summarizePrepWeek(finishPrepWeek(assemblePrepWeekResult(b.stepPlan, narration), b));
    const live = w.phases.flatMap((p: { steps: { skipSuggested?: boolean }[] }) => p.steps.filter((s) => !s.skipSuggested)) as {
      stepKey: string; instructions: string; estimatedMinutes: number; containerNames?: string[]; title: string;
    }[];
    const byPhase: Record<string, number> = {};
    for (const p of w.phases) byPhase[p.phase] = p.steps.filter((s: { skipSuggested?: boolean }) => !s.skipSuggested).reduce((n: number, s: { estimatedMinutes: number }) => n + s.estimatedMinutes, 0);
    const kinds: Map<string, string> = b.stepPlan.labelKinds ?? new Map();
    const lids = [...new Set(live.flatMap((s) => s.containerNames ?? []))];
    const portionSteps = live.filter((s) => b.stepPlan.steps.find((x: { stepKey: string; portionLines?: string[] }) => x.stepKey === s.stepKey)?.portionLines);
    out.push({
      code: row.code,
      planId: row.planId,
      containers: w.containerCount,
      minutes: w.estimatedMinutes,
      stepMinutes: live.reduce((n, s) => n + s.estimatedMinutes, 0),
      byPhase,
      proteinSteps: live.filter((s) => s.stepKey.startsWith("proteins#")).map((s) => `${s.title} ${s.estimatedMinutes}`),
      heldLines: w.phases.flatMap((p: { heldForCookDay?: string[] }) => p.heldForCookDay ?? []).length,
      sameTub: live.filter((s) => /\bsame (tub|bowl|jar|container|bag|plate)\b/.test(s.instructions)).length,
      // a one-portion step whose amount is printed twice: an opening and exactly one line
      twice: portionSteps.filter((s) => s.instructions.split("\n").length === 2 && !/^Into /.test(s.instructions.split("\n")[1])).length,
      portionSteps: portionSteps.length,
      singleDishContentLids: lids.filter((n) => n.includes(" — ") && kinds.get(n) !== "shared").length,
      maxContainerName: Math.max(0, ...lids.map((n) => n.length)),
    });
    console.error(`${row.code.padEnd(14)} ${w.containerCount} · ${w.estimatedMinutes} min`);
  }
  writeFileSync(join(HERE, "out", `census_${ENGINE}.json`), JSON.stringify(out, null, 2));
}
main().finally(() => base.$disconnect());

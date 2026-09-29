// [grocery] B3 · Part E (D-WS9-284 ruling 10) — RULE 3, MEASURED WHERE IT CAN
// BE SEEN. READ-ONLY.
//
//   node --env-file=.env --import tsx scripts/grocery-b3/paths-after.ts
//     -> out/paths-after.txt
//
// The grocery corpus cannot show this: only TWO plans on dev reach a component
// with a bought path and no scratch one, and neither is among the 20 census
// plans. So the scheduler is run on those two, BEFORE and AFTER, and
// `GET /meals/:id` is composed for all 10 bought-only components' dishes.
//
// BEFORE is not a git checkout: `selectDefaultPathSteps`'s pre-B3 body is four
// characters of predicate, reproduced here as `dropBoughtUnconditionally`, and
// the scheduler is called with each in turn. Everything else is the shipped
// code.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import {
  scheduleCookingSequence,
  selectDefaultPathSteps,
  type SchedulerDish,
  type SchedulerPhase,
} from "../../src/lib/cookingScheduler";
import { composeMealDetail } from "../../src/routes/meals";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const host = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");
const prisma = new PrismaClient();

const L: string[] = [];
const say = (s = "") => { L.push(s); console.log(s); };

/** The pre-B3 predicate, verbatim: drop every `bought` step, no question asked. */
function dropBoughtUnconditionally<T extends { pathKey?: string | null }>(steps: T[]): T[] {
  return steps.filter((s) => (s.pathKey ?? null) !== "bought");
}

async function main() {
  // ── the 10 only-bought components, by id ────────────────────────────────
  const tagged = await prisma.recipeInstructionStep.findMany({
    where: { componentKey: { not: null }, ownerType: "dish" },
    select: { ownerId: true, componentKey: true, pathKey: true, stepIndex: true, stepTextTranslated: true },
  });
  const comps = new Map<string, { scratch: number; bought: number }>();
  for (const s of tagged) {
    const k = `${s.ownerId}|${s.componentKey}`;
    const c = comps.get(k) ?? { scratch: 0, bought: 0 };
    if (s.pathKey === "scratch") c.scratch++;
    else if (s.pathKey === "bought") c.bought++;
    comps.set(k, c);
  }
  const onlyBought = [...comps.entries()].filter(([, c]) => c.scratch === 0 && c.bought > 0);
  say(`# [grocery] B3 Part E — Rule 3 on the only-bought components (${onlyBought.length})`);
  say("");

  // ── (a) GET /meals/:id for every dish that owns one ──────────────────────
  say("## (a) GET /meals/:id — one path each");
  const obDishIds = [...new Set(onlyBought.map(([k]) => k.split("|")[0]))];
  const links = await prisma.mealDishLink.findMany({
    where: { dishId: { in: obDishIds } },
    select: { mealId: true, dishId: true },
  });
  const mealByDish = new Map(links.map((l) => [l.dishId, l.mealId]));
  let allOnePath = true;
  for (const [key, counts] of onlyBought) {
    const [dishId, componentKey] = key.split("|");
    const mealId = mealByDish.get(dishId);
    const dish = await prisma.dish.findUnique({ where: { id: dishId }, select: { title: true } });
    if (!mealId) { say(`   ${dishId.slice(0, 8)} "${dish?.title}" — no MealDishLink; read through GET /dishes/:id instead`); continue; }
    const meal = await composeMealDetail(prisma, mealId);
    const d = meal?.dishes.find((x) => x.dishId === dishId);
    if (!d) { say(`   ${dishId.slice(0, 8)} "${dish?.title}" — not in the composed meal`); allOnePath = false; continue; }
    const byComponent = new Map<string, Set<string>>();
    for (const s of d.steps) {
      if (!s.componentKey) continue;
      const set = byComponent.get(s.componentKey) ?? new Set();
      set.add(String(s.pathKey));
      byComponent.set(s.componentKey, set);
    }
    const mixed = [...byComponent.entries()].filter(([, p]) => p.size > 1);
    const boughtHere = d.steps.filter((s) => s.componentKey === componentKey);
    if (mixed.length > 0 || boughtHere.length !== counts.bought) allOnePath = false;
    say(
      `   ${dishId.slice(0, 8)}  "${d.title}"  component "${componentKey}"` +
        `  steps on the wire ${d.steps.length}` +
        `  ·  this component: ${boughtHere.length}/${counts.bought} bought step(s) PRESENT` +
        `  ·  components carrying two paths: ${mixed.length}`,
    );
    for (const s of boughtHere) say(`        [${s.stepIndex}] ${s.pathKey} — ${s.text.slice(0, 96)}`);
  }
  say(`   VERDICT: ${allOnePath ? "every component returns exactly one path, and the bought-only ones are present" : "SOMETHING IS WRONG — see above"}`);

  // ── (b) the scheduler, on the two plans that reach one ───────────────────
  say("");
  say("## (b) the scheduler, BEFORE vs AFTER, on the two dev plans that reach an only-bought component");
  const obMealIds = [...new Set([...mealByDish.values()])];
  const items = await prisma.mealPlanItem.findMany({
    where: { mealId: { in: obMealIds } },
    select: { mealPlanInstanceId: true, mealId: true },
  });
  const planIds = [...new Set(items.map((i) => i.mealPlanInstanceId))];
  say(`   plans: ${planIds.map((p) => p.slice(0, 8)).join(", ")}`);

  for (const planId of planIds) {
    const plan = await prisma.mealPlanInstance.findUnique({
      where: { id: planId },
      select: { id: true, titleOverride: true, template: { select: { title: true } }, items: { select: { mealId: true } } },
    });
    say("");
    say(`   ### ${planId.slice(0, 8)}  "${plan?.titleOverride ?? plan?.template?.title ?? ""}"`);
    for (const { mealId } of plan?.items ?? []) {
      const meal = await prisma.meal.findUnique({
        where: { id: mealId },
        select: { title: true, dishLinks: { select: { dishId: true, positionIndex: true, dish: { select: { title: true } } } } },
      });
      if (!meal) continue;
      const dishIds = meal.dishLinks.map((l) => l.dishId);
      const steps = await prisma.recipeInstructionStep.findMany({
        where: { ownerType: "dish", ownerId: { in: dishIds } },
        select: {
          ownerId: true, stepIndex: true, estimatedMinutes: true, phaseType: true,
          isTimingSensitive: true, parallelGroup: true, componentKey: true, pathKey: true,
          stepTextTranslated: true,
        },
        orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }],
      });
      if (steps.length === 0) continue;
      const byDish = new Map<string, typeof steps>();
      for (const s of steps) {
        const a = byDish.get(s.ownerId) ?? [];
        a.push(s);
        byDish.set(s.ownerId, a);
      }
      const build = (
        select: <T extends { pathKey?: string | null; componentKey?: string | null }>(x: T[]) => T[],
      ): SchedulerDish[] =>
        meal.dishLinks
          .filter((l) => byDish.has(l.dishId))
          .map((l) => ({
            dishId: l.dishId,
            title: l.dish.title,
            positionIndex: l.positionIndex,
            steps: select(byDish.get(l.dishId)!).map((s) => ({
              stepIndex: s.stepIndex,
              estimatedMinutes: s.estimatedMinutes,
              phaseType: s.phaseType as SchedulerPhase,
              isTimingSensitive: s.isTimingSensitive,
              parallelGroup: s.parallelGroup,
              componentKey: s.componentKey,
              pathKey: s.pathKey,
            })),
          }))
          .filter((d) => d.steps.length > 0);

      // scheduleCookingSequence applies the CURRENT predicate at its own input,
      // so BEFORE is produced by pre-filtering with the old one first.
      const after = scheduleCookingSequence(build((x) => x));
      const before = scheduleCookingSequence(build(dropBoughtUnconditionally));

      const touched = dishIds.filter((id) => onlyBought.some(([k]) => k.startsWith(id)));
      if (touched.length === 0) continue;
      say(`      meal "${meal.title}"`);
      say(`         steps scheduled   BEFORE ${before.steps.length}  ->  AFTER ${after.steps.length}`);
      say(`         totalEstimated    BEFORE ${before.totalEstimatedMinutes} min  ->  AFTER ${after.totalEstimatedMinutes} min`);
      for (const id of touched) {
        const comp = onlyBought.find(([k]) => k.startsWith(id))![0].split("|")[1];
        const missing = (byDish.get(id) ?? []).filter(
          (s) => s.componentKey === comp && !before.steps.some((x) => x.dishId === id && x.originalStepIndex === s.stepIndex),
        );
        const present = (byDish.get(id) ?? []).filter(
          (s) => s.componentKey === comp && after.steps.some((x) => x.dishId === id && x.originalStepIndex === s.stepIndex),
        );
        say(`         "${byDish.get(id)![0] ? (meal.dishLinks.find((l) => l.dishId === id)?.dish.title ?? id) : id}" · component "${comp}"`);
        for (const s of missing) say(`             BEFORE: MISSING  [${s.stepIndex}] ${s.stepTextTranslated.slice(0, 92)}`);
        for (const s of present) say(`             AFTER:  present  [${s.stepIndex}] ${s.stepTextTranslated.slice(0, 92)}`);
      }
    }
  }

  // ── (c) the whole population, at the predicate level ─────────────────────
  say("");
  say("## (c) every one of the 10, at the predicate level (no plan needed)");
  let recovered = 0;
  for (const [key, counts] of onlyBought) {
    const [dishId, componentKey] = key.split("|");
    const all = await prisma.recipeInstructionStep.findMany({
      where: { ownerType: "dish", ownerId: dishId },
      select: { stepIndex: true, componentKey: true, pathKey: true },
      orderBy: { stepIndex: "asc" },
    });
    const beforeKept = dropBoughtUnconditionally(all).length;
    const afterKept = selectDefaultPathSteps(all).length;
    const dish = await prisma.dish.findUnique({ where: { id: dishId }, select: { title: true } });
    recovered += afterKept - beforeKept;
    say(
      `   ${dishId.slice(0, 8)} "${dish?.title}" · "${componentKey}": ${all.length} steps · ` +
        `BEFORE kept ${beforeKept} · AFTER kept ${afterKept} · recovered ${afterKept - beforeKept} (= its ${counts.bought} bought step(s))`,
    );
  }
  say(`   steps recovered across the 10 components: ${recovered}`);

  writeFileSync(join(OUT, "paths-after.txt"), L.join("\n") + "\n", "utf8");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());

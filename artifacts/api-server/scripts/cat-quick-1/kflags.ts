// CAT-QUICK-1 — QA-COOK-1's kitchen checks K1–K7 (scripts/qa-cook/simulator.ts), offline and free:
// no server, no account, no AI cook. A meal's Cook Mode session is rebuilt the way SEQ-1's reseq.ts
// rebuilds one (it reproduced QA-COOK-1's captured sessions 76/76): a multi-dish meal is the
// Sequencer's order (scheduleCookingSequence over the steps with their text, as Cook Mode's
// non-feast call), unplaced steps appended; a single dish is its authored order. Unprepped, at the
// authored 4 servings (no scaling), default path only (no `bought` steps).
//
//   node --env-file=.env --import tsx scripts/cat-quick-1/kflags.ts --catalog            # the baseline
//   node --env-file=.env --import tsx scripts/cat-quick-1/kflags.ts --gen <label>        # a generated batch
//   node --env-file=.env --import tsx scripts/cat-quick-1/kflags.ts --keys <prefix>      # written meals
import { PrismaClient } from "@prisma/client";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isServedCold, scheduleCookingSequence, type SchedulerDish, type SchedulerPhase } from "../../src/lib/cookingScheduler";
import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import { simulate } from "../qa-cook/simulator";
import type { CookView, KFinding, ShownStep } from "../qa-cook/types";

export interface PlainStep { text: string; phaseType: string; estimatedMinutes: number; isTimingSensitive: boolean; parallelGroup?: string | null; pathKey?: string | null }
export interface PlainDish { dishId: string; title: string; role: string | null; ingredientNames: string[]; steps: PlainStep[] }
export interface PlainMeal { id: string; title: string; dishes: PlainDish[] }

export function cookView(m: PlainMeal): CookView {
  const dishes = m.dishes.map((d) => ({ ...d, steps: d.steps.filter((s) => s.pathKey !== "bought") })).filter((d) => d.steps.length > 0);
  const shownOf = (d: PlainDish, s: PlainStep, k: number): ShownStep => ({
    n: 0, key: `${d.dishId}#${k}`, dishId: d.dishId, stepIndex: k, ...(dishes.length > 1 ? { dishTitle: d.title } : {}),
    text: s.text, phaseType: s.phaseType, estimatedMinutes: s.estimatedMinutes, isTimingSensitive: s.isTimingSensitive,
    parallelGroup: s.parallelGroup ?? null, doneInPrep: false, preppedLabels: [],
  });
  let steps: ShownStep[];
  let total: number;
  if (dishes.length > 1) {
    const input: SchedulerDish[] = dishes.map((d, i) => ({
      dishId: d.dishId, title: d.title, positionIndex: i, roleLabel: d.role, ingredientNames: d.ingredientNames,
      steps: d.steps.map((s, k) => ({ stepIndex: k, estimatedMinutes: Math.max(1, s.estimatedMinutes), phaseType: s.phaseType as SchedulerPhase, isTimingSensitive: s.isTimingSensitive, parallelGroup: s.parallelGroup ?? null, componentKey: null, pathKey: null, text: s.text })),
    }));
    const r = scheduleCookingSequence(input);
    const merged = new Set((r.mergedSteps ?? []).map((x) => `${x.dishId}#${x.stepIndex}`));
    const used = new Set<string>();
    steps = [];
    for (const e of [...r.steps].sort((a, b) => a.sequenceIndex - b.sequenceIndex)) {
      const d = dishes.find((x) => x.dishId === e.dishId);
      const s = d?.steps[e.originalStepIndex];
      if (!d || !s || used.has(`${d.dishId}#${e.originalStepIndex}`)) continue;
      used.add(`${d.dishId}#${e.originalStepIndex}`);
      steps.push({ ...shownOf(d, s, e.originalStepIndex), ...(e.reason ? { cue: e.reason } : {}), startOffsetMinutes: e.startOffsetMinutes });
    }
    for (const d of dishes) d.steps.forEach((s, k) => { const key = `${d.dishId}#${k}`; if (!used.has(key) && !merged.has(key)) steps.push(shownOf(d, s, k)); });
    total = r.totalEstimatedMinutes;
  } else {
    steps = dishes.flatMap((d) => d.steps.map((s, k) => shownOf(d, s, k)));
    total = steps.reduce((a, s) => a + s.estimatedMinutes, 0);
  }
  return {
    sourceMealId: m.id, title: m.title, category: dishes.length > 1 ? "multi-dish" : "one-pan", servings: 4, authoredServings: 4,
    prepped: false, multiDish: dishes.length > 1, isFeast: false,
    dishes: dishes.map((d) => ({ dishId: d.dishId, title: d.title, servedCold: isServedCold({ title: d.title }), ingredientNames: d.ingredientNames })),
    steps: steps.map((s, i) => ({ ...s, n: i + 1 })), totalMinutes: total, recap: [],
  };
}

export async function loadMeals(prisma: PrismaClient, where: Parameters<PrismaClient["meal"]["findMany"]>[0] extends infer A ? A extends { where?: infer W } ? W : never : never): Promise<PlainMeal[]> {
  const meals = await prisma.meal.findMany({
    where,
    select: { id: true, title: true, dishLinks: { orderBy: { positionIndex: "asc" }, select: { dishId: true, roleLabel: true, dish: { select: { title: true, dishIngredients: { select: { ingredient: { select: { canonicalName: true } } } } } } } } },
  });
  const ids = meals.flatMap((m) => m.dishLinks.map((l) => l.dishId));
  const steps = await prisma.recipeInstructionStep.findMany({ where: { ownerType: "dish", ownerId: { in: ids } }, orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }], select: { ownerId: true, stepTextTranslated: true, phaseType: true, estimatedMinutes: true, isTimingSensitive: true, parallelGroup: true, pathKey: true } });
  const by = new Map<string, PlainStep[]>();
  for (const s of steps) by.set(s.ownerId, [...(by.get(s.ownerId) ?? []), { text: s.stepTextTranslated, phaseType: s.phaseType, estimatedMinutes: s.estimatedMinutes, isTimingSensitive: s.isTimingSensitive, parallelGroup: s.parallelGroup, pathKey: s.pathKey }]);
  return meals.map((m) => ({ id: m.id, title: m.title, dishes: m.dishLinks.map((l) => ({ dishId: l.dishId, title: l.dish.title, role: l.roleLabel, ingredientNames: l.dish.dishIngredients.map((x) => x.ingredient.canonicalName), steps: by.get(l.dishId) ?? [] })) }));
}

/** A generated payload (generate.ts gen.json) as a PlainMeal. */
export function fromPayload(id: string, p: { title: string; dishes: Array<{ kind: string; title?: string; role?: string; ingredients?: { name: string }[]; steps?: Array<{ text: string; phaseType?: string; estimatedMinutes?: number; isTimingSensitive?: boolean; parallelGroup?: string | null; pathKey?: string | null }> }> }): PlainMeal {
  return {
    id, title: p.title,
    dishes: p.dishes.filter((d) => d.kind === "new").map((d, i) => ({
      dishId: `${id}-d${i}`, title: d.title ?? "", role: d.role ?? null, ingredientNames: (d.ingredients ?? []).map((x) => x.name.toLowerCase()),
      steps: (d.steps ?? []).map((s) => ({ text: s.text, phaseType: s.phaseType ?? "cook", estimatedMinutes: s.estimatedMinutes ?? 1, isTimingSensitive: s.isTimingSensitive ?? false, parallelGroup: s.parallelGroup ?? null, pathKey: s.pathKey ?? null })),
    })),
  };
}

export interface KSummary { meals: number; withAny: number; withHigh: number; perMeal: number; byFlag: Record<string, { findings: number; meals: number }>; bySig: Record<string, number> }
export function summarize(rows: { id: string; findings: KFinding[] }[]): KSummary {
  const byFlag: Record<string, { findings: number; meals: Set<string> }> = {};
  const bySig: Record<string, number> = {};
  let total = 0;
  for (const r of rows) for (const f of r.findings) {
    total++;
    const k = (byFlag[f.flag] ??= { findings: 0, meals: new Set() });
    k.findings++; k.meals.add(r.id);
    const sig = f.signature.split(":").slice(0, 2).join(":");
    bySig[sig] = (bySig[sig] ?? 0) + 1;
  }
  return {
    meals: rows.length, withAny: rows.filter((r) => r.findings.length > 0).length, withHigh: rows.filter((r) => r.findings.some((f) => f.severity === "high")).length,
    perMeal: rows.length ? total / rows.length : 0,
    byFlag: Object.fromEntries(Object.entries(byFlag).sort().map(([k, v]) => [k, { findings: v.findings, meals: v.meals.size }])),
    bySig: Object.fromEntries(Object.entries(bySig).sort((a, b) => b[1] - a[1])),
  };
}
export function line(label: string, s: KSummary): string {
  const pct = (n: number) => `${((100 * n) / Math.max(1, s.meals)).toFixed(0)}%`;
  return `${label}: ${s.meals} meals · findings/meal ${s.perMeal.toFixed(2)} · any ${pct(s.withAny)} · high ${pct(s.withHigh)} · ${Object.entries(s.byFlag).map(([k, v]) => `${k} ${v.findings}/${v.meals}m`).join(" ")}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const OUT = "scripts/output/cat-quick-1";
  let meals: PlainMeal[];
  let label: string;
  const gen = arg("--gen");
  if (gen) {
    const recs = JSON.parse(readFileSync(join(OUT, gen, "gen.json"), "utf8")) as { n: number; payload: Parameters<typeof fromPayload>[1] }[];
    meals = recs.map((r) => fromPayload(`#${r.n}`, r.payload));
    label = `gen ${gen}`;
  } else {
    const { mode } = assertScriptDatabase("cat-quick-1/kflags");
    if (mode !== "dev") throw new Error("dev only");
    const prisma = new PrismaClient();
    const keys = arg("--keys");
    meals = await loadMeals(prisma, keys
      ? { dishFamilyKey: { startsWith: keys }, isArchived: false }
      : { userId: null, isArchived: false, isPublic: true, activeTimeMinutes: { not: null }, NOT: { tags: { has: "thanksgiving-feast" } } });
    await prisma.$disconnect();
    label = keys ? `written ${keys}` : "catalog";
  }
  const rows = meals.map((m) => ({ id: m.id, title: m.title, findings: simulate(cookView(m)).findings }));
  const s = summarize(rows);
  console.log(line(label, s));
  console.log(`  signatures: ${Object.entries(s.bySig).slice(0, 12).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  if (argv.includes("--list")) for (const r of rows) if (r.findings.length) console.log(`  ${r.id.slice(0, 10)} ${r.title.slice(0, 60)}: ${r.findings.map((f) => `${f.signature}[${f.severity}]`).join(", ")}`);
  const out = arg("--out");
  if (out) writeFileSync(out, JSON.stringify({ summary: s, rows }, null, 1));
}
if (process.argv[1]?.replace(/\\/g, "/").endsWith("cat-quick-1/kflags.ts")) main().catch((e) => { console.error(e); process.exit(1); });

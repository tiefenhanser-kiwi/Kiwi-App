// CAT-QUICK-1 (D-WS9-365 / D-WS9-375) — generate quick-shelf meals through the catalog's own path,
// WITHOUT writing them. runStoreFill (store.generate_meal + store.finalize_steps, the cached store
// prefixes) runs with the time budget (≤30 min, ≤11 steps) on both prefixes and `apply: false`;
// its acceptance hook records every merged meal's materialize payload, and this script stamps the
// time the deterministic layer WILL write (deriveMealTiming over the payload's steps, the same input
// stampMealTiming reads back). Nothing touches the database; write.ts writes the accepted ones.
//
//   node --env-file=.env --import tsx scripts/cat-quick-1/generate.ts --label test10 --ids 1,14,28
//   node --env-file=.env --import tsx scripts/cat-quick-1/generate.ts --label b1 --ids … --rework test10
//
// --rework <label>: regenerate the listed concepts once with a line naming what the first version
// stamped (the rework Hans allowed: fewer steps, the concept's own store product), into --label.
//
// Spend: a hard cumulative breaker over the whole lane (scripts/output/cat-quick-1/spend.json),
// checked before every call; $25 by default (the lane cap). Stop-and-report, never a throw.
import { PrismaClient } from "@prisma/client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getModelRate, MODEL_SONNET } from "../../src/lib/ai/promptRegistry";
import { runAICall as productionRunAICall } from "../../src/lib/ai/runAICall";
import type { MaterializeMealPayload } from "../../src/lib/mealMaterialize";
import { deriveMealTiming } from "../../src/lib/mealTiming";
import type { SchedulerDish, SchedulerPhase } from "../../src/lib/cookingScheduler";
import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";
import { computeCacheAwareCostUsd, emptyTokenTotals, runStoreFill, type TokenTotals } from "../../src/lib/storeFill";
import type { TargetDish } from "../../src/lib/storeFillDishes";
import { TIME_BUDGET_PROMPT_VERSION, type TimeBudget } from "../../src/lib/storeFillPrompts";
import { uncutInPayload } from "./knife";
import { keyFor, TARGETS, type QuickTarget } from "./targets";

export const OUT = "scripts/output/cat-quick-1";
export const BUDGET: TimeBudget = { totalMinutes: 30, maxSteps: 11 };
const SPEND_FILE = join(OUT, "spend.json");

/** The stamp the write will produce: the payload's steps through deriveMealTiming (dish order = position).
 *  The title is the dish id, as stampMealTiming passes it on an everyday meal: the scheduler's
 *  title rules (a salad served cold) would move the number (#107: 24 with titles, 27 stamped). */
export function predictTiming(p: MaterializeMealPayload): { total: number | null; active: number | null; steps: number; dishes: number } {
  const dishes: SchedulerDish[] = p.dishes.flatMap((d, i) => d.kind !== "new" ? [] : [{
    dishId: `d${i}`, title: `d${i}`, positionIndex: d.positionIndex,
    steps: d.steps.map((s, k) => ({ stepIndex: k, estimatedMinutes: Math.max(1, s.estimatedMinutes ?? 1), phaseType: (s.phaseType ?? "cook") as SchedulerPhase, isTimingSensitive: s.isTimingSensitive ?? false, parallelGroup: s.parallelGroup ?? null, componentKey: s.componentKey ?? null, pathKey: s.pathKey ?? null })),
  }]);
  const t = deriveMealTiming(dishes);
  const steps = p.dishes.reduce((a, d) => a + (d.kind === "new" ? d.steps.filter((s) => s.pathKey !== "bought").length : 0), 0);
  return { total: t.totalMinutes, active: t.activeMinutes, steps, dishes: p.dishes.length };
}

export interface GenRecord {
  n: number; key: string; title: string; target: string; payload: MaterializeMealPayload;
  predicted: { total: number | null; active: number | null; steps: number; dishes: number };
  hidden?: string[];
  /** Cuts an ingredient note asks for that no step does (knife.ts). */
  uncut?: string[];
  rework?: string;
}

/** Ingredients that arrive already cooked (work no step does, so time the stamp never sees),
 *  unless the concept's own shortcut names them. test10 #28 served "3 cup cooked white rice" with no step. */
export function hiddenWork(p: MaterializeMealPayload, t: QuickTarget): string[] {
  const allowed = (t.shortcut ?? "").toLowerCase();
  const out: string[] = [];
  for (const d of p.dishes) if (d.kind === "new") for (const i of d.ingredients) {
    const text = `${i.name} ${i.preparationNote ?? ""}`.toLowerCase();
    if (!/\b(cooked|leftover|day-old|pre-?cooked)\b/.test(text)) continue;
    if (/\b(cooked|leftover|day-old)\b/.test(allowed) && i.name.toLowerCase().split(/\W+/).some((w) => w.length >= 4 && allowed.includes(w))) continue;
    out.push(`${i.quantity} ${i.unit} ${i.name}`);
  }
  return out;
}

/** Accepted: stamps within the budget, hides no cooked ingredient, leaves no cut to a note. */
export const accepted = (r: GenRecord) => r.predicted.total !== null && r.predicted.total <= BUDGET.totalMinutes && (r.hidden ?? []).length === 0 && (r.uncut ?? []).length === 0;

function toTargetDish(t: QuickTarget, i: number): TargetDish {
  return { rank: i + 1, dish: t.title, key: keyFor(t), category: t.cuisine, parentDish: t.title, band: "midtail", siblingCount: 1, shortcut: t.shortcut };
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const label = arg("--label");
  if (!label) throw new Error("--label <name>");
  const ids = (arg("--ids") ?? "").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
  const cap = Number(arg("--cap") ?? 25);
  const reworkFrom = arg("--rework");
  const { host, mode } = assertScriptDatabase("cat-quick-1/generate");
  if (mode !== "dev") throw new Error("cat-quick-1 runs on dev only");

  const targets = TARGETS.filter((t) => ids.includes(t.n));
  if (targets.length !== ids.length) throw new Error(`unknown concept ids: ${ids.filter((n) => !TARGETS.some((t) => t.n === n)).join(",")}`);
  // A rework names what the first version stamped (the brief rides the generate call's user body).
  const prior = reworkFrom ? new Map((JSON.parse(readFileSync(join(OUT, reworkFrom, "gen.json"), "utf8")) as GenRecord[]).map((r) => [r.n, r])) : null;

  mkdirSync(join(OUT, label), { recursive: true });
  const prisma = new PrismaClient();
  const rate = await getModelRate(MODEL_SONNET, prisma);
  const spent: { spentUsd: number; calls: number } = existsSync(SPEND_FILE) ? JSON.parse(readFileSync(SPEND_FILE, "utf8")) : { spentUsd: 0, calls: 0 };
  console.log(`database: ${host} (${mode}) · prompt ${TIME_BUDGET_PROMPT_VERSION} · budget ≤${BUDGET.totalMinutes} min, ≤${BUDGET.maxSteps} steps · ${targets.length} concepts · lane spend so far $${spent.spentUsd.toFixed(4)} / cap $${cap} · NO WRITES`);

  const thisRun: TokenTotals = emptyTokenTotals();
  const guarded = (async (key: string, vars: unknown, schema: unknown, opts: unknown) => {
    const cum = spent.spentUsd + computeCacheAwareCostUsd(thisRun, rate);
    if (cum >= cap) {
      console.log(`SPEND BREAKER: $${cum.toFixed(4)} ≥ $${cap} before ${key}`);
      return { success: false, reason: "spend_breaker", userFacingMessage: "spend breaker", metadata: { inputTokens: 0, outputTokens: 0 } };
    }
    const res = await (productionRunAICall as unknown as (...a: unknown[]) => Promise<{ metadata: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number } }>)(key, vars, schema, opts);
    thisRun.aiCalls++; thisRun.input += res.metadata.inputTokens ?? 0; thisRun.output += res.metadata.outputTokens ?? 0;
    thisRun.cacheRead += res.metadata.cacheReadInputTokens ?? 0; thisRun.cacheCreation += res.metadata.cacheCreationInputTokens ?? 0;
    writeFileSync(SPEND_FILE, JSON.stringify({ spentUsd: spent.spentUsd + computeCacheAwareCostUsd(thisRun, rate), calls: spent.calls + thisRun.aiCalls }));
    return res;
  }) as unknown as typeof productionRunAICall;

  const records: GenRecord[] = [];
  const skips: string[] = [];
  // One runStoreFill per concept so a rework's brief can differ per meal; the prefixes are the same
  // bytes on every call, so the cache stays warm across them.
  for (const [i, t] of targets.entries()) {
    const p = prior?.get(t.n);
    const over = p && (p.predicted.total ?? 999) > BUDGET.totalMinutes
      ? `came out at ${p.predicted.total} minutes (${p.predicted.active} hands-on) with ${p.predicted.steps} steps on Kiwi's clock, over the ${BUDGET.totalMinutes}-minute budget. Rebuild it to fit: less work around the dish${t.shortcut ? `, the shortcut product as the recipe's ingredient` : ""}, a side that needs no cooking or none at all, and fewer, fuller steps — never shorter minutes.`
      : "";
    const hid = p?.hidden?.length
      ? `listed ${p.hidden.join(", ")} already cooked, with no step that cooks it — time the clock never saw. Every component is cooked in this recipe's own steps unless the shortcut line names it: cook it in a step, or leave it out.`
      : "";
    const unc = p?.uncut?.length
      ? `left cuts to the ingredient notes with no step that does them (${p.uncut.join("; ")}): every cut an ingredient note asks for is done in a step, folded into one prep step, and its minutes count.`
      : "";
    const brief = p ? `This dinner was generated once already and ${[over, hid, unc].filter(Boolean).join(" It also ")}` : undefined;
    const r = await runStoreFill(
      { prisma, runAICall: guarded },
      {
        apply: false, limit: 1, dishes: [toTargetDish(t, i)], profiles: [{ key: "quick-4-easy", servings: 4, difficulty: "easy" }],
        maxCostUsd: Math.max(0.01, cap - spent.spentUsd), maxCalls: 6, rate, timeBudget: BUDGET, brief, finalizeBrief: undefined,
        acceptMeal: (c, payload) => {
          records.push({ n: t.n, key: c.key, title: payload.title, target: t.title, payload, predicted: predictTiming(payload), hidden: hiddenWork(payload, t), uncut: uncutInPayload(payload), ...(brief ? { rework: brief } : {}) });
          return null;
        },
        log: () => {},
      },
    );
    for (const s of r.skips) if (s.stage !== "dedup") skips.push(`#${t.n} ${s.stage}: ${s.reason}${s.title ? ` ("${s.title}")` : ""}`);
    for (const c of r.completenessRejections) skips.push(`#${t.n} completeness retry ${c.attempt}: ${c.reason}`);
    for (const s of r.skips.filter((x) => x.stage === "dedup")) skips.push(`#${t.n} already in the catalog (${t.title})`);
    const rec = records.find((x) => x.n === t.n);
    console.log(`#${String(t.n).padStart(3)} ${rec ? `${String(rec.predicted.total).padStart(3)} min (${rec.predicted.active} hands-on) · ${rec.predicted.steps} steps · ${rec.predicted.dishes} dishes · ${rec.title}${rec.hidden?.length ? ` · HIDDEN WORK: ${rec.hidden.join(", ")}` : ""}${rec.uncut?.length ? ` · UNCUT: ${rec.uncut.join("; ")}` : ""}` : "— no meal"} · $${(spent.spentUsd + computeCacheAwareCostUsd(thisRun, rate)).toFixed(3)}`);
    writeFileSync(join(OUT, label, "gen.json"), JSON.stringify(records, null, 1));
  }
  await prisma.$disconnect();

  const runCost = computeCacheAwareCostUsd(thisRun, rate);
  const ok = records.filter(accepted);
  console.log(`\n${label}: ${records.length} generated · ≤${BUDGET.totalMinutes}: ${ok.length}/${targets.length} · calls ${thisRun.aiCalls} · this run $${runCost.toFixed(4)} · lane $${(spent.spentUsd + runCost).toFixed(4)} · cache read ${thisRun.cacheRead} / created ${thisRun.cacheCreation} / uncached ${thisRun.input} / out ${thisRun.output}`);
  for (const s of skips) console.log(`  ${s}`);
  writeFileSync(join(OUT, label, "run.json"), JSON.stringify({ label, prompt: TIME_BUDGET_PROMPT_VERSION, budget: BUDGET, ids, costUsd: runCost, laneUsd: spent.spentUsd + runCost, skips, at: new Date().toISOString() }, null, 1));
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("cat-quick-1/generate.ts")) main().catch((e) => { console.error(e); process.exit(1); });

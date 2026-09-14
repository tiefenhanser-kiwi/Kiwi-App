// D-WS9-240 item 6 — the 30-minute catalog supplement.
//
// Generates Hans's 30-minute target list (scripts/output/ws9-30min/*.csv — gitignored, his disk)
// into the shared catalog through the CATALOG's real generation path: runStoreFill
// (src/lib/storeFill.ts) → store.generate_meal + store.finalize_steps via runAICall (the cached
// Block 3.8 prefixes, which carry the firstDependent contract) → mergeSteps/deriveParallelGroups →
// materializeMeal with STORE_FILL_TARGET (public, userId null, batch_generated) → stampMealTiming.
// The 1,124 shelf meals were born this way; these are too. The CSV's dish split rides the
// generate call's volatile input (TargetDish.dishes, D-WS9-240 item 6).
//
//   node --env-file=.env --import tsx scripts/ws9-30min/generate.ts --limit 5 --apply
//   node --env-file=.env --import tsx scripts/ws9-30min/generate.ts --apply            # all rows
//   node --env-file=.env --import tsx scripts/ws9-30min/generate.ts --report           # DB → run.json, no calls
//
// ⚠️ SHARED CATALOG DATA (D-WS9-230) — Hans ruled the run (September 14). Revert: revert.ts,
// which removes exactly the meals this run created, by id (dishFamilyKey `km30-…`).
//
// Spend: a HARD CUMULATIVE breaker at $60, checked BEFORE EVERY AI call across restarts
// (spend.json), stop-and-report, never a throw. Resumable: runStoreFill dedups on dishFamilyKey
// from the DB, so a restart skips every row already written and generates only what is missing.
import { PrismaClient } from "@prisma/client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { getModelRate, MODEL_SONNET } from "../../src/lib/ai/promptRegistry";
import { runAICall as productionRunAICall } from "../../src/lib/ai/runAICall";
import type { SchedulerDish, SchedulerPhase } from "../../src/lib/cookingScheduler";
import { deriveMealTiming } from "../../src/lib/mealTiming";
import { computeCacheAwareCostUsd, emptyTokenTotals, runStoreFill, type ModelRateUsd, type TokenTotals } from "../../src/lib/storeFill";
import type { TargetDish } from "../../src/lib/storeFillDishes";

export const OUT = "scripts/output/ws9-30min";
const CSV = `${OUT}/kiwi_30min_meal_targets_2026-09-12.csv`;
const SPEND_FILE = `${OUT}/spend.json`;
const SPEND_CAP_USD = 60;
export const KEY_PREFIX = "km30-";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const REPORT_ONLY = argv.includes("--report");
const limitIdx = argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : Infinity;

// ── the target list ──────────────────────────────────────────────────────────
export type TargetRow = { id: string; title: string; cuisine: string; protein: string; dishes: string[]; estTotalMin: number; estHandsOnMin: number; why: string; shortcut: string };
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((x) => x !== "")) rows.push(row); row = []; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); if (row.some((x) => x !== "")) rows.push(row); }
  return rows;
}
export function readTargets(): TargetRow[] {
  const rows = parseCsv(readFileSync(CSV, "utf8"));
  const header = rows[0];
  const want = ["id", "title", "cuisine", "protein", "dishes", "est_total_min", "est_hands_on_min", "why_it_fits_kiwis_clock", "shortcut_used"];
  if (header.join(",") !== want.join(",")) throw new Error(`unexpected CSV header: ${header.join(",")}`);
  return rows.slice(1).map((r) => ({ id: r[0], title: r[1], cuisine: r[2], protein: r[3], dishes: r[4].split("|").map((s) => s.trim()).filter(Boolean), estTotalMin: Number(r[5]), estHandsOnMin: Number(r[6]), why: r[7], shortcut: r[8] }));
}
const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const keyFor = (t: TargetRow) => `${KEY_PREFIX}${t.id.toLowerCase()}-${slug(t.title)}`.slice(0, 120);
function toTargetDish(t: TargetRow, i: number): TargetDish {
  return { rank: i + 1, dish: t.title, key: keyFor(t), category: t.cuisine, parentDish: t.title, band: "midtail", siblingCount: 1, dishes: t.dishes };
}

// ── DB read-back: the derived number is the acceptance, never the model's estimate ──
type MealReport = { kmId: string; key: string; mealId: string; title: string; createdAt: string; derivedTotal: number; active: number | null; serialSum: number; claimedSaving: number; dishes: { title: string; role: string; steps: number; tagged: number }[]; ignoredTags: number; estTotalMin: number };
export async function reportFromDb(prisma: PrismaClient, targets: TargetRow[]): Promise<MealReport[]> {
  const byKey = new Map(targets.map((t) => [keyFor(t), t]));
  const meals = await prisma.meal.findMany({ where: { sourceType: "batch_generated", dishFamilyKey: { startsWith: KEY_PREFIX } }, select: { id: true, title: true, dishFamilyKey: true, createdAt: true, estimatedTimeMinutes: true, activeTimeMinutes: true, dishLinks: { select: { dishId: true, positionIndex: true, roleLabel: true, dish: { select: { title: true } } } } }, orderBy: { createdAt: "asc" } });
  const dishIds = meals.flatMap((m) => m.dishLinks.map((l) => l.dishId));
  const steps = await prisma.recipeInstructionStep.findMany({ where: { ownerType: "dish", ownerId: { in: dishIds } }, select: { ownerId: true, stepIndex: true, estimatedMinutes: true, phaseType: true, isTimingSensitive: true, parallelGroup: true, componentKey: true, pathKey: true }, orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }] });
  const out: MealReport[] = [];
  for (const m of meals) {
    const t = byKey.get(m.dishFamilyKey ?? "");
    const dishes: SchedulerDish[] = m.dishLinks.map((l) => ({ dishId: l.dishId, title: l.dish.title, positionIndex: l.positionIndex, steps: steps.filter((s) => s.ownerId === l.dishId).map((s) => ({ stepIndex: s.stepIndex, estimatedMinutes: s.estimatedMinutes, phaseType: s.phaseType as SchedulerPhase, isTimingSensitive: s.isTimingSensitive, parallelGroup: s.parallelGroup, componentKey: s.componentKey, pathKey: s.pathKey })) }));
    const timing = deriveMealTiming(dishes);
    // serial sum = every step of every dish end to end (base + scratch path only, so a dual-path
    // dish is not double-counted): what the meal would take with no overlap at all.
    const serialSum = dishes.reduce((a, d) => a + d.steps.filter((s) => s.pathKey !== "bought").reduce((b, s) => b + s.estimatedMinutes, 0), 0);
    out.push({ kmId: t?.id ?? "?", key: m.dishFamilyKey ?? "", mealId: m.id, title: m.title, createdAt: m.createdAt.toISOString(), derivedTotal: m.estimatedTimeMinutes, active: m.activeTimeMinutes, serialSum, claimedSaving: serialSum - m.estimatedTimeMinutes, dishes: m.dishLinks.map((l) => ({ title: l.dish.title, role: l.roleLabel ?? "", steps: steps.filter((s) => s.ownerId === l.dishId).length, tagged: steps.filter((s) => s.ownerId === l.dishId && s.parallelGroup).length })), ignoredTags: timing.ignoredTags.length, estTotalMin: t?.estTotalMin ?? 0 });
    if (timing.totalMinutes !== m.estimatedTimeMinutes) console.log(`  🔴 ${m.id.slice(0, 8)} stored ${m.estimatedTimeMinutes} ≠ derived ${timing.totalMinutes} — the D-WS9-235 invariant is false on this meal`);
  }
  return out;
}
export function distribution(rs: MealReport[]): string {
  const ts = rs.map((r) => r.derivedTotal).sort((a, b) => a - b);
  const p = (q: number) => ts.length ? ts[Math.min(ts.length - 1, Math.floor(q * ts.length))] : 0;
  return `n=${ts.length} · ≤30: ${ts.filter((t) => t <= 30).length} · ≤45: ${ts.filter((t) => t <= 45).length} · >45: ${ts.filter((t) => t > 45).length} · mean=${ts.length ? (ts.reduce((a, b) => a + b, 0) / ts.length).toFixed(1) : "-"} · p50=${p(0.5)} · max=${ts.length ? ts[ts.length - 1] : "-"}`;
}
async function shelf(prisma: PrismaClient): Promise<string> {
  const pop = await prisma.meal.findMany({ where: { isPublic: true, isArchived: false, mealType: "dinner", activeTimeMinutes: { not: null } }, select: { estimatedTimeMinutes: true } });
  return `population ${pop.length} · ≤30: ${pop.filter((m) => m.estimatedTimeMinutes <= 30).length} · ≤45: ${pop.filter((m) => m.estimatedTimeMinutes <= 45).length} · ≤60: ${pop.filter((m) => m.estimatedTimeMinutes <= 60).length}`;
}

// ── main ─────────────────────────────────────────────────────────────────────
const targets = readTargets();
console.log(`target list: ${CSV} · rows=${targets.length} · fields=id,title,cuisine,protein,dishes(|-split),est_total_min,est_hands_on_min,why_it_fits_kiwis_clock,shortcut_used · dish-split sizes: ${[...new Map(targets.map((t) => [t.dishes.length, targets.filter((x) => x.dishes.length === t.dishes.length).length]))].sort().map(([k, v]) => `${k}→${v}`).join(", ")}`);
const prisma = new PrismaClient();
if (REPORT_ONLY) {
  const rs = await reportFromDb(prisma, targets);
  writeFileSync(`${OUT}/run.json`, JSON.stringify({ reportedAt: new Date().toISOString(), meals: rs }, null, 1));
  console.log(`DB: ${rs.length} km30- meals · ${distribution(rs)}`);
  console.log(`shelf: ${await shelf(prisma)}`);
  await prisma.$disconnect(); process.exit(0);
}

const rate: ModelRateUsd = await getModelRate(MODEL_SONNET, prisma);
let prior: { spentUsd: number; calls: number } = existsSync(SPEND_FILE) ? JSON.parse(readFileSync(SPEND_FILE, "utf8")) : { spentUsd: 0, calls: 0 };
console.log(`seam: runStoreFill (src/lib/storeFill.ts) · prompts store.generate_meal + store.finalize_steps (cached prefixes in storeFillPrompts.ts) · materializeMeal → STORE_FILL_TARGET · rate $${rate.inputPerMtokUsd}/$${rate.outputPerMtokUsd} per Mtok · prior spend $${prior.spentUsd.toFixed(4)} over ${prior.calls} calls · cap $${SPEND_CAP_USD} · mode ${APPLY ? "APPLY (writes)" : "no writes"}`);
if (!existsSync(`${OUT}/pre_run.json`)) {
  const existing = await prisma.meal.count({ where: { sourceType: "batch_generated" } });
  const km = await prisma.meal.count({ where: { dishFamilyKey: { startsWith: KEY_PREFIX } } });
  writeFileSync(`${OUT}/pre_run.json`, JSON.stringify({ recordedAt: new Date().toISOString(), batchGeneratedMeals: existing, km30Meals: km, shelf: await shelf(prisma) }, null, 1));
  console.log(`pre-run dump: batch_generated=${existing} · km30- meals already present=${km} → ${OUT}/pre_run.json`);
}

// The breaker wraps runAICall: cumulative (prior runs + this run) checked before EVERY call.
const thisRun: TokenTotals = emptyTokenTotals();
let breakerTripped = false;
const calls: { key: string; usd: number; cum: number }[] = [];
const guardedRunAICall: typeof productionRunAICall = (async (key: string, vars: unknown, schema: unknown, opts: unknown) => {
  const cum = prior.spentUsd + computeCacheAwareCostUsd(thisRun, rate);
  if (cum >= SPEND_CAP_USD || breakerTripped) {
    breakerTripped = true;
    console.log(`SPEND BREAKER: $${cum.toFixed(4)} ≥ $${SPEND_CAP_USD} before ${key} — refusing the call`);
    return { success: false, reason: "spend_breaker", userFacingMessage: "spend breaker", metadata: { inputTokens: 0, outputTokens: 0 } };
  }
  const res = await (productionRunAICall as unknown as (...a: unknown[]) => Promise<{ metadata: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number } }>)(key, vars, schema, opts);
  const before = computeCacheAwareCostUsd(thisRun, rate);
  thisRun.aiCalls++; thisRun.input += res.metadata.inputTokens ?? 0; thisRun.output += res.metadata.outputTokens ?? 0; thisRun.cacheRead += res.metadata.cacheReadInputTokens ?? 0; thisRun.cacheCreation += res.metadata.cacheCreationInputTokens ?? 0;
  const after = computeCacheAwareCostUsd(thisRun, rate);
  calls.push({ key, usd: after - before, cum: prior.spentUsd + after });
  writeFileSync(SPEND_FILE, JSON.stringify({ spentUsd: prior.spentUsd + after, calls: prior.calls + thisRun.aiCalls }));
  return res;
}) as unknown as typeof productionRunAICall;

const dishes = targets.slice(0, Number.isFinite(LIMIT) ? LIMIT : targets.length).map(toTargetDish);
const t0 = Date.now();
const result = await runStoreFill(
  { prisma, runAICall: guardedRunAICall },
  { apply: APPLY, limit: dishes.length, dishes, maxCostUsd: Math.max(0.01, SPEND_CAP_USD - prior.spentUsd), maxCalls: dishes.length * 5, maxConsecutiveFailures: 3, rate, log: (m) => console.log(m) },
);
const wall = (Date.now() - t0) / 1000;
const runCost = computeCacheAwareCostUsd(thisRun, rate);
console.log(`\nrun: attempted=${result.attempted} written=${result.records.filter((r) => r.written).length} skips=${result.skips.length} (${[...new Map(result.skips.map((s) => [s.stage + ":" + s.reason, result.skips.filter((x) => x.stage === s.stage && x.reason === s.reason).length]))].map(([k, v]) => `${k}=${v}`).join(", ") || "none"}) completenessRejections=${result.completenessRejections.length} stoppedBy=${result.stoppedBy ?? "none"} · calls=${thisRun.aiCalls} · cost this run $${runCost.toFixed(4)} · cumulative $${(prior.spentUsd + runCost).toFixed(4)} · per written meal $${result.records.filter((r) => r.written).length ? (runCost / result.records.filter((r) => r.written).length).toFixed(4) : "-"} · cache-read ${thisRun.cacheRead} / created ${thisRun.cacheCreation} / uncached in ${thisRun.input} / out ${thisRun.output} · wall ${wall.toFixed(0)}s`);
if (calls.length) console.log(`per-call: ${calls.map((c) => `${c.key.replace("store.", "")}=$${c.usd.toFixed(4)}`).join(" ")}`);
const pgi = result.parallelGroupIssues;
console.log(`parallelGroup issues on this run: ${pgi.length} · adjacency_override=${pgi.filter((i) => i.cls === "adjacency_override").length} · null_declared=${pgi.filter((i) => i.cls === "null_declared").length} · missing_window=${pgi.filter((i) => i.cls === "missing_window").length} · other=${[...new Map(pgi.filter((i) => !["adjacency_override", "null_declared", "missing_window"].includes(i.cls)).map((i) => [i.cls, pgi.filter((x) => x.cls === i.cls).length]))].map(([k, v]) => `${k}=${v}`).join(",") || "none"}`);
for (const s of result.skips.filter((x) => x.stage !== "dedup")) console.log(`  skip [${s.targetDish.slice(0, 50)}] ${s.stage}: ${s.reason}${s.title ? ` ("${s.title}")` : ""}`);
for (const c of result.completenessRejections) console.log(`  completeness retry [${c.targetDish.slice(0, 50)}] attempt ${c.attempt}: ${c.reason}`);

// the derived numbers, from the DB
const rs = await reportFromDb(prisma, targets);
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/run.json`, JSON.stringify({ reportedAt: new Date().toISOString(), meals: rs }, null, 1));
const thisRunIds = new Set(result.records.map((r) => r.mealId).filter(Boolean));
const mine = rs.filter((r) => thisRunIds.has(r.mealId));
console.log(`\nDERIVED (this run, ${mine.length} meals): ${distribution(mine)}`);
for (const r of mine) console.log(`  ${r.kmId} ${r.title.slice(0, 58).padEnd(58)} derived ${String(r.derivedTotal).padStart(3)} (active ${r.active}) · serial ${r.serialSum} · saving ${r.claimedSaving} · csv-est ${r.estTotalMin} · dishes ${r.dishes.map((d) => `${d.role}:${d.steps}s/${d.tagged}t`).join(" ")}${r.ignoredTags ? ` · ignoredTags ${r.ignoredTags}` : ""}`);
console.log(`DERIVED (all km30- meals in the DB): ${distribution(rs)}`);
console.log(`shelf now: ${await shelf(prisma)}`);
console.log(`revert: node --env-file=.env --import tsx scripts/ws9-30min/revert.ts --apply   (removes exactly the km30- meals, by id from run.json)`);
await prisma.$disconnect();

// [prepcook] Part J.1 — the corpus engine table, FREE (no AI, no writes).
//
//   node --env-file=.env --import tsx scripts/prep-cook-census/part-j1/census.ts [path-to-J0-prepStorage.ts]
//
// Per corpus plan:
//   • containers — J.0's v20 header (part-j0/out/regen.json) → J.1, computed the way
//     the route computes it (stand-in prose; the count never depends on prose);
//   • expired windows — a rendered, dated step whose container window ends before its
//     cook day: under the J.0 table and the J.1 table with no holds (proteins excluded:
//     J.0 already held them), and as served with R1's holds;
//   • the cook-day list length.
// The J.0 table is read from a snapshot of prepStorage.ts at 242b846 (argv[2]).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PrismaClient } from "@prisma/client";

import { loadPrepWeekInput } from "../../../src/lib/prepWeekAggregation";
import { buildPrepWeekPlan, finishPrepWeek, type PrepWeekBuild } from "../../../src/lib/prepWeekBuild";
import { assemblePrepWeekResult, summarizePrepWeek } from "../../../src/lib/prepWeekAssembly";
import { STORAGE_TABLE, storageClassFor, type StorageClass } from "../../../src/lib/prepStorage";
import { TEST_USER_ID, loadCorpus } from "../part-i/corpus";

if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) throw new Error("REFUSING: not the dev branch");
const HERE = dirname(fileURLToPath(import.meta.url));
const WRITE_OPS = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const base = new PrismaClient();
const prisma = base.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
  if (WRITE_OPS.has(operation)) throw new Error(`WRITE BLOCKED: ${model}.${operation}`);
  return query(args);
} } } }) as unknown as PrismaClient;

function wire(b: PrepWeekBuild) {
  const narration = { steps: b.stepPlan.narrationInput.steps.map((s) => ({ stepId: s.stepId, title: "T", instructions: "Do it." })) };
  return summarizePrepWeek(finishPrepWeek(assemblePrepWeekResult(b.stepPlan, narration), b));
}

/** Expired windows among rendered, dated, non-protein steps, with a given table. */
function expired(b: PrepWeekBuild, table: readonly StorageClass[], lagByMealId: ReadonlyMap<string, number>, withProteins = false) {
  let candidates = 0;
  let hits = 0;
  for (const st of b.stepPlan.steps) {
    if (st.demoted || st.holdsNoContainer || st.fixedProse) continue;
    if (st.phase === "proteins" && !withProteins) continue;
    const h = b.holds.get(st.stepKey);
    if (h?.all) continue;
    const meals = h ? h.keptMealIds : st.contributesToMealIds;
    const lags = meals.map((m) => lagByMealId.get(m)).filter((n): n is number => n !== undefined);
    if (lags.length === 0) continue;
    const ctx = b.storageContexts.get(st.stepKey)!;
    const windows = ctx.closes && ctx.closes.length > 0
      ? ctx.closes.map((c) => storageClassFor(c.text, c.name, c.ingredientNames, table))
      : [storageClassFor(ctx.text, ctx.bowlName, ctx.ingredientNames, table)];
    const fridge = windows.filter((w) => !w.roomTemp);
    if (fridge.length === 0) continue;
    candidates++;
    if (Math.max(...lags) > Math.min(...fridge.map((w) => w.days))) hits++;
  }
  return { candidates, hits };
}

/**
 * As served, per PORTION: a kept portion whose meal's lag passes the window of the
 * container it goes into. This is the exact claim R1 makes; a step-level count pairs
 * one container's window with another meal's lag and over-counts.
 */
function expiredPortions(b: PrepWeekBuild, lagByMealId: ReadonlyMap<string, number>) {
  const windowByName = new Map<string, number>();
  for (const ctx of b.storageContexts.values()) {
    for (const c of ctx.closes ?? []) {
      const cls = storageClassFor(c.text, c.name, c.ingredientNames);
      windowByName.set(c.name, cls.roomTemp ? Infinity : cls.days);
    }
  }
  let candidates = 0;
  let hits = 0;
  const examples: string[] = [];
  for (const st of b.stepPlan.steps) {
    if (st.demoted || st.holdsNoContainer || st.fixedProse) continue;
    const h = b.holds.get(st.stepKey);
    if (h?.all) continue;
    for (const c of h ? h.keptComponents : st.components) {
      for (const m of c.measures) {
        const lag = m.mealId ? lagByMealId.get(m.mealId) : undefined;
        if (lag === undefined) continue;
        const dest = m.destination ?? st.bowlName;
        const own = storageClassFor(c.ingredientName, "", [c.ingredientName]);
        const win = dest && windowByName.has(dest) ? windowByName.get(dest)! : own.roomTemp ? Infinity : own.days;
        if (!Number.isFinite(win)) continue;
        candidates++;
        if (lag > win) {
          hits++;
          if (examples.length < 3) examples.push(`${st.stepKey.slice(0, 20)} ${c.ingredientName} → ${dest ?? "own"} (${win}d) lag ${lag}${st.portionLines ? "" : " [narrated step]"}`);
        }
      }
    }
  }
  if (examples.length) console.error(examples.join("\n"));
  return { candidates, hits };
}

async function main() {
  const j0Path = process.argv[2];
  if (!j0Path) throw new Error("pass the J.0 prepStorage.ts snapshot");
  const j0 = (await import(pathToFileURL(j0Path).href)) as { STORAGE_TABLE: readonly StorageClass[] };
  const regen = JSON.parse(readFileSync(join(HERE, "..", "part-j0", "out", "regen.json"), "utf8")) as { code: string; containerCount: number; estimatedMinutes: number }[];
  const rows: string[] = [];
  const tot = { j0: { c: 0, h: 0 }, j1: { c: 0, h: 0 }, served: { c: 0, h: 0 }, before: 0, after: 0, held: 0 };
  for (const row of await loadCorpus(prisma)) {
    const load = await loadPrepWeekInput({ planId: row.planId, userId: TEST_USER_ID, prisma });
    const lag = load.cookDays.lagByMealId;
    const raw = buildPrepWeekPlan(load, { noHolds: true });
    const served = buildPrepWeekPlan(load);
    const w = wire(served);
    const a = expired(raw, j0.STORAGE_TABLE, lag);
    const bb = expired(raw, STORAGE_TABLE, lag);
    const c = expiredPortions(served, lag);
    const before = regen.find((x) => x.code === row.code);
    const heldN = w.phases.find((p) => p.phase === "proteins")?.heldForCookDay?.length ?? 0;
    tot.j0.c += a.candidates; tot.j0.h += a.hits; tot.j1.c += bb.candidates; tot.j1.h += bb.hits; tot.served.c += c.candidates; tot.served.h += c.hits;
    tot.before += before?.containerCount ?? 0; tot.after += w.containerCount ?? 0; tot.held += heldN;
    rows.push(`| ${row.code} | ${before?.containerCount ?? "—"} → ${w.containerCount} | ${before?.estimatedMinutes ?? "—"} → ${w.estimatedMinutes} | ${a.hits}/${a.candidates} | ${bb.hits}/${bb.candidates} | ${c.hits}/${c.candidates} | ${heldN} |`);
  }
  const out = [
    "| plan | containers J.0 → J.1 | minutes J.0 → J.1 | expired, J.0 table | expired, J.1 table | expired, served (R1) | cook-day lines |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    `| **total** | **${tot.before} → ${tot.after}** | | **${tot.j0.h}/${tot.j0.c}** | **${tot.j1.h}/${tot.j1.c}** | **${tot.served.h}/${tot.served.c}** | ${tot.held} |`,
  ].join("\n");
  console.log(out);
  writeFileSync(join(HERE, "census.md"), `${out}\n`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => base.$disconnect());

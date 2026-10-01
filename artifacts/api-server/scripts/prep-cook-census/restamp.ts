// [prepcook] B1 · B — D-WS9-297 ruling 6: re-stamp meals whose stored
// `Meal.estimatedTimeMinutes` / `activeTimeMinutes` no longer match what
// `deriveMealTiming` computes from their own steps.
//
// A BACKFILL, NOT A FIX. Both numbers come off `cookingScheduler`; a mismatch
// means the stamp predates a scheduler change (BUG-270's path selection, the
// D-WS9-239 catalog tagging, and now BUG-337's latest bound + cold-dish
// forwarding). The derive is the authority.
//
//   # report only, writes nothing
//   node --env-file=.env --import tsx scripts/prep-cook-census/restamp.ts --scan
//   # report + write (dev only; public catalog per D-WS9-230's carve-out)
//   node --env-file=.env --import tsx scripts/prep-cook-census/restamp.ts --apply
//   # undo a run from its own ledger
//   node --env-file=.env --import tsx scripts/prep-cook-census/restamp.ts --revert out/restamp-<stamp>.json
//
// `--scan` alone is the default, so a bare invocation cannot write.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { deriveMealTiming } from "../../src/lib/mealTiming";
import type { SchedulerPhase } from "../../src/lib/cookingScheduler";

const prisma = new PrismaClient();
const DB_HOST = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!DB_HOST.includes("ep-broad-haze")) {
  throw new Error(`REFUSING: DATABASE_URL host is not the dev branch (${DB_HOST.slice(0, 8)}…)`);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const HAS = (n: string) => process.argv.includes(`--${n}`);
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const APPLY = HAS("apply");
const REVERT = arg("revert");
/** Only these plans' meals, when given; otherwise every meal with steps. */
const ONLY_PLANS = (arg("plans") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

interface LedgerRow {
  mealId: string;
  title: string;
  before: { total: number; active: number | null };
  after: { total: number; active: number | null };
}

async function revert(path: string) {
  const rows = JSON.parse(readFileSync(path, "utf8")).rows as LedgerRow[];
  let n = 0;
  for (const r of rows) {
    await prisma.meal.update({
      where: { id: r.mealId },
      data: { estimatedTimeMinutes: r.before.total, activeTimeMinutes: r.before.active },
    });
    n++;
  }
  console.log(`reverted ${n} meal(s) from ${path}`);
}

async function main() {
  if (REVERT) return revert(REVERT);

  const mealIds = ONLY_PLANS.length
    ? (
        await prisma.mealPlanItem.findMany({
          where: { planInstance: { OR: ONLY_PLANS.map((p) => ({ id: { startsWith: p } })) } },
          select: { mealId: true },
        })
      ).map((r) => r.mealId)
    : (await prisma.meal.findMany({ where: { isArchived: false }, select: { id: true } })).map((r) => r.id);
  const uniqueIds = [...new Set(mealIds)];

  const rows: LedgerRow[] = [];
  let scanned = 0;
  // Batched so a full-catalog scan does not hold 3,500 meals of steps in memory.
  const BATCH = 200;
  for (let i = 0; i < uniqueIds.length; i += BATCH) {
    const slice = uniqueIds.slice(i, i + BATCH);
    const meals = await prisma.meal.findMany({
      where: { id: { in: slice } },
      select: {
        id: true, title: true, estimatedTimeMinutes: true, activeTimeMinutes: true,
        dishLinks: { select: { dishId: true, positionIndex: true, dish: { select: { title: true } } } },
      },
    });
    const dishIds = meals.flatMap((m) => m.dishLinks.map((l) => l.dishId));
    const steps = dishIds.length
      ? await prisma.recipeInstructionStep.findMany({
          where: { ownerType: "dish", ownerId: { in: dishIds } },
          orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }],
          select: {
            ownerId: true, stepIndex: true, estimatedMinutes: true, phaseType: true,
            isTimingSensitive: true, parallelGroup: true, componentKey: true, pathKey: true,
          },
        })
      : [];
    const byDish = new Map<string, typeof steps>();
    for (const s of steps) {
      const l = byDish.get(s.ownerId);
      if (l) l.push(s); else byDish.set(s.ownerId, [s]);
    }
    for (const m of meals) {
      scanned++;
      const timing = deriveMealTiming(
        m.dishLinks.map((l) => ({
          dishId: l.dishId,
          title: l.dish.title,
          positionIndex: l.positionIndex,
          // NO `text`: the derive needs no prose, and passing none is what keeps
          // this identical to the save-time stamp's own call.
          steps: (byDish.get(l.dishId) ?? []).map((s) => ({
            stepIndex: s.stepIndex,
            estimatedMinutes: s.estimatedMinutes <= 0 ? 1 : s.estimatedMinutes,
            phaseType: s.phaseType as SchedulerPhase,
            isTimingSensitive: s.isTimingSensitive,
            parallelGroup: s.parallelGroup,
            componentKey: s.componentKey,
            pathKey: s.pathKey,
          })),
        })),
      );
      // Null means "cannot say" (no dish has a step) — the caller keeps what it
      // had, so there is nothing to re-stamp.
      if (timing.totalMinutes === null) continue;
      if (
        m.estimatedTimeMinutes === timing.totalMinutes &&
        m.activeTimeMinutes === timing.activeMinutes
      ) continue;
      rows.push({
        mealId: m.id,
        title: m.title,
        before: { total: m.estimatedTimeMinutes, active: m.activeTimeMinutes },
        after: { total: timing.totalMinutes, active: timing.activeMinutes },
      });
    }
  }

  const deltas = rows.map((r) => r.after.total - r.before.total).sort((a, b) => a - b);
  const q = (p: number) => (deltas.length ? deltas[Math.floor((deltas.length - 1) * p)] : 0);
  console.log(`scanned ${scanned} meal(s); ${rows.length} stale`);
  if (deltas.length) {
    console.log(`  total-minute delta: min ${deltas[0]}  p25 ${q(0.25)}  median ${q(0.5)}  p75 ${q(0.75)}  max ${deltas.at(-1)}`);
  }
  for (const r of rows.slice(0, 20)) {
    console.log(`  ${r.mealId.slice(0, 8)}  ${String(r.before.total).padStart(4)}→${String(r.after.total).padStart(4)} total  ${String(r.before.active ?? "-").padStart(4)}→${String(r.after.active ?? "-").padStart(4)} active  ${r.title.slice(0, 56)}`);
  }
  if (rows.length > 20) console.log(`  … and ${rows.length - 20} more`);

  // ── BUG-341 / G2 — THE SWEEP FILE THE CHECKER SCORES ──────────────────────
  //
  // 🔴 WHY THIS EXISTS. K-R6 always compared the right pair (Cook Mode's total
  // against `Meal.estimatedTimeMinutes`, the field the card renders). It scored
  // 0 anyway, because the census corpus is 13 plans and B1 re-stamped exactly
  // those 13 plans' 23 meals. The instrument was measuring a sample its own
  // lane had already repaired. The QA harness picked 25 other catalog meals and
  // 9 of them were stale; a population scan found 791 of 2,042.
  //
  // A per-plan rule cannot see a population. So the population scan — which is
  // this file, and already existed — now writes what it found as DATA, and
  // check.ts scores K-R6 over it without a database of its own.
  //
  // Written on --scan as well as --apply: the sweep is the measurement, and the
  // measurement must not require the write.
  writeFileSync(
    join(OUT, "stamp-sweep.json"),
    JSON.stringify(
      {
        stamp: new Date().toISOString(),
        host: DB_HOST,
        applied: APPLY,
        scope: ONLY_PLANS.length ? ONLY_PLANS : "all non-archived meals",
        scanned,
        stale: rows.length,
        rows,
      },
      null,
      2,
    ),
  );

  if (!APPLY) {
    // "nothing written" used to be true of the whole run. It is now true only
    // of the DATABASE, and saying so precisely matters: the sweep file IS a
    // write, to out/.
    console.log("\n--scan only; no DATABASE write. Pass --apply to write.");
    console.log(`sweep written: ${join(OUT, "stamp-sweep.json")} (check.ts scores K-R6 over it)`);
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ledger = join(OUT, `restamp-${stamp}.json`);
  writeFileSync(ledger, JSON.stringify({ stamp, host: DB_HOST, rows }, null, 2));
  for (const r of rows) {
    await prisma.meal.update({
      where: { id: r.mealId },
      data: { estimatedTimeMinutes: r.after.total, activeTimeMinutes: r.after.active },
    });
  }
  console.log(`\nwrote ${rows.length} meal(s). Ledger (revert with --revert): ${ledger}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

// D-WS9-235 — backfill every meal's derived timing from its steps.
//
// BUG-245 measured the damage: 1,458 of 1,555 derivable meals claimed less time
// than their own steps take, median 20 minutes short, p90 48. bab1a44 fixed
// generation forward; this repairs what is already stored.
//
// ── USAGE ─────────────────────────────────────────────────────────────────
//   node --env-file=.env --import tsx scripts/d235-derive-meal-timing.ts
//   node --env-file=.env --import tsx scripts/d235-derive-meal-timing.ts --apply
//
// Dry-run is the default. --apply writes in batched transactions.
//
// ⚠️ REQUIRES THE MIGRATION. activeTimeMinutes must exist; the script checks and
// refuses rather than failing halfway.
//
// ── THE SAFETY ARGUMENT ───────────────────────────────────────────────────
// Two hashes bracket the run:
//   • NON-TIMING hash — every meal's id + title + sourceType + servingsDefault
//     + difficulty + macros. This must be IDENTICAL after. It is the proof that
//     a timing backfill touched only timing.
//   • TIMING hash — id + estimatedTimeMinutes + activeTimeMinutes. This must
//     CHANGE on the first apply and must NOT change on a second (idempotence).
//
// The derivation imports deriveMealTiming, which imports the scheduler. It
// reimplements nothing: a meal backfilled today gets the number derive-at-save
// would give it if the meal were re-saved tomorrow.
import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";

import { deriveMealTiming } from "../src/lib/mealTiming.js";
import type { SchedulerDish, SchedulerPhase } from "../src/lib/cookingScheduler.js";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
console.log("DB HOST =", new URL(process.env.DATABASE_URL!).host);
console.log(`MODE    = ${APPLY ? "APPLY (writes)" : "DRY-RUN (no writes)"}`);

// Does the migration's column exist yet? A WRITE without it would fail halfway,
// so --apply refuses. A DRY-RUN does not need it — every value is NULL
// pre-migration — and refusing there would force the migration to be applied
// before anyone could see the numbers that justify it, which is the wrong order.
let hasActiveColumn = true;
try {
  await prisma.$queryRawUnsafe(`SELECT "activeTimeMinutes" FROM meals LIMIT 1`);
} catch {
  hasActiveColumn = false;
}
if (!hasActiveColumn) {
  if (APPLY) {
    console.error(
      `\n🔴 REFUSING: meals."activeTimeMinutes" does not exist. Apply the migration first:\n` +
        `   cd artifacts\\api-server; pnpm exec prisma migrate deploy`,
    );
    await prisma.$disconnect();
    process.exit(2);
  }
  console.log(
    `\n⚠️  meals."activeTimeMinutes" does not exist yet — migration not applied.\n` +
      `   The dry-run below is still accurate: it derives from the STEPS, which the\n` +
      `   migration does not touch. Only the timing hash omits the missing column.`,
  );
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

async function hashes(): Promise<{ nonTiming: string; timing: string; n: number }> {
  const rows = await prisma.meal.findMany({
    select: {
      id: true, title: true, sourceType: true, servingsDefault: true, difficulty: true,
      caloriesPerServing: true, proteinGPerServing: true, carbsGPerServing: true, fatGPerServing: true,
      estimatedTimeMinutes: true,
      ...(hasActiveColumn ? { activeTimeMinutes: true } : {}),
    },
    orderBy: { id: "asc" },
  });
  return {
    nonTiming: sha(rows.map((r) =>
      [r.id, r.title, r.sourceType, r.servingsDefault, r.difficulty,
       r.caloriesPerServing, r.proteinGPerServing, r.carbsGPerServing, r.fatGPerServing].join("|"),
    ).join("\n")),
    timing: sha(
      rows
        .map((r) => {
          const active = (r as { activeTimeMinutes?: number | null }).activeTimeMinutes;
          return `${r.id}:${r.estimatedTimeMinutes}:${active ?? "-"}`;
        })
        .join("\n"),
    ),
    n: rows.length,
  };
}

const before = await hashes();
console.log(`\nBEFORE  meals=${before.n}`);
console.log(`  non-timing sha256 = ${before.nonTiming}`);
console.log(`  timing     sha256 = ${before.timing}`);

// ── derive ────────────────────────────────────────────────────────────────
const meals = await prisma.meal.findMany({
  select: {
    id: true, title: true, estimatedTimeMinutes: true, sourceType: true,
    dishLinks: { select: { dishId: true, positionIndex: true } },
  },
  orderBy: { id: "asc" },
});
const steps = await prisma.recipeInstructionStep.findMany({
  where: { ownerType: "dish" },
  select: { ownerId: true, stepIndex: true, estimatedMinutes: true, phaseType: true, isTimingSensitive: true },
  orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }],
});
const byDish = new Map<string, SchedulerDish["steps"]>();
for (const s of steps) {
  const list = byDish.get(s.ownerId) ?? [];
  list.push({
    stepIndex: s.stepIndex,
    estimatedMinutes: s.estimatedMinutes,
    phaseType: s.phaseType as SchedulerPhase,
    isTimingSensitive: s.isTimingSensitive,
  });
  byDish.set(s.ownerId, list);
}

interface Plan { mealId: string; total: number; active: number; dishTotals: Map<string, number>; delta: number; sourceType: string; }
const plans: Plan[] = [];
const skipped: { id: string; title: string; why: string }[] = [];
for (const m of meals) {
  const dishes: SchedulerDish[] = m.dishLinks
    .filter((dl) => byDish.has(dl.dishId))
    .sort((a, b) => a.positionIndex - b.positionIndex)
    .map((dl, i) => ({ dishId: dl.dishId, title: dl.dishId, positionIndex: i, steps: byDish.get(dl.dishId)! }));
  const t = deriveMealTiming(dishes);
  if (t.totalMinutes === null || t.activeMinutes === null) {
    skipped.push({ id: m.id, title: m.title, why: m.dishLinks.length === 0 ? "no dishes" : "no steps on any dish" });
    continue;
  }
  plans.push({
    mealId: m.id, total: t.totalMinutes, active: t.activeMinutes, dishTotals: t.dishTotals,
    delta: t.totalMinutes - m.estimatedTimeMinutes, sourceType: m.sourceType,
  });
}

const pct = (arr: number[], p: number) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN;
};
const deltas = plans.map((p) => p.delta);
console.log(`\nDERIVABLE ${plans.length} of ${meals.length}   SKIPPED ${skipped.length}`);
console.log(`\nTHE MOVE (derived total − stored), minutes:`);
console.log(`  p10=${pct(deltas, 10)}  p50=${pct(deltas, 50)}  p90=${pct(deltas, 90)}   max=${Math.max(...deltas)}  min=${Math.min(...deltas)}`);
console.log(`  meals gaining time: ${deltas.filter((d) => d > 0).length}   unchanged: ${deltas.filter((d) => d === 0).length}   losing: ${deltas.filter((d) => d < 0).length}`);
const bySrc = new Map<string, number[]>();
for (const p of plans) bySrc.set(p.sourceType, [...(bySrc.get(p.sourceType) ?? []), p.delta]);
console.log(`  by sourceType:`);
for (const [k, ds] of [...bySrc.entries()].sort()) {
  console.log(`    ${k.padEnd(18)} n=${String(ds.length).padStart(5)}  p50=${String(pct(ds, 50)).padStart(4)}  p90=${String(pct(ds, 90)).padStart(4)}`);
}
console.log(`\nSKIPPED MEALS (${skipped.length}) — stored time left untouched, activeTimeMinutes stays NULL:`);
for (const s of skipped) console.log(`  ${s.id}  ${s.why.padEnd(20)} "${s.title.slice(0, 54)}"`);

if (!APPLY) {
  console.log(`\nDRY-RUN — nothing written. Re-run with --apply to write.`);
  await prisma.$disconnect();
  process.exit(0);
}

// ── apply, batched ────────────────────────────────────────────────────────
const BATCH = 50;
let written = 0;
for (let i = 0; i < plans.length; i += BATCH) {
  const slice = plans.slice(i, i + BATCH);
  await prisma.$transaction([
    ...slice.map((p) =>
      prisma.meal.update({
        where: { id: p.mealId },
        data: { estimatedTimeMinutes: p.total, activeTimeMinutes: p.active },
      }),
    ),
    ...slice.flatMap((p) =>
      [...p.dishTotals.entries()].map(([dishId, total]) =>
        prisma.dish.update({ where: { id: dishId }, data: { estimatedTimeMinutes: total } }),
      ),
    ),
  ]);
  written += slice.length;
  if (written % 250 === 0 || written === plans.length) console.log(`  …${written}/${plans.length}`);
}

const after = await hashes();
console.log(`\nAFTER   meals=${after.n}`);
console.log(`  non-timing sha256 = ${after.nonTiming}`);
console.log(`  timing     sha256 = ${after.timing}`);
console.log(`\nVERIFICATION`);
console.log(`  meal count unchanged        : ${after.n === before.n ? `YES (${after.n})` : `🔴 NO`}`);
console.log(`  NON-TIMING columns untouched: ${after.nonTiming === before.nonTiming ? "YES" : "🔴 NO"}`);
console.log(`  timing hash moved           : ${after.timing !== before.timing ? "YES" : "no (already backfilled — idempotent re-run)"}`);
if (after.n !== before.n || after.nonTiming !== before.nonTiming) {
  console.error(`\n🔴 VERIFICATION FAILED — inspect before trusting this run.`);
  await prisma.$disconnect();
  process.exit(3);
}
console.log(`\n✅ verified. Re-run without --apply to confirm the move is now zero.`);
await prisma.$disconnect();

// [prepcook] B1 — price the two scheduler rulings, separately and together.
//
// D-WS9-297 ruling 1 asks for "the meals that get LONGER, with before/after
// minutes", and ruling 3 is a design change Hans may reverse. Neither question
// can be answered from the shipped schedule alone, so every corpus meal is
// scheduled FOUR ways and the four totals are printed side by side:
//
//   base  both rulings off  — the pre-B1 behaviour
//   +lag  ruling 1 only
//   +cold ruling 3 only
//   ship  both (what production now does)
//
// Read-only: no writes, no AI, no cost.
//
//   node --env-file=.env --import tsx scripts/prep-cook-census/price.ts \
//     --plans b4aa6fee,31c7a885,…
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import {
  scheduleCookingSequence,
  isServedCold,
  LAG_AFTER_HEAT_REST,
  LAG_AFTER_HEAT_OTHER,
  type SchedulerDish,
  type SchedulerPhase,
  type ScheduleResult,
} from "../../src/lib/cookingScheduler";

const prisma = new PrismaClient();
if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) {
  throw new Error("REFUSING: not the dev branch");
}
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const PREFIXES = (arg("plans") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Rest/other gaps that exceed the bound, measured off a result. */
function lagViolations(r: ScheduleResult, dishes: SchedulerDish[]): number {
  const startOf = new Map<string, number>();
  for (const e of r.steps) startOf.set(`${e.dishId}#${e.originalStepIndex}`, e.startOffsetMinutes);
  let n = 0;
  for (const d of dishes) {
    const ordered = [...d.steps].sort((a, b) => a.stepIndex - b.stepIndex);
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1];
      if (prev.phaseType !== "cook") continue;
      const a = startOf.get(`${d.dishId}#${prev.stepIndex}`);
      const b = startOf.get(`${d.dishId}#${ordered[i].stepIndex}`);
      if (a == null || b == null) continue;
      const bound = ordered[i].phaseType === "rest" ? LAG_AFTER_HEAT_REST : LAG_AFTER_HEAT_OTHER;
      if (b - (a + prev.estimatedMinutes) > bound) n++;
    }
  }
  return n;
}

/** Idle minutes inside passive windows >= 10 min (the K-R5 measure). */
function idleInWindows(r: ScheduleResult, dishes: SchedulerDish[]): number {
  const src = new Map<string, { s: SchedulerStepLike; dishId: string }>();
  for (const d of dishes) for (const s of d.steps) src.set(`${d.dishId}#${s.stepIndex}`, { s, dishId: d.dishId });
  const placed = r.steps.map((e) => {
    const hit = src.get(`${e.dishId}#${e.originalStepIndex}`)!;
    const unattended =
      hit.s.phaseType === "preheat" || hit.s.phaseType === "rest" || hit.s.phaseType === "hold" ||
      (hit.s.phaseType === "cook" && !hit.s.isTimingSensitive);
    return { start: e.startOffsetMinutes, finish: e.startOffsetMinutes + hit.s.estimatedMinutes, unattended };
  });
  let idle = 0;
  for (const w of placed) {
    if (!w.unattended || w.finish - w.start < 10) continue;
    let filled = 0;
    for (const o of placed) {
      if (o === w || o.unattended) continue;
      filled += Math.max(0, Math.min(w.finish, o.finish) - Math.max(w.start, o.start));
    }
    idle += Math.max(0, w.finish - w.start - filled);
  }
  return idle;
}
interface SchedulerStepLike { phaseType: SchedulerPhase; isTimingSensitive: boolean; estimatedMinutes: number }

async function main() {
  const planIds: string[] = [];
  for (const p of PREFIXES) {
    const rows = await prisma.mealPlanInstance.findMany({ where: { id: { startsWith: p } }, select: { id: true } });
    if (rows.length === 1) planIds.push(rows[0].id);
  }
  const items = await prisma.mealPlanItem.findMany({
    where: { mealPlanInstanceId: { in: planIds } },
    select: { mealId: true },
  });
  const mealIds = [...new Set(items.map((i) => i.mealId))];

  const rows: {
    mealId: string; title: string; dishes: number; coldDishes: string[];
    base: number; lag: number; cold: number; ship: number;
    vBase: number; vShip: number; idleBase: number; idleShip: number;
  }[] = [];

  for (const mealId of mealIds) {
    const meal = await prisma.meal.findUnique({
      where: { id: mealId },
      select: {
        id: true, title: true,
        dishLinks: { orderBy: { positionIndex: "asc" }, select: { dishId: true, positionIndex: true, roleLabel: true, dish: { select: { title: true } } } },
      },
    });
    if (!meal) continue;
    const steps = await prisma.recipeInstructionStep.findMany({
      where: { ownerType: "dish", ownerId: { in: meal.dishLinks.map((l) => l.dishId) } },
      orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }],
    });
    const byDish = new Map<string, typeof steps>();
    for (const s of steps) {
      const l = byDish.get(s.ownerId);
      if (l) l.push(s); else byDish.set(s.ownerId, [s]);
    }
    const dishes: SchedulerDish[] = meal.dishLinks
      .filter((l) => byDish.has(l.dishId))
      .map((l) => ({
        dishId: l.dishId,
        title: l.dish.title,
        positionIndex: l.positionIndex,
        roleLabel: l.roleLabel,
        steps: (byDish.get(l.dishId) ?? []).map((s) => ({
          stepIndex: s.stepIndex,
          estimatedMinutes: s.estimatedMinutes <= 0 ? 1 : s.estimatedMinutes,
          phaseType: s.phaseType as SchedulerPhase,
          isTimingSensitive: s.isTimingSensitive,
          parallelGroup: s.parallelGroup,
          componentKey: s.componentKey,
          pathKey: s.pathKey,
          text: s.stepTextRaw,
        })),
      }));
    if (dishes.length === 0) continue;

    const base = scheduleCookingSequence(dishes, { enforceMaxLag: false, coldDishesForward: false });
    const lag = scheduleCookingSequence(dishes, { enforceMaxLag: true, coldDishesForward: false });
    const cold = scheduleCookingSequence(dishes, { enforceMaxLag: false, coldDishesForward: true });
    const ship = scheduleCookingSequence(dishes);
    rows.push({
      mealId: meal.id,
      title: meal.title,
      dishes: dishes.length,
      coldDishes: dishes.filter(isServedCold).map((d) => d.title),
      base: base.totalEstimatedMinutes,
      lag: lag.totalEstimatedMinutes,
      cold: cold.totalEstimatedMinutes,
      ship: ship.totalEstimatedMinutes,
      vBase: lagViolations(base, dishes),
      vShip: lagViolations(ship, dishes),
      idleBase: idleInWindows(base, dishes),
      idleShip: idleInWindows(ship, dishes),
    });
  }

  const pct = (a: number, b: number) => (a === 0 ? 0 : Math.round(((b - a) / a) * 1000) / 10);
  const grew = rows.filter((r) => r.ship > r.base).sort((a, b) => pct(a.base, a.ship) - pct(b.base, b.ship)).reverse();
  const shrank = rows.filter((r) => r.ship < r.base);
  const same = rows.filter((r) => r.ship === r.base);

  const L: string[] = [];
  L.push(`PRICING THE B1 SCHEDULER RULINGS — ${rows.length} meals`);
  L.push("");
  L.push(`  lag violations   base ${rows.reduce((s, r) => s + r.vBase, 0)}  →  ship ${rows.reduce((s, r) => s + r.vShip, 0)}`);
  L.push(`  idle window min  base ${rows.reduce((s, r) => s + r.idleBase, 0)}  →  ship ${rows.reduce((s, r) => s + r.idleShip, 0)}`);
  L.push(`  totals: ${grew.length} longer, ${shrank.length} shorter, ${same.length} unchanged`);
  L.push("");
  L.push("  GREW (ship vs base), worst first:");
  L.push("   base  +lag +cold  ship    Δ     %   dishes  cold dishes / title");
  for (const r of grew) {
    L.push(
      `  ${String(r.base).padStart(5)} ${String(r.lag).padStart(5)} ${String(r.cold).padStart(5)} ${String(r.ship).padStart(5)}  ${String(r.ship - r.base).padStart(4)} ${String(pct(r.base, r.ship)).padStart(6)}%  ${String(r.dishes).padStart(3)}    ${r.coldDishes.length ? `[${r.coldDishes.join(", ")}] ` : ""}${r.title.slice(0, 44)}`,
    );
  }
  L.push("");
  L.push("  SHRANK, biggest first:");
  for (const r of [...shrank].sort((a, b) => (a.ship - a.base) - (b.ship - b.base)).slice(0, 12)) {
    L.push(
      `  ${String(r.base).padStart(5)} ${String(r.lag).padStart(5)} ${String(r.cold).padStart(5)} ${String(r.ship).padStart(5)}  ${String(r.ship - r.base).padStart(4)} ${String(pct(r.base, r.ship)).padStart(6)}%  ${String(r.dishes).padStart(3)}    ${r.coldDishes.length ? `[${r.coldDishes.join(", ")}] ` : ""}${r.title.slice(0, 44)}`,
    );
  }
  L.push("");
  L.push("  ATTRIBUTION — which ruling moved it:");
  L.push(`    ruling 1 alone changed ${rows.filter((r) => r.lag !== r.base).length} meal(s); longer ${rows.filter((r) => r.lag > r.base).length}, shorter ${rows.filter((r) => r.lag < r.base).length}`);
  L.push(`    ruling 3 alone changed ${rows.filter((r) => r.cold !== r.base).length} meal(s); longer ${rows.filter((r) => r.cold > r.base).length}, shorter ${rows.filter((r) => r.cold < r.base).length}`);
  L.push(`    over +10%: ruling 1 ${rows.filter((r) => pct(r.base, r.lag) > 10).length}, ruling 3 ${rows.filter((r) => pct(r.base, r.cold) > 10).length}, shipped ${rows.filter((r) => pct(r.base, r.ship) > 10).length}`);

  const text = L.join("\n");
  writeFileSync(join(OUT, "price.txt"), text);
  writeFileSync(join(OUT, "price.json"), JSON.stringify(rows, null, 2));
  console.log(text);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());

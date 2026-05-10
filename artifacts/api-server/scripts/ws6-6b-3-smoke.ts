// Live smoke for WS6 6b-3 — Plan macro recalc.
//
// Imports computePlanMacros() directly (no HTTP), runs against the
// real DB + a real Anthropic call, and verifies cache + persist-back
// behavior end-to-end.
//
// Setup quirk: the dev seed populates Dish.{cal,protein,carbs,fat}
// with non-zero values, so the smoke would skip the AI path entirely
// (everything would be 'cached'). We zero those four fields out in a
// pre-step before run #1 so we can observe the full flow:
//   run #1 → all 'computed' + persist-back
//   run #2 → all 'cached' (cost=$0, ~no latency)
//
// The seed itself is NOT modified — re-running prisma:seed:dev resets
// the dishes back to their canonical macros. Smoke is repeatable.
//
// Run:   pnpm --filter @workspace/api-server exec tsx scripts/ws6-6b-3-smoke.ts
//
// Prereq: prisma:seed (AIPrompts) AND prisma:seed:dev (dev meals + plans)
// must have been run. ANTHROPIC_API_KEY must be set.

import { PrismaClient } from "@prisma/client";

import { computePlanMacros } from "../src/lib/planMacros.ts";

const prisma = new PrismaClient();
const DEV_USER_EMAIL = "hans.tiefenthaler+8@gmail.com";
const TARGET_PLAN_ID = "dev-plan-instance-weeknight";

interface RunReport {
  label: string;
  latencyMs: number;
  costUsd: number;
  dailyCalories: number;
  perDayCount: number;
  perMealCount: number;
  hasEstimatedMacros: boolean;
  statuses: Array<{ dishTitle: string; status: string }>;
}

async function getDevUserId(): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { email: DEV_USER_EMAIL },
    select: { id: true },
  });
  if (!user) {
    throw new Error(
      `dev user ${DEV_USER_EMAIL} not found — run pnpm --filter @workspace/api-server prisma:seed:dev`,
    );
  }
  return user.id;
}

async function dishIdsForPlan(planId: string): Promise<string[]> {
  const plan = await prisma.mealPlanInstance.findUnique({
    where: { id: planId },
    include: {
      items: {
        include: {
          meal: { include: { dishLinks: true } },
        },
      },
    },
  });
  if (!plan) throw new Error(`plan ${planId} not found`);
  const ids = new Set<string>();
  for (const item of plan.items) {
    for (const link of item.meal.dishLinks) ids.add(link.dishId);
  }
  return [...ids];
}

async function zeroDishMacros(dishIds: string[]): Promise<void> {
  await prisma.dish.updateMany({
    where: { id: { in: dishIds } },
    data: {
      caloriesPerServing: 0,
      proteinGPerServing: 0,
      carbsGPerServing: 0,
      fatGPerServing: 0,
    },
  });
}

async function sumLlmCost(userId: string, since: Date): Promise<number> {
  const rows = await prisma.lLMCallLog.findMany({
    where: {
      userId,
      createdAt: { gte: since },
      promptKey: "nutrition.ingredient_estimate",
    },
    select: { costEstimateUsd: true },
  });
  return rows.reduce((acc, r) => acc + Number(r.costEstimateUsd), 0);
}

async function runOnce(label: string, userId: string): Promise<RunReport> {
  const beforeAt = new Date();
  const startedAt = Date.now();
  const result = await computePlanMacros({
    prisma,
    userId,
    planId: TARGET_PLAN_ID,
  });
  const latencyMs = Date.now() - startedAt;
  const costUsd = await sumLlmCost(userId, beforeAt);

  const statuses = result.perMeal.flatMap((m) =>
    m.dishMacros.map((d) => ({ dishTitle: d.dishTitle, status: d.status })),
  );

  console.log(`\n── ${label} ──`);
  console.log(`  latency: ${latencyMs}ms  cost: $${costUsd.toFixed(5)}`);
  console.log(
    `  dailyAverages: cal=${result.dailyAverages.calories}  protein=${result.dailyAverages.proteinG}g  carbs=${result.dailyAverages.carbsG}g  fat=${result.dailyAverages.fatG}g`,
  );
  console.log(`  perDay (${result.perDay.length} days):`);
  for (const d of result.perDay) {
    console.log(
      `    ${d.day}: ${d.totals.calories} cal · ${d.totals.proteinG}g P · ${d.totals.carbsG}g C · ${d.totals.fatG}g F  (${d.mealCount} meals)`,
    );
  }
  console.log(`  perMeal (${result.perMeal.length} items):`);
  for (const m of result.perMeal) {
    for (const d of m.dishMacros) {
      console.log(
        `    [${d.status}] ${m.mealTitle} → ${d.dishTitle}: ${d.macros.calories} cal`,
      );
    }
  }
  if (result.estimationCaveats.length > 0) {
    console.log(`  caveats:`);
    for (const c of result.estimationCaveats) console.log(`    - ${c}`);
  }

  return {
    label,
    latencyMs,
    costUsd,
    dailyCalories: result.dailyAverages.calories,
    perDayCount: result.perDay.length,
    perMealCount: result.perMeal.length,
    hasEstimatedMacros: result.hasEstimatedMacros,
    statuses,
  };
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY not set. Smoke aborts (would fail every dish via no_api_key).",
    );
    process.exitCode = 1;
    return;
  }

  console.log("══════════════════════════════════════════════════════════");
  console.log("WS6 6b-3 smoke — computePlanMacros() against dev plan");
  console.log("══════════════════════════════════════════════════════════");

  const userId = await getDevUserId();
  console.log(`  user: ${userId} (${DEV_USER_EMAIL})`);
  console.log(`  plan: ${TARGET_PLAN_ID}`);

  const dishIds = await dishIdsForPlan(TARGET_PLAN_ID);
  console.log(`  zeroing macros on ${dishIds.length} dishes for run #1...`);
  await zeroDishMacros(dishIds);

  // Sanity: confirm the zero actually stuck.
  const zeroed = await prisma.dish.findMany({
    where: { id: { in: dishIds } },
    select: { id: true, caloriesPerServing: true },
  });
  const allZero = zeroed.every((d) => d.caloriesPerServing === 0);
  if (!allZero) {
    console.error(`  ✗ failed to zero dish macros — aborting`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ✓ all ${dishIds.length} dishes confirmed at 0 calories`);

  const run1 = await runOnce("RUN #1 — fresh estimate", userId);
  const run2 = await runOnce("RUN #2 — cached estimate", userId);

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("VERIFICATION");
  console.log("══════════════════════════════════════════════════════════");

  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];

  checks.push({
    name: "run #1 has 4 perDay entries (Mon–Thu)",
    pass: run1.perDayCount === 4,
    detail: `got ${run1.perDayCount}`,
  });
  checks.push({
    name: "run #1 has 4 perMeal entries",
    pass: run1.perMealCount === 4,
    detail: `got ${run1.perMealCount}`,
  });
  checks.push({
    name: "run #1 dailyAverages.calories populated",
    pass: run1.dailyCalories > 0,
    detail: `got ${run1.dailyCalories}`,
  });
  checks.push({
    name: "run #1 hasEstimatedMacros=true",
    pass: run1.hasEstimatedMacros === true,
    detail: `got ${run1.hasEstimatedMacros}`,
  });
  const allComputed = run1.statuses.every((s) => s.status === "computed");
  checks.push({
    name: "run #1 all dish statuses === 'computed'",
    pass: allComputed,
    detail: run1.statuses.map((s) => `${s.dishTitle}=${s.status}`).join(", "),
  });

  const allCached = run2.statuses.every((s) => s.status === "cached");
  checks.push({
    name: "run #2 all dish statuses === 'cached'",
    pass: allCached,
    detail: run2.statuses.map((s) => `${s.dishTitle}=${s.status}`).join(", "),
  });
  checks.push({
    name: "run #2 cost === 0",
    pass: run2.costUsd === 0,
    detail: `got $${run2.costUsd.toFixed(5)}`,
  });
  checks.push({
    name: "run #2 latency much lower than run #1",
    pass: run2.latencyMs < run1.latencyMs / 2,
    detail: `${run2.latencyMs}ms vs ${run1.latencyMs}ms`,
  });
  // Caching is deterministic post-persist: same dailyAverages exactly.
  checks.push({
    name: "run #1 and run #2 dailyAverages match",
    pass: run1.dailyCalories === run2.dailyCalories,
    detail: `${run1.dailyCalories} vs ${run2.dailyCalories}`,
  });

  for (const c of checks) {
    console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}  (${c.detail})`);
  }

  const allPass = checks.every((c) => c.pass);
  console.log(
    `\n  Overall: ${allPass ? "✅ PASS" : "❌ FAIL"}`,
  );
  console.log(
    `  First run latency / cost: ${run1.latencyMs}ms / $${run1.costUsd.toFixed(5)}.`,
  );
  console.log(
    `  Second run latency / cost: ${run2.latencyMs}ms / $${run2.costUsd.toFixed(5)}.`,
  );

  if (!allPass) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("smoke failed", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

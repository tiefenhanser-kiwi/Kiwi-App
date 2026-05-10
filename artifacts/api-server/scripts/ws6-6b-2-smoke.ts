// Live smoke for WS6 6b-2 — Simple Dish macros AI helper.
//
// Helper-only sub-phase: there is no HTTP route yet. The smoke imports
// estimateDishMacros() directly, loads two dev meals' DishIngredients from
// Postgres (seeded by prisma:seed:dev), invokes the helper against a real
// Anthropic API call (Haiku, text+Zod), and verifies the result shape +
// LLMCallLog write + sanity bounds.
//
// Run:   pnpm --filter @workspace/api-server exec tsx scripts/ws6-6b-2-smoke.ts
//
// Prereq: prisma:seed (for AIPrompts) AND prisma:seed:dev (for dev meals)
// must have been run. ANTHROPIC_API_KEY must be set.

import { PrismaClient } from "@prisma/client";

import { estimateDishMacros } from "../src/lib/dishMacros.ts";

const prisma = new PrismaClient();
const SMOKE_USER_ID = "smoke-ws6-6b-2-user";
const SMOKE_USER_EMAIL = "smoke+ws6-6b-2@kiwi.dev";

// Dev meals seeded by prisma/seeds/devData.ts. Two cuisines so we
// confirm the helper generalizes.
const TARGET_DISHES: Array<{ dishId: string; expectedServings: number }> = [
  { dishId: "dev-dish-beef-tacos", expectedServings: 4 },
  { dishId: "dev-dish-spaghetti-carbonara", expectedServings: 4 },
];

interface CaseReport {
  dishId: string;
  dishTitle: string;
  ingredientCount: number;
  status: "success" | "failed";
  error?: string;
  perServing?: {
    calories: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
  };
  confidence?: string;
  caveats?: string[];
  sanityPass: boolean;
  llmLogPass: boolean;
  latencyMs?: number;
  costUsd?: number | null;
}

async function ensureSmokeUser(): Promise<void> {
  await prisma.user.upsert({
    where: { id: SMOKE_USER_ID },
    update: {},
    create: {
      id: SMOKE_USER_ID,
      email: SMOKE_USER_EMAIL,
      firstName: "Smoke",
      lastName: "DishMacros",
      defaultHouseholdSize: 2,
    },
  });
}

async function runCase(dishId: string): Promise<CaseReport> {
  const dish = await prisma.dish.findUnique({
    where: { id: dishId },
    include: {
      dishIngredients: {
        include: { ingredient: true },
        orderBy: { positionIndex: "asc" },
      },
    },
  });
  if (!dish) {
    return {
      dishId,
      dishTitle: "(missing)",
      ingredientCount: 0,
      status: "failed",
      error: `dish ${dishId} not found — run pnpm prisma:seed:dev`,
      sanityPass: false,
      llmLogPass: false,
    };
  }

  const ingredients = dish.dishIngredients.map((di) => ({
    name: di.ingredient.displayName,
    quantity: di.quantity,
    unit: di.unit,
    isOptional: di.isOptional,
  }));

  console.log(`  dish: "${dish.title}" (${ingredients.length} ingredients)`);
  console.log(`  servings: ${dish.servingsDefault}`);
  for (const ing of ingredients) {
    const tag = ing.isOptional ? " [optional]" : "";
    console.log(`    - ${ing.quantity} ${ing.unit} ${ing.name}${tag}`);
  }

  const beforeLogs = await prisma.lLMCallLog.count({
    where: {
      userId: SMOKE_USER_ID,
      promptKey: "nutrition.ingredient_estimate",
    },
  });

  const startedAt = Date.now();
  const result = await estimateDishMacros({
    prisma,
    userId: SMOKE_USER_ID,
    dishTitle: dish.title,
    servings: dish.servingsDefault,
    ingredients,
  });
  const elapsedMs = Date.now() - startedAt;

  if (result.status === "failed") {
    return {
      dishId,
      dishTitle: dish.title,
      ingredientCount: ingredients.length,
      status: "failed",
      error: result.error,
      sanityPass: false,
      llmLogPass: false,
      latencyMs: elapsedMs,
    };
  }

  console.log(
    `  → calories=${result.perServing.calories}  proteinG=${result.perServing.proteinG}  carbsG=${result.perServing.carbsG}  fatG=${result.perServing.fatG}  confidence=${result.confidence ?? "?"}`,
  );
  if (result.caveats && result.caveats.length > 0) {
    console.log(`  caveats:`);
    for (const c of result.caveats) console.log(`    - ${c}`);
  }
  console.log(`  latency: ${elapsedMs}ms`);

  const cal = result.perServing.calories;
  const sanityPass =
    cal >= 100 &&
    cal <= 2000 &&
    Number.isInteger(cal) &&
    result.perServing.proteinG > 0 &&
    result.perServing.carbsG > 0 &&
    result.perServing.fatG > 0 &&
    !!result.confidence;

  const afterLogs = await prisma.lLMCallLog.count({
    where: {
      userId: SMOKE_USER_ID,
      promptKey: "nutrition.ingredient_estimate",
    },
  });
  const newLogs = afterLogs - beforeLogs;
  const llmLogPass = newLogs === 1;

  const latestLog = await prisma.lLMCallLog.findFirst({
    where: {
      userId: SMOKE_USER_ID,
      promptKey: "nutrition.ingredient_estimate",
    },
    orderBy: { createdAt: "desc" },
    select: { costEstimateUsd: true },
  });

  console.log(
    `  cost: $${latestLog?.costEstimateUsd?.toFixed(5) ?? "?"}  LLMCallLog rows added: ${newLogs} ${llmLogPass ? "✓" : "✗"}  sanity: ${sanityPass ? "✓" : "✗"}`,
  );

  return {
    dishId,
    dishTitle: dish.title,
    ingredientCount: ingredients.length,
    status: "success",
    perServing: result.perServing,
    confidence: result.confidence,
    caveats: result.caveats,
    sanityPass,
    llmLogPass,
    latencyMs: elapsedMs,
    costUsd: latestLog?.costEstimateUsd ?? null,
  };
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY not set. Smoke aborts (this would fall through to the no_api_key error path).",
    );
    process.exitCode = 1;
    return;
  }

  await ensureSmokeUser();

  console.log("══════════════════════════════════════════════════════════");
  console.log("WS6 6b-2 smoke — estimateDishMacros() against dev meals");
  console.log("══════════════════════════════════════════════════════════");

  const reports: CaseReport[] = [];
  for (let i = 0; i < TARGET_DISHES.length; i++) {
    const target = TARGET_DISHES[i];
    console.log(
      `\n── Case ${i + 1}/${TARGET_DISHES.length}: ${target.dishId} ──`,
    );
    const report = await runCase(target.dishId);
    reports.push(report);
  }

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("SUMMARY");
  console.log("══════════════════════════════════════════════════════════");
  const allPass = reports.every(
    (r) => r.status === "success" && r.sanityPass && r.llmLogPass,
  );
  for (const r of reports) {
    const flags = [
      r.status === "success" ? "✓ status" : `✗ status=${r.status}`,
      r.sanityPass ? "✓ sanity" : "✗ sanity",
      r.llmLogPass ? "✓ log" : "✗ log",
    ];
    console.log(
      `  [${r.dishId}] ${flags.join(" ")} cal=${r.perServing?.calories ?? "?"} latency=${r.latencyMs ?? "?"}ms cost=$${r.costUsd?.toFixed(5) ?? "?"}`,
    );
    if (r.error) console.log(`    error: ${r.error}`);
  }
  console.log(`\n  Overall: ${allPass ? "✅ PASS" : "❌ FAIL"}`);

  if (!allPass) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("smoke failed", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

// Live smoke for WS6 6b-5 — Meal Builder Mode A (parse free-text meal).
//
// Helper-direct (no HTTP). Imports parseMealFromText, invokes it against a
// real Anthropic API call (Haiku, text+Zod), and verifies result shape +
// sanity bounds across three input shapes: simple single-dish, composite
// multi-dish, and a vegetarian-hint scenario.
//
// Run:   pnpm --filter @workspace/api-server exec tsx scripts/ws6-6b-5-smoke.ts
//
// Prereq: prisma:seed (so meal_builder.mode_a_parse v2+ active body is in
// the DB). ANTHROPIC_API_KEY must be set.

import { PrismaClient } from "@prisma/client";

import { parseMealFromText } from "../src/lib/mealBuilder.ts";

const prisma = new PrismaClient();
const SMOKE_USER_ID = "smoke-ws6-6b-5-user";
const SMOKE_USER_EMAIL = "smoke+ws6-6b-5@kiwi.dev";

// Sanity bound — flag if total spend across all three calls exceeds this.
const COST_CEILING_USD = 0.1;

interface ParseCase {
  label: string;
  freeText: string;
  servings: number;
  userHints?: {
    dietary?: string[];
    allergens?: string[];
    cuisinesLiked?: string[];
  };
  expectedSubDishCount: number;
  // Loose cuisine expectation (case-insensitive). Pass a string for a single
  // allowed value, an array for a set of allowed values (any match passes),
  // or null for "must be null". Omit for "no expectation".
  expectedCuisine?: string | string[] | null;
  // Loose ingredient hints — pass if ANY of these names appears
  // (case-insensitive substring) across all sub-dishes' ingredients.
  expectedIngredientsAnyOf?: string[];
  // Ingredients that MUST NOT appear (for dietary checks). Substring match,
  // case-insensitive.
  forbiddenIngredients?: string[];
  // Expected role distribution. Pass if EVERY listed role appears at least once.
  expectedRoles?: Array<"main" | "side" | "sauce" | "topping" | "base">;
  // Optional positionIndex check — exact sequence expected (e.g. [0, 1, 2]).
  expectedPositionIndexes?: number[];
}

const CASES: ParseCase[] = [
  {
    label: "Simple single-dish (slow-cooker beef stew)",
    freeText: "Slow-cooker beef stew with carrots and potatoes",
    servings: 4,
    expectedSubDishCount: 1,
    expectedCuisine: ["American", "Comfort Food"],
    expectedIngredientsAnyOf: ["beef", "carrot", "potato", "broth"],
    expectedRoles: ["main"],
    expectedPositionIndexes: [0],
  },
  {
    label:
      "Composite multi-dish (chicken piccata + arugula salad + lemon vinaigrette)",
    freeText:
      "Chicken piccata with a side arugula salad and lemon vinaigrette",
    servings: 4,
    expectedSubDishCount: 3,
    expectedCuisine: "italian",
    expectedIngredientsAnyOf: [
      "chicken",
      "lemon",
      "capers",
      "arugula",
      "olive oil",
    ],
    expectedRoles: ["main", "side", "sauce"],
    expectedPositionIndexes: [0, 1, 2],
  },
  {
    label: "Vegetarian hint (hearty pasta dinner + salad)",
    freeText: "Hearty pasta dinner with a salad",
    servings: 4,
    userHints: { dietary: ["vegetarian"] },
    expectedSubDishCount: 2,
    expectedCuisine: "italian",
    expectedIngredientsAnyOf: ["pasta", "olive oil"],
    forbiddenIngredients: [
      "chicken",
      "beef",
      "pork",
      "bacon",
      "pancetta",
      "guanciale",
      "sausage",
      "shrimp",
      "salmon",
      "tuna",
      "fish",
      "anchovy",
      "lamb",
    ],
    expectedRoles: ["main", "side"],
  },
];

interface CaseReport {
  label: string;
  status: "success" | "failed";
  error?: string;
  subDishCount?: number;
  subDishTitles?: string[];
  roles?: string[];
  positionIndexes?: number[];
  cuisine?: string | null;
  difficulty?: string;
  totalSteps?: number;
  totalEstMinutes?: number;
  parallelGroupSteps?: number;
  timingSensitiveSteps?: number;
  ingredientsAnyOfHit?: boolean;
  forbiddenHit?: string[];
  rolesPresent?: boolean;
  positionIndexesMatch?: boolean;
  cuisineMatch?: boolean;
  caveats?: string[];
  latencyMs: number;
  costUsd?: number | null;
  sanityPass: boolean;
}

async function ensureSmokeUser(): Promise<void> {
  await prisma.user.upsert({
    where: { id: SMOKE_USER_ID },
    update: {},
    create: {
      id: SMOKE_USER_ID,
      email: SMOKE_USER_EMAIL,
      firstName: "Smoke",
      lastName: "ModeA",
      defaultHouseholdSize: 2,
    },
  });
}

async function latestCost(): Promise<number | null> {
  const row = await prisma.lLMCallLog.findFirst({
    where: { userId: SMOKE_USER_ID, promptKey: "meal_builder.mode_a_parse" },
    orderBy: { createdAt: "desc" },
    select: { costEstimateUsd: true },
  });
  if (row?.costEstimateUsd == null) return null;
  return Number(row.costEstimateUsd);
}

function lower(s: string): string {
  return s.toLowerCase();
}

async function runCase(c: ParseCase): Promise<CaseReport> {
  console.log(`\n── ${c.label} ──`);
  console.log(`  freeText: "${c.freeText}"`);
  if (c.userHints) {
    console.log(`  userHints: ${JSON.stringify(c.userHints)}`);
  }

  const startedAt = Date.now();
  const result = await parseMealFromText({
    prisma,
    userId: SMOKE_USER_ID,
    freeText: c.freeText,
    servings: c.servings,
    userHints: c.userHints,
  });
  const elapsedMs = Date.now() - startedAt;

  if (result.status === "failed") {
    return {
      label: c.label,
      status: "failed",
      error: result.error,
      latencyMs: elapsedMs,
      sanityPass: false,
    };
  }

  const meal = result.meal;

  // Pretty-print the meal.
  console.log(`  meal: "${meal.title}"`);
  console.log(
    `    cuisine=${meal.cuisine ?? "(null)"} difficulty=${meal.difficulty} servings=${meal.servingsDefault} time=${meal.estimatedPrepMinutes + meal.estimatedCookMinutes}m (prep=${meal.estimatedPrepMinutes} cook=${meal.estimatedCookMinutes})`,
  );
  console.log(`    tags=[${meal.tags.join(", ")}]`);
  for (const sd of meal.subDishes) {
    console.log(
      `    [${sd.positionIndex}] ${sd.role.padEnd(8)} ${sd.title} — ${sd.ingredients.length} ingredients, ${sd.steps.length} steps`,
    );
    for (const ing of sd.ingredients) {
      const opt = ing.isOptional ? " (opt)" : "";
      console.log(`         ${ing.quantity} ${ing.unit} ${ing.name}${opt}`);
    }
    for (let i = 0; i < sd.steps.length; i++) {
      const st = sd.steps[i];
      const flags = [
        st.phaseType.padEnd(8),
        st.isTimingSensitive ? "⏱" : " ",
        st.parallelGroup != null ? `‖${st.parallelGroup}` : "  ",
        `${st.estimatedMinutes}m`,
      ].join(" ");
      console.log(`         ${String(i + 1).padStart(2)}. [${flags}] ${st.content}`);
    }
  }
  if (result.caveats && result.caveats.length > 0) {
    console.log(`    caveats:`);
    for (const cv of result.caveats) console.log(`      - ${cv}`);
  }

  // ── sanity checks ──
  const allIngredientNames = meal.subDishes
    .flatMap((sd) => sd.ingredients.map((i) => lower(i.name)));

  const ingredientsAnyOfHit =
    !c.expectedIngredientsAnyOf ||
    c.expectedIngredientsAnyOf.some((hint) =>
      allIngredientNames.some((n) => n.includes(lower(hint))),
    );

  const forbiddenHit = (c.forbiddenIngredients ?? []).filter((bad) =>
    allIngredientNames.some((n) => n.includes(lower(bad))),
  );

  const rolesFound = new Set(meal.subDishes.map((sd) => sd.role));
  const rolesPresent =
    !c.expectedRoles ||
    c.expectedRoles.every((r) => rolesFound.has(r));

  const positionIndexes = meal.subDishes.map((sd) => sd.positionIndex);
  const positionIndexesMatch =
    !c.expectedPositionIndexes ||
    JSON.stringify(positionIndexes) ===
      JSON.stringify(c.expectedPositionIndexes);

  const expectedCuisine = c.expectedCuisine;
  const cuisineMatch =
    expectedCuisine === undefined ||
    (expectedCuisine === null && meal.cuisine === null) ||
    (typeof expectedCuisine === "string" &&
      meal.cuisine?.toLowerCase() === expectedCuisine.toLowerCase()) ||
    (Array.isArray(expectedCuisine) &&
      meal.cuisine != null &&
      expectedCuisine.some(
        (v) => v.toLowerCase() === meal.cuisine!.toLowerCase(),
      ));

  const totalSteps = meal.subDishes.reduce(
    (acc, sd) => acc + sd.steps.length,
    0,
  );
  const totalEstMinutes = meal.subDishes.reduce(
    (acc, sd) =>
      acc + sd.steps.reduce((sa, s) => sa + s.estimatedMinutes, 0),
    0,
  );
  const parallelGroupSteps = meal.subDishes.reduce(
    (acc, sd) => acc + sd.steps.filter((s) => s.parallelGroup != null).length,
    0,
  );
  const timingSensitiveSteps = meal.subDishes.reduce(
    (acc, sd) => acc + sd.steps.filter((s) => s.isTimingSensitive).length,
    0,
  );

  const sanityPass =
    meal.subDishes.length === c.expectedSubDishCount &&
    ingredientsAnyOfHit &&
    forbiddenHit.length === 0 &&
    rolesPresent &&
    positionIndexesMatch &&
    cuisineMatch;

  const costUsd = await latestCost();
  console.log(
    `  → subDishes=${meal.subDishes.length}/${c.expectedSubDishCount} ingredHint=${ingredientsAnyOfHit ? "✓" : "✗"} forbidden=${forbiddenHit.length === 0 ? "✓" : `✗ (${forbiddenHit.join(",")})`} roles=${rolesPresent ? "✓" : "✗"} positions=${positionIndexesMatch ? "✓" : "✗"} cuisine=${cuisineMatch ? "✓" : "✗"}`,
  );
  console.log(`  latency: ${elapsedMs}ms  cost: $${costUsd?.toFixed(5) ?? "?"}`);

  return {
    label: c.label,
    status: "success",
    subDishCount: meal.subDishes.length,
    subDishTitles: meal.subDishes.map((sd) => sd.title),
    roles: meal.subDishes.map((sd) => sd.role),
    positionIndexes,
    cuisine: meal.cuisine,
    difficulty: meal.difficulty,
    totalSteps,
    totalEstMinutes,
    parallelGroupSteps,
    timingSensitiveSteps,
    ingredientsAnyOfHit,
    forbiddenHit,
    rolesPresent,
    positionIndexesMatch,
    cuisineMatch,
    caveats: result.caveats,
    latencyMs: elapsedMs,
    costUsd,
    sanityPass,
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
  console.log("WS6 6b-5 smoke — Meal Builder Mode A (parseMealFromText)");
  console.log("══════════════════════════════════════════════════════════");

  const reports: CaseReport[] = [];
  for (const c of CASES) {
    reports.push(await runCase(c));
  }

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("SUMMARY");
  console.log("══════════════════════════════════════════════════════════");

  let totalLatency = 0;
  let totalCost = 0;

  for (const r of reports) {
    const flags = [
      r.status === "success" ? "✓ status" : `✗ status=${r.status}`,
      r.sanityPass ? "✓ sanity" : "✗ sanity",
      r.cuisineMatch === undefined
        ? "  (no cuisine expect)"
        : r.cuisineMatch
          ? "✓ cuisine"
          : "✗ cuisine",
    ];
    console.log(
      `\n  [${r.label}]\n    ${flags.join(" ")}`,
    );
    if (r.status === "success") {
      console.log(
        `    subDishes=${r.subDishCount} roles=[${(r.roles ?? []).join(",")}] positions=[${(r.positionIndexes ?? []).join(",")}]`,
      );
      console.log(
        `    cuisine=${r.cuisine ?? "(null)"} difficulty=${r.difficulty} totalSteps=${r.totalSteps} totalEst=${r.totalEstMinutes}m parallel=${r.parallelGroupSteps} timingSensitive=${r.timingSensitiveSteps}`,
      );
      if (r.forbiddenHit && r.forbiddenHit.length > 0) {
        console.log(`    ✗ forbidden ingredients present: ${r.forbiddenHit.join(", ")}`);
      }
    }
    console.log(
      `    latency=${r.latencyMs}ms cost=$${r.costUsd?.toFixed(5) ?? "?"}`,
    );
    if (r.error) console.log(`    error: ${r.error}`);
    totalLatency += r.latencyMs;
    if (r.costUsd != null) totalCost += r.costUsd;
  }

  const costUnderCeiling = totalCost < COST_CEILING_USD;
  const allSanityPass = reports.every(
    (r) => r.status === "success" && r.sanityPass,
  );
  const allPass = allSanityPass && costUnderCeiling;

  console.log(
    `\nTotal: ${reports.length} AI calls, ${totalLatency}ms, $${totalCost.toFixed(5)} (ceiling $${COST_CEILING_USD.toFixed(2)})`,
  );
  console.log(
    `Sanity: ${allSanityPass ? "✅" : "❌"}  Cost: ${costUnderCeiling ? "✅" : "❌"}`,
  );
  console.log(`Overall: ${allPass ? "✅ PASS" : "❌ FAIL"}`);

  if (!allPass) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("smoke failed", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

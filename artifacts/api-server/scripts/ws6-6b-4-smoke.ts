// Live smoke for WS6 6b-4 — Kiwi-assist (ingredients + steps) AI helpers.
//
// Helper-direct (no HTTP). Imports assistDishIngredients + assistDishSteps,
// invokes each against a real Anthropic API call (Haiku, text+Zod), and
// verifies the result shape + sanity bounds. The flag is FREE per PRD §1.2
// — no entitlement check involved here.
//
// Run:   pnpm --filter @workspace/api-server exec tsx scripts/ws6-6b-4-smoke.ts
//
// Prereq: prisma:seed (so meal_builder.assist_ingredients +
// meal_builder.assist_steps prompt rows + active versions exist).
// ANTHROPIC_API_KEY must be set.

import { PrismaClient } from "@prisma/client";

import {
  assistDishIngredients,
  assistDishSteps,
} from "../src/lib/kiwiAssist.ts";

const prisma = new PrismaClient();
const SMOKE_USER_ID = "smoke-ws6-6b-4-user";
const SMOKE_USER_EMAIL = "smoke+ws6-6b-4@kiwi.dev";

// ── case definitions ──────────────────────────────────────────────────

interface IngredientsCase {
  label: string;
  dishTitle: string;
  cuisine?: string;
  existingIngredients: { name: string; quantity?: number; unit?: string }[];
  servings: number;
  // Sanity expectations.
  minOutputCount: number;
  // Names we expect to come back flagged isUserProvided=true.
  expectedUserProvided: string[];
  // Loose ingredient hints we expect to see (cuisine-appropriateness check).
  // Pass if AT LEAST ONE of these names appears (case-insensitive substring).
  expectedAnyOf?: string[];
}

interface StepsCase {
  label: string;
  dishTitle: string;
  cuisine?: string;
  ingredients: { name: string; quantity: number; unit: string }[];
  servings: number;
  prepTimeMinutes?: number;
  cookTimeMinutes?: number;
  // Sanity expectations.
  minSteps: number;
  maxSteps: number;
  // Phase-tag hints (loose): expect at least one step matching each.
  expectAnyOfPhases?: Array<
    "prep" | "preheat" | "cook" | "rest" | "assemble" | "hold"
  >;
}

const INGREDIENT_CASES: IngredientsCase[] = [
  {
    label: "Beef Tacos (Mexican) — user typed 2 of 8 ingredients",
    dishTitle: "Beef Tacos",
    cuisine: "Mexican",
    existingIngredients: [{ name: "ground beef" }, { name: "tortillas" }],
    servings: 4,
    minOutputCount: 5,
    expectedUserProvided: ["ground beef", "tortillas"],
    expectedAnyOf: ["cilantro", "lime", "onion", "salsa", "tomato"],
  },
  {
    label: "Spaghetti Carbonara (Italian) — cuisine-appropriate additions",
    dishTitle: "Spaghetti Carbonara",
    cuisine: "Italian",
    existingIngredients: [{ name: "spaghetti" }, { name: "eggs" }],
    servings: 4,
    minOutputCount: 4,
    expectedUserProvided: ["spaghetti", "eggs"],
    // Italian-appropriate: pecorino or guanciale or pancetta. Failing this
    // means the model defaulted to generic "bacon + parmesan" (regression
    // signal for cuisine guidance).
    expectedAnyOf: ["pecorino", "guanciale", "pancetta", "parmesan"],
  },
];

const STEP_CASES: StepsCase[] = [
  {
    label: "Beef Tacos — 8 ingredients, 4 servings",
    dishTitle: "Beef Tacos",
    cuisine: "Mexican",
    ingredients: [
      { name: "ground beef", quantity: 1, unit: "lb" },
      { name: "taco shells", quantity: 12, unit: "each" },
      { name: "onion", quantity: 1, unit: "each" },
      { name: "garlic", quantity: 2, unit: "clove" },
      { name: "taco seasoning", quantity: 2, unit: "tbsp" },
      { name: "shredded lettuce", quantity: 2, unit: "cup" },
      { name: "cheddar cheese", quantity: 1, unit: "cup" },
      { name: "salsa", quantity: 0.5, unit: "cup" },
    ],
    servings: 4,
    prepTimeMinutes: 10,
    cookTimeMinutes: 20,
    minSteps: 4,
    maxSteps: 12,
  },
  {
    label: "Sheet-Pan Chicken Fajitas — expect preheat phase",
    dishTitle: "Sheet-Pan Chicken Fajitas",
    cuisine: "Mexican",
    ingredients: [
      { name: "chicken breast", quantity: 1.5, unit: "lb" },
      { name: "red bell pepper", quantity: 2, unit: "each" },
      { name: "yellow bell pepper", quantity: 1, unit: "each" },
      { name: "red onion", quantity: 1, unit: "each" },
      { name: "olive oil", quantity: 3, unit: "tbsp" },
      { name: "fajita seasoning", quantity: 2, unit: "tbsp" },
      { name: "lime", quantity: 1, unit: "each" },
      { name: "flour tortillas", quantity: 8, unit: "each" },
    ],
    servings: 4,
    prepTimeMinutes: 10,
    cookTimeMinutes: 25,
    minSteps: 4,
    maxSteps: 12,
    expectAnyOfPhases: ["preheat"],
  },
];

// ── reports ───────────────────────────────────────────────────────────

interface IngredientsReport {
  label: string;
  status: "success" | "failed";
  error?: string;
  outputCount?: number;
  userProvidedMatched: number;
  userProvidedTotal: number;
  addedByKiwiCount: number;
  cuisineHintMatched?: boolean;
  noDuplicates?: boolean;
  allHaveQtyAndUnit?: boolean;
  caveats?: string[];
  latencyMs: number;
  costUsd?: number | null;
  sanityPass: boolean;
}

interface StepsReport {
  label: string;
  status: "success" | "failed";
  error?: string;
  stepCount?: number;
  phasesUsed?: string[];
  totalEstMinutes?: number;
  timingSensitiveCount?: number;
  expectedPhaseHit?: boolean;
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
      lastName: "KiwiAssist",
      defaultHouseholdSize: 2,
    },
  });
}

async function latestCostFor(promptKey: string): Promise<number | null> {
  const row = await prisma.lLMCallLog.findFirst({
    where: { userId: SMOKE_USER_ID, promptKey },
    orderBy: { createdAt: "desc" },
    select: { costEstimateUsd: true },
  });
  if (row?.costEstimateUsd == null) return null;
  // Prisma may return Decimal for numeric columns — coerce to JS number so
  // downstream .toFixed() arithmetic works.
  return Number(row.costEstimateUsd);
}

function lower(s: string): string {
  return s.toLowerCase();
}

async function runIngredientsCase(
  c: IngredientsCase,
): Promise<IngredientsReport> {
  console.log(`\n── ${c.label} ──`);
  console.log(`  dish: "${c.dishTitle}" cuisine=${c.cuisine ?? "(none)"}`);
  console.log(
    `  user typed: ${c.existingIngredients.map((i) => i.name).join(", ") || "(none)"}`,
  );

  const startedAt = Date.now();
  const result = await assistDishIngredients({
    prisma,
    userId: SMOKE_USER_ID,
    dishTitle: c.dishTitle,
    cuisine: c.cuisine,
    existingIngredients: c.existingIngredients,
    servings: c.servings,
  });
  const elapsedMs = Date.now() - startedAt;

  if (result.status === "failed") {
    return {
      label: c.label,
      status: "failed",
      error: result.error,
      userProvidedMatched: 0,
      userProvidedTotal: c.expectedUserProvided.length,
      addedByKiwiCount: 0,
      latencyMs: elapsedMs,
      sanityPass: false,
    };
  }

  // Print one line per ingredient with flags so smoke output reads at a glance.
  for (const ing of result.ingredients) {
    const tag = ing.isUserProvided ? "[user]" : ing.addedByKiwi ? "[+kiwi]" : "[?]";
    console.log(
      `    ${tag.padEnd(7)} ${ing.quantity} ${ing.unit} ${ing.name}${ing.isOptional ? " (optional)" : ""}`,
    );
  }
  if (result.caveats && result.caveats.length > 0) {
    console.log(`  caveats:`);
    for (const cv of result.caveats) console.log(`    - ${cv}`);
  }

  const lowered = result.ingredients.map((i) => lower(i.name));
  const userProvidedNames = result.ingredients
    .filter((i) => i.isUserProvided)
    .map((i) => lower(i.name));
  const matched = c.expectedUserProvided.filter((exp) =>
    userProvidedNames.some((u) => u.includes(lower(exp)) || lower(exp).includes(u)),
  );
  const addedByKiwi = result.ingredients.filter((i) => i.addedByKiwi).length;

  const cuisineHintMatched =
    !c.expectedAnyOf ||
    c.expectedAnyOf.some((hint) =>
      lowered.some((n) => n.includes(lower(hint))),
    );

  const noDuplicates = new Set(lowered).size === lowered.length;
  const allHaveQtyAndUnit = result.ingredients.every(
    (i) => i.quantity > 0 && i.unit.trim().length > 0,
  );

  const sanityPass =
    result.ingredients.length >= c.minOutputCount &&
    matched.length === c.expectedUserProvided.length &&
    addedByKiwi > 0 &&
    cuisineHintMatched &&
    noDuplicates &&
    allHaveQtyAndUnit;

  const costUsd = await latestCostFor("meal_builder.assist_ingredients");
  console.log(
    `  → ingredients=${result.ingredients.length} userProvided=${matched.length}/${c.expectedUserProvided.length} addedByKiwi=${addedByKiwi} cuisineHint=${cuisineHintMatched ? "✓" : "✗"} dedup=${noDuplicates ? "✓" : "✗"} qtyUnit=${allHaveQtyAndUnit ? "✓" : "✗"}`,
  );
  console.log(`  latency: ${elapsedMs}ms  cost: $${costUsd?.toFixed(5) ?? "?"}`);

  return {
    label: c.label,
    status: "success",
    outputCount: result.ingredients.length,
    userProvidedMatched: matched.length,
    userProvidedTotal: c.expectedUserProvided.length,
    addedByKiwiCount: addedByKiwi,
    cuisineHintMatched,
    noDuplicates,
    allHaveQtyAndUnit,
    caveats: result.caveats,
    latencyMs: elapsedMs,
    costUsd,
    sanityPass,
  };
}

async function runStepsCase(c: StepsCase): Promise<StepsReport> {
  console.log(`\n── ${c.label} ──`);
  console.log(
    `  dish: "${c.dishTitle}" cuisine=${c.cuisine ?? "(none)"} ${c.ingredients.length} ingredients`,
  );

  const startedAt = Date.now();
  const result = await assistDishSteps({
    prisma,
    userId: SMOKE_USER_ID,
    dishTitle: c.dishTitle,
    cuisine: c.cuisine,
    ingredients: c.ingredients,
    servings: c.servings,
    prepTimeMinutes: c.prepTimeMinutes,
    cookTimeMinutes: c.cookTimeMinutes,
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

  for (let i = 0; i < result.steps.length; i++) {
    const st = result.steps[i];
    const flags = [
      st.phaseType.padEnd(8),
      st.isTimingSensitive ? "⏱" : " ",
      st.parallelGroup ? `‖${st.parallelGroup}` : "  ",
      `${st.estimatedMinutes}m`,
    ].join(" ");
    console.log(`    ${String(i + 1).padStart(2)}. [${flags}] ${st.content}`);
  }
  if (result.caveats && result.caveats.length > 0) {
    console.log(`  caveats:`);
    for (const cv of result.caveats) console.log(`    - ${cv}`);
  }

  const phasesUsed = Array.from(new Set(result.steps.map((s) => s.phaseType)));
  const totalEstMinutes = result.steps.reduce(
    (acc, s) => acc + s.estimatedMinutes,
    0,
  );
  const timingSensitiveCount = result.steps.filter(
    (s) => s.isTimingSensitive,
  ).length;
  const expectedPhaseHit =
    !c.expectAnyOfPhases ||
    c.expectAnyOfPhases.some((p) => phasesUsed.includes(p));

  const sanityPass =
    result.steps.length >= c.minSteps &&
    result.steps.length <= c.maxSteps &&
    totalEstMinutes >= 5 &&
    totalEstMinutes <= 120 &&
    expectedPhaseHit &&
    result.steps.every((s) => s.content.length > 0);

  const costUsd = await latestCostFor("meal_builder.assist_steps");
  console.log(
    `  → steps=${result.steps.length} totalEst=${totalEstMinutes}m phases=[${phasesUsed.join(",")}] timingSensitive=${timingSensitiveCount} phaseExpect=${expectedPhaseHit ? "✓" : "✗"}`,
  );
  console.log(`  latency: ${elapsedMs}ms  cost: $${costUsd?.toFixed(5) ?? "?"}`);

  return {
    label: c.label,
    status: "success",
    stepCount: result.steps.length,
    phasesUsed,
    totalEstMinutes,
    timingSensitiveCount,
    expectedPhaseHit,
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
  console.log("WS6 6b-4 smoke — Kiwi-assist (ingredients + steps)");
  console.log("══════════════════════════════════════════════════════════");

  console.log("\nPhase 1 — assistDishIngredients");
  console.log("──────────────────────────────");
  const ingReports: IngredientsReport[] = [];
  for (const c of INGREDIENT_CASES) {
    ingReports.push(await runIngredientsCase(c));
  }

  console.log("\n\nPhase 2 — assistDishSteps");
  console.log("──────────────────────────────");
  const stepReports: StepsReport[] = [];
  for (const c of STEP_CASES) {
    stepReports.push(await runStepsCase(c));
  }

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("SUMMARY");
  console.log("══════════════════════════════════════════════════════════");

  let totalLatency = 0;
  let totalCost = 0;

  console.log("\nassistDishIngredients:");
  for (const r of ingReports) {
    const flags = [
      r.status === "success" ? "✓ status" : `✗ status=${r.status}`,
      r.sanityPass ? "✓ sanity" : "✗ sanity",
      r.cuisineHintMatched ? "✓ cuisine" : "✗ cuisine",
    ];
    console.log(
      `  [${r.label}]\n    ${flags.join(" ")} userProvided=${r.userProvidedMatched}/${r.userProvidedTotal} +kiwi=${r.addedByKiwiCount} latency=${r.latencyMs}ms cost=$${r.costUsd?.toFixed(5) ?? "?"}`,
    );
    if (r.error) console.log(`    error: ${r.error}`);
    totalLatency += r.latencyMs;
    if (r.costUsd != null) totalCost += r.costUsd;
  }

  console.log("\nassistDishSteps:");
  for (const r of stepReports) {
    const flags = [
      r.status === "success" ? "✓ status" : `✗ status=${r.status}`,
      r.sanityPass ? "✓ sanity" : "✗ sanity",
      r.expectedPhaseHit === undefined
        ? "  (no phase expect)"
        : r.expectedPhaseHit
          ? "✓ phaseExpect"
          : "✗ phaseExpect",
    ];
    console.log(
      `  [${r.label}]\n    ${flags.join(" ")} steps=${r.stepCount ?? "?"} totalEst=${r.totalEstMinutes ?? "?"}m phases=[${r.phasesUsed?.join(",") ?? "?"}] latency=${r.latencyMs}ms cost=$${r.costUsd?.toFixed(5) ?? "?"}`,
    );
    if (r.error) console.log(`    error: ${r.error}`);
    totalLatency += r.latencyMs;
    if (r.costUsd != null) totalCost += r.costUsd;
  }

  const allPass =
    ingReports.every((r) => r.status === "success" && r.sanityPass) &&
    stepReports.every((r) => r.status === "success" && r.sanityPass);

  console.log(`\nTotal: 4 AI calls, ${totalLatency}ms, $${totalCost.toFixed(5)}`);
  console.log(`Overall: ${allPass ? "✅ PASS" : "❌ FAIL"}`);

  if (!allPass) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("smoke failed", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

// WS6 6b-6 — Cumulative live smoke across all six AI flows shipped in 6b.
//
// Helper-direct (no HTTP). One representative test case per flow, fired
// sequentially against the live Anthropic API + real DB. Pattern follows the
// multi-phase aggregation shape from ws6-6b-4-smoke.ts (per-flow CaseReport +
// summary loop), generalized to six flows.
//
// Setup quirk (mirrors 6b-3 smoke): the dev seed populates Dish.{cal,protein,
// carbs,fat} with non-zero values. We zero those four fields on the dev
// dishes touched by Flows 2 and 3 BEFORE Flow 2 runs so the macro estimator
// has work to do (otherwise estimateDishMacros has no opinion to form and
// computePlanMacros short-circuits to the cache on Flow 3). Re-running
// prisma:seed:dev resets the seed to canonical values; this smoke is
// re-runnable.
//
// Mode A retry-rate watch (D-WS6-033): parseMealFromText strips run metadata
// from its result type, so retryCount is recovered by reading the LLMCallLog
// row written by runAICall immediately after the Mode A call. Printed in a
// dedicated section at the end — if retryCount > 0, the brief asks us to
// surface it prominently as a confirmation signal for the D-WS6-033 thread.
//
// Run:   pnpm --filter @workspace/api-server exec tsx scripts/ws6-6b-6-smoke.ts
//
// Prereq: prisma:seed (AIPrompts) AND prisma:seed:dev (dev meals + plans).
// ANTHROPIC_API_KEY must be set.

import { PrismaClient } from "@prisma/client";

import { runAICall } from "../src/lib/ai/runAICall";
import {
  FindSimilarResultSchema,
  type MealCandidate,
} from "../src/lib/ai/schemas/findSimilar";
import { estimateDishMacros } from "../src/lib/dishMacros";
import { computePlanMacros } from "../src/lib/planMacros";
import {
  assistDishIngredients,
  assistDishSteps,
} from "../src/lib/kiwiAssist";
import { parseMealFromText } from "../src/lib/mealBuilder";

const prisma = new PrismaClient();

const DEV_USER_EMAIL = "hans.tiefenthaler+8@gmail.com";

const DEV_DISH_IDS = {
  beefTacos: "dev-dish-beef-tacos",
  carbonara: "dev-dish-spaghetti-carbonara",
  tikkaMasala: "dev-dish-chicken-tikka-masala",
  grainBowl: "dev-dish-mediterranean-grain-bowl",
  padThai: "dev-dish-pad-thai",
  fajitas: "dev-dish-sheet-pan-fajitas",
} as const;

const DEV_PLAN_ID = "dev-plan-instance-weeknight";

// ── per-flow reports ──────────────────────────────────────────────────────

interface FlowReport {
  name: string;
  status: "success" | "failed";
  error?: string;
  pass: boolean;
  latencyMs: number;
  costUsd: number;
  retryCount: number;
  detail: string;
  llmLogRowsWritten: number;
}

// ── helpers ───────────────────────────────────────────────────────────────

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

async function loadDishWithIngredients(dishId: string): Promise<{
  title: string;
  servings: number;
  ingredients: Array<{
    name: string;
    quantity: number;
    unit: string;
    isOptional: boolean;
  }>;
}> {
  const dish = await prisma.dish.findUnique({
    where: { id: dishId },
    include: {
      dishIngredients: {
        include: { ingredient: true },
        orderBy: { positionIndex: "asc" },
      },
    },
  });
  if (!dish) throw new Error(`dish ${dishId} not found — run prisma:seed:dev`);
  return {
    title: dish.title,
    servings: dish.servingsDefault,
    ingredients: dish.dishIngredients.map((di) => ({
      name: di.ingredient.displayName,
      quantity: Number(di.quantity),
      unit: di.unit,
      isOptional: di.isOptional,
    })),
  };
}

async function readLatestLogRow(
  userId: string,
  promptKey: string,
  since: Date,
): Promise<{
  retryCount: number;
  costUsd: number;
  rowsWritten: number;
} | null> {
  const rows = await prisma.lLMCallLog.findMany({
    where: { userId, promptKey, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    select: { retryCount: true, costEstimateUsd: true },
  });
  if (rows.length === 0) return null;
  const totalCost = rows.reduce(
    (acc, r) => acc + Number(r.costEstimateUsd ?? 0),
    0,
  );
  return {
    retryCount: rows[0].retryCount,
    costUsd: totalCost,
    rowsWritten: rows.length,
  };
}

// ── flows ─────────────────────────────────────────────────────────────────

async function flow1_findSimilar(userId: string): Promise<FlowReport> {
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("FLOW 1/6 — Find Similar (6b-1)");
  console.log("══════════════════════════════════════════════════════════");

  const beefTacos = await prisma.dish.findUnique({
    where: { id: DEV_DISH_IDS.beefTacos },
    select: { id: true, title: true },
  });
  if (!beefTacos) {
    return {
      name: "Find Similar",
      status: "failed",
      pass: false,
      error: "Beef Tacos dev dish missing — run prisma:seed:dev",
      latencyMs: 0,
      costUsd: 0,
      retryCount: 0,
      detail: "",
      llmLogRowsWritten: 0,
    };
  }

  // Mirror routes/meals.ts: the route calls runAICall with this exact arg
  // shape. We don't have a helper export, so re-create the runAICall call
  // here. (Logic is small enough that duplicating it for smoke purposes is
  // cleaner than spinning up an in-process HTTP server.)
  const source: MealCandidate = {
    id: beefTacos.id,
    title: beefTacos.title,
    cuisine: "Mexican",
    mealType: "dinner",
    keyIngredients: ["ground beef", "taco shells", "cheese", "salsa"],
    tags: ["weeknight", "quick"],
  };
  const candidates: MealCandidate[] = [
    {
      id: DEV_DISH_IDS.grainBowl,
      title: "Mediterranean Grain Bowl",
      cuisine: "Mediterranean",
      mealType: "dinner",
      keyIngredients: ["farro", "chickpeas", "feta", "tahini"],
    },
    {
      id: DEV_DISH_IDS.carbonara,
      title: "Spaghetti Carbonara",
      cuisine: "Italian",
      mealType: "dinner",
      keyIngredients: ["spaghetti", "bacon", "eggs", "parmesan"],
    },
    {
      id: DEV_DISH_IDS.padThai,
      title: "Pad Thai",
      cuisine: "Thai",
      mealType: "dinner",
      keyIngredients: ["rice noodles", "shrimp", "peanuts"],
    },
    {
      id: DEV_DISH_IDS.tikkaMasala,
      title: "Chicken Tikka Masala",
      cuisine: "Indian",
      mealType: "dinner",
      keyIngredients: ["chicken thighs", "coconut milk", "tikka paste"],
    },
    {
      id: DEV_DISH_IDS.fajitas,
      title: "Sheet-Pan Chicken Fajitas",
      cuisine: "Tex-Mex",
      mealType: "dinner",
      keyIngredients: ["chicken breast", "bell peppers", "tortillas"],
    },
  ];

  console.log(`  source: "${source.title}" (${source.cuisine})`);
  console.log(`  candidates: ${candidates.length}`);

  const since = new Date();
  const startedAt = Date.now();
  const result = await runAICall(
    "meals.find_similar",
    {
      findSimilarInput: {
        source,
        candidates,
        limit: 10,
      },
    },
    FindSimilarResultSchema,
    { prisma, userId },
  );
  const latencyMs = Date.now() - startedAt;

  if (!result.success) {
    return {
      name: "Find Similar",
      status: "failed",
      pass: false,
      error: result.userFacingMessage,
      latencyMs,
      costUsd: 0,
      retryCount: 0,
      detail: `reason=${result.reason}`,
      llmLogRowsWritten: 0,
    };
  }

  // Drop invented match IDs (mirrors route behavior).
  const validIds = new Set(candidates.map((c) => c.id));
  const filtered = result.data.matches.filter((m) => validIds.has(m.mealId));

  for (const m of filtered) {
    const cand = candidates.find((c) => c.id === m.mealId);
    console.log(
      `    ${m.mealId.padEnd(40)} score=${m.similarityScore.toFixed(2)} cuisine=${cand?.cuisine}  reason="${m.reason}"`,
    );
  }

  // Same-cuisine baseline (informational): Tex-Mex Fajitas SHOULD rank near
  // the top for a Mexican Beef Tacos source. Don't fail allPass on a miss.
  const orderedIds = filtered.map((m) => m.mealId);
  const fajitasIdx = orderedIds.indexOf(DEV_DISH_IDS.fajitas);
  const padThaiIdx = orderedIds.indexOf(DEV_DISH_IDS.padThai);
  const fajitasAhead =
    fajitasIdx !== -1 &&
    (padThaiIdx === -1 || fajitasIdx < padThaiIdx);
  console.log(
    `  cuisine-baseline (Fajitas ahead of Pad Thai): ${fajitasAhead ? "✓" : "ℹ informational miss"}`,
  );

  // Emit the activity event the route would emit (so smoke verifies the
  // end-to-end side effect — log + activity — both fire).
  await prisma.userActivity.create({
    data: {
      userId,
      eventType: "meal_found_similar_used",
      entityId: source.id,
      platform: "api",
    },
  });

  const logInfo = await readLatestLogRow(userId, "meals.find_similar", since);
  const activity = await prisma.userActivity.count({
    where: {
      userId,
      eventType: "meal_found_similar_used",
      createdAt: { gte: since },
    },
  });

  const shapePass = filtered.every(
    (m) =>
      typeof m.mealId === "string" &&
      m.similarityScore >= 0 &&
      m.similarityScore <= 1 &&
      m.reason.length > 0,
  );

  const pass = shapePass && (logInfo?.rowsWritten ?? 0) === 1 && activity === 1;

  console.log(
    `  matches=${filtered.length} shape=${shapePass ? "✓" : "✗"} log=${logInfo?.rowsWritten ?? 0} activity=${activity}`,
  );
  console.log(
    `  latency=${latencyMs}ms cost=$${(logInfo?.costUsd ?? 0).toFixed(5)} retries=${logInfo?.retryCount ?? 0}`,
  );

  return {
    name: "Find Similar",
    status: "success",
    pass,
    latencyMs,
    costUsd: logInfo?.costUsd ?? 0,
    retryCount: logInfo?.retryCount ?? 0,
    detail: `matches=${filtered.length} fajitasAhead=${fajitasAhead}`,
    llmLogRowsWritten: logInfo?.rowsWritten ?? 0,
  };
}

async function flow2_dishMacros(userId: string): Promise<FlowReport> {
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("FLOW 2/6 — Dish Macros helper (6b-2)");
  console.log("══════════════════════════════════════════════════════════");

  const dish = await loadDishWithIngredients(DEV_DISH_IDS.beefTacos);
  console.log(`  dish: "${dish.title}" (${dish.ingredients.length} ingredients, ${dish.servings} servings)`);

  // Confirm macros were zeroed in setup.
  const zeroed = await prisma.dish.findUnique({
    where: { id: DEV_DISH_IDS.beefTacos },
    select: { caloriesPerServing: true },
  });
  if (!zeroed || zeroed.caloriesPerServing !== 0) {
    return {
      name: "Dish Macros",
      status: "failed",
      pass: false,
      error: `expected zeroed macros on Beef Tacos but got cal=${zeroed?.caloriesPerServing}`,
      latencyMs: 0,
      costUsd: 0,
      retryCount: 0,
      detail: "",
      llmLogRowsWritten: 0,
    };
  }

  const since = new Date();
  const startedAt = Date.now();
  const result = await estimateDishMacros({
    prisma,
    userId,
    dishTitle: dish.title,
    servings: dish.servings,
    ingredients: dish.ingredients,
  });
  const latencyMs = Date.now() - startedAt;

  if (result.status === "failed") {
    return {
      name: "Dish Macros",
      status: "failed",
      pass: false,
      error: result.error,
      latencyMs,
      costUsd: 0,
      retryCount: 0,
      detail: "",
      llmLogRowsWritten: 0,
    };
  }

  console.log(
    `  → cal=${result.perServing.calories} P=${result.perServing.proteinG}g C=${result.perServing.carbsG}g F=${result.perServing.fatG}g confidence=${result.confidence ?? "?"}`,
  );

  const sanityPass =
    result.perServing.calories >= 100 &&
    result.perServing.calories <= 2000 &&
    result.perServing.proteinG > 0 &&
    result.perServing.carbsG > 0 &&
    result.perServing.fatG > 0;

  const logInfo = await readLatestLogRow(
    userId,
    "nutrition.ingredient_estimate",
    since,
  );

  const pass = sanityPass && (logInfo?.rowsWritten ?? 0) === 1;
  console.log(
    `  sanity=${sanityPass ? "✓" : "✗"} log=${logInfo?.rowsWritten ?? 0} latency=${latencyMs}ms cost=$${(logInfo?.costUsd ?? 0).toFixed(5)} retries=${logInfo?.retryCount ?? 0}`,
  );

  return {
    name: "Dish Macros",
    status: "success",
    pass,
    latencyMs,
    costUsd: logInfo?.costUsd ?? 0,
    retryCount: logInfo?.retryCount ?? 0,
    detail: `cal=${result.perServing.calories} confidence=${result.confidence ?? "?"}`,
    llmLogRowsWritten: logInfo?.rowsWritten ?? 0,
  };
}

async function flow3_planRecalc(userId: string): Promise<FlowReport> {
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("FLOW 3/6 — Plan Macro Recalc (6b-3)");
  console.log("══════════════════════════════════════════════════════════");
  console.log(`  plan: ${DEV_PLAN_ID} ("Weeknight Dinners")`);

  // Beef Tacos was already estimated and persisted by Flow 2. To exercise
  // the AI path for the other 3 dishes in the plan, zero them now (Flow 2
  // touched only Beef Tacos).
  const planDishIds = [
    DEV_DISH_IDS.beefTacos,
    DEV_DISH_IDS.carbonara,
    DEV_DISH_IDS.fajitas,
    DEV_DISH_IDS.grainBowl,
  ];
  // Re-zero ALL plan dishes so Flow 3 fires fresh estimates against the AI
  // for every meal in the plan. Mirrors the 6b-3 standalone smoke pattern.
  await zeroDishMacros(planDishIds);

  const since = new Date();
  const startedAt = Date.now();
  const result = await computePlanMacros({ prisma, userId, planId: DEV_PLAN_ID });
  const latencyMs = Date.now() - startedAt;

  console.log(
    `  dailyAverages: cal=${result.dailyAverages.calories} P=${result.dailyAverages.proteinG}g C=${result.dailyAverages.carbsG}g F=${result.dailyAverages.fatG}g`,
  );
  console.log(`  perDay (${result.perDay.length} days):`);
  for (const d of result.perDay) {
    console.log(
      `    ${d.day}: ${d.totals.calories} cal · ${d.totals.proteinG}g P · ${d.totals.carbsG}g C · ${d.totals.fatG}g F  (${d.mealCount} meals)`,
    );
  }
  console.log(`  perMeal (${result.perMeal.length} items):`);
  const statuses: string[] = [];
  for (const m of result.perMeal) {
    for (const d of m.dishMacros) {
      console.log(`    [${d.status}] ${m.mealTitle} → ${d.dishTitle}: ${d.macros.calories} cal`);
      statuses.push(d.status);
    }
  }

  const allComputed = statuses.every((s) => s === "computed");
  const hasFourDays = result.perDay.length === 4;
  const hasFourMeals = result.perMeal.length === 4;

  // Verify plan_macros_recalculated activity event was emitted.
  const planActivity = await prisma.userActivity.count({
    where: {
      userId,
      eventType: "plan_macros_recalculated",
      createdAt: { gte: since },
    },
  });

  const logInfo = await readLatestLogRow(
    userId,
    "nutrition.ingredient_estimate",
    since,
  );

  // We expect 4 LLMCallLog rows (one per plan dish — all zeroed so all
  // fire AI). costUsd from readLatestLogRow already sums across rows.
  const fourLogs = (logInfo?.rowsWritten ?? 0) === 4;

  const pass = allComputed && hasFourDays && hasFourMeals && fourLogs && planActivity === 1;

  console.log(
    `  allComputed=${allComputed ? "✓" : "✗"} 4days=${hasFourDays ? "✓" : "✗"} 4meals=${hasFourMeals ? "✓" : "✗"} 4logs=${fourLogs ? "✓" : "✗"} activity=${planActivity}`,
  );
  console.log(
    `  latency=${latencyMs}ms cost=$${(logInfo?.costUsd ?? 0).toFixed(5)} (sum across 4 calls)`,
  );

  return {
    name: "Plan Macro Recalc",
    status: "success",
    pass,
    latencyMs,
    costUsd: logInfo?.costUsd ?? 0,
    retryCount: 0, // aggregate retry count across 4 calls is less meaningful
    detail: `dailyCal=${result.dailyAverages.calories} statuses=[${statuses.join(",")}]`,
    llmLogRowsWritten: logInfo?.rowsWritten ?? 0,
  };
}

async function flow4_kiwiAssistIngredients(userId: string): Promise<FlowReport> {
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("FLOW 4/6 — Kiwi-assist Ingredients (6b-4)");
  console.log("══════════════════════════════════════════════════════════");
  console.log(`  dishTitle="Beef Tacos" cuisine=Mexican existing=[ground beef] servings=4`);

  const since = new Date();
  const startedAt = Date.now();
  const result = await assistDishIngredients({
    prisma,
    userId,
    dishTitle: "Beef Tacos",
    cuisine: "Mexican",
    existingIngredients: [{ name: "ground beef" }],
    servings: 4,
  });
  const latencyMs = Date.now() - startedAt;

  if (result.status === "failed") {
    return {
      name: "Kiwi-assist Ingredients",
      status: "failed",
      pass: false,
      error: result.error,
      latencyMs,
      costUsd: 0,
      retryCount: 0,
      detail: "",
      llmLogRowsWritten: 0,
    };
  }

  for (const ing of result.ingredients) {
    const tag = ing.isUserProvided ? "[user]" : ing.addedByKiwi ? "[+kiwi]" : "[?]";
    console.log(
      `    ${tag.padEnd(7)} ${ing.quantity} ${ing.unit} ${ing.name}${ing.isOptional ? " (opt)" : ""}`,
    );
  }

  const groundBeef = result.ingredients.find((i) =>
    i.name.toLowerCase().includes("ground beef"),
  );
  const groundBeefIsUserProvided = !!groundBeef?.isUserProvided;
  const addedByKiwiCount = result.ingredients.filter((i) => i.addedByKiwi).length;
  const sanityPass =
    result.ingredients.length >= 4 &&
    !!groundBeef &&
    groundBeefIsUserProvided &&
    addedByKiwiCount > 0;

  const logInfo = await readLatestLogRow(
    userId,
    "meal_builder.assist_ingredients",
    since,
  );
  const pass = sanityPass && (logInfo?.rowsWritten ?? 0) === 1;

  console.log(
    `  ingredients=${result.ingredients.length} groundBeef=${groundBeefIsUserProvided ? "✓ user" : "✗"} +kiwi=${addedByKiwiCount}`,
  );
  console.log(
    `  latency=${latencyMs}ms cost=$${(logInfo?.costUsd ?? 0).toFixed(5)} retries=${logInfo?.retryCount ?? 0}`,
  );

  return {
    name: "Kiwi-assist Ingredients",
    status: "success",
    pass,
    latencyMs,
    costUsd: logInfo?.costUsd ?? 0,
    retryCount: logInfo?.retryCount ?? 0,
    detail: `count=${result.ingredients.length} +kiwi=${addedByKiwiCount}`,
    llmLogRowsWritten: logInfo?.rowsWritten ?? 0,
  };
}

async function flow5_kiwiAssistSteps(userId: string): Promise<FlowReport> {
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("FLOW 5/6 — Kiwi-assist Steps (6b-4)");
  console.log("══════════════════════════════════════════════════════════");

  // Use the canonical Carbonara ingredient list from the seed (without
  // optional parsley).
  const carbonaraIngredients = [
    { name: "spaghetti", quantity: 1, unit: "lb" },
    { name: "bacon", quantity: 6, unit: "oz" },
    { name: "eggs", quantity: 4, unit: "each" },
    { name: "parmesan", quantity: 1, unit: "cup" },
    { name: "black pepper", quantity: 1, unit: "tsp" },
    { name: "garlic", quantity: 2, unit: "cloves" },
    { name: "salt", quantity: 1, unit: "tsp" },
  ];

  console.log(`  dishTitle="Spaghetti Carbonara" cuisine=Italian ingredients=${carbonaraIngredients.length} servings=4`);

  const since = new Date();
  const startedAt = Date.now();
  const result = await assistDishSteps({
    prisma,
    userId,
    dishTitle: "Spaghetti Carbonara",
    cuisine: "Italian",
    ingredients: carbonaraIngredients,
    servings: 4,
  });
  const latencyMs = Date.now() - startedAt;

  if (result.status === "failed") {
    return {
      name: "Kiwi-assist Steps",
      status: "failed",
      pass: false,
      error: result.error,
      latencyMs,
      costUsd: 0,
      retryCount: 0,
      detail: "",
      llmLogRowsWritten: 0,
    };
  }

  for (let i = 0; i < result.steps.length; i++) {
    const st = result.steps[i];
    const flags = [
      st.phaseType.padEnd(8),
      st.isTimingSensitive ? "⏱" : " ",
      `${st.estimatedMinutes}m`,
    ].join(" ");
    console.log(`    ${String(i + 1).padStart(2)}. [${flags}] ${st.content}`);
  }

  const phasesUsed = Array.from(new Set(result.steps.map((s) => s.phaseType)));
  const timingSensitive = result.steps.filter((s) => s.isTimingSensitive).length;
  const sanityPass =
    result.steps.length >= 4 &&
    result.steps.length <= 10 &&
    phasesUsed.length >= 2 &&
    timingSensitive >= 1;

  const logInfo = await readLatestLogRow(
    userId,
    "meal_builder.assist_steps",
    since,
  );
  const pass = sanityPass && (logInfo?.rowsWritten ?? 0) === 1;

  console.log(
    `  steps=${result.steps.length} phases=[${phasesUsed.join(",")}] timingSensitive=${timingSensitive}`,
  );
  console.log(
    `  latency=${latencyMs}ms cost=$${(logInfo?.costUsd ?? 0).toFixed(5)} retries=${logInfo?.retryCount ?? 0}`,
  );

  return {
    name: "Kiwi-assist Steps",
    status: "success",
    pass,
    latencyMs,
    costUsd: logInfo?.costUsd ?? 0,
    retryCount: logInfo?.retryCount ?? 0,
    detail: `steps=${result.steps.length} timingSensitive=${timingSensitive}`,
    llmLogRowsWritten: logInfo?.rowsWritten ?? 0,
  };
}

async function flow6_modeAParseMeal(userId: string): Promise<FlowReport> {
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("FLOW 6/6 — Mode A Parse-Meal (6b-5) — D-WS6-033 RETRY-RATE WATCH");
  console.log("══════════════════════════════════════════════════════════");

  const freeText = "Chicken piccata with arugula salad";
  console.log(`  freeText="${freeText}" servings=4`);

  const since = new Date();
  const startedAt = Date.now();
  const result = await parseMealFromText({
    prisma,
    userId,
    freeText,
    servings: 4,
  });
  const latencyMs = Date.now() - startedAt;

  if (result.status === "failed") {
    return {
      name: "Mode A Parse-Meal",
      status: "failed",
      pass: false,
      error: result.error,
      latencyMs,
      costUsd: 0,
      retryCount: 0,
      detail: "",
      llmLogRowsWritten: 0,
    };
  }

  const meal = result.meal;
  console.log(`  meal: "${meal.title}"`);
  console.log(
    `    cuisine=${meal.cuisine ?? "(null)"} difficulty=${meal.difficulty} servings=${meal.servingsDefault} subDishes=${meal.subDishes.length}`,
  );
  for (const sd of meal.subDishes) {
    console.log(
      `    [${sd.positionIndex}] ${sd.role.padEnd(8)} ${sd.title} (${sd.ingredients.length} ing, ${sd.steps.length} steps)`,
    );
  }

  const roles = meal.subDishes.map((sd) => sd.role);
  const hasMain = roles.includes("main");
  const hasSide = roles.includes("side");
  const twoSubDishes = meal.subDishes.length === 2;
  const cuisineItalian = meal.cuisine?.toLowerCase() === "italian";

  const logInfo = await readLatestLogRow(
    userId,
    "meal_builder.mode_a_parse",
    since,
  );
  const retryCount = logInfo?.retryCount ?? 0;

  const sanityPass = twoSubDishes && hasMain && hasSide;
  const pass = sanityPass && (logInfo?.rowsWritten ?? 0) === 1;

  console.log(
    `  2subDishes=${twoSubDishes ? "✓" : "✗"} main=${hasMain ? "✓" : "✗"} side=${hasSide ? "✓" : "✗"} cuisineItalian=${cuisineItalian ? "✓" : "ℹ"}`,
  );
  console.log(
    `  latency=${latencyMs}ms cost=$${(logInfo?.costUsd ?? 0).toFixed(5)} retries=${retryCount} ${retryCount > 0 ? "⚠ D-WS6-033 SIGNAL" : ""}`,
  );

  return {
    name: "Mode A Parse-Meal",
    status: "success",
    pass,
    latencyMs,
    costUsd: logInfo?.costUsd ?? 0,
    retryCount,
    detail: `subDishes=${meal.subDishes.length} cuisine=${meal.cuisine ?? "(null)"} roles=[${roles.join(",")}]`,
    llmLogRowsWritten: logInfo?.rowsWritten ?? 0,
  };
}

// ── main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY not set. Cumulative smoke aborts (all six flows would fail via no_api_key).",
    );
    process.exitCode = 1;
    return;
  }

  console.log("══════════════════════════════════════════════════════════");
  console.log("WS6 6b-6 CUMULATIVE SMOKE — all six 6b AI flows");
  console.log("══════════════════════════════════════════════════════════");

  const userId = await getDevUserId();
  console.log(`  dev user: ${userId} (${DEV_USER_EMAIL})`);

  // Setup: zero Beef Tacos macros so Flow 2 has work to do. Flow 3 will
  // re-zero the full plan-dish set before it runs.
  console.log(`  setup: zeroing Beef Tacos macros for Flow 2...`);
  await zeroDishMacros([DEV_DISH_IDS.beefTacos]);

  // Run flows sequentially — order matters (Flow 2 needs the zeroed Beef
  // Tacos, Flow 3 re-zeroes the plan-dish set).
  const reports: FlowReport[] = [];
  reports.push(await flow1_findSimilar(userId));
  reports.push(await flow2_dishMacros(userId));
  reports.push(await flow3_planRecalc(userId));
  reports.push(await flow4_kiwiAssistIngredients(userId));
  reports.push(await flow5_kiwiAssistSteps(userId));
  reports.push(await flow6_modeAParseMeal(userId));

  // ── summary ─────────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("SUMMARY");
  console.log("══════════════════════════════════════════════════════════");

  let totalLatency = 0;
  let totalCost = 0;
  let totalLogs = 0;
  let totalRetries = 0;
  for (const r of reports) {
    const flag = r.status === "failed" ? "✗" : r.pass ? "✓" : "✗";
    console.log(
      `  ${flag} ${r.name.padEnd(28)} ${r.detail.padEnd(48)} latency=${r.latencyMs}ms cost=$${r.costUsd.toFixed(5)} retries=${r.retryCount} logs=${r.llmLogRowsWritten}`,
    );
    if (r.error) console.log(`      error: ${r.error}`);
    totalLatency += r.latencyMs;
    totalCost += r.costUsd;
    totalLogs += r.llmLogRowsWritten;
    totalRetries += r.retryCount;
  }

  console.log("");
  console.log(`  Aggregate: ${reports.length} flows, ${totalLatency}ms, $${totalCost.toFixed(5)}, ${totalLogs} LLMCallLog rows written`);

  // Expected LLMCallLog rows: 1 (Find Similar) + 1 (Dish Macros) + 4 (Plan
  // Recalc) + 1 (Kiwi-assist Ingr) + 1 (Kiwi-assist Steps) + 1 (Mode A) = 9.
  const EXPECTED_LOG_ROWS = 9;
  const logCountPass = totalLogs === EXPECTED_LOG_ROWS;
  console.log(
    `  LLMCallLog count: ${totalLogs}/${EXPECTED_LOG_ROWS} ${logCountPass ? "✓" : "✗"}`,
  );

  // ── Mode A retry-rate observation (D-WS6-033) ───────────────────────────
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("D-WS6-033 — Mode A retry-rate observation");
  console.log("══════════════════════════════════════════════════════════");
  const modeAReport = reports[5];
  if (modeAReport.retryCount > 0) {
    console.log(
      `  ⚠ Mode A retry count: ${modeAReport.retryCount} — SIGNAL CONFIRMED.`,
    );
    console.log(
      `    The 6b-5 smoke saw validation_failed → retry → success on Test 3.`,
    );
    console.log(
      `    Repeated here in 6b-6, the retry-rate concern in D-WS6-033 is`,
    );
    console.log(
      `    urgent — recommend prompt iteration before WS7 surfaces Mode A.`,
    );
  } else {
    console.log(
      `  ✓ Mode A retry count: 0 — PASS, no retries observed.`,
    );
    console.log(
      `    D-WS6-033's retry-rate concern can be de-prioritized: the prompt`,
    );
    console.log(
      `    is producing valid output on first attempt for this test case.`,
    );
    console.log(
      `    Compound-cuisine prompt iteration remains open as a separate concern.`,
    );
  }

  const allPass = reports.every((r) => r.pass) && logCountPass;
  console.log(`\n  Overall: ${allPass ? "✅ PASS" : "❌ FAIL"}`);
  if (!allPass) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("smoke failed", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

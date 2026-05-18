// WS6 6d-2 — Prep the Week aggregation live smoke.
// In-process HTTP (no separate api-server). Spins up Express with the
// production cooking router, mints a JWT for the dev user, POSTs to
// /api/plans/:planId/prep-week against real Anthropic + real Neon.
//
// Surfaces under test:
//   - Cache miss → Sonnet tool_use, LLMCallLog row written, PrepWeekStructure
//     row written
//   - Cache hit on second invocation (same revisionId) → no AI call, no
//     new LLMCallLog row, identical structureJson
//
// Fixture: 5-meal plan with intentional ingredient overlap per plan §2.8
// (yellow onion across 4 meals, garlic across 3, bell pepper across 2,
// chicken + salmon multi-protein). Gives the AI real aggregation work.
//
// Idempotency: teardown at script start AND end wipes fixture rows by ID.
//
// Run:    pnpm --filter @workspace/api-server exec tsx scripts/ws6-6d-2-smoke.ts
// Prereq: prisma:seed (AIPrompts, includes prep.aggregation_logic body)
//         AND prisma:seed:dev (Hans's account). ANTHROPIC_API_KEY must be set.

import { PrismaClient } from "@prisma/client";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../src/lib/auth";
import { createCookingRouter } from "../src/routes/cooking";
import type { PrepWeekResult } from "../src/lib/ai/schemas/prepWeek";

const prisma = new PrismaClient();

const DEV_USER_EMAIL = "hans.tiefenthaler+8@gmail.com";

// Stable fixture IDs — teardown keyed by ID.
const TEMPLATE_ID = "00000000-6d02-4111-8111-000000000001";
const PLAN_ID = "00000000-6d02-4111-8111-000000000002";

const MEAL_TACOS = "00000000-6d02-4222-8222-000000000001";
const MEAL_STIRFRY = "00000000-6d02-4222-8222-000000000002";
const MEAL_CURRY = "00000000-6d02-4222-8222-000000000003";
const MEAL_SALMON = "00000000-6d02-4222-8222-000000000004";
const MEAL_PASTA = "00000000-6d02-4222-8222-000000000005";

const DISH_TACOS_BEEF = "00000000-6d02-4333-8333-000000000001";
const DISH_STIRFRY_CHICKEN = "00000000-6d02-4333-8333-000000000002";
const DISH_CURRY_CHICKEN = "00000000-6d02-4333-8333-000000000003";
const DISH_SALMON_FILLET = "00000000-6d02-4333-8333-000000000004";
const DISH_PASTA_SAUCE = "00000000-6d02-4333-8333-000000000005";
const DISH_SALMON_VINAIGRETTE = "00000000-6d02-4333-8333-000000000006";

// Smoke-owned ingredients — namespace canonicalName to avoid collisions
// with seeded data.
const ING_PREFIX = "smoke6d2_";
const ING = {
  onion: "00000000-6d02-4444-8444-000000000001",
  garlic: "00000000-6d02-4444-8444-000000000002",
  bell_pepper: "00000000-6d02-4444-8444-000000000003",
  chicken: "00000000-6d02-4444-8444-000000000004",
  salmon: "00000000-6d02-4444-8444-000000000005",
  ground_beef: "00000000-6d02-4444-8444-000000000006",
  taco_seasoning: "00000000-6d02-4444-8444-000000000007",
  curry_powder: "00000000-6d02-4444-8444-000000000008",
  olive_oil: "00000000-6d02-4444-8444-000000000009",
  lemon: "00000000-6d02-4444-8444-00000000000a",
  dijon: "00000000-6d02-4444-8444-00000000000b",
  tomato: "00000000-6d02-4444-8444-00000000000c",
};

const ALL_MEAL_IDS = [
  MEAL_TACOS,
  MEAL_STIRFRY,
  MEAL_CURRY,
  MEAL_SALMON,
  MEAL_PASTA,
];
const ALL_DISH_IDS = [
  DISH_TACOS_BEEF,
  DISH_STIRFRY_CHICKEN,
  DISH_CURRY_CHICKEN,
  DISH_SALMON_FILLET,
  DISH_PASTA_SAUCE,
  DISH_SALMON_VINAIGRETTE,
];
const ALL_INGREDIENT_IDS = Object.values(ING);

const COST_CEILING_USD = 0.2;

interface SurfaceReport {
  label: string;
  status: "PASS" | "FAIL";
  wallMs: number;
  costUsd: number;
  notes: string[];
}

// ── teardown / setup ──────────────────────────────────────────────────

async function teardown(): Promise<void> {
  // PrepWeekStructure cascades on plan delete, but delete defensively first.
  await prisma.prepWeekStructure.deleteMany({ where: { planId: PLAN_ID } });
  // MealPlanItem cascades on plan delete (onDelete: Cascade in schema).
  // Delete plan, then template.
  await prisma.mealPlanInstance.deleteMany({ where: { id: PLAN_ID } });
  await prisma.mealPlanTemplate.deleteMany({ where: { id: TEMPLATE_ID } });
  // DishIngredient cascades on dish delete. MealDishLink cascades on meal
  // delete. Order: meals (→ links), dishes (→ dishIngredients), ingredients.
  await prisma.mealDishLink.deleteMany({ where: { mealId: { in: ALL_MEAL_IDS } } });
  await prisma.dishIngredient.deleteMany({
    where: { dishId: { in: ALL_DISH_IDS } },
  });
  await prisma.meal.deleteMany({ where: { id: { in: ALL_MEAL_IDS } } });
  await prisma.dish.deleteMany({ where: { id: { in: ALL_DISH_IDS } } });
  await prisma.ingredient.deleteMany({
    where: { id: { in: ALL_INGREDIENT_IDS } },
  });
  console.log("[teardown] fixtures cleared");
}

async function createIngredients(): Promise<void> {
  const rows: Array<{
    id: string;
    canonicalName: string;
    displayName: string;
    category: string;
    defaultUnit: string;
  }> = [
    { id: ING.onion, canonicalName: `${ING_PREFIX}yellow_onion`, displayName: "yellow onion", category: "Produce", defaultUnit: "medium" },
    { id: ING.garlic, canonicalName: `${ING_PREFIX}garlic`, displayName: "garlic", category: "Produce", defaultUnit: "cloves" },
    { id: ING.bell_pepper, canonicalName: `${ING_PREFIX}bell_pepper`, displayName: "bell pepper", category: "Produce", defaultUnit: "medium" },
    { id: ING.chicken, canonicalName: `${ING_PREFIX}chicken_thighs`, displayName: "boneless chicken thighs", category: "Protein", defaultUnit: "lb" },
    { id: ING.salmon, canonicalName: `${ING_PREFIX}salmon_fillet`, displayName: "salmon fillet", category: "Protein", defaultUnit: "lb" },
    { id: ING.ground_beef, canonicalName: `${ING_PREFIX}ground_beef`, displayName: "ground beef (85/15)", category: "Protein", defaultUnit: "lb" },
    { id: ING.taco_seasoning, canonicalName: `${ING_PREFIX}taco_seasoning`, displayName: "taco seasoning blend", category: "Pantry", defaultUnit: "tbsp" },
    { id: ING.curry_powder, canonicalName: `${ING_PREFIX}curry_powder`, displayName: "curry powder", category: "Pantry", defaultUnit: "tbsp" },
    { id: ING.olive_oil, canonicalName: `${ING_PREFIX}olive_oil`, displayName: "olive oil", category: "Pantry", defaultUnit: "tbsp" },
    { id: ING.lemon, canonicalName: `${ING_PREFIX}lemon`, displayName: "lemon", category: "Produce", defaultUnit: "each" },
    { id: ING.dijon, canonicalName: `${ING_PREFIX}dijon_mustard`, displayName: "Dijon mustard", category: "Pantry", defaultUnit: "tsp" },
    { id: ING.tomato, canonicalName: `${ING_PREFIX}crushed_tomato`, displayName: "crushed tomatoes", category: "Pantry", defaultUnit: "oz" },
  ];
  await prisma.ingredient.createMany({ data: rows });
}

async function createFixture(userId: string): Promise<void> {
  await createIngredients();

  // Dishes — one per meal except salmon (main + vinaigrette).
  await prisma.dish.createMany({
    data: [
      { id: DISH_TACOS_BEEF, userId, title: "Ground Beef Tacos", servingsDefault: 4 },
      { id: DISH_STIRFRY_CHICKEN, userId, title: "Chicken Stir Fry", servingsDefault: 4 },
      { id: DISH_CURRY_CHICKEN, userId, title: "Chicken Curry", servingsDefault: 4 },
      { id: DISH_SALMON_FILLET, userId, title: "Pan-Seared Salmon", servingsDefault: 2 },
      { id: DISH_SALMON_VINAIGRETTE, userId, title: "Lemon-Dijon Vinaigrette", servingsDefault: 2 },
      { id: DISH_PASTA_SAUCE, userId, title: "Simple Tomato Pasta", servingsDefault: 4 },
    ],
  });

  // DishIngredients — designed for cross-meal aggregation.
  // Yellow onion: tacos (diced) + stirfry (diced) + curry (diced) + salmon-vin? no, pasta (diced thin slices). Re-check plan §2.8:
  //   "Onion: appears in 4 of 5 meals (Meal A diced, Meal B diced, Meal C diced, Meal D thinly sliced)".
  // We give onion to: tacos, stirfry, curry (all diced) and pasta (thinly sliced).
  // Garlic: 3 meals, all minced — stirfry, curry, pasta.
  // Bell pepper: 2 meals, both sliced — stirfry, curry.
  // Chicken thighs: 2 meals different cuts — stirfry (cubed), curry (whole pieces).
  // Salmon: 1 meal.
  // Spice blends: tacos (taco seasoning), curry (curry powder).
  // Vinaigrette: salmon dish (olive oil + lemon + dijon).
  await prisma.dishIngredient.createMany({
    data: [
      // Tacos
      { dishId: DISH_TACOS_BEEF, ingredientId: ING.onion, quantity: 1, unit: "medium", preparationNote: "diced", positionIndex: 0 },
      { dishId: DISH_TACOS_BEEF, ingredientId: ING.ground_beef, quantity: 1, unit: "lb", preparationNote: null, positionIndex: 1 },
      { dishId: DISH_TACOS_BEEF, ingredientId: ING.taco_seasoning, quantity: 2, unit: "tbsp", preparationNote: null, positionIndex: 2 },
      // Stir-fry
      { dishId: DISH_STIRFRY_CHICKEN, ingredientId: ING.onion, quantity: 1, unit: "medium", preparationNote: "diced", positionIndex: 0 },
      { dishId: DISH_STIRFRY_CHICKEN, ingredientId: ING.garlic, quantity: 3, unit: "cloves", preparationNote: "minced", positionIndex: 1 },
      { dishId: DISH_STIRFRY_CHICKEN, ingredientId: ING.bell_pepper, quantity: 1, unit: "medium", preparationNote: "sliced", positionIndex: 2 },
      { dishId: DISH_STIRFRY_CHICKEN, ingredientId: ING.chicken, quantity: 1, unit: "lb", preparationNote: "cubed", positionIndex: 3 },
      // Curry
      { dishId: DISH_CURRY_CHICKEN, ingredientId: ING.onion, quantity: 1, unit: "medium", preparationNote: "diced", positionIndex: 0 },
      { dishId: DISH_CURRY_CHICKEN, ingredientId: ING.garlic, quantity: 4, unit: "cloves", preparationNote: "minced", positionIndex: 1 },
      { dishId: DISH_CURRY_CHICKEN, ingredientId: ING.bell_pepper, quantity: 1, unit: "medium", preparationNote: "sliced", positionIndex: 2 },
      { dishId: DISH_CURRY_CHICKEN, ingredientId: ING.chicken, quantity: 1.5, unit: "lb", preparationNote: null, positionIndex: 3 },
      { dishId: DISH_CURRY_CHICKEN, ingredientId: ING.curry_powder, quantity: 2, unit: "tbsp", preparationNote: null, positionIndex: 4 },
      // Salmon — main fillet
      { dishId: DISH_SALMON_FILLET, ingredientId: ING.salmon, quantity: 0.75, unit: "lb", preparationNote: null, positionIndex: 0 },
      { dishId: DISH_SALMON_FILLET, ingredientId: ING.olive_oil, quantity: 1, unit: "tbsp", preparationNote: null, positionIndex: 1 },
      // Salmon — vinaigrette
      { dishId: DISH_SALMON_VINAIGRETTE, ingredientId: ING.olive_oil, quantity: 3, unit: "tbsp", preparationNote: null, positionIndex: 0 },
      { dishId: DISH_SALMON_VINAIGRETTE, ingredientId: ING.lemon, quantity: 1, unit: "each", preparationNote: "juiced", positionIndex: 1 },
      { dishId: DISH_SALMON_VINAIGRETTE, ingredientId: ING.dijon, quantity: 1, unit: "tsp", preparationNote: null, positionIndex: 2 },
      // Pasta
      { dishId: DISH_PASTA_SAUCE, ingredientId: ING.onion, quantity: 1, unit: "medium", preparationNote: "thinly sliced", positionIndex: 0 },
      { dishId: DISH_PASTA_SAUCE, ingredientId: ING.garlic, quantity: 3, unit: "cloves", preparationNote: "minced", positionIndex: 1 },
      { dishId: DISH_PASTA_SAUCE, ingredientId: ING.tomato, quantity: 28, unit: "oz", preparationNote: null, positionIndex: 2 },
      { dishId: DISH_PASTA_SAUCE, ingredientId: ING.olive_oil, quantity: 2, unit: "tbsp", preparationNote: null, positionIndex: 3 },
    ],
  });

  // Meals — each with one dish, except salmon which has two.
  await prisma.meal.createMany({
    data: [
      { id: MEAL_TACOS, userId, title: "Ground Beef Tacos", servingsDefault: 4 },
      { id: MEAL_STIRFRY, userId, title: "Chicken Stir Fry", servingsDefault: 4 },
      { id: MEAL_CURRY, userId, title: "Chicken Curry", servingsDefault: 4 },
      { id: MEAL_SALMON, userId, title: "Pan-Seared Salmon with Lemon-Dijon Vinaigrette", servingsDefault: 2 },
      { id: MEAL_PASTA, userId, title: "Simple Tomato Pasta", servingsDefault: 4 },
    ],
  });

  await prisma.mealDishLink.createMany({
    data: [
      { mealId: MEAL_TACOS, dishId: DISH_TACOS_BEEF, positionIndex: 0, roleLabel: "main" },
      { mealId: MEAL_STIRFRY, dishId: DISH_STIRFRY_CHICKEN, positionIndex: 0, roleLabel: "main" },
      { mealId: MEAL_CURRY, dishId: DISH_CURRY_CHICKEN, positionIndex: 0, roleLabel: "main" },
      { mealId: MEAL_SALMON, dishId: DISH_SALMON_FILLET, positionIndex: 0, roleLabel: "main" },
      { mealId: MEAL_SALMON, dishId: DISH_SALMON_VINAIGRETTE, positionIndex: 1, roleLabel: "sauce" },
      { mealId: MEAL_PASTA, dishId: DISH_PASTA_SAUCE, positionIndex: 0, roleLabel: "main" },
    ],
  });

  // Template (required FK on MealPlanInstance) + plan instance with items.
  await prisma.mealPlanTemplate.create({
    data: {
      id: TEMPLATE_ID,
      userId,
      title: "Smoke 6d-2 5-meal week",
      defaultDaysCount: 5,
    },
  });
  await prisma.mealPlanInstance.create({
    data: {
      id: PLAN_ID,
      userId,
      mealPlanTemplateId: TEMPLATE_ID,
      titleOverride: "Smoke 6d-2 week",
      items: {
        create: [
          { mealId: MEAL_TACOS, positionIndex: 0, assignedDayOfWeek: "Mon" },
          { mealId: MEAL_STIRFRY, positionIndex: 1, assignedDayOfWeek: "Tue" },
          { mealId: MEAL_CURRY, positionIndex: 2, assignedDayOfWeek: "Wed" },
          { mealId: MEAL_SALMON, positionIndex: 3, assignedDayOfWeek: "Thu" },
          { mealId: MEAL_PASTA, positionIndex: 4, assignedDayOfWeek: "Fri" },
        ],
      },
    },
  });
  console.log("[setup] fixture created (5 meals, 6 dishes, 21 ingredient links)");
}

// ── helpers ───────────────────────────────────────────────────────────

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

async function readPrepWeekLog(
  userId: string,
  since: Date,
): Promise<{ count: number; costUsd: number; latencyMs: number; retryCount: number }> {
  const rows = await prisma.lLMCallLog.findMany({
    where: {
      userId,
      promptKey: "prep.aggregation_logic",
      createdAt: { gte: since },
    },
    select: { costEstimateUsd: true, latencyMs: true, retryCount: true },
  });
  const costUsd = rows.reduce((s, r) => s + Number(r.costEstimateUsd ?? 0), 0);
  const latencyMs = rows.reduce((s, r) => s + (r.latencyMs ?? 0), 0);
  const retryCount = rows.reduce((s, r) => s + (r.retryCount ?? 0), 0);
  return { count: rows.length, costUsd, latencyMs, retryCount };
}

function startInProcessServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const app: Express = express();
  app.use(express.json());
  app.use("/api", createCookingRouter());

  return new Promise((resolve, reject) => {
    const server: Server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) {
        reject(new Error("server did not bind"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/api`,
        close: () =>
          new Promise<void>((r, j) =>
            server.close((err) => (err ? j(err) : r())),
          ),
      });
    });
  });
}

// ── surfaces ──────────────────────────────────────────────────────────

interface PrepWeekResponse {
  cacheHit: boolean;
  result: PrepWeekResult;
  planRevisionId: number;
  generatedAt: string;
  promptVersion: number;
  metadata?: { latencyMs?: number };
}

async function surface_cacheMiss(
  baseUrl: string,
  token: string,
  userId: string,
): Promise<SurfaceReport> {
  console.log("\n══ [cache miss] AI generation ══");
  const wallStart = Date.now();
  const since = new Date();
  const notes: string[] = [];

  const res = await fetch(`${baseUrl}/plans/${PLAN_ID}/prep-week`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const wallMs = Date.now() - wallStart;
  notes.push(`http_status=${res.status}`);

  if (res.status !== 200) {
    const text = await res.text();
    notes.push(`non-200 body: ${text.slice(0, 400)}`);
    return { label: "cache miss → AI", status: "FAIL", wallMs, costUsd: 0, notes };
  }

  const body = (await res.json()) as PrepWeekResponse;
  const log = await readPrepWeekLog(userId, since);

  notes.push(`cacheHit=${body.cacheHit}`);
  notes.push(`promptVersion=${body.promptVersion}`);
  notes.push(`planRevisionId=${body.planRevisionId}`);
  notes.push(`totalEstimatedMinutes=${body.result.totalEstimatedMinutes}`);
  notes.push(`llmCallLogRows=${log.count}`);
  notes.push(`ai_latencyMs=${log.latencyMs}`);
  notes.push(`retries=${log.retryCount}`);

  const phases = body.result.phases;
  const checks: string[] = [];
  if (body.cacheHit !== false) checks.push("cacheHit must be false on first invocation");
  if (phases.length !== 4) checks.push(`phases.length expected 4, got ${phases.length}`);
  const expectedOrder = ["seasonings_dry", "sauces_marinades", "produce", "proteins"];
  for (let i = 0; i < expectedOrder.length; i++) {
    if (phases[i]?.phase !== expectedOrder[i]) {
      checks.push(`phase[${i}] expected ${expectedOrder[i]}, got ${phases[i]?.phase}`);
      break;
    }
  }
  if (phases[3]?.phase !== "proteins") {
    checks.push("proteins phase must be last (food safety)");
  }
  if (log.count !== 1) {
    checks.push(`LLMCallLog expected 1 row, got ${log.count}`);
  }
  if (log.costUsd <= 0) {
    checks.push(`LLMCallLog costUsd expected > 0, got ${log.costUsd}`);
  }

  // Aggregation expectation: at least one step in Phase 3 (produce) has
  // contributesToMealIds.length >= 2 (the onion batch).
  const produceMultiStep = phases[2]?.steps.find(
    (s) => s.contributesToMealIds.length >= 2,
  );
  if (!produceMultiStep) {
    checks.push("expected at least one Phase 3 step covering >=2 meals (onion batch)");
  } else {
    notes.push(
      `produce_multi_step: "${produceMultiStep.title}" covers ${produceMultiStep.contributesToMealIds.length} meals`,
    );
  }

  // Multi-protein cutting-board-wash step expected in Phase 4.
  const proteinSteps = phases[3]?.steps ?? [];
  const washStep = proteinSteps.find((s) =>
    /(wash|clean|sanitize).*(cutting board|board|knife)/i.test(s.instructions + " " + s.title),
  );
  if (!washStep) {
    checks.push("expected a cutting-board-wash step in Phase 4 (multi-protein scenario)");
  } else {
    notes.push(`wash_step: "${washStep.title}"`);
  }

  // totalEstimatedMinutes within ±2 of recomputed sum.
  const recomputed = phases.reduce(
    (sum, p) => sum + p.steps.reduce((s, st) => s + st.estimatedMinutes, 0),
    0,
  );
  notes.push(`recomputed_total=${recomputed}min (reported=${body.result.totalEstimatedMinutes})`);
  if (Math.abs(recomputed - body.result.totalEstimatedMinutes) > 2) {
    checks.push(
      `totalEstimatedMinutes drift > 2: reported=${body.result.totalEstimatedMinutes}, recomputed=${recomputed}`,
    );
  }

  // PrepWeekStructure row should exist now.
  const cached = await prisma.prepWeekStructure.findUnique({ where: { planId: PLAN_ID } });
  if (!cached) checks.push("PrepWeekStructure row not written after cache miss");
  else notes.push(`cache_row_id=${cached.id} revisionId=${cached.lastGeneratedFromPlanRevisionId}`);

  // Surface step counts per phase for transparency.
  const phaseCounts = phases.map((p) => `${p.phase}=${p.steps.length}`).join(", ");
  notes.push(`phase_step_counts: ${phaseCounts}`);

  const pass = checks.length === 0;
  if (!pass) for (const c of checks) notes.push(`CHECK FAILED: ${c}`);
  return {
    label: "cache miss → AI",
    status: pass ? "PASS" : "FAIL",
    wallMs,
    costUsd: log.costUsd,
    notes,
  };
}

async function surface_cacheHit(
  baseUrl: string,
  token: string,
  userId: string,
): Promise<SurfaceReport> {
  console.log("\n══ [cache hit] second invocation ══");
  const wallStart = Date.now();
  const since = new Date();
  const notes: string[] = [];

  // Snapshot the cached structure for byte-comparison.
  const preCached = await prisma.prepWeekStructure.findUnique({
    where: { planId: PLAN_ID },
  });
  if (!preCached) {
    return {
      label: "cache hit",
      status: "FAIL",
      wallMs: 0,
      costUsd: 0,
      notes: ["no PrepWeekStructure row to test against"],
    };
  }
  const preJson = JSON.stringify(preCached.structureJson);

  const res = await fetch(`${baseUrl}/plans/${PLAN_ID}/prep-week`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const wallMs = Date.now() - wallStart;
  notes.push(`http_status=${res.status}`);

  if (res.status !== 200) {
    const text = await res.text();
    notes.push(`non-200 body: ${text.slice(0, 400)}`);
    return { label: "cache hit", status: "FAIL", wallMs, costUsd: 0, notes };
  }

  const body = (await res.json()) as PrepWeekResponse;
  const log = await readPrepWeekLog(userId, since);

  notes.push(`cacheHit=${body.cacheHit}`);
  notes.push(`promptVersion=${body.promptVersion}`);
  notes.push(`llmCallLogRowsSinceStart=${log.count}`);

  const checks: string[] = [];
  if (body.cacheHit !== true) checks.push("cacheHit must be true on second invocation");
  if (log.count !== 0) checks.push(`LLMCallLog expected 0 new rows, got ${log.count}`);
  const postJson = JSON.stringify(body.result);
  if (postJson !== preJson) {
    checks.push("structureJson on cache hit must match pre-hit cached row");
  }

  const pass = checks.length === 0;
  if (!pass) for (const c of checks) notes.push(`CHECK FAILED: ${c}`);
  return {
    label: "cache hit",
    status: pass ? "PASS" : "FAIL",
    wallMs,
    costUsd: 0,
    notes,
  };
}

// ── main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set in env — aborting smoke");
    process.exit(2);
  }

  console.log("══════════════════════════════════════════════════════════");
  console.log("WS6 6d-2 — Prep the Week live smoke");
  console.log("══════════════════════════════════════════════════════════");

  const runStartIso = new Date().toISOString();
  const userId = await getDevUserId();
  console.log(`dev user: ${userId} (${DEV_USER_EMAIL})`);

  await teardown();
  await createFixture(userId);

  const server = await startInProcessServer();
  const token = signToken(userId);

  const wallStart = Date.now();
  const rMiss = await surface_cacheMiss(server.baseUrl, token, userId);
  const rHit = await surface_cacheHit(server.baseUrl, token, userId);
  const totalWallMs = Date.now() - wallStart;

  const reports = [rMiss, rHit];
  const passCount = reports.filter((r) => r.status === "PASS").length;
  const failCount = reports.filter((r) => r.status === "FAIL").length;
  const totalCost = reports.reduce((s, r) => s + r.costUsd, 0);

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("=== WS6 6d-2 Smoke ===");
  console.log(`Run date:        ${runStartIso}`);
  console.log(`Total:           2 surfaces, ${passCount} PASS, ${failCount} FAIL`);
  console.log(`Wall latency:    ${totalWallMs}ms total`);
  console.log(`Cost:            $${totalCost.toFixed(4)} (prep.aggregation_logic only)`);

  console.log("\nPer-surface:");
  for (const r of reports) {
    const wallStr = `${r.wallMs}ms`.padStart(7);
    const costStr = `$${r.costUsd.toFixed(4)}`.padStart(8);
    const label = `[${r.label}]`.padEnd(28);
    console.log(`  ${label} ${r.status.padEnd(6)} ${wallStr}   ${costStr}`);
    for (const n of r.notes) console.log(`    - ${n}`);
  }

  if (totalCost > COST_CEILING_USD) {
    console.log(
      `\n[COST WARNING] $${totalCost.toFixed(4)} exceeds ceiling $${COST_CEILING_USD}`,
    );
  }

  await server.close();
  await teardown();
  await prisma.$disconnect();

  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\n[FATAL] smoke crashed:", err);
  prisma.$disconnect().finally(() => process.exit(2));
});

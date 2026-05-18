// WS6 6d-3 — Cumulative live smoke covering 6d-1 (Cooking Sequencer) +
// 6d-2 (Prep the Week aggregation) against a single shared 3-meal plan.
//
// In-process HTTP (no separate api-server). Spins up Express with the
// production cooking router, mints a JWT for the dev user, POSTs to
// both endpoints against real Anthropic + real Neon.
//
// Shared fixture rationale: one plan gives both endpoints real work to
// do, mirroring how production data will flow (one plan generates both
// kinds of AI orchestration) and catching subtle schema drift between
// the two endpoints' shared data dependencies.
//
// Plan composition (§3.1 of the 6d-3 plan):
//   Meal 1 — Pan-seared Chicken Thighs + Roasted Broccoli (2 dishes, multi)
//   Meal 2 — Spaghetti Carbonara (1 dish, single — exercises no-AI branch)
//   Meal 3 — Pan-seared Salmon + Rice Pilaf (2 dishes, multi)
//
// Cross-meal ingredient overlaps:
//   Yellow onion → M1 + M3   (2-meal produce batch)
//   Garlic       → M1 + M2 + M3 (3-meal produce batch)
//   Three distinct proteins (chicken / guanciale / salmon) → cutting-board-wash
//
// Surfaces under test:
//   - Sequencer Meal 1 (multi-dish AI path)
//   - Sequencer Meal 2 (single-dish degradation — no AI, no LLMCallLog)
//   - Sequencer Meal 3 (multi-dish AI path, different cuisine/protein)
//   - Prep-week cache miss → AI generation
//   - Prep-week cache hit → byte-identical structureJson, no new LLMCallLog
//
// Post-6d test baseline anchored in the preamble (run pre-smoke).
//
// Idempotency: teardown at script start AND end wipes fixture rows by ID.
//
// Run:    pnpm --filter @workspace/api-server exec tsx scripts/ws6-6d-3-smoke.ts
// Prereq: prisma:seed (AIPrompts) AND prisma:seed:dev (Hans's account).
//         ANTHROPIC_API_KEY must be set.

import { PrismaClient } from "@prisma/client";
import express, { type Express } from "express";
import type { Server } from "node:http";

import { signToken } from "../src/lib/auth";
import { createCookingRouter } from "../src/routes/cooking";
import type { SequencedStep } from "../src/lib/ai/schemas/sequencer";
import type { PrepWeekResult } from "../src/lib/ai/schemas/prepWeek";

const prisma = new PrismaClient();

const DEV_USER_EMAIL = "hans.tiefenthaler+8@gmail.com";

// Post-6d test baseline (captured pre-smoke per §3.3 of the 6d-3 plan).
// Re-run `pnpm --filter @workspace/api-server test` to verify stability.
const TEST_BASELINE_TOTAL = 329;
const TEST_BASELINE_PASSING = 327;
const TEST_BASELINE_SKIPPED = 2;

// Stable fixture IDs (valid v4-shape UUIDs — required by PrepWeekInputSchema).
const TEMPLATE_ID = "00000000-6d03-4111-8111-000000000001";
const PLAN_ID = "00000000-6d03-4111-8111-000000000002";

const MEAL_CHICKEN_BROCCOLI = "00000000-6d03-4222-8222-000000000001";
const MEAL_CARBONARA = "00000000-6d03-4222-8222-000000000002";
const MEAL_SALMON_RICE = "00000000-6d03-4222-8222-000000000003";

const DISH_CHICKEN = "00000000-6d03-4333-8333-000000000001";
const DISH_BROCCOLI = "00000000-6d03-4333-8333-000000000002";
const DISH_CARBONARA = "00000000-6d03-4333-8333-000000000003";
const DISH_SALMON = "00000000-6d03-4333-8333-000000000004";
const DISH_RICE = "00000000-6d03-4333-8333-000000000005";

// Smoke-owned ingredients — namespace canonicalName to avoid collisions
// with seeded data.
const ING_PREFIX = "smoke6d3_";
const ING = {
  onion: "00000000-6d03-4444-8444-000000000001",
  garlic: "00000000-6d03-4444-8444-000000000002",
  chicken_thighs: "00000000-6d03-4444-8444-000000000003",
  guanciale: "00000000-6d03-4444-8444-000000000004",
  salmon: "00000000-6d03-4444-8444-000000000005",
  broccoli: "00000000-6d03-4444-8444-000000000006",
  olive_oil: "00000000-6d03-4444-8444-000000000007",
  lemon: "00000000-6d03-4444-8444-000000000008",
  spaghetti: "00000000-6d03-4444-8444-000000000009",
  eggs: "00000000-6d03-4444-8444-00000000000a",
  pecorino: "00000000-6d03-4444-8444-00000000000b",
  rice: "00000000-6d03-4444-8444-00000000000c",
  chicken_broth: "00000000-6d03-4444-8444-00000000000d",
};

const ALL_MEAL_IDS = [
  MEAL_CHICKEN_BROCCOLI,
  MEAL_CARBONARA,
  MEAL_SALMON_RICE,
];
const ALL_DISH_IDS = [
  DISH_CHICKEN,
  DISH_BROCCOLI,
  DISH_CARBONARA,
  DISH_SALMON,
  DISH_RICE,
];
const ALL_INGREDIENT_IDS = Object.values(ING);

// Conservative ceilings per plan: sequencer < 20s, prep-week < 30s,
// per-call cost < $0.10, total cumulative cost ≈ $0.07–0.10.
const PER_CALL_COST_WARN_USD = 0.1;
const SEQUENCER_LATENCY_WARN_MS = 20_000;
const PREPWEEK_LATENCY_WARN_MS = 30_000;
const SINGLE_DISH_LATENCY_CEIL_MS = 1_000;
const CACHE_HIT_LATENCY_CEIL_MS = 500;
const TOTAL_COST_CEILING_USD = 0.2;

interface SurfaceReport {
  label: string;
  status: "PASS" | "FAIL";
  wallMs: number;
  costUsd: number;
  aiCalls: number;
  retryCount: number;
  notes: string[];
}

// ── teardown ──────────────────────────────────────────────────────────

async function teardown(): Promise<void> {
  // PrepWeekStructure cascades on plan delete, but defensive delete first.
  await prisma.prepWeekStructure.deleteMany({ where: { planId: PLAN_ID } });
  // MealPlanItem cascades on plan delete.
  await prisma.mealPlanInstance.deleteMany({ where: { id: PLAN_ID } });
  await prisma.mealPlanTemplate.deleteMany({ where: { id: TEMPLATE_ID } });
  // Steps are polymorphic (no FK) — wipe by ownerType+ownerId.
  await prisma.recipeInstructionStep.deleteMany({
    where: { ownerType: "dish", ownerId: { in: ALL_DISH_IDS } },
  });
  // MealDishLink cascades on meal delete. DishIngredient cascades on dish
  // delete. Belt-and-braces order: links, dishIngredients, meals, dishes,
  // ingredients.
  await prisma.mealDishLink.deleteMany({
    where: { mealId: { in: ALL_MEAL_IDS } },
  });
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

// ── setup ─────────────────────────────────────────────────────────────

async function createIngredients(): Promise<void> {
  await prisma.ingredient.createMany({
    data: [
      { id: ING.onion, canonicalName: `${ING_PREFIX}yellow_onion`, displayName: "yellow onion", category: "Produce", defaultUnit: "medium" },
      { id: ING.garlic, canonicalName: `${ING_PREFIX}garlic`, displayName: "garlic", category: "Produce", defaultUnit: "cloves" },
      { id: ING.chicken_thighs, canonicalName: `${ING_PREFIX}chicken_thighs`, displayName: "boneless chicken thighs", category: "Protein", defaultUnit: "lb" },
      { id: ING.guanciale, canonicalName: `${ING_PREFIX}guanciale`, displayName: "guanciale", category: "Protein", defaultUnit: "oz" },
      { id: ING.salmon, canonicalName: `${ING_PREFIX}salmon_fillet`, displayName: "salmon fillet", category: "Protein", defaultUnit: "lb" },
      { id: ING.broccoli, canonicalName: `${ING_PREFIX}broccoli`, displayName: "broccoli", category: "Produce", defaultUnit: "head" },
      { id: ING.olive_oil, canonicalName: `${ING_PREFIX}olive_oil`, displayName: "olive oil", category: "Pantry", defaultUnit: "tbsp" },
      { id: ING.lemon, canonicalName: `${ING_PREFIX}lemon`, displayName: "lemon", category: "Produce", defaultUnit: "each" },
      { id: ING.spaghetti, canonicalName: `${ING_PREFIX}spaghetti`, displayName: "spaghetti", category: "Pantry", defaultUnit: "oz" },
      { id: ING.eggs, canonicalName: `${ING_PREFIX}eggs`, displayName: "large eggs", category: "Dairy", defaultUnit: "each" },
      { id: ING.pecorino, canonicalName: `${ING_PREFIX}pecorino`, displayName: "pecorino romano", category: "Dairy", defaultUnit: "oz" },
      { id: ING.rice, canonicalName: `${ING_PREFIX}long_grain_rice`, displayName: "long-grain rice", category: "Pantry", defaultUnit: "cup" },
      { id: ING.chicken_broth, canonicalName: `${ING_PREFIX}chicken_broth`, displayName: "chicken broth", category: "Pantry", defaultUnit: "cup" },
    ],
  });
}

async function createFixture(userId: string): Promise<void> {
  await createIngredients();

  // Dishes.
  await prisma.dish.createMany({
    data: [
      { id: DISH_CHICKEN, userId, title: "Pan-seared Chicken Thighs", estimatedTimeMinutes: 20, servingsDefault: 4 },
      { id: DISH_BROCCOLI, userId, title: "Roasted Broccoli", estimatedTimeMinutes: 18, servingsDefault: 4 },
      { id: DISH_CARBONARA, userId, title: "Spaghetti Carbonara", estimatedTimeMinutes: 20, servingsDefault: 4 },
      { id: DISH_SALMON, userId, title: "Pan-seared Salmon", estimatedTimeMinutes: 18, servingsDefault: 4 },
      { id: DISH_RICE, userId, title: "Rice Pilaf", estimatedTimeMinutes: 25, servingsDefault: 4 },
    ],
  });

  // DishIngredients — laid out for prep-week aggregation hits.
  // Cross-meal overlaps:
  //   onion: chicken (M1, diced) + rice (M3, diced) → 2-meal produce batch
  //   garlic: chicken (M1, minced) + carbonara (M2, minced) + rice (M3, minced) → 3-meal produce batch
  //   Three proteins: chicken_thighs (M1), guanciale (M2), salmon (M3) → cutting-board-wash in proteins phase
  await prisma.dishIngredient.createMany({
    data: [
      // M1 Dish A — chicken thighs
      { dishId: DISH_CHICKEN, ingredientId: ING.chicken_thighs, quantity: 1.5, unit: "lb", preparationNote: null, positionIndex: 0 },
      { dishId: DISH_CHICKEN, ingredientId: ING.onion, quantity: 1, unit: "medium", preparationNote: "diced", positionIndex: 1 },
      { dishId: DISH_CHICKEN, ingredientId: ING.garlic, quantity: 2, unit: "cloves", preparationNote: "minced", positionIndex: 2 },
      { dishId: DISH_CHICKEN, ingredientId: ING.olive_oil, quantity: 2, unit: "tbsp", preparationNote: null, positionIndex: 3 },
      { dishId: DISH_CHICKEN, ingredientId: ING.lemon, quantity: 0.5, unit: "each", preparationNote: "juiced", positionIndex: 4 },
      // M1 Dish B — broccoli
      { dishId: DISH_BROCCOLI, ingredientId: ING.broccoli, quantity: 1, unit: "head", preparationNote: "cut into florets", positionIndex: 0 },
      { dishId: DISH_BROCCOLI, ingredientId: ING.olive_oil, quantity: 2, unit: "tbsp", preparationNote: null, positionIndex: 1 },
      // M2 — Carbonara (single dish, also contributes garlic for cross-meal aggregation)
      { dishId: DISH_CARBONARA, ingredientId: ING.spaghetti, quantity: 12, unit: "oz", preparationNote: null, positionIndex: 0 },
      { dishId: DISH_CARBONARA, ingredientId: ING.guanciale, quantity: 4, unit: "oz", preparationNote: "diced", positionIndex: 1 },
      { dishId: DISH_CARBONARA, ingredientId: ING.eggs, quantity: 3, unit: "each", preparationNote: null, positionIndex: 2 },
      { dishId: DISH_CARBONARA, ingredientId: ING.pecorino, quantity: 2, unit: "oz", preparationNote: "grated", positionIndex: 3 },
      { dishId: DISH_CARBONARA, ingredientId: ING.garlic, quantity: 1, unit: "cloves", preparationNote: "minced", positionIndex: 4 },
      // M3 Dish A — salmon
      { dishId: DISH_SALMON, ingredientId: ING.salmon, quantity: 1, unit: "lb", preparationNote: null, positionIndex: 0 },
      { dishId: DISH_SALMON, ingredientId: ING.olive_oil, quantity: 1, unit: "tbsp", preparationNote: null, positionIndex: 1 },
      { dishId: DISH_SALMON, ingredientId: ING.lemon, quantity: 0.5, unit: "each", preparationNote: "juiced", positionIndex: 2 },
      // M3 Dish B — rice pilaf
      { dishId: DISH_RICE, ingredientId: ING.rice, quantity: 1, unit: "cup", preparationNote: null, positionIndex: 0 },
      { dishId: DISH_RICE, ingredientId: ING.chicken_broth, quantity: 2, unit: "cup", preparationNote: null, positionIndex: 1 },
      { dishId: DISH_RICE, ingredientId: ING.onion, quantity: 1, unit: "medium", preparationNote: "diced", positionIndex: 2 },
      { dishId: DISH_RICE, ingredientId: ING.garlic, quantity: 2, unit: "cloves", preparationNote: "minced", positionIndex: 3 },
      { dishId: DISH_RICE, ingredientId: ING.olive_oil, quantity: 1, unit: "tbsp", preparationNote: null, positionIndex: 4 },
    ],
  });

  // Meals.
  await prisma.meal.createMany({
    data: [
      { id: MEAL_CHICKEN_BROCCOLI, userId, title: "Pan-seared chicken thighs with roasted broccoli", estimatedTimeMinutes: 30, servingsDefault: 4 },
      { id: MEAL_CARBONARA, userId, title: "Spaghetti Carbonara", estimatedTimeMinutes: 20, servingsDefault: 4, cuisineType: "italian" },
      { id: MEAL_SALMON_RICE, userId, title: "Pan-seared salmon with rice pilaf", estimatedTimeMinutes: 30, servingsDefault: 4 },
    ],
  });

  await prisma.mealDishLink.createMany({
    data: [
      { mealId: MEAL_CHICKEN_BROCCOLI, dishId: DISH_CHICKEN, positionIndex: 0, roleLabel: "main" },
      { mealId: MEAL_CHICKEN_BROCCOLI, dishId: DISH_BROCCOLI, positionIndex: 1, roleLabel: "side" },
      { mealId: MEAL_CARBONARA, dishId: DISH_CARBONARA, positionIndex: 0, roleLabel: "main" },
      { mealId: MEAL_SALMON_RICE, dishId: DISH_SALMON, positionIndex: 0, roleLabel: "main" },
      { mealId: MEAL_SALMON_RICE, dishId: DISH_RICE, positionIndex: 1, roleLabel: "side" },
    ],
  });

  // RecipeInstructionStep rows for each dish — sequencer needs these.
  await createSteps();

  // Template + plan instance with items.
  await prisma.mealPlanTemplate.create({
    data: {
      id: TEMPLATE_ID,
      userId,
      title: "Smoke 6d-3 3-meal week",
      defaultDaysCount: 3,
    },
  });
  await prisma.mealPlanInstance.create({
    data: {
      id: PLAN_ID,
      userId,
      mealPlanTemplateId: TEMPLATE_ID,
      titleOverride: "Smoke 6d-3 week",
      items: {
        create: [
          { mealId: MEAL_CHICKEN_BROCCOLI, positionIndex: 0, assignedDayOfWeek: "Mon" },
          { mealId: MEAL_CARBONARA, positionIndex: 1, assignedDayOfWeek: "Wed" },
          { mealId: MEAL_SALMON_RICE, positionIndex: 2, assignedDayOfWeek: "Fri" },
        ],
      },
    },
  });

  console.log("[setup] fixture created (3 meals, 5 dishes, 20 ingredient links, 23 steps)");
}

async function createSteps(): Promise<void> {
  // M1 Dish A — Chicken thighs (5 steps, ~20min, sear at idx 2 timing-sensitive)
  await prisma.recipeInstructionStep.createMany({
    data: [
      { ownerType: "dish", ownerId: DISH_CHICKEN, stepIndex: 0, stepTextRaw: "Pat the chicken thighs dry and season generously with salt and pepper.", stepTextTranslated: "Pat the chicken thighs dry and season generously with salt and pepper.", estimatedMinutes: 2, phaseType: "prep", parallelGroup: null },
      { ownerType: "dish", ownerId: DISH_CHICKEN, stepIndex: 1, stepTextRaw: "Heat olive oil in a large skillet over medium-high heat until shimmering.", stepTextTranslated: "Heat olive oil in a large skillet over medium-high heat until shimmering.", estimatedMinutes: 3, phaseType: "preheat", parallelGroup: null },
      { ownerType: "dish", ownerId: DISH_CHICKEN, stepIndex: 2, stepTextRaw: "Sear the chicken skin-side down for 7 minutes without moving, then flip and cook 5 more minutes.", stepTextTranslated: "Sear the chicken skin-side down for 7 minutes without moving, then flip and cook 5 more minutes.", estimatedMinutes: 12, phaseType: "cook", parallelGroup: null, isTimingSensitive: true },
      { ownerType: "dish", ownerId: DISH_CHICKEN, stepIndex: 3, stepTextRaw: "Add diced onion and minced garlic; sauté 2 minutes until fragrant.", stepTextTranslated: "Add diced onion and minced garlic; sauté 2 minutes until fragrant.", estimatedMinutes: 2, phaseType: "cook", parallelGroup: null },
      { ownerType: "dish", ownerId: DISH_CHICKEN, stepIndex: 4, stepTextRaw: "Squeeze lemon juice over and let rest 3 minutes before serving.", stepTextTranslated: "Squeeze lemon juice over and let rest 3 minutes before serving.", estimatedMinutes: 3, phaseType: "rest", parallelGroup: null },
    ],
  });

  // M1 Dish B — Roasted broccoli (3 steps, ~18min, steam-window timing-sensitive)
  await prisma.recipeInstructionStep.createMany({
    data: [
      { ownerType: "dish", ownerId: DISH_BROCCOLI, stepIndex: 0, stepTextRaw: "Preheat oven to 425F.", stepTextTranslated: "Preheat oven to 425F.", estimatedMinutes: 5, phaseType: "preheat", parallelGroup: null },
      { ownerType: "dish", ownerId: DISH_BROCCOLI, stepIndex: 1, stepTextRaw: "Toss broccoli florets with olive oil, salt, and pepper on a sheet pan.", stepTextTranslated: "Toss broccoli florets with olive oil, salt, and pepper on a sheet pan.", estimatedMinutes: 3, phaseType: "prep", parallelGroup: null },
      { ownerType: "dish", ownerId: DISH_BROCCOLI, stepIndex: 2, stepTextRaw: "Roast 15 minutes until edges are charred and stems are crisp-tender.", stepTextTranslated: "Roast 15 minutes until edges are charred and stems are crisp-tender.", estimatedMinutes: 15, phaseType: "cook", parallelGroup: "passive-roast" },
    ],
  });

  // M2 — Carbonara (5 steps, ~20min, single-dish path — no AI)
  await prisma.recipeInstructionStep.createMany({
    data: [
      { ownerType: "dish", ownerId: DISH_CARBONARA, stepIndex: 0, stepTextRaw: "Bring a large pot of salted water to a boil.", stepTextTranslated: "Bring a large pot of salted water to a boil.", estimatedMinutes: 8, phaseType: "preheat", parallelGroup: null },
      { ownerType: "dish", ownerId: DISH_CARBONARA, stepIndex: 1, stepTextRaw: "Render diced guanciale in a cold skillet over medium heat until crisp.", stepTextTranslated: "Render diced guanciale in a cold skillet over medium heat until crisp.", estimatedMinutes: 6, phaseType: "cook", parallelGroup: null },
      { ownerType: "dish", ownerId: DISH_CARBONARA, stepIndex: 2, stepTextRaw: "Whisk eggs and grated pecorino in a bowl; season with black pepper.", stepTextTranslated: "Whisk eggs and grated pecorino in a bowl; season with black pepper.", estimatedMinutes: 2, phaseType: "prep", parallelGroup: null },
      { ownerType: "dish", ownerId: DISH_CARBONARA, stepIndex: 3, stepTextRaw: "Cook spaghetti until al dente; reserve 1 cup pasta water before draining.", stepTextTranslated: "Cook spaghetti until al dente; reserve 1 cup pasta water before draining.", estimatedMinutes: 9, phaseType: "cook", parallelGroup: null },
      { ownerType: "dish", ownerId: DISH_CARBONARA, stepIndex: 4, stepTextRaw: "Off heat, toss pasta with guanciale and egg mixture, loosening with pasta water until creamy.", stepTextTranslated: "Off heat, toss pasta with guanciale and egg mixture, loosening with pasta water until creamy.", estimatedMinutes: 2, phaseType: "assemble", parallelGroup: null },
    ],
  });

  // M3 Dish A — Salmon (5 steps, ~18min, sear at idx 2 timing-sensitive)
  await prisma.recipeInstructionStep.createMany({
    data: [
      { ownerType: "dish", ownerId: DISH_SALMON, stepIndex: 0, stepTextRaw: "Pat salmon fillets dry and season with salt and pepper.", stepTextTranslated: "Pat salmon fillets dry and season with salt and pepper.", estimatedMinutes: 2, phaseType: "prep", parallelGroup: null },
      { ownerType: "dish", ownerId: DISH_SALMON, stepIndex: 1, stepTextRaw: "Heat olive oil in a large skillet over medium-high heat until shimmering.", stepTextTranslated: "Heat olive oil in a large skillet over medium-high heat until shimmering.", estimatedMinutes: 3, phaseType: "preheat", parallelGroup: null },
      { ownerType: "dish", ownerId: DISH_SALMON, stepIndex: 2, stepTextRaw: "Sear salmon skin-side down 6 minutes without moving, then flip 3 minutes.", stepTextTranslated: "Sear salmon skin-side down 6 minutes without moving, then flip 3 minutes.", estimatedMinutes: 9, phaseType: "cook", parallelGroup: null, isTimingSensitive: true },
      { ownerType: "dish", ownerId: DISH_SALMON, stepIndex: 3, stepTextRaw: "Transfer to a plate and rest 3 minutes, tented with foil.", stepTextTranslated: "Transfer to a plate and rest 3 minutes, tented with foil.", estimatedMinutes: 3, phaseType: "rest", parallelGroup: null },
      { ownerType: "dish", ownerId: DISH_SALMON, stepIndex: 4, stepTextRaw: "Finish with a squeeze of lemon and serve.", stepTextTranslated: "Finish with a squeeze of lemon and serve.", estimatedMinutes: 1, phaseType: "assemble", parallelGroup: null },
    ],
  });

  // M3 Dish B — Rice pilaf (5 steps, ~25min, simmer at idx 3 timing-sensitive)
  await prisma.recipeInstructionStep.createMany({
    data: [
      { ownerType: "dish", ownerId: DISH_RICE, stepIndex: 0, stepTextRaw: "Melt olive oil in a medium saucepan over medium heat.", stepTextTranslated: "Melt olive oil in a medium saucepan over medium heat.", estimatedMinutes: 2, phaseType: "preheat", parallelGroup: null },
      { ownerType: "dish", ownerId: DISH_RICE, stepIndex: 1, stepTextRaw: "Add diced onion and minced garlic; sauté 3 minutes until softened.", stepTextTranslated: "Add diced onion and minced garlic; sauté 3 minutes until softened.", estimatedMinutes: 3, phaseType: "cook", parallelGroup: null },
      { ownerType: "dish", ownerId: DISH_RICE, stepIndex: 2, stepTextRaw: "Add rice and toast 2 minutes, stirring frequently.", stepTextTranslated: "Add rice and toast 2 minutes, stirring frequently.", estimatedMinutes: 2, phaseType: "cook", parallelGroup: null },
      { ownerType: "dish", ownerId: DISH_RICE, stepIndex: 3, stepTextRaw: "Pour in chicken broth, bring to a boil, then cover and simmer on low until liquid is absorbed.", stepTextTranslated: "Pour in chicken broth, bring to a boil, then cover and simmer on low until liquid is absorbed.", estimatedMinutes: 16, phaseType: "cook", parallelGroup: "passive-simmer" },
      { ownerType: "dish", ownerId: DISH_RICE, stepIndex: 4, stepTextRaw: "Fluff rice with a fork and let stand 2 minutes before serving.", stepTextTranslated: "Fluff rice with a fork and let stand 2 minutes before serving.", estimatedMinutes: 2, phaseType: "rest", parallelGroup: null },
    ],
  });
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

async function readLog(
  userId: string,
  promptKey: string,
  since: Date,
): Promise<{ count: number; costUsd: number; latencyMs: number; retryCount: number; promptVersion: number | null }> {
  const rows = await prisma.lLMCallLog.findMany({
    where: { userId, promptKey, createdAt: { gte: since } },
    select: { costEstimateUsd: true, latencyMs: true, retryCount: true, promptVersion: true },
    orderBy: { createdAt: "desc" },
  });
  const costUsd = rows.reduce((s, r) => s + Number(r.costEstimateUsd ?? 0), 0);
  const latencyMs = rows.reduce((s, r) => s + (r.latencyMs ?? 0), 0);
  const retryCount = rows.reduce((s, r) => s + (r.retryCount ?? 0), 0);
  return {
    count: rows.length,
    costUsd,
    latencyMs,
    retryCount,
    promptVersion: rows[0]?.promptVersion ?? null,
  };
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

interface SequencerResponse {
  sequence: SequencedStep[];
  totalEstimatedMinutes: number;
  dishCount: number;
  usedAI: boolean;
}

interface PrepWeekResponse {
  cacheHit: boolean;
  result: PrepWeekResult;
  planRevisionId: number;
  generatedAt: string;
  promptVersion: number;
  metadata?: { latencyMs?: number };
}

function checkSequencerMultiDish(
  body: SequencerResponse,
  expectedDishCount: number,
  expectedStepCount: number,
  timingSensitiveSteps: Array<{ dishId: string; originalStepIndex: number }>,
  notes: string[],
): string[] {
  const checks: string[] = [];

  if (!body.usedAI) checks.push("usedAI was false on multi-dish");
  if (body.dishCount !== expectedDishCount) {
    checks.push(`dishCount expected ${expectedDishCount}, got ${body.dishCount}`);
  }
  if (body.sequence.length !== expectedStepCount) {
    checks.push(`steps expected ${expectedStepCount}, got ${body.sequence.length}`);
  }

  const sortedByIdx = [...body.sequence].sort(
    (a, b) => a.sequenceIndex - b.sequenceIndex,
  );

  // Contiguous monotonic sequenceIndex 0..n-1.
  for (let i = 0; i < sortedByIdx.length; i++) {
    if (sortedByIdx[i].sequenceIndex !== i) {
      checks.push(`sequenceIndex gap at position ${i}: got ${sortedByIdx[i].sequenceIndex}`);
      break;
    }
  }

  // Each (dishId, originalStepIndex) appears exactly once.
  const seen = new Set<string>();
  for (const s of sortedByIdx) {
    const key = `${s.dishId}:${s.originalStepIndex}`;
    if (seen.has(key)) {
      checks.push(`duplicate step in output: ${key}`);
      break;
    }
    seen.add(key);
  }

  // Intra-dish order preserved.
  const perDishLast = new Map<string, number>();
  for (const s of sortedByIdx) {
    const last = perDishLast.get(s.dishId);
    if (last !== undefined && s.originalStepIndex < last) {
      checks.push(
        `intra-dish order inverted: dish ${s.dishId} step ${s.originalStepIndex} after ${last}`,
      );
      break;
    }
    perDishLast.set(s.dishId, s.originalStepIndex);
  }

  // No foreign-dish step inserted between a timing-sensitive step and the
  // next step of the same dish (sequencer's no-weave rule).
  let weaveViolations = 0;
  for (const ts of timingSensitiveSteps) {
    const tsPos = sortedByIdx.findIndex(
      (s) => s.dishId === ts.dishId && s.originalStepIndex === ts.originalStepIndex,
    );
    if (tsPos < 0) continue;
    // Find the next step from the same dish after this position.
    const nextSameDishPos = sortedByIdx.findIndex(
      (s, i) => i > tsPos && s.dishId === ts.dishId,
    );
    if (nextSameDishPos < 0) continue; // ts was the last step from that dish — fine.
    // Anything between tsPos and nextSameDishPos from another dish is a violation.
    for (let i = tsPos + 1; i < nextSameDishPos; i++) {
      if (sortedByIdx[i].dishId !== ts.dishId) {
        weaveViolations++;
        break;
      }
    }
  }
  notes.push(`timing_sensitive_weave_violations=${weaveViolations}`);
  if (weaveViolations > 0) {
    checks.push(
      `${weaveViolations} timing-sensitive no-weave violation(s) — sequencer scheduled a foreign step between a timing-sensitive step and the next same-dish step`,
    );
  }

  // At least some reason annotations present.
  const withReason = body.sequence.filter((s) => typeof s.reason === "string" && s.reason);
  notes.push(`reasonsAnnotated=${withReason.length}/${body.sequence.length}`);
  if (withReason.length === 0) {
    checks.push("no `reason` annotations present (expected at least some on multi-dish)");
  } else {
    for (const s of withReason.slice(0, 2)) {
      notes.push(`reason@seq${s.sequenceIndex}: "${s.reason}"`);
    }
  }

  return checks;
}

async function surface_sequencerMulti(
  label: string,
  mealId: string,
  baseUrl: string,
  token: string,
  userId: string,
  expectedDishCount: number,
  expectedStepCount: number,
  timingSensitiveSteps: Array<{ dishId: string; originalStepIndex: number }>,
): Promise<SurfaceReport> {
  console.log(`\n══ [${label}] multi-dish AI sequencer ══`);
  const wallStart = Date.now();
  const since = new Date();
  const notes: string[] = [];

  const res = await fetch(`${baseUrl}/meals/${mealId}/cooking-sequence`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const wallMs = Date.now() - wallStart;
  notes.push(`http_status=${res.status}`);

  if (res.status !== 200) {
    const text = await res.text();
    notes.push(`non-200 body: ${text.slice(0, 400)}`);
    return {
      label,
      status: "FAIL",
      wallMs,
      costUsd: 0,
      aiCalls: 0,
      retryCount: 0,
      notes,
    };
  }

  const body = (await res.json()) as SequencerResponse;
  const log = await readLog(userId, "sequencer.step_ordering", since);

  notes.push(`usedAI=${body.usedAI}`);
  notes.push(`dishCount=${body.dishCount}`);
  notes.push(`steps=${body.sequence.length}`);
  notes.push(`totalEstimatedMinutes=${body.totalEstimatedMinutes}`);
  notes.push(`llmCallLogRows=${log.count}`);
  notes.push(`ai_latencyMs=${log.latencyMs}`);
  notes.push(`retries=${log.retryCount}`);
  if (log.promptVersion !== null) notes.push(`promptVersion=${log.promptVersion}`);

  const checks: string[] = checkSequencerMultiDish(
    body,
    expectedDishCount,
    expectedStepCount,
    timingSensitiveSteps,
    notes,
  );
  if (log.count !== 1) {
    checks.push(`LLMCallLog expected 1 row, got ${log.count}`);
  }
  if (log.costUsd <= 0) {
    checks.push(`LLMCallLog costUsd expected > 0, got ${log.costUsd}`);
  }
  if (log.costUsd > PER_CALL_COST_WARN_USD) {
    notes.push(
      `[WARN] per-call cost $${log.costUsd.toFixed(4)} > $${PER_CALL_COST_WARN_USD}`,
    );
  }
  if (wallMs > SEQUENCER_LATENCY_WARN_MS) {
    notes.push(`[WARN] wall latency ${wallMs}ms > ${SEQUENCER_LATENCY_WARN_MS}ms`);
  }

  const pass = checks.length === 0;
  if (!pass) for (const c of checks) notes.push(`CHECK FAILED: ${c}`);

  return {
    label,
    status: pass ? "PASS" : "FAIL",
    wallMs,
    costUsd: log.costUsd,
    aiCalls: log.count,
    retryCount: log.retryCount,
    notes,
  };
}

async function surface_sequencerSingle(
  baseUrl: string,
  token: string,
  userId: string,
): Promise<SurfaceReport> {
  console.log(`\n══ [seq-M2] single-dish degradation (no AI) ══`);
  const wallStart = Date.now();
  const since = new Date();
  const notes: string[] = [];

  const res = await fetch(`${baseUrl}/meals/${MEAL_CARBONARA}/cooking-sequence`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const wallMs = Date.now() - wallStart;
  notes.push(`http_status=${res.status}`);

  if (res.status !== 200) {
    const text = await res.text();
    notes.push(`non-200 body: ${text.slice(0, 400)}`);
    return {
      label: "seq-M2 (single-dish)",
      status: "FAIL",
      wallMs,
      costUsd: 0,
      aiCalls: 0,
      retryCount: 0,
      notes,
    };
  }

  const body = (await res.json()) as SequencerResponse;
  const log = await readLog(userId, "sequencer.step_ordering", since);

  notes.push(`usedAI=${body.usedAI}`);
  notes.push(`dishCount=${body.dishCount}`);
  notes.push(`steps=${body.sequence.length}`);
  notes.push(`totalEstimatedMinutes=${body.totalEstimatedMinutes}`);
  notes.push(`llmCallLogRowsSinceStart=${log.count}`);

  const checks: string[] = [];
  if (body.usedAI) checks.push("usedAI was true on single-dish (must be false)");
  if (body.dishCount !== 1) checks.push(`dishCount expected 1, got ${body.dishCount}`);
  if (body.sequence.length !== 5) {
    checks.push(`steps expected 5 (carbonara), got ${body.sequence.length}`);
  }
  if (log.count !== 0) {
    checks.push(`LLMCallLog expected 0 rows (no AI), got ${log.count}`);
  }
  if (wallMs > SINGLE_DISH_LATENCY_CEIL_MS) {
    checks.push(
      `single-dish latency ${wallMs}ms exceeds ceiling ${SINGLE_DISH_LATENCY_CEIL_MS}ms (no AI path should be fast)`,
    );
  }
  // 8 + 6 + 2 + 9 + 2 = 27 minutes expected.
  if (body.totalEstimatedMinutes !== 27) {
    checks.push(`totalEstimatedMinutes expected 27, got ${body.totalEstimatedMinutes}`);
  }
  // sequenceIndex == originalStepIndex on single-dish branch (verbatim order).
  for (const s of body.sequence) {
    if (s.sequenceIndex !== s.originalStepIndex) {
      checks.push(
        `single-dish sequenceIndex ${s.sequenceIndex} != originalStepIndex ${s.originalStepIndex} (must be verbatim)`,
      );
      break;
    }
  }
  // No `reason` annotations on single-dish branch.
  for (const s of body.sequence) {
    if (s.reason !== undefined) {
      checks.push(`single-dish step ${s.sequenceIndex} has reason (should be omitted on no-AI path)`);
      break;
    }
  }
  // Cumulative startsAtMinutes.
  const expectedStarts = [0, 8, 14, 16, 25];
  for (let i = 0; i < expectedStarts.length; i++) {
    if (body.sequence[i].startsAtMinutes !== expectedStarts[i]) {
      checks.push(
        `single-dish startsAtMinutes[${i}] expected ${expectedStarts[i]}, got ${body.sequence[i].startsAtMinutes}`,
      );
      break;
    }
  }

  const pass = checks.length === 0;
  if (!pass) for (const c of checks) notes.push(`CHECK FAILED: ${c}`);

  return {
    label: "seq-M2 (single-dish)",
    status: pass ? "PASS" : "FAIL",
    wallMs,
    costUsd: 0,
    aiCalls: 0,
    retryCount: 0,
    notes,
  };
}

async function surface_prepWeekMiss(
  baseUrl: string,
  token: string,
  userId: string,
): Promise<SurfaceReport> {
  console.log("\n══ [prep-week miss] AI generation ══");
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
    return {
      label: "prep-week miss → AI",
      status: "FAIL",
      wallMs,
      costUsd: 0,
      aiCalls: 0,
      retryCount: 0,
      notes,
    };
  }

  const body = (await res.json()) as PrepWeekResponse;
  const log = await readLog(userId, "prep.aggregation_logic", since);

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
  if (log.costUsd > PER_CALL_COST_WARN_USD) {
    notes.push(
      `[WARN] per-call cost $${log.costUsd.toFixed(4)} > $${PER_CALL_COST_WARN_USD}`,
    );
  }
  if (wallMs > PREPWEEK_LATENCY_WARN_MS) {
    notes.push(`[WARN] wall latency ${wallMs}ms > ${PREPWEEK_LATENCY_WARN_MS}ms`);
  }

  // Aggregation expectation: at least one Phase 3 (produce) step covers ≥2 meals.
  const produceMultiStep = phases[2]?.steps.find(
    (s) => s.contributesToMealIds.length >= 2,
  );
  if (!produceMultiStep) {
    checks.push("expected at least one Phase 3 step covering >=2 meals (onion or garlic batch)");
  } else {
    notes.push(
      `produce_multi_step: "${produceMultiStep.title}" covers ${produceMultiStep.contributesToMealIds.length} meals`,
    );
  }

  // Multi-protein cutting-board-wash step expected in Phase 4 (3 distinct proteins).
  const proteinSteps = phases[3]?.steps ?? [];
  const washStep = proteinSteps.find((s) =>
    /(wash|clean|sanitize).*(cutting board|board|knife)/i.test(s.instructions + " " + s.title),
  );
  if (!washStep) {
    checks.push("expected a cutting-board-wash step in Phase 4 (3 distinct proteins scenario)");
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

  const phaseCounts = phases.map((p) => `${p.phase}=${p.steps.length}`).join(", ");
  notes.push(`phase_step_counts: ${phaseCounts}`);

  const pass = checks.length === 0;
  if (!pass) for (const c of checks) notes.push(`CHECK FAILED: ${c}`);

  return {
    label: "prep-week miss → AI",
    status: pass ? "PASS" : "FAIL",
    wallMs,
    costUsd: log.costUsd,
    aiCalls: log.count,
    retryCount: log.retryCount,
    notes,
  };
}

async function surface_prepWeekHit(
  baseUrl: string,
  token: string,
  userId: string,
): Promise<SurfaceReport> {
  console.log("\n══ [prep-week hit] second invocation ══");
  const wallStart = Date.now();
  const since = new Date();
  const notes: string[] = [];

  const preCached = await prisma.prepWeekStructure.findUnique({
    where: { planId: PLAN_ID },
  });
  if (!preCached) {
    return {
      label: "prep-week hit",
      status: "FAIL",
      wallMs: 0,
      costUsd: 0,
      aiCalls: 0,
      retryCount: 0,
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
    return {
      label: "prep-week hit",
      status: "FAIL",
      wallMs,
      costUsd: 0,
      aiCalls: 0,
      retryCount: 0,
      notes,
    };
  }

  const body = (await res.json()) as PrepWeekResponse;
  const log = await readLog(userId, "prep.aggregation_logic", since);

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
  if (wallMs > CACHE_HIT_LATENCY_CEIL_MS) {
    checks.push(
      `cache-hit latency ${wallMs}ms exceeds ceiling ${CACHE_HIT_LATENCY_CEIL_MS}ms (no AI path should be fast)`,
    );
  }

  const pass = checks.length === 0;
  if (!pass) for (const c of checks) notes.push(`CHECK FAILED: ${c}`);

  return {
    label: "prep-week hit",
    status: pass ? "PASS" : "FAIL",
    wallMs,
    costUsd: 0,
    aiCalls: 0,
    retryCount: 0,
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
  console.log("WS6 6d-3 — Cumulative live smoke (6d-1 sequencer + 6d-2 prep-week)");
  console.log("══════════════════════════════════════════════════════════");
  console.log(
    `Post-6d test baseline: ${TEST_BASELINE_TOTAL} tests ` +
      `(${TEST_BASELINE_PASSING} passing, ${TEST_BASELINE_SKIPPED} skipped) ` +
      `— anchor for 6-CLOSE`,
  );

  const runStartIso = new Date().toISOString();
  const userId = await getDevUserId();
  console.log(`dev user: ${userId} (${DEV_USER_EMAIL})`);

  await teardown();
  await createFixture(userId);

  const server = await startInProcessServer();
  const token = signToken(userId);

  // Run order matches §3.2 of the 6d-3 plan.
  const wallStart = Date.now();

  // Surface 1: Sequencer Meal 1 — chicken thighs + roasted broccoli (multi-dish).
  // 8 steps total (5 chicken + 3 broccoli). Only the chicken sear is genuinely
  // timing-sensitive — broccoli roast is parallelGroup "passive-roast" so the
  // sequencer is expected (and encouraged) to weave during that 15-min window.
  const rSeqM1 = await surface_sequencerMulti(
    "seq-M1 (chicken+broccoli)",
    MEAL_CHICKEN_BROCCOLI,
    server.baseUrl,
    token,
    userId,
    2,
    8,
    [{ dishId: DISH_CHICKEN, originalStepIndex: 2 }],
  );

  // Surface 2: Sequencer Meal 2 — carbonara (single-dish, no AI).
  const rSeqM2 = await surface_sequencerSingle(server.baseUrl, token, userId);

  // Surface 3: Sequencer Meal 3 — salmon + rice pilaf (multi-dish).
  // 10 steps total (5 salmon + 5 rice). Only the salmon sear is genuinely
  // timing-sensitive — rice simmer is parallelGroup "passive-simmer", which
  // explicitly signals the 16-min window is hands-free for other-dish work.
  const rSeqM3 = await surface_sequencerMulti(
    "seq-M3 (salmon+rice)",
    MEAL_SALMON_RICE,
    server.baseUrl,
    token,
    userId,
    2,
    10,
    [{ dishId: DISH_SALMON, originalStepIndex: 2 }],
  );

  // Surface 4: Prep-week miss.
  const rMiss = await surface_prepWeekMiss(server.baseUrl, token, userId);

  // Surface 5: Prep-week hit.
  const rHit = await surface_prepWeekHit(server.baseUrl, token, userId);

  const totalWallMs = Date.now() - wallStart;

  const reports = [rSeqM1, rSeqM2, rSeqM3, rMiss, rHit];
  const passCount = reports.filter((r) => r.status === "PASS").length;
  const failCount = reports.filter((r) => r.status === "FAIL").length;
  const totalCost = reports.reduce((s, r) => s + r.costUsd, 0);
  const totalAiCalls = reports.reduce((s, r) => s + r.aiCalls, 0);
  const totalRetries = reports.reduce((s, r) => s + r.retryCount, 0);
  // Wall latency excluding cache hit per §3.2 step 7.
  const wallExcludingCacheHit = reports
    .filter((r) => r.label !== "prep-week hit")
    .reduce((s, r) => s + r.wallMs, 0);

  // ── report ─────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("=== WS6 6d-3 Cumulative Smoke ===");
  console.log(`Run date:               ${runStartIso}`);
  console.log(
    `Surfaces:               5 (3 sequencer + 2 prep-week), ${passCount} PASS, ${failCount} FAIL`,
  );
  console.log(`Wall (all):             ${totalWallMs}ms`);
  console.log(`Wall (excl cache-hit):  ${wallExcludingCacheHit}ms`);
  console.log(`AI calls fired:         ${totalAiCalls} (expected 3: seq-M1, seq-M3, prep-week miss)`);
  console.log(`Retries observed:       ${totalRetries}`);
  console.log(`Cumulative cost:        $${totalCost.toFixed(4)}`);

  console.log("\nPer-surface:");
  for (const r of reports) {
    const wallStr = `${r.wallMs}ms`.padStart(7);
    const costStr = `$${r.costUsd.toFixed(4)}`.padStart(8);
    const label = `[${r.label}]`.padEnd(32);
    console.log(`  ${label} ${r.status.padEnd(6)} ${wallStr}   ${costStr}`);
    for (const n of r.notes) console.log(`    - ${n}`);
  }

  if (totalCost > TOTAL_COST_CEILING_USD) {
    console.log(
      `\n[COST WARNING] $${totalCost.toFixed(4)} exceeds ceiling $${TOTAL_COST_CEILING_USD}`,
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

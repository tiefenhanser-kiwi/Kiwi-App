// WS6 6c-7 Block 2 — Cumulative live smoke across all seven 6c surfaces.
//
// Helper-direct (no HTTP). Imports the production helpers and runs them
// against real Anthropic + real Neon. Mirrors the convention from
// ws6-6c-1-smoke.ts and ws6-6b-6-smoke.ts. The api-server process does
// NOT need to be running.
//
// Substrate-only sites (route handler envelopes NOT exercised — those are
// covered by the automated test suite):
//   - 6c-1 URL Import — buildStructuredHints + htmlToText helpers are
//     route-private (recipes.ts:118-216); we replicate them inline.
//   - 6c-4 Generate Grocery — the persistence transaction at
//     groceryLists.ts:205-244 (creates the list + items + activity) is
//     replicated inline.
//   - 6c-6 Persistent add — the inline prisma write + activity emit at
//     groceryLists.ts:470-511 is replicated inline.
//
// Image fixture: scripts/fixtures/recipe-card.jpg
//   Source: https://commons.wikimedia.org/wiki/File:Boiled_Calf%E2%80%99s_Head_recipe_(1854).jpg
//   License: CC0 1.0 Universal Public Domain Dedication.
//   Origin: "The American Home Cook Book" (1854), anonymous author.
//   Size: 920 KB, 1678x1454 JPEG. Above the 200-500 KB target — readable
//   recipe-text dominates over byte-count for a vision fixture.
//
// Idempotency: teardown at script start deletes any existing grocery list
// on dev-plan-instance-spice-it-up (items cascade-delete via the GroceryList
// FK). Re-run safe.
//
// First-run image fixture validation: if the image surface returns
// no_recipe_content AND no fixtures/.recipe-card-validated marker exists,
// the script exits non-zero and the run is treated as a borderline-fixture
// FAIL. The marker is written on first PASS so subsequent
// no_recipe_content responses are treated as acceptable variance.
//
// Error categories:
//   PASS    — surface returned schema-valid output AND assertions held.
//   FAIL    — AI helper schema/contract failure, unhandled error, or
//             assertion bust. Bug in the system under test.
//   SKIPPED — environmental: anti-bot fetch failures (6c-1), fixture
//             missing (6c-2), AI returning no_recipe_content for the
//             image on a non-first run.
//
// Run:    pnpm --filter @workspace/api-server exec tsx scripts/ws6-6c-7-smoke.ts
//
// Prereq: prisma:seed (AIPrompts) AND prisma:seed:dev (Hans's account +
//         plans). ANTHROPIC_API_KEY must be set.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { PrismaClient, type StoreSection } from "@prisma/client";
import * as cheerio from "cheerio";

import {
  fetchRecipePage,
  extractJsonLdRecipe,
  parseIngredientLines,
  reformatRecipeForKiwi,
  RecipeImportError,
  type RecipeJsonLd,
} from "../src/lib/recipeImport";
import {
  consolidatePlanIngredients,
} from "../src/lib/groceryList";
import {
  fillPurchaseSizesWithWriteBack,
  generateFinalGroceryList,
  categorizeGroceryItem,
  GroceryListAIError,
} from "../src/lib/groceryListAI";
import { searchIngredientsByPrefix } from "../src/lib/ingredientSearch";
import { normalizeIngredientName } from "../src/lib/groceryNormalization";
import type { SectionKey } from "../src/lib/ai/schemas/grocery";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = join(__dirname, "fixtures");
const IMAGE_FIXTURE_PATH = join(FIXTURE_DIR, "recipe-card.jpg");
const IMAGE_VALIDATED_MARKER = join(FIXTURE_DIR, ".recipe-card-validated");

const prisma = new PrismaClient();

const DEV_USER_EMAIL = "hans.tiefenthaler+8@gmail.com";
const DEV_PLAN_ID = "dev-plan-instance-spice-it-up";

const URL_FIXTURE = "https://www.loveandlemons.com/pasta-pomodoro/";

const TEXT_FIXTURE_SHORT =
  "Sugar Cookies. Ingredients: flour, sugar, butter, eggs. Bake at 350F until golden.";

const TEXT_FIXTURE_LONG =
  "Simple Roast Chicken. Serves 4.\n" +
  "Ingredients: 1 whole chicken (about 4 lbs), 2 tbsp olive oil, 1 tsp kosher salt, " +
  "1/2 tsp black pepper, 4 garlic cloves, 1 lemon, 6 sprigs fresh thyme.\n" +
  "Instructions: 1. Preheat oven to 425F. 2. Pat chicken dry and rub with olive oil. " +
  "3. Season inside and out with salt and pepper. 4. Stuff cavity with garlic, halved " +
  "lemon, and thyme. 5. Roast 60-70 minutes until internal temp reaches 165F. " +
  "6. Rest 10 minutes before carving.";

// Per Phase 1 refinement #2. Tried in order; first to return >= 1 hit wins.
// All four returning zero -> FAIL (real bug in the basics seed).
const PREFIX_FALLBACK_CHAIN = ["tom", "carr", "oni", "chick"];

// Authored zero-hit query for the AI-fallback path. If a future seed
// accidentally includes a row that prefix-matches this, the AI-fallback
// surface will FAIL (returned source=lookup) and the chain needs revisiting.
const AI_FALLBACK_QUERY = "dragonfruit-curry-paste";

// Authored persistent-add payload. Plausibly absent from the basics seed;
// if the seed gains a "smoked paprika" row, ingredientId will be non-null
// on add — both paths are accepted.
const ADD_ITEM_NAME = "smoked paprika";
const ADD_ITEM_SECTION: SectionKey = "pantry";

const COST_CEILING_USD = 0.5;

// Copied from groceryLists.ts:59-70 (route-private constant).
const KNOWN_SECTIONS: StoreSection[] = [
  "produce",
  "meat_seafood",
  "dairy_eggs",
  "bakery_bread",
  "pantry",
  "canned",
  "frozen",
  "snacks",
  "household",
  "extras",
];

const MODEL_SONNET = "claude-sonnet-4-6";
const MODEL_HAIKU = "claude-haiku-4-5-20251001";

// ── per-surface report types ─────────────────────────────────────────────

type SurfaceStatus = "PASS" | "FAIL" | "SKIPPED";

interface SurfaceReport {
  key: string;
  label: string;
  status: SurfaceStatus;
  wallMs: number;
  aiMs: number;
  costUsd: number;
  notes: string[];
}

// ── helpers ──────────────────────────────────────────────────────────────

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

async function teardownGroceryListForPlan(planId: string, userId: string): Promise<void> {
  const existing = await prisma.groceryList.findFirst({
    where: { mealPlanInstanceId: planId, userId },
    select: { id: true },
  });
  if (existing) {
    // GroceryListItem.groceryListId has onDelete: Cascade — items vanish
    // with the parent list.
    await prisma.groceryList.delete({ where: { id: existing.id } });
    console.log(`[teardown] deleted grocery list ${existing.id} (cascade items) for plan ${planId}`);
  } else {
    console.log(`[teardown] no existing list for plan ${planId} — skip`);
  }
}

interface LogRowSummary {
  count: number;
  costUsd: number;
  retryCount: number;
}

async function readLogsByKey(
  userId: string,
  promptKey: string,
  since: Date,
): Promise<LogRowSummary> {
  const rows = await prisma.lLMCallLog.findMany({
    where: { userId, promptKey, createdAt: { gte: since } },
    select: { costEstimateUsd: true, retryCount: true },
  });
  const totalCost = rows.reduce((s, r) => s + Number(r.costEstimateUsd ?? 0), 0);
  const totalRetries = rows.reduce((s, r) => s + (r.retryCount ?? 0), 0);
  return { count: rows.length, costUsd: totalCost, retryCount: totalRetries };
}

async function readLogsByModel(
  userId: string,
  since: Date,
): Promise<{ sonnetUsd: number; haikuUsd: number; totalUsd: number; totalRetries: number }> {
  const rows = await prisma.lLMCallLog.findMany({
    where: { userId, createdAt: { gte: since } },
    select: { model: true, costEstimateUsd: true, retryCount: true },
  });
  let sonnetUsd = 0;
  let haikuUsd = 0;
  let totalRetries = 0;
  for (const r of rows) {
    const cost = Number(r.costEstimateUsd ?? 0);
    if (r.model === MODEL_SONNET) sonnetUsd += cost;
    else if (r.model === MODEL_HAIKU) haikuUsd += cost;
    totalRetries += r.retryCount ?? 0;
  }
  return {
    sonnetUsd,
    haikuUsd,
    totalUsd: sonnetUsd + haikuUsd,
    totalRetries,
  };
}

// ── route-private helpers replicated inline ──────────────────────────────

const MAX_RAW_TEXT_CHARS = 32_000;

function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, header, footer, nav, form").remove();
  const text = $("body").text() || $.text();
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_RAW_TEXT_CHARS
    ? collapsed.slice(0, MAX_RAW_TEXT_CHARS)
    : collapsed;
}

function flattenInstructions(input: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (!node) return;
    if (typeof node === "string") {
      const trimmed = node.trim();
      if (trimmed) out.push(trimmed);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if (obj.itemListElement) {
        walk(obj.itemListElement);
        return;
      }
      if (typeof obj.text === "string") {
        const t = obj.text.trim();
        if (t) out.push(t);
        return;
      }
      if (typeof obj.name === "string") {
        const n = obj.name.trim();
        if (n) out.push(n);
      }
    }
  };
  walk(input);
  return out;
}

function buildStructuredHints(jsonLd: RecipeJsonLd) {
  const rawIngredients = Array.isArray(jsonLd.recipeIngredient)
    ? jsonLd.recipeIngredient.filter((s): s is string => typeof s === "string")
    : [];
  const parsed = parseIngredientLines(rawIngredients);
  const steps = flattenInstructions(jsonLd.recipeInstructions);
  let servingsDefault: number | undefined;
  if (typeof jsonLd.recipeYield === "number" && jsonLd.recipeYield > 0) {
    servingsDefault = Math.trunc(jsonLd.recipeYield);
  } else if (typeof jsonLd.recipeYield === "string") {
    const m = jsonLd.recipeYield.match(/\d+/);
    if (m) servingsDefault = Number.parseInt(m[0], 10);
  }
  return {
    title: typeof jsonLd.name === "string" ? jsonLd.name : undefined,
    description:
      typeof jsonLd.description === "string" ? jsonLd.description : undefined,
    ingredients: parsed.length > 0 ? parsed : undefined,
    steps: steps.length > 0 ? steps : undefined,
    servingsDefault,
  };
}

// Mirrors groceryLists.ts:75-87 (route-private).
const CATEGORY_TO_SECTION_LOOKUP: Record<string, SectionKey> = {
  Produce: "produce",
  Protein: "meat_seafood",
  Dairy: "dairy_eggs",
  Pantry: "pantry",
  Bakery: "bakery_bread",
  Frozen: "frozen",
};

function sectionForCategory(category: string | null | undefined): SectionKey {
  if (!category) return "extras";
  return CATEGORY_TO_SECTION_LOOKUP[category] ?? "extras";
}

async function lookupIngredientIdByCanonicalName(
  canonicalName: string,
): Promise<string | null> {
  const normalized = normalizeIngredientName(canonicalName);
  const row = await prisma.ingredient.findFirst({
    where: { canonicalName: normalized },
    select: { id: true },
  });
  return row?.id ?? null;
}

// ── surfaces ─────────────────────────────────────────────────────────────

interface SurfaceContext {
  userId: string;
}

async function surface_6c1_urlImport(ctx: SurfaceContext): Promise<SurfaceReport> {
  console.log("\n══ [6c-1] URL Import ══");
  const wallStart = Date.now();
  const notes: string[] = [`fixture=${URL_FIXTURE}`];

  let html: string;
  try {
    const fetched = await fetchRecipePage(URL_FIXTURE);
    html = fetched.html;
  } catch (err) {
    const code = err instanceof RecipeImportError ? err.code : "fetch_failed";
    notes.push(`fetch_error code=${code}`);
    notes.push(`err=${err instanceof Error ? err.message : String(err)}`);
    return {
      key: "6c-1",
      label: "URL Import",
      status: "SKIPPED",
      wallMs: Date.now() - wallStart,
      aiMs: 0,
      costUsd: 0,
      notes,
    };
  }

  const jsonLd = extractJsonLdRecipe(html);
  const structuredHints = jsonLd ? buildStructuredHints(jsonLd) : undefined;
  const rawText = jsonLd ? undefined : htmlToText(html);
  const expectedSource: "structured_data" | "ai_fallback" = jsonLd
    ? "structured_data"
    : "ai_fallback";
  notes.push(`source=${expectedSource}`);

  const aiStart = Date.now();
  const aiResult = await reformatRecipeForKiwi(
    {
      url: URL_FIXTURE,
      ...(structuredHints ? { structuredHints } : {}),
      ...(rawText ? { rawText } : {}),
    },
    { prisma, userId: ctx.userId },
  );
  const aiMs = Date.now() - aiStart;
  const costUsd = aiResult.metadata.costEstimateUsd ?? 0;

  if (!aiResult.success) {
    notes.push(`AI failure reason=${aiResult.reason}`);
    return {
      key: "6c-1",
      label: "URL Import",
      status: "FAIL",
      wallMs: Date.now() - wallStart,
      aiMs,
      costUsd,
      notes,
    };
  }

  if (aiResult.data.status === "no_recipe_content") {
    notes.push(`no_recipe_content reason=${aiResult.data.reason}`);
    return {
      key: "6c-1",
      label: "URL Import",
      status: "FAIL",
      wallMs: Date.now() - wallStart,
      aiMs,
      costUsd,
      notes,
    };
  }

  const recipe = aiResult.data.recipe;
  notes.push(`title="${recipe.meal.title}"`);
  notes.push(`dishes=${recipe.dishes.length}`);
  const ingCount = recipe.dishes.reduce((n, d) => n + d.ingredients.length, 0);
  notes.push(`total_ingredients=${ingCount}`);

  const pass =
    typeof recipe.meal.title === "string" &&
    recipe.meal.title.length > 0 &&
    recipe.dishes.length > 0 &&
    ingCount > 0;

  return {
    key: "6c-1",
    label: "URL Import",
    status: pass ? "PASS" : "FAIL",
    wallMs: Date.now() - wallStart,
    aiMs,
    costUsd,
    notes,
  };
}

interface ImageSurfaceResult extends SurfaceReport {
  isNoRecipeContent: boolean;
}

async function surface_6c2_imageImport(ctx: SurfaceContext): Promise<ImageSurfaceResult> {
  console.log("\n══ [6c-2] Image Import ══");
  const wallStart = Date.now();
  const notes: string[] = [`fixture=${IMAGE_FIXTURE_PATH}`];

  if (!existsSync(IMAGE_FIXTURE_PATH)) {
    notes.push("fixture file missing on disk");
    return {
      key: "6c-2",
      label: "Image Import",
      status: "SKIPPED",
      wallMs: Date.now() - wallStart,
      aiMs: 0,
      costUsd: 0,
      notes,
      isNoRecipeContent: false,
    };
  }

  const bytes = readFileSync(IMAGE_FIXTURE_PATH);
  const b64 = bytes.toString("base64");
  notes.push(`bytes=${bytes.length}`);

  const aiStart = Date.now();
  const aiResult = await reformatRecipeForKiwi(
    { images: [{ mediaType: "image/jpeg", data: b64 }] },
    { prisma, userId: ctx.userId },
  );
  const aiMs = Date.now() - aiStart;
  const costUsd = aiResult.metadata.costEstimateUsd ?? 0;

  if (!aiResult.success) {
    notes.push(`AI failure reason=${aiResult.reason}`);
    return {
      key: "6c-2",
      label: "Image Import",
      status: "FAIL",
      wallMs: Date.now() - wallStart,
      aiMs,
      costUsd,
      notes,
      isNoRecipeContent: false,
    };
  }

  if (aiResult.data.status === "no_recipe_content") {
    notes.push(`no_recipe_content reason=${aiResult.data.reason}`);
    return {
      key: "6c-2",
      label: "Image Import",
      status: "SKIPPED",
      wallMs: Date.now() - wallStart,
      aiMs,
      costUsd,
      notes,
      isNoRecipeContent: true,
    };
  }

  const recipe = aiResult.data.recipe;
  notes.push(`title="${recipe.meal.title}"`);
  notes.push(`dishes=${recipe.dishes.length}`);
  const ingCount = recipe.dishes.reduce((n, d) => n + d.ingredients.length, 0);
  notes.push(`total_ingredients=${ingCount}`);

  const pass =
    typeof recipe.meal.title === "string" &&
    recipe.meal.title.length > 0 &&
    recipe.dishes.length > 0 &&
    ingCount > 0;

  return {
    key: "6c-2",
    label: "Image Import",
    status: pass ? "PASS" : "FAIL",
    wallMs: Date.now() - wallStart,
    aiMs,
    costUsd,
    notes,
    isNoRecipeContent: false,
  };
}

async function surface_6c3_textImport(ctx: SurfaceContext): Promise<SurfaceReport> {
  console.log("\n══ [6c-3] Text Import ══");
  const wallStart = Date.now();
  const notes: string[] = [];
  let aiMsTotal = 0;
  let costTotal = 0;

  const fixtures = [
    { label: "short(82c)", text: TEXT_FIXTURE_SHORT },
    { label: "long(~480c)", text: TEXT_FIXTURE_LONG },
  ];

  let allPass = true;
  for (const f of fixtures) {
    const aiStart = Date.now();
    const aiResult = await reformatRecipeForKiwi(
      { rawText: f.text },
      { prisma, userId: ctx.userId },
    );
    const aiMs = Date.now() - aiStart;
    aiMsTotal += aiMs;
    costTotal += aiResult.metadata.costEstimateUsd ?? 0;

    if (!aiResult.success) {
      allPass = false;
      notes.push(`${f.label}: AI failure reason=${aiResult.reason}`);
      continue;
    }
    if (aiResult.data.status === "no_recipe_content") {
      allPass = false;
      notes.push(`${f.label}: no_recipe_content reason=${aiResult.data.reason}`);
      continue;
    }
    const recipe = aiResult.data.recipe;
    const ingCount = recipe.dishes.reduce((n, d) => n + d.ingredients.length, 0);
    notes.push(
      `${f.label}: title="${recipe.meal.title}" dishes=${recipe.dishes.length} ing=${ingCount}`,
    );
    if (
      !recipe.meal.title ||
      recipe.dishes.length === 0 ||
      ingCount === 0
    ) {
      allPass = false;
      notes.push(`${f.label}: empty title/dishes/ingredients`);
    }
  }

  return {
    key: "6c-3",
    label: "Text Import",
    status: allPass ? "PASS" : "FAIL",
    wallMs: Date.now() - wallStart,
    aiMs: aiMsTotal,
    costUsd: costTotal,
    notes,
  };
}

interface GenerateSurfaceResult extends SurfaceReport {
  groceryListId: string | null;
  finalItems: Array<{
    canonicalName: string;
    displayName: string;
    quantity: number;
    unit: string;
    sectionKey: SectionKey;
    isUniversalStaple: boolean;
    isUserPantryStaple: boolean;
    isRecurringItem: boolean;
    notes: string | null;
    isAmbiguous: boolean;
    ambiguityOptions?: string[] | undefined;
    wasAiInferred: boolean;
  }>;
}

async function surface_6c4_generateGrocery(
  ctx: SurfaceContext,
): Promise<GenerateSurfaceResult> {
  console.log("\n══ [6c-4] Generate Grocery ══");
  const wallStart = Date.now();
  const aiCallStart = new Date();
  const notes: string[] = [`plan=${DEV_PLAN_ID}`];

  const plan = await prisma.mealPlanInstance.findFirst({
    where: { id: DEV_PLAN_ID, userId: ctx.userId },
    select: {
      id: true,
      titleOverride: true,
      revisionId: true,
      template: { select: { title: true } },
    },
  });
  if (!plan) {
    notes.push(`plan not found for user`);
    return {
      key: "6c-4",
      label: "Generate Grocery",
      status: "FAIL",
      wallMs: Date.now() - wallStart,
      aiMs: 0,
      costUsd: 0,
      notes,
      groceryListId: null,
      finalItems: [],
    };
  }

  let consolidated;
  try {
    consolidated = await consolidatePlanIngredients({
      prisma,
      planId: DEV_PLAN_ID,
      userId: ctx.userId,
    });
  } catch (err) {
    notes.push(`consolidate threw: ${err instanceof Error ? err.message : String(err)}`);
    return {
      key: "6c-4",
      label: "Generate Grocery",
      status: "FAIL",
      wallMs: Date.now() - wallStart,
      aiMs: 0,
      costUsd: 0,
      notes,
      groceryListId: null,
      finalItems: [],
    };
  }
  notes.push(`consolidated=${consolidated.length}`);

  let withSizes;
  try {
    withSizes = await fillPurchaseSizesWithWriteBack(consolidated, {
      prisma,
      userId: ctx.userId,
    });
  } catch (err) {
    notes.push(`gap_fill threw: ${err instanceof Error ? err.message : String(err)}`);
    return {
      key: "6c-4",
      label: "Generate Grocery",
      status: "FAIL",
      wallMs: Date.now() - wallStart,
      aiMs: 0,
      costUsd: 0,
      notes,
      groceryListId: null,
      finalItems: [],
    };
  }
  const cacheMisses = consolidated.filter(
    (c) =>
      c.purchaseUnit === null ||
      c.purchaseQuantity === null ||
      c.purchaseDisplay === null,
  ).length;
  notes.push(`gap_fill_calls(expected)=${cacheMisses}`);

  const planTitle = plan.titleOverride ?? plan.template.title;

  let final;
  try {
    final = await generateFinalGroceryList(planTitle, withSizes, KNOWN_SECTIONS, {
      prisma,
      userId: ctx.userId,
    });
  } catch (err) {
    notes.push(
      `generate_final threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      key: "6c-4",
      label: "Generate Grocery",
      status: "FAIL",
      wallMs: Date.now() - wallStart,
      aiMs: 0,
      costUsd: 0,
      notes,
      groceryListId: null,
      finalItems: [],
    };
  }
  notes.push(`final.items=${final.items.length}`);

  // Persist via the same tx the route uses (groceryLists.ts:205-244).
  const groceryList = await prisma.$transaction(async (tx) => {
    const grocery = await tx.groceryList.create({
      data: {
        userId: ctx.userId,
        title: `Groceries: ${planTitle}`,
        mealPlanInstanceId: DEV_PLAN_ID,
        sourceType: "plan",
        status: "active",
        lastGeneratedFromPlanRevisionId: plan.revisionId,
        lastGeneratedAt: new Date(),
      },
    });

    const itemsForInsert = await Promise.all(
      final.items.map(async (item) => ({
        groceryListId: grocery.id,
        ingredientId: await lookupIngredientIdByCanonicalName(item.canonicalName),
        displayName: item.displayName,
        quantity: item.quantity,
        unit: item.unit,
        storeSection: item.sectionKey as StoreSection,
        isUniversalStaple: item.isUniversalStaple,
        isUserPantryStaple: item.isUserPantryStaple,
        isRecurringItem: item.isRecurringItem,
        wasAiInferred: item.wasAiInferred,
        isAmbiguous: item.isAmbiguous,
        ambiguityOptions: item.ambiguityOptions ?? [],
        notes: item.notes,
      })),
    );

    if (itemsForInsert.length > 0) {
      await tx.groceryListItem.createMany({ data: itemsForInsert });
    }
    return grocery;
  });

  // Activity log — non-blocking in the route; we await here so the smoke
  // can deterministically assert the row exists.
  await prisma.userActivity.create({
    data: {
      userId: ctx.userId,
      eventType: "generate_grocery",
      entityType: "grocery_list",
      entityId: groceryList.id,
      platform: "api",
      metadata: { planId: DEV_PLAN_ID, itemCount: final.items.length },
    },
  });

  notes.push(`groceryListId=${groceryList.id}`);

  // AI metrics for the 6c-4 surface line: pull all rows for the two prompt
  // keys the surface fires, since aiCallStart.
  const gapFillLogs = await readLogsByKey(
    ctx.userId,
    "grocery.gap_fill_purchase_size",
    aiCallStart,
  );
  const generateLogs = await readLogsByKey(
    ctx.userId,
    "grocery.generate_list",
    aiCallStart,
  );
  const aiMs = 0; // detailed per-call latency lives in LLMCallLog; we don't sum it here.
  const costUsd = gapFillLogs.costUsd + generateLogs.costUsd;
  notes.push(
    `gap_fill_logs=${gapFillLogs.count} generate_logs=${generateLogs.count} retries=${gapFillLogs.retryCount + generateLogs.retryCount}`,
  );

  // Acceptance: persisted row matches what we asked for, activity emitted.
  const persistedList = await prisma.groceryList.findUnique({
    where: { id: groceryList.id },
    select: {
      lastGeneratedFromPlanRevisionId: true,
      lastGeneratedAt: true,
      items: { select: { id: true } },
    },
  });
  const activityRow = await prisma.userActivity.findFirst({
    where: {
      userId: ctx.userId,
      eventType: "generate_grocery",
      entityId: groceryList.id,
    },
    select: { id: true },
  });
  const persistOk =
    persistedList !== null &&
    persistedList.lastGeneratedFromPlanRevisionId === plan.revisionId &&
    persistedList.lastGeneratedAt !== null &&
    persistedList.items.length === final.items.length;
  const activityOk = activityRow !== null;
  notes.push(`persist_ok=${persistOk} activity_ok=${activityOk}`);

  const pass = persistOk && activityOk && final.items.length > 0;

  return {
    key: "6c-4",
    label: "Generate Grocery",
    status: pass ? "PASS" : "FAIL",
    wallMs: Date.now() - wallStart,
    aiMs,
    costUsd,
    notes,
    groceryListId: groceryList.id,
    finalItems: final.items,
  };
}

function surface_6c5_ambiguity(
  finalItems: GenerateSurfaceResult["finalItems"],
): SurfaceReport {
  console.log("\n══ [6c-5] Ambiguity assertions (lenient/structural) ══");
  const wallStart = Date.now();
  const notes: string[] = [];

  const total = finalItems.length;
  let flaggedCount = 0;
  let schemaViolations = 0;
  const violationDetails: string[] = [];

  for (const item of finalItems) {
    const hasOptions =
      Array.isArray(item.ambiguityOptions) && item.ambiguityOptions.length > 0;
    if (item.isAmbiguous) {
      flaggedCount++;
      if (
        !Array.isArray(item.ambiguityOptions) ||
        item.ambiguityOptions.length < 2 ||
        item.ambiguityOptions.length > 4
      ) {
        schemaViolations++;
        violationDetails.push(
          `isAmbiguous=true but ambiguityOptions len=${item.ambiguityOptions?.length ?? 0} for canonicalName="${item.canonicalName}"`,
        );
      }
    } else {
      // Lenient: undefined or empty array both accepted for non-flagged.
      if (hasOptions) {
        schemaViolations++;
        violationDetails.push(
          `isAmbiguous=false but ambiguityOptions present (len=${item.ambiguityOptions!.length}) for canonicalName="${item.canonicalName}"`,
        );
      }
    }
  }

  notes.push(`flagged=${flaggedCount}/${total}`);
  notes.push(`schema_violations=${schemaViolations}`);
  for (const v of violationDetails) notes.push(v);

  return {
    key: "6c-5",
    label: "Ambiguous flag",
    status: schemaViolations === 0 ? "PASS" : "FAIL",
    wallMs: Date.now() - wallStart,
    aiMs: 0,
    costUsd: 0,
    notes,
  };
}

async function surface_6c6_lookupPrefix(
  _ctx: SurfaceContext,
): Promise<SurfaceReport> {
  console.log("\n══ [6c-6] Lookup prefix ══");
  const wallStart = Date.now();
  const notes: string[] = [];

  for (const needle of PREFIX_FALLBACK_CHAIN) {
    const hits = await searchIngredientsByPrefix(prisma, needle, 5);
    if (hits.length > 0) {
      notes.push(`needle="${needle}" hits=${hits.length}`);
      notes.push(
        `top=[${hits
          .slice(0, 3)
          .map((h) => h.canonicalName)
          .join(", ")}]`,
      );
      const allIngredientIds = hits.every((h) => typeof h.ingredientId === "string" && h.ingredientId.length > 0);
      if (!allIngredientIds) {
        notes.push("FAIL: at least one hit has empty ingredientId");
        return {
          key: "6c-6.prefix",
          label: "Lookup prefix",
          status: "FAIL",
          wallMs: Date.now() - wallStart,
          aiMs: 0,
          costUsd: 0,
          notes,
        };
      }
      return {
        key: "6c-6.prefix",
        label: "Lookup prefix",
        status: "PASS",
        wallMs: Date.now() - wallStart,
        aiMs: 0,
        costUsd: 0,
        notes,
      };
    }
    notes.push(`needle="${needle}" hits=0`);
  }

  notes.push(`FAIL: all ${PREFIX_FALLBACK_CHAIN.length} fallback needles returned 0 hits`);
  return {
    key: "6c-6.prefix",
    label: "Lookup prefix",
    status: "FAIL",
    wallMs: Date.now() - wallStart,
    aiMs: 0,
    costUsd: 0,
    notes,
  };
}

async function surface_6c6_lookupAiFallback(
  ctx: SurfaceContext,
): Promise<SurfaceReport> {
  console.log("\n══ [6c-6] Lookup AI fallback ══");
  const wallStart = Date.now();
  const notes: string[] = [`query="${AI_FALLBACK_QUERY}"`];

  const hits = await searchIngredientsByPrefix(prisma, AI_FALLBACK_QUERY, 5);
  if (hits.length > 0) {
    notes.push(
      `FAIL: prefix-lookup unexpectedly returned ${hits.length} hits (chain pollution)`,
    );
    return {
      key: "6c-6.ai",
      label: "Lookup AI-fallback",
      status: "FAIL",
      wallMs: Date.now() - wallStart,
      aiMs: 0,
      costUsd: 0,
      notes,
    };
  }
  notes.push(`prefix_hits=0 — falling through to AI`);

  const aiStart = Date.now();
  let result;
  try {
    result = await categorizeGroceryItem(AI_FALLBACK_QUERY, undefined, undefined, {
      prisma,
      userId: ctx.userId,
    });
  } catch (err) {
    notes.push(
      `categorizeGroceryItem threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      key: "6c-6.ai",
      label: "Lookup AI-fallback",
      status: "FAIL",
      wallMs: Date.now() - wallStart,
      aiMs: Date.now() - aiStart,
      costUsd: 0,
      notes,
    };
  }
  const aiMs = Date.now() - aiStart;

  notes.push(`itemName="${result.itemName}" sectionKey=${result.sectionKey}`);
  if (result.suggestedQuantity) notes.push(`suggestedQuantity="${result.suggestedQuantity}"`);

  // Cost pulled from the most recent recurring_item_categorize row.
  const since = new Date(aiStart - 1000);
  const logs = await readLogsByKey(
    ctx.userId,
    "grocery.recurring_item_categorize",
    since,
  );

  const pass =
    typeof result.itemName === "string" &&
    result.itemName.length > 0 &&
    KNOWN_SECTIONS.includes(result.sectionKey as StoreSection);

  return {
    key: "6c-6.ai",
    label: "Lookup AI-fallback",
    status: pass ? "PASS" : "FAIL",
    wallMs: Date.now() - wallStart,
    aiMs,
    costUsd: logs.costUsd,
    notes,
  };
}

async function surface_6c6_persistentAdd(
  ctx: SurfaceContext,
  groceryListId: string | null,
): Promise<SurfaceReport> {
  console.log("\n══ [6c-6] Persistent add ══");
  const wallStart = Date.now();
  const notes: string[] = [];

  if (!groceryListId) {
    notes.push("SKIPPED: no groceryListId from 6c-4 (upstream failed)");
    return {
      key: "6c-6.add",
      label: "Persistent add",
      status: "SKIPPED",
      wallMs: Date.now() - wallStart,
      aiMs: 0,
      costUsd: 0,
      notes,
    };
  }

  // Resolve ingredientId via the same normalized canonical lookup the route
  // uses (best-effort — null is fine).
  const ingredientId = await lookupIngredientIdByCanonicalName(ADD_ITEM_NAME);
  notes.push(`ingredientId_resolved=${ingredientId ?? "null"}`);

  // Resolve unit default. If we have an ingredientId, pull its defaultUnit
  // (mirrors the route at groceryLists.ts:459-466).
  let defaultUnit = "each";
  if (ingredientId) {
    const ing = await prisma.ingredient.findUnique({
      where: { id: ingredientId },
      select: { defaultUnit: true },
    });
    if (ing?.defaultUnit) defaultUnit = ing.defaultUnit;
  }
  notes.push(`defaultUnit=${defaultUnit}`);

  const item = await prisma.groceryListItem.create({
    data: {
      groceryListId,
      displayName: ADD_ITEM_NAME,
      quantity: 1,
      unit: defaultUnit,
      storeSection: ADD_ITEM_SECTION as StoreSection,
      ingredientId,
      isUniversalStaple: false,
      isUserPantryStaple: false,
      isRecurringItem: false,
      wasAiInferred: false,
      isAmbiguous: false,
      ambiguityOptions: [],
      notes: null,
    },
  });
  notes.push(`itemId=${item.id}`);

  await prisma.userActivity.create({
    data: {
      userId: ctx.userId,
      eventType: "grocery_item_added",
      entityType: "grocery_list",
      entityId: groceryListId,
      platform: "api",
      metadata: { itemName: ADD_ITEM_NAME },
    },
  });

  // Verify: item row visible from the list FK, activity emitted.
  const persisted = await prisma.groceryListItem.findUnique({
    where: { id: item.id },
    select: { displayName: true, storeSection: true, groceryListId: true },
  });
  const activity = await prisma.userActivity.findFirst({
    where: {
      userId: ctx.userId,
      eventType: "grocery_item_added",
      entityId: groceryListId,
    },
    select: { id: true },
  });
  const pass =
    persisted !== null &&
    persisted.displayName === ADD_ITEM_NAME &&
    persisted.storeSection === ADD_ITEM_SECTION &&
    persisted.groceryListId === groceryListId &&
    activity !== null;

  return {
    key: "6c-6.add",
    label: "Persistent add",
    status: pass ? "PASS" : "FAIL",
    wallMs: Date.now() - wallStart,
    aiMs: 0,
    costUsd: 0,
    notes,
  };
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set in env — aborting smoke");
    process.exit(2);
  }

  console.log("══════════════════════════════════════════════════════════");
  console.log("WS6 6c-7 Block 2 — cumulative smoke (6c-1 .. 6c-6)");
  console.log("══════════════════════════════════════════════════════════");

  const runStartIso = new Date().toISOString();
  const sinceForRollUp = new Date();
  const userId = await getDevUserId();
  console.log(`dev user: ${userId} (${DEV_USER_EMAIL})`);

  await teardownGroceryListForPlan(DEV_PLAN_ID, userId);

  const ctx: SurfaceContext = { userId };

  const wallStart = Date.now();
  const r6c1 = await surface_6c1_urlImport(ctx);
  const r6c2 = await surface_6c2_imageImport(ctx);
  const r6c3 = await surface_6c3_textImport(ctx);
  const r6c4 = await surface_6c4_generateGrocery(ctx);
  const r6c5 = surface_6c5_ambiguity(r6c4.finalItems);
  const r6c6prefix = await surface_6c6_lookupPrefix(ctx);
  const r6c6ai = await surface_6c6_lookupAiFallback(ctx);
  const r6c6add = await surface_6c6_persistentAdd(ctx, r6c4.groceryListId);
  const totalWallMs = Date.now() - wallStart;

  const reports: SurfaceReport[] = [
    r6c1,
    r6c2,
    r6c3,
    r6c4,
    r6c5,
    r6c6prefix,
    r6c6ai,
    r6c6add,
  ];

  // Aggregate via LLMCallLog rows for the dev user since script start —
  // authoritative source of cost / retry truth.
  const byModel = await readLogsByModel(userId, sinceForRollUp);
  const totalAiMs = reports.reduce((s, r) => s + r.aiMs, 0);

  const passCount = reports.filter((r) => r.status === "PASS").length;
  const failCount = reports.filter((r) => r.status === "FAIL").length;
  const skipCount = reports.filter((r) => r.status === "SKIPPED").length;

  // First-run image fixture validation gate.
  const imageWasNoRecipeContent = r6c2.isNoRecipeContent === true;
  const fixtureValidated = existsSync(IMAGE_VALIDATED_MARKER);
  let firstRunBorderlineFail = false;
  if (r6c2.status === "PASS" && !fixtureValidated) {
    writeFileSync(
      IMAGE_VALIDATED_MARKER,
      `Validated by ws6-6c-7-smoke at ${runStartIso}\n`,
    );
    console.log(
      `\n[fixture] wrote ${IMAGE_VALIDATED_MARKER} — image fixture validated on first PASS`,
    );
  }
  if (imageWasNoRecipeContent && !fixtureValidated) {
    firstRunBorderlineFail = true;
  }

  // ── report ─────────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("=== WS6 6c-7 Block 2 Smoke ===");
  console.log(`Run date:        ${runStartIso}`);
  console.log(
    `Total:           8 lines (7 surfaces), ${passCount} PASS, ${failCount} FAIL, ${skipCount} SKIPPED`,
  );
  console.log(`Wall latency:    ${totalWallMs}ms total`);
  console.log(`AI latency:      ${totalAiMs}ms total (sum of measured AI calls)`);
  console.log(
    `Cost:            $${byModel.totalUsd.toFixed(4)} total (Sonnet $${byModel.sonnetUsd.toFixed(4)}, Haiku $${byModel.haikuUsd.toFixed(4)})`,
  );
  console.log(`Retries:         ${byModel.totalRetries} across all calls`);

  console.log("\nPer-surface:");
  const fmt = (r: SurfaceReport) => {
    const wallStr = `${r.wallMs}ms`.padStart(7);
    const costStr = `$${r.costUsd.toFixed(4)}`.padStart(8);
    const label = `[${r.key}] ${r.label}`.padEnd(34);
    return `  ${label} ${r.status.padEnd(8)} ${wallStr}   ${costStr}`;
  };
  for (const r of reports) {
    console.log(fmt(r));
    for (const n of r.notes) console.log(`    - ${n}`);
  }

  console.log(`\nIdempotency: teardown-then-run — re-run safe (teardown at script start).`);

  if (firstRunBorderlineFail) {
    console.log(
      `\n[FIXTURE GATE] First-run image fixture returned no_recipe_content.`,
    );
    console.log(
      `              Marker ${IMAGE_VALIDATED_MARKER} not present —`,
    );
    console.log(
      `              treating fixture as BORDERLINE. Re-source per Phase 1.`,
    );
  }

  if (byModel.totalRetries > 0) {
    console.log(
      `\n[D-WS6-033 watch] Retries observed: ${byModel.totalRetries} total across this run.`,
    );
  }
  if (byModel.totalUsd > COST_CEILING_USD) {
    console.log(
      `\n[COST WARNING] $${byModel.totalUsd.toFixed(4)} exceeds ceiling $${COST_CEILING_USD}`,
    );
  }

  await prisma.$disconnect();

  // Exit codes: 0 = all PASS, 1 = any FAIL OR first-run borderline image,
  // 2 = unhandled crash (set elsewhere).
  if (failCount > 0 || firstRunBorderlineFail) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n[FATAL] smoke crashed:", err);
  prisma.$disconnect().finally(() => process.exit(2));
});

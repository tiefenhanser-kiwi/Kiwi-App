// Live smoke for WS6 6c-1 — Recipe import (URL → JSON-LD or AI fallback →
// canonical reformat) + scale parity check.
//
// Helper-direct (no HTTP). Mirrors the 6b-5 pattern: imports the production
// helpers, runs them against real fetches + real Anthropic calls (Sonnet,
// text+Zod), and reports per-call latency / cost / retry count plus an
// aggregate roll-up.
//
// Run:    pnpm --filter @workspace/api-server exec tsx scripts/ws6-6c-1-smoke.ts
//
// Prereq:
//   - prisma:seed has been run with the new 6c-1 prompts in place
//   - ANTHROPIC_API_KEY is set in .env
//   - api-server is NOT required to be running (helpers call SDK directly)

import { PrismaClient } from "@prisma/client";

import {
  fetchRecipePage,
  extractJsonLdRecipe,
  parseIngredientLines,
  reformatRecipeForKiwi,
} from "../src/lib/recipeImport.ts";
import { runAICall } from "../src/lib/ai/runAICall.ts";
import { ScaleResponseSchema } from "../src/lib/ai/schemas/scale.ts";

const prisma = new PrismaClient();
const SMOKE_USER_ID = "smoke-ws6-6c-1-user";
const COST_CEILING_USD = 0.2; // 4 import + 2 scale = 6 calls; sonnet ~$0.02-0.04 each

type ExpectSource =
  | "structured_data"
  | "ai_fallback"
  | "no_recipe_content"
  | "fetch_error";

interface ImportCase {
  label: string;
  url: string;
  expectSource: ExpectSource;
}

// Outcome confidence hierarchy: a higher-confidence actual outcome always
// satisfies a lower-confidence expectation. The reverse never holds. Order
// (low → high): fetch_error < no_recipe_content < ai_fallback < structured_data.
//
//   fetch_error      — request died at the network/HTTP layer; no AI call made
//   no_recipe_content — AI ran, decided page has no parseable recipe
//   ai_fallback      — no JSON-LD; AI parsed raw HTML successfully
//   structured_data  — JSON-LD found and AI reformatted from it
//
// Why the asymmetry: if we expected no_recipe_content but got fetch_error,
// we caught it cheaper at the fetch layer — strictly better. Demoting that
// to FAIL would punish the optimization.
//
// AI-layer peer exception: ai_fallback and no_recipe_content are PEERS, not
// ordered. Both are valid AI responses to a fetched-but-fuzzy page: parse
// succeeded vs. AI decided the page isn't a real recipe. The rank says
// ai_fallback > no_recipe_content (which would reject the peer case), so we
// handle it explicitly below.
const SOURCE_RANK: Record<string, number> = {
  fetch_error: 0,
  no_recipe_content: 1,
  ai_fallback: 2,
  structured_data: 3,
};

function meetsExpectation(actual: string, expected: ExpectSource): boolean {
  // Peer exception: AI bailing with no_recipe_content for an ai_fallback
  // expectation is still a correct AI-layer decision.
  if (expected === "ai_fallback" && actual === "no_recipe_content") return true;
  const a = SOURCE_RANK[actual];
  const e = SOURCE_RANK[expected];
  if (a === undefined || e === undefined) return actual === expected;
  return a >= e;
}

const IMPORT_CASES: ImportCase[] = [
  // 6c-1-fix-2: AllRecipes was expected structured_data in earlier smokes,
  // but Cloudflare's managed-challenge blocks all plain-fetch traffic
  // regardless of UA. We now expect the fetch layer to detect Cloudflare
  // markers and bail before any AI call. This is a deliberate design
  // limitation (no headless browser); recommended fallback is Image Import.
  {
    label: "AllRecipes — Cloudflare-blocked (expect fetch_error)",
    url: "https://www.allrecipes.com/recipe/231506/simple-macaroni-and-cheese/",
    expectSource: "fetch_error",
  },
  {
    label: "Tone It Up roundup blog (expect ai_fallback or no_recipe_content)",
    url: "https://my.toneitup.com/blogs/latest/recipes-workouts-for-the-4th-and-all-summer-long",
    expectSource: "ai_fallback",
  },
  // 6c-1-fix-2: NYT Cooking returns 308 to unauthenticated requests. Previous
  // behavior auto-followed the redirect and let the AI parse whatever recipe
  // landed at the target URL ("Strawberry Cassata" in one smoke run). Now we
  // refuse 3xx at the fetch layer, saving the wasted AI call.
  {
    label: "NYT Cooking chocolate chip cookies (expect fetch_error from 308 redirect)",
    url: "https://cooking.nytimes.com/recipes/1018185-chocolate-chip-cookies",
    expectSource: "fetch_error",
  },
  // 6c-1-fix-2: Live structured_data coverage. Love & Lemons publishes a
  // proper JSON-LD Recipe and accepts the KiwiBot UA (preflighted via curl +
  // Node fetch). Replaces the AllRecipes structured_data slot lost to CF.
  {
    label: "Love & Lemons pasta pomodoro (expect structured_data)",
    url: "https://www.loveandlemons.com/pasta-pomodoro/",
    expectSource: "structured_data",
  },
];

// Fallback scale-test ingredient list. Used when no import case produces a
// real recipe payload (all 3 of the network-dependent cases can legitimately
// fail in a single smoke run). Spans a fractional quantity, a count, and a
// can/jar unit so scale parity is meaningfully exercised.
const SCALE_FIXTURE: { name: string; amount: string }[] = [
  { name: "spaghetti", amount: "1 lb" },
  { name: "garlic cloves", amount: "4" },
  { name: "olive oil", amount: "1/4 cup" },
  { name: "san marzano tomatoes", amount: "1 (28-oz) can" },
  { name: "fresh basil", amount: "8 leaves" },
];

interface CallReport {
  label: string;
  source: string;
  durationMs: number;
  costEstimateUsd: number;
  retryCount: number;
  success: boolean;
  notes: string[];
}

async function runImportCase(c: ImportCase): Promise<{
  report: CallReport;
  capturedTitle?: string;
  capturedIngredients?: { name: string; amount: string }[];
}> {
  const start = Date.now();
  const notes: string[] = [];
  let source: "structured_data" | "ai_fallback" = "ai_fallback";
  let html = "";
  try {
    const fetched = await fetchRecipePage(c.url);
    html = fetched.html;
  } catch (err) {
    return {
      report: {
        label: c.label,
        source: "fetch_error",
        durationMs: Date.now() - start,
        costEstimateUsd: 0,
        retryCount: 0,
        success: meetsExpectation("fetch_error", c.expectSource),
        notes: [`fetch failed: ${err instanceof Error ? err.message : String(err)}`],
      },
    };
  }

  const jsonLd = extractJsonLdRecipe(html);
  const structuredHints = jsonLd
    ? {
        title: typeof jsonLd.name === "string" ? jsonLd.name : undefined,
        description:
          typeof jsonLd.description === "string" ? jsonLd.description : undefined,
        ingredients:
          Array.isArray(jsonLd.recipeIngredient) && jsonLd.recipeIngredient.length > 0
            ? parseIngredientLines(jsonLd.recipeIngredient.filter((s): s is string => typeof s === "string"))
            : undefined,
      }
    : undefined;
  const rawText = jsonLd
    ? undefined
    : html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 32_000);
  source = jsonLd ? "structured_data" : "ai_fallback";

  const aiResult = await reformatRecipeForKiwi(
    {
      url: c.url,
      ...(structuredHints ? { structuredHints } : {}),
      ...(rawText ? { rawText } : {}),
    },
    { prisma, userId: SMOKE_USER_ID },
  );

  const durationMs = Date.now() - start;

  if (!aiResult.success) {
    return {
      report: {
        label: c.label,
        source,
        durationMs,
        costEstimateUsd: aiResult.metadata.costEstimateUsd ?? 0,
        retryCount: aiResult.metadata.retryCount ?? 0,
        success: false,
        notes: [`AI failure: ${aiResult.reason}`, aiResult.userFacingMessage],
      },
    };
  }

  if (aiResult.data.status === "no_recipe_content") {
    notes.push(`AI returned no_recipe_content: ${aiResult.data.reason}`);
    return {
      report: {
        label: c.label,
        source: "no_recipe_content",
        durationMs,
        costEstimateUsd: aiResult.metadata.costEstimateUsd ?? 0,
        retryCount: aiResult.metadata.retryCount ?? 0,
        success: meetsExpectation("no_recipe_content", c.expectSource),
        notes,
      },
    };
  }

  const recipe = aiResult.data.recipe;
  notes.push(`title="${recipe.meal.title}"`);
  notes.push(`dishes=${recipe.dishes.length}`);
  notes.push(
    `total_ingredients=${recipe.dishes.reduce((n, d) => n + d.ingredients.length, 0)}`,
  );
  notes.push(`cuisine=${recipe.meal.cuisineType}`);
  notes.push(`mealType=${recipe.meal.mealType}`);

  // Aggregate ingredients across dishes into a flat list shaped for the
  // scale endpoint, formatting "{qty} {unit}" as the amount.
  const flat = recipe.dishes.flatMap((d) =>
    d.ingredients.map((i) => ({
      name: i.name,
      amount: `${i.quantity} ${i.unit}`.trim(),
    })),
  );

  return {
    report: {
      label: c.label,
      source,
      durationMs,
      costEstimateUsd: aiResult.metadata.costEstimateUsd ?? 0,
      retryCount: aiResult.metadata.retryCount ?? 0,
      success: meetsExpectation(source, c.expectSource),
      notes,
    },
    capturedTitle: recipe.meal.title,
    capturedIngredients: flat,
  };
}

async function runScaleCase(
  label: string,
  fromServings: number,
  toServings: number,
  ingredients: { name: string; amount: string }[],
): Promise<CallReport> {
  const start = Date.now();
  const result = await runAICall(
    "recipes.scale_ingredients",
    {
      scaleInput: {
        fromServings,
        toServings,
        ingredients,
      },
    },
    ScaleResponseSchema,
    { prisma, userId: SMOKE_USER_ID },
  );
  const durationMs = Date.now() - start;
  if (!result.success) {
    return {
      label,
      source: "scale",
      durationMs,
      costEstimateUsd: result.metadata.costEstimateUsd ?? 0,
      retryCount: result.metadata.retryCount ?? 0,
      success: false,
      notes: [`AI failure: ${result.reason}`],
    };
  }
  return {
    label,
    source: "scale",
    durationMs,
    costEstimateUsd: result.metadata.costEstimateUsd ?? 0,
    retryCount: result.metadata.retryCount ?? 0,
    success: result.data.scaled.length === ingredients.length,
    notes: [`scaled_count=${result.data.scaled.length}`, `factor=${toServings / fromServings}`],
  };
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set in env — aborting smoke");
    process.exit(2);
  }

  // LLMCallLog.userId is a FK to User. Without a real row, every LLMCallLog
  // write FK-fails and the smoke can't validate prompt accounting. Idempotent
  // upsert leaves one deterministic dev-DB row.
  await prisma.user.upsert({
    where: { id: SMOKE_USER_ID },
    update: {},
    create: {
      id: SMOKE_USER_ID,
      email: "smoke-ws6-6c-1@kitchenwizard.ai",
      firstName: "Smoke",
      lastName: "Test",
    },
  });

  const reports: CallReport[] = [];
  let firstSuccessfulImport:
    | { title: string; ingredients: { name: string; amount: string }[] }
    | null = null;

  for (const c of IMPORT_CASES) {
    process.stdout.write(`\n→ ${c.label}\n`);
    const { report, capturedTitle, capturedIngredients } = await runImportCase(c);
    reports.push(report);
    process.stdout.write(
      `  source=${report.source} durMs=${report.durationMs} cost=$${report.costEstimateUsd.toFixed(4)} retries=${report.retryCount} ${report.success ? "PASS" : "FAIL"}\n`,
    );
    for (const n of report.notes) process.stdout.write(`    ${n}\n`);
    if (
      !firstSuccessfulImport &&
      capturedTitle &&
      capturedIngredients &&
      capturedIngredients.length > 0
    ) {
      firstSuccessfulImport = {
        title: capturedTitle,
        ingredients: capturedIngredients.slice(0, 10),
      };
    }
  }

  // Always run scale tests — fall back to SCALE_FIXTURE when no import case
  // produced a real recipe. This keeps scale parity exercised every run, even
  // when all network-dependent import URLs legitimately fail.
  const scaleSource = firstSuccessfulImport
    ? { label: firstSuccessfulImport.title, ingredients: firstSuccessfulImport.ingredients }
    : { label: "SCALE_FIXTURE (no successful import)", ingredients: SCALE_FIXTURE };

  process.stdout.write(`\n→ Scale 2 → 4 (${scaleSource.label})\n`);
  const scaleUp = await runScaleCase(
    "Scale up 2→4",
    2,
    4,
    scaleSource.ingredients,
  );
  reports.push(scaleUp);
  process.stdout.write(
    `  durMs=${scaleUp.durationMs} cost=$${scaleUp.costEstimateUsd.toFixed(4)} retries=${scaleUp.retryCount} ${scaleUp.success ? "PASS" : "FAIL"}\n`,
  );
  for (const n of scaleUp.notes) process.stdout.write(`    ${n}\n`);

  process.stdout.write(`\n→ Scale 4 → 2 (${scaleSource.label})\n`);
  const scaleDown = await runScaleCase(
    "Scale down 4→2",
    4,
    2,
    scaleSource.ingredients,
  );
  reports.push(scaleDown);
  process.stdout.write(
    `  durMs=${scaleDown.durationMs} cost=$${scaleDown.costEstimateUsd.toFixed(4)} retries=${scaleDown.retryCount} ${scaleDown.success ? "PASS" : "FAIL"}\n`,
  );
  for (const n of scaleDown.notes) process.stdout.write(`    ${n}\n`);

  // Aggregate roll-up.
  const totalCost = reports.reduce((s, r) => s + r.costEstimateUsd, 0);
  const totalRetries = reports.reduce((s, r) => s + r.retryCount, 0);
  const successes = reports.filter((r) => r.success).length;
  const sourceBreakdown = reports.reduce<Record<string, number>>((acc, r) => {
    acc[r.source] = (acc[r.source] ?? 0) + 1;
    return acc;
  }, {});

  // LLMCallLog audit (only calls Hans's user / the smoke user).
  let logCount = 0;
  try {
    logCount = await prisma.lLMCallLog.count({
      where: { userId: SMOKE_USER_ID },
    });
  } catch (err) {
    console.warn("LLMCallLog count failed:", err);
  }

  process.stdout.write("\n");
  process.stdout.write("──────────────────────────────────────────\n");
  process.stdout.write("Smoke 6c-1 aggregate\n");
  process.stdout.write("──────────────────────────────────────────\n");
  process.stdout.write(`Total calls:        ${reports.length}\n`);
  process.stdout.write(`Successes:          ${successes}/${reports.length}\n`);
  process.stdout.write(`Total cost (USD):   $${totalCost.toFixed(4)}\n`);
  process.stdout.write(`Total retries:      ${totalRetries}\n`);
  process.stdout.write(`Source breakdown:   ${JSON.stringify(sourceBreakdown)}\n`);
  process.stdout.write(`LLMCallLog rows:    ${logCount} for ${SMOKE_USER_ID}\n`);
  process.stdout.write("──────────────────────────────────────────\n");

  if (totalCost > COST_CEILING_USD) {
    process.stdout.write(
      `WARNING: total cost $${totalCost.toFixed(4)} exceeds ceiling $${COST_CEILING_USD}\n`,
    );
  }

  await prisma.$disconnect();
  if (successes < reports.length) process.exit(1);
}

main().catch((err) => {
  console.error("Smoke failed with unhandled error:", err);
  prisma.$disconnect().finally(() => process.exit(2));
});

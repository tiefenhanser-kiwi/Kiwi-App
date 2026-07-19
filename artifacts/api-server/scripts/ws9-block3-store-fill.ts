// Plan-Gen Arc · Block 3 (D-WS9-041) — store-fill harness CLI (thin wrapper).
//
// Dry-run by DEFAULT (generates + prints what it WOULD write, no DB writes).
// --apply writes the meals to the store. All logic lives in src/lib/storeFill.ts
// (typechecked + unit-tested); this file only wires real deps and prints.
//
//   Dry-run:  node --env-file=.env --import tsx scripts/ws9-block3-store-fill.ts --limit 12
//   Apply:    node --env-file=.env --import tsx scripts/ws9-block3-store-fill.ts --limit 12 --apply
//
// NOTE: even dry-run makes real AI calls (that is how you inspect quality and
// measure cost before writing); only the persist step is gated by --apply.

import { PrismaClient } from "@prisma/client";

import { getModelRate, MODEL_SONNET } from "../src/lib/ai/promptRegistry";
import {
  cacheHitRate,
  runStoreFill,
  type StoreFillResult,
} from "../src/lib/storeFill";

interface Args {
  apply: boolean;
  limit: number;
  maxCostUsd: number;
  maxCalls?: number;
}

function numFlag(argv: string[], flag: string): number | undefined {
  const i = argv.indexOf(flag);
  if (i < 0 || !argv[i + 1]) return undefined;
  const n = Number(argv[i + 1]);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number (got ${argv[i + 1]})`);
  return n;
}

function parseArgs(argv: string[]): Args {
  const apply = argv.includes("--apply");
  const limit = numFlag(argv, "--limit") ?? 12;
  const maxCostUsd = numFlag(argv, "--max-cost") ?? 75;
  const maxCalls = numFlag(argv, "--max-calls");
  return { apply, limit, maxCostUsd, maxCalls };
}

function printResult(result: StoreFillResult): void {
  const mode = result.apply ? "APPLY (writing)" : "DRY-RUN (no writes)";
  console.log("");
  console.log(`=== WS9 Block 3 store-fill — ${mode} ===`);
  console.log(`attempted: ${result.attempted}   produced: ${result.records.length}   skipped: ${result.skips.length}`);
  console.log("");

  for (const r of result.records) {
    const flag = r.written ? `WROTE ${r.mealId}` : "would write";
    console.log(`• [${r.targetDish}] → "${r.title}" (${r.cuisineType}, ${r.difficulty}, serves ${r.servings}) [${r.profileKey}] — ${flag}`);
    for (const d of r.dishes) {
      console.log(`    - ${d.role}: "${d.title}" — ${d.ingredientCount} ingredients, ${d.stepCount} steps`);
    }
    console.log(`    allergens: [${r.allergens.join(", ") || "none"}]`);
  }

  if (result.completenessRejections.length > 0) {
    console.log("");
    console.log(`completeness rejections (regenerated): ${result.completenessRejections.length}`);
    for (const p of result.completenessRejections) {
      console.log(`    [${p.targetDish}] attempt ${p.attempt}: ${p.reason}${p.title ? ` ("${p.title}")` : ""}`);
    }
  }

  if (result.skips.length > 0) {
    console.log("");
    console.log(`skips (logged, not written): ${result.skips.length}`);
    for (const s of result.skips) {
      console.log(`    [${s.profileKey}] ${s.stage}: ${s.reason}${s.title ? ` ("${s.title}")` : ""}`);
    }
  }

  if (result.stoppedBy) {
    console.log("");
    console.log(`⚠️ RUN HALTED EARLY by control: ${result.stoppedBy}`);
  }

  const t = result.tokens;
  const hit = (cacheHitRate(t) * 100).toFixed(1);
  const perMeal = result.records.length > 0 ? result.costUsd / result.records.length : 0;
  console.log("");
  console.log("=== cost summary ===");
  console.log(`meals produced:        ${result.records.length}`);
  console.log(`AI calls:              ${t.aiCalls}`);
  console.log(`input tokens (uncached): ${t.input}`);
  console.log(`output tokens:         ${t.output}`);
  console.log(`cache_read tokens:     ${t.cacheRead}`);
  console.log(`cache_creation tokens: ${t.cacheCreation}`);
  console.log(`cache-hit rate:        ${hit}%  (cache_read / all input-side tokens)`);
  console.log(`cache-aware cost:      $${result.costUsd.toFixed(4)}`);
  console.log(`cost per meal:         $${perMeal.toFixed(4)}`);
}

async function main(): Promise<void> {
  const { apply, limit, maxCostUsd, maxCalls } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const rate = await getModelRate(MODEL_SONNET, prisma);
    const result = await runStoreFill(
      { prisma },
      { apply, limit, maxCostUsd, maxCalls, rate, log: (m) => console.log(m) },
    );
    printResult(result);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

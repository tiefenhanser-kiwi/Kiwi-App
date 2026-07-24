// Plan-Gen Arc · Block 3 (D-WS9-041) — store-fill harness CLI (thin wrapper).
//
// Default (no flags): generates + prints what it WOULD write, real AI calls, no
// DB writes. --apply writes the meals to the store. All logic lives in
// src/lib/storeFill.ts (typechecked + unit-tested); this file only wires real
// deps, selects the dish set, prints, and (optionally) dumps full meals.
//
//   Pre-flight (NO api spend):  node --env-file=.env --import tsx scripts/ws9-block3-store-fill.ts --sample-bands 50 --dry-run
//   Sample 50 across bands:     node --env-file=.env --import tsx scripts/ws9-block3-store-fill.ts --sample-bands 50 --max-cost 10 --dump out.json
//   Head, real AI, no writes:   node --env-file=.env --import tsx scripts/ws9-block3-store-fill.ts --limit 12
//   Apply (writes):             node --env-file=.env --import tsx scripts/ws9-block3-store-fill.ts --limit 12 --apply
//
// NOTE: --dry-run is a PRE-FLIGHT — it prints the work + cost estimate and exits
// WITHOUT any API call. It is NOT the same as the default no-flags mode (which
// makes real AI calls but skips only the DB write).

import { writeFileSync } from "node:fs";

import { PrismaClient } from "@prisma/client";

import { getModelRate, MODEL_SONNET } from "../src/lib/ai/promptRegistry";
import { TARGET_DISHES, type TargetDish } from "../src/lib/storeFillDishes";
import {
  cacheHitRate,
  computeCacheAwareCostUsd,
  runStoreFill,
  type ModelRateUsd,
  type StoreFillMealCapture,
  type StoreFillResult,
} from "../src/lib/storeFill";

interface Args {
  apply: boolean;
  limit: number;
  sampleBands?: number;
  targets?: string;
  dryRun: boolean;
  dump?: string;
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

function strFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0 || !argv[i + 1]) return undefined;
  return argv[i + 1];
}

function parseArgs(argv: string[]): Args {
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  const limit = numFlag(argv, "--limit") ?? 12;
  const sampleBands = numFlag(argv, "--sample-bands");
  const targets = strFlag(argv, "--targets");
  const dump = strFlag(argv, "--dump");
  const maxCostUsd = numFlag(argv, "--max-cost") ?? 75;
  const maxCalls = numFlag(argv, "--max-calls");
  return { apply, limit, sampleBands, targets, dryRun, dump, maxCostUsd, maxCalls };
}

// ── targeted selection (--targets "sub1,sub2,..."): for each comma-separated
// substring, pick the FIRST version-row (by rank) whose version name contains it
// (case-insensitive). One row per substring, deduped by key. Deterministic; lets a
// re-sample concentrate on specific cases (e.g. cheese-anchored + construction-is-
// the-dish) rather than a blind band spread. Unmatched substrings are reported.
function selectTargets(all: TargetDish[], spec: string): TargetDish[] {
  const byRank = all.slice().sort((a, b) => a.rank - b.rank);
  const subs = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const picked: TargetDish[] = [];
  const seen = new Set<string>();
  const misses: string[] = [];
  for (const sub of subs) {
    const lc = sub.toLowerCase();
    const hit = byRank.find((d) => d.dish.toLowerCase().includes(lc) && !seen.has(d.key));
    if (!hit) { misses.push(sub); continue; }
    seen.add(hit.key);
    picked.push(hit);
  }
  if (misses.length) console.log(`⚠️ --targets: no unused match for ${misses.length} substring(s): ${misses.join(" | ")}`);
  return picked;
}

// ── band-stratified sampling (Phase 2: sample ACROSS rank bands, not the head) ─
// Splits N across three strata — top25 versions, midtail multi-version, and the
// N=1 tail (siblingCount===1) — then stride-picks within each (sorted by rank)
// for even spread. Deterministic: no RNG, so the sample is reproducible.
function stridePick<T>(items: T[], take: number): T[] {
  if (take >= items.length) return items.slice();
  if (take <= 0) return [];
  const out: T[] = [];
  const step = items.length / take;
  for (let k = 0; k < take; k++) out.push(items[Math.floor(k * step)]);
  return out;
}

function sampleAcrossBands(all: TargetDish[], n: number): TargetDish[] {
  const byRank = (a: TargetDish, b: TargetDish) => a.rank - b.rank;
  const top25 = all.filter((d) => d.band === "top25").sort(byRank);
  const midMulti = all.filter((d) => d.band === "midtail" && d.siblingCount > 1).sort(byRank);
  const n1tail = all.filter((d) => d.siblingCount === 1).sort(byRank);

  const nTop = Math.round(n * 0.34);
  const nTail = Math.round(n * 0.32);
  const nMid = n - nTop - nTail;

  const picked = [
    ...stridePick(top25, nTop),
    ...stridePick(midMulti, nMid),
    ...stridePick(n1tail, nTail),
  ];
  // De-dup by key (strata are disjoint, but guard anyway) and cap at n.
  const seen = new Set<string>();
  const out: TargetDish[] = [];
  for (const d of picked) {
    if (seen.has(d.key)) continue;
    seen.add(d.key);
    out.push(d);
    if (out.length >= n) break;
  }
  return out;
}

function bandBreakdown(dishes: TargetDish[]): string {
  const top = dishes.filter((d) => d.band === "top25").length;
  const tail = dishes.filter((d) => d.siblingCount === 1).length;
  const mid = dishes.length - top - tail;
  return `top25=${top}, midtail-multi=${mid}, N=1 tail=${tail}`;
}

// ── pre-flight cost estimate (HYPOTHESIS — the run reports the real number) ────
// Steady-state, cache-warm per-meal token model. RE-CALIBRATED (Block 3.8) to the
// REAL runtime numbers observed in LLMCallLog across the prior sample runs
// (store.generate_meal n=176, store.finalize_steps n=153) — the prior constants
// were the stale pre-3.7 prefix sizes (generate 4,058 / finalize 3,162) and
// under-counted the finalize user body. Current values, all runtime-observed:
//   • input (uncached user bodies): generate ~470 + finalize ~1,294 = 1,764
//   • output: generate ~1,375 + finalize ~1,584 = 2,959
//   • cacheRead (WARM tools+system prefix, read every call): generate 5,880
//     (measured) + finalize 5,154 (4,469 system after the D-WS9-069 base-step-purity
//     rewrite + ~685 tool schema) = 11,034. This is what the API reports as
//     cache_read on a warm hit.
// Body/output padded ~20% for completeness-retry regenerations. --max-cost is the
// hard ceiling regardless.
const EST_PER_MEAL = {
  aiCalls: 2,
  input: 470 + 1294, // uncached user bodies: generate target + finalize meal JSON
  output: 1375 + 1584, // generate meal JSON + finalize step arrays
  cacheRead: 5880 + 5154, // both warm tools+system prefixes, read from cache
  cacheCreation: 0,
};
const EST_RETRY_PAD = 1.2;
// One-time cache-creation on the first meal (writes each distinct prefix once).
const EST_FIRST_MEAL_CACHE_CREATION = 5880 + 5154;

function printPreflight(dishes: TargetDish[], rate: ModelRateUsd, maxCostUsd: number): void {
  const meals = dishes.length;
  const calls = meals * EST_PER_MEAL.aiCalls;
  const perMeal = computeCacheAwareCostUsd(EST_PER_MEAL, rate) * EST_RETRY_PAD;
  const firstMealExtra = computeCacheAwareCostUsd(
    { ...EST_PER_MEAL, cacheRead: 0, cacheCreation: EST_FIRST_MEAL_CACHE_CREATION },
    rate,
  ) - computeCacheAwareCostUsd({ ...EST_PER_MEAL, cacheRead: 0 }, rate);
  const est = perMeal * meals + firstMealExtra;

  console.log("");
  console.log("=== WS9 Block 3 store-fill — DRY-RUN PRE-FLIGHT (no API calls) ===");
  console.log(`rows to process:        ${meals}   (${bandBreakdown(dishes)})`);
  console.log(`estimated AI calls:     ${calls}   (2 per meal: generate + finalize)`);
  console.log(`rate:                   $${rate.inputPerMtokUsd}/Mtok in, $${rate.outputPerMtokUsd}/Mtok out`);
  console.log(`estimated cost:         ~$${est.toFixed(2)}   (HYPOTHESIS — real number comes from the run)`);
  console.log(`hard ceiling (--max-cost): $${maxCostUsd.toFixed(2)}`);
  console.log("");
  console.log("No API calls were made. Re-run without --dry-run to generate.");
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
      const subs = d.substitutionCount > 0 ? `, ${d.substitutionCount} substitution(s)` : "";
      // Block 3.7 (D-WS9-066) — surface the dual-path shape when the dish has one.
      const dual = d.boughtStepCount > 0
        ? `, ${d.componentCount} component(s) [${d.scratchStepCount} scratch / ${d.boughtStepCount} bought]`
        : "";
      console.log(`    - ${d.role}: "${d.title}" — ${d.ingredientCount} ingredients, ${d.stepCount} steps${subs}${dual}`);
    }
    console.log(`    allergens: [${r.allergens.join(", ") || "none"}]`);
  }

  if (result.substitutionDrops.length > 0) {
    console.log("");
    console.log(`substitution drops (unmatched replaces-name, dropped not fatal): ${result.substitutionDrops.length}`);
    for (const d of result.substitutionDrops) {
      console.log(`    [${d.targetDish}] "${d.dishTitle}" — dropped "${d.product}" (unmatched: ${d.unmatched.join(", ")})`);
    }
  }

  // Block 3.7 (D-WS9-066) — dual-path rollup + tag-validation findings.
  const dualDishes = result.records.reduce((n, r) => n + r.dishes.filter((d) => d.boughtStepCount > 0).length, 0);
  const totalComponents = result.records.reduce((n, r) => n + r.dishes.reduce((m, d) => m + d.componentCount, 0), 0);
  console.log("");
  console.log(`swappable components: ${dualDishes} dish(es) got a bought path, ${totalComponents} component(s) total`);
  if (result.componentTagFindings.length > 0) {
    console.log(`component tag findings (drop-and-keep, not fatal): ${result.componentTagFindings.length}`);
    for (const f of result.componentTagFindings) {
      console.log(`    [${f.targetDish}] "${f.dishTitle}" — ${f.reason}: ${f.detail}`);
    }
  } else {
    console.log("component tag findings: 0 (no tags stripped, no missing bought paths)");
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
  const args = parseArgs(process.argv.slice(2));
  const { apply, limit, sampleBands, targets, dryRun, dump, maxCostUsd, maxCalls } = args;

  // Select the dish set: --targets picks specific rows by name substring;
  // --sample-bands stratifies across rank bands; otherwise the harness takes the
  // first --limit by rank (the head). --targets wins if both are given.
  const sampled = targets
    ? selectTargets(TARGET_DISHES, targets)
    : sampleBands
      ? sampleAcrossBands(TARGET_DISHES, sampleBands)
      : undefined;
  const effLimit = sampled ? sampled.length : limit;

  const prisma = new PrismaClient();
  try {
    const rate = await getModelRate(MODEL_SONNET, prisma);

    if (dryRun) {
      const dishes = sampled ?? TARGET_DISHES.slice().sort((a, b) => a.rank - b.rank).slice(0, limit);
      printPreflight(dishes, rate, maxCostUsd);
      return;
    }

    const captures: StoreFillMealCapture[] = [];
    const result = await runStoreFill(
      { prisma },
      {
        apply,
        limit: effLimit,
        maxCostUsd,
        maxCalls,
        rate,
        dishes: sampled,
        log: (m) => console.log(m),
        onMeal: dump ? (c) => captures.push(c) : undefined,
      },
    );
    printResult(result);

    if (dump) {
      writeFileSync(dump, JSON.stringify(captures, null, 2), "utf8");
      console.log("");
      console.log(`dumped ${captures.length} full meals → ${dump}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

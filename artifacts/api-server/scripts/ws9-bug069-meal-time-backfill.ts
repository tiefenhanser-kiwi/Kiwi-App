// BUG-069 / D-WS9-128 — meal-level estimatedTimeMinutes undercounts unattended cook time.
//
// A probe established: Meal.estimatedTimeMinutes is the ONLY persisted meal-level
// time field, and the Cook Time sort reads it alone ascending (mealSort.ts:42).
// Store-fill composition and step generation are two independent passes
// (storeFill.ts:12) that diverged — a slow-cooker meal can store et=30 while
// carrying an honest 480-minute "cook on low for 8 hours" step, so it sorts above
// a 35-minute sheet-pan meal.
//
// DETECTION (provable, not heuristic): a meal cannot take less wall-clock time
// than one of its own steps, so `estimatedTimeMinutes < max(step estimatedMinutes)`
// is NECESSARILY wrong.
//
// RULED FORMULA (D-WS9-128):
//   Eligibility: max(step) >= 240  AND  et < max(step)
//   New value:   et := max(current et, Σ step estimatedMinutes)
// The max(...) guarantees we NEVER lower an already-correct value. The >=240 gate
// keeps quick parallel meals out of scope, where Σ step overcounts badly (the mash
// boils while the steak rests). Steps summed across BOTH dish-owned and meal-owned
// rows (a 283-row legacy meal-owned tail exists).
//
// Writes estimatedTimeMinutes and NOTHING ELSE. --dry-run is the DEFAULT; writing
// requires an explicit --apply. Idempotent: after apply, et >= maxStep so a second
// run flags zero rows.
//
// USAGE:
//   DRY-RUN: node --env-file=.env --import tsx scripts/ws9-bug069-meal-time-backfill.ts
//   APPLY:   node --env-file=.env --import tsx scripts/ws9-bug069-meal-time-backfill.ts --apply

import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PrismaClient } from "@prisma/client";

// __dirname shim (ESM) — the pattern that broke an earlier, never-run backfill.
const __dirname = dirname(fileURLToPath(import.meta.url));
void __dirname; // reserved for future CSV output; referenced so lint stays quiet.

// ── Pure, testable formula ────────────────────────────────────────────────────

/** The ruled gate: only meals with a genuine 4h+ unattended block. */
export const MAX_STEP_GATE = 240;
/** The information-only lower band the prompt asks us to report but NOT apply. */
export const REPORT_BAND = 120;

export interface MealTimeRow {
  id: string;
  title: string;
  sourceType: string;
  currentEt: number;
  maxStep: number;
  stepSum: number;
}

/** Eligibility for the applied fix: a real 4h+ step AND an et provably too low. */
export function isEligible(row: { maxStep: number; currentEt: number }): boolean {
  return row.maxStep >= MAX_STEP_GATE && row.currentEt < row.maxStep;
}

/**
 * The recompute. NEVER lowers a value — max(current, sum). A meal with no steps
 * has stepSum 0, so this returns the current value unchanged (and it is never
 * eligible anyway, since maxStep 0 < 240).
 */
export function recomputeEt(row: { currentEt: number; stepSum: number }): number {
  return Math.max(row.currentEt, row.stepSum);
}

// ── DB read: per-meal maxStep + stepSum across dish-owned AND meal-owned steps ──

async function loadMealTimeRows(prisma: PrismaClient): Promise<MealTimeRow[]> {
  // Pre-filter to meals with a maxStep >= REPORT_BAND so both the applied (>=240)
  // and information-only (>=120) bands are covered in one read. Everything below
  // 120 is out of scope entirely and never fetched.
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      title: string;
      sourceType: string;
      currentEt: number;
      maxStep: number;
      stepSum: number;
    }>
  >(`
    WITH steps AS (
      SELECT m.id, m.title, m."sourceType"::text AS "sourceType",
        m."estimatedTimeMinutes" AS "currentEt",
        GREATEST(COALESCE(ds.mx,0), COALESCE(msx.mx,0))::int AS "maxStep",
        (COALESCE(ds.sm,0) + COALESCE(msx.sm,0))::int AS "stepSum"
      FROM meals m
      LEFT JOIN LATERAL (
        SELECT sum(s."estimatedMinutes")::int sm, max(s."estimatedMinutes")::int mx
        FROM meal_dish_links l
        JOIN recipe_instruction_steps s
          ON s."ownerType" = 'dish' AND s."ownerId" = l."dishId"
        WHERE l."mealId" = m.id
      ) ds ON true
      LEFT JOIN LATERAL (
        SELECT sum(s."estimatedMinutes")::int sm, max(s."estimatedMinutes")::int mx
        FROM recipe_instruction_steps s
        WHERE s."ownerType" = 'meal' AND s."ownerId" = m.id
      ) msx ON true
    )
    SELECT id, title, "sourceType", "currentEt", "maxStep", "stepSum"
    FROM steps
    WHERE "maxStep" >= ${REPORT_BAND}
    ORDER BY "currentEt" ASC, "maxStep" DESC;
  `);
  return rows;
}

// ── Reporting ─────────────────────────────────────────────────────────────────

function printTable(title: string, rows: MealTimeRow[]): void {
  console.log(`\n${title} (${rows.length} rows)`);
  if (rows.length === 0) return;
  console.log(
    `  ${"id".padEnd(36)}  ${"src".padEnd(16)}  et→new   maxStep  stepSum  title`,
  );
  for (const r of rows) {
    const newEt = recomputeEt(r);
    console.log(
      `  ${r.id.padEnd(36)}  ${r.sourceType.padEnd(16)}  ` +
        `${String(r.currentEt).padStart(3)}→${String(newEt).padEnd(4)} ` +
        `${String(r.maxStep).padStart(6)}  ${String(r.stepSum).padStart(6)}  ` +
        r.title.slice(0, 60),
    );
  }
}

function countByProvenance(rows: MealTimeRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.sourceType] = (out[r.sourceType] ?? 0) + 1;
  return out;
}

async function run(prisma: PrismaClient, apply: boolean): Promise<void> {
  const all = await loadMealTimeRows(prisma);

  const eligible = all.filter(isEligible);
  // Information-only: the 120–239 band the prompt asks us to size but NOT apply.
  const bandOnly = all.filter(
    (r) => r.maxStep >= REPORT_BAND && r.maxStep < MAX_STEP_GATE && r.currentEt < r.maxStep,
  );

  console.log("=".repeat(78));
  console.log(`BUG-069 / D-WS9-128 — meal estimatedTimeMinutes recompute`);
  console.log(`mode: ${apply ? "APPLY (writing)" : "DRY-RUN (default, reads only)"}`);
  console.log(`gate: maxStep >= ${MAX_STEP_GATE} AND et < maxStep`);
  console.log(`formula: et := max(current et, Σ step estimatedMinutes)`);
  console.log("=".repeat(78));

  printTable("FLAGGED (eligible, will be recomputed)", eligible);

  console.log(`\nCounts by provenance (flagged):`, JSON.stringify(countByProvenance(eligible)));

  console.log(
    `\nInformation-only — the >=${REPORT_BAND} (2h) band would ADD ${bandOnly.length} ` +
      `more meals (maxStep ${REPORT_BAND}–${MAX_STEP_GATE - 1}, et<maxStep). NOT APPLIED.`,
  );
  if (bandOnly.length > 0) printTable(`  (2h-band additions — reported only)`, bandOnly);

  if (!apply) {
    console.log(
      `\nDRY-RUN complete. ${eligible.length} meals would change. ` +
        `Re-run with --apply to write.`,
    );
    return;
  }

  // ── APPLY: write estimatedTimeMinutes and NOTHING ELSE ──────────────────────
  let written = 0;
  for (const r of eligible) {
    const newEt = recomputeEt(r);
    if (newEt === r.currentEt) continue; // defensive; eligibility implies newEt>et
    const data = { estimatedTimeMinutes: newEt };
    // Hard assert: the write touches exactly one column.
    const keys = Object.keys(data);
    if (keys.length !== 1 || keys[0] !== "estimatedTimeMinutes") {
      throw new Error(`REFUSING WRITE: data touches ${keys.join(",")}, expected only estimatedTimeMinutes`);
    }
    await prisma.meal.update({ where: { id: r.id }, data });
    written++;
  }
  console.log(`\nAPPLY complete. Wrote estimatedTimeMinutes on ${written} meals.`);
}

// ── Entry (only when run directly, so tests can import the pure exports) ────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.argv.slice(2).includes("--apply");
  const prisma = new PrismaClient();
  run(prisma, apply)
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

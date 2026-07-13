// WS7-8b / BUG-032 — post-apply verification sweep (READ-ONLY).
//
// The regression pin for Phase 2 Correction 2 (Foundation ids are searchable but
// 404 on by-id fetch). Asserts, as HARD failures:
//   1. every matched nutritionRefPerUnit fdcId is BY-ID FETCHABLE (zero 404s) —
//      proves we did not write another unauditable pointer;
//   2. none of the 13 known-dead Foundation fdcIds remain anywhere;
//   3. the ratified re-matches landed (each applied row now carries its new
//      fdcId; fresh tarragon is a miss-marker; lime zest is untouched).
// Exit code 1 on any failed assertion.
//
// Run (PowerShell, from artifacts/api-server):
//   node --env-file=.env --import tsx scripts/ws7-8b-bug032-verify.ts

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { getFoodsBatch, isUsdaEnabled } from "../src/lib/usda/fdcClient";
import { isMatchedRef } from "../src/lib/usda/ingredientEnrichment";
import { parseCsv } from "./ws7-8b-usda-backfill";

const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "output");
const FETCH_CHUNK = 8;
const FETCH_RETRIES = 3;
const DEAD_FOUNDATION_IDS = new Set([
  747429, 323121, 747447, 333281, 328637, 321360, 324653, 747997, 746777, 329370,
  746767, 746766, 326698,
]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function latest(prefix: string): string {
  const files = readdirSync(OUTPUT_DIR).filter((f) => f.startsWith(prefix) && f.endsWith(".csv")).sort();
  if (files.length === 0) throw new Error(`no ${prefix}*.csv in output/`);
  return join(OUTPUT_DIR, files[files.length - 1]);
}

async function main(): Promise<void> {
  if (!isUsdaEnabled()) {
    console.error("USDA_INGREDIENTS_API_KEY not set — cannot run by-id fetchability check. Aborting.");
    process.exitCode = 1;
    return;
  }
  const failures: string[] = [];
  const prisma = new PrismaClient();
  try {
    const all = await prisma.ingredient.findMany({
      select: { id: true, canonicalName: true, nutritionRefPerUnit: true },
    });
    const matched = all.filter((r) => isMatchedRef(r.nutritionRefPerUnit));
    const misses = all.length - matched.length;
    console.log(`\n=== BUG-032 post-apply verification ===`);
    console.log(`  total rows:   ${all.length}`);
    console.log(`  matched:      ${matched.length}`);
    console.log(`  miss/other:   ${misses}\n`);

    // ── Assertion 1 — every matched fdcId is by-id fetchable ──
    const fdcIds = [
      ...new Set(matched.map((r) => (r.nutritionRefPerUnit as { fdcId: number }).fdcId)),
    ];
    console.log(`  by-id fetching ${fdcIds.length} unique fdcIds ...`);
    const fetched = new Set<number>();
    for (let i = 0; i < fdcIds.length; i += FETCH_CHUNK) {
      const chunk = fdcIds.slice(i, i + FETCH_CHUNK);
      for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
        const res = await getFoodsBatch(chunk);
        if (res.ok) {
          for (const f of res.data) fetched.add(f.fdcId);
          break;
        }
        if (res.reason === "rate_limited") {
          console.error("  ! rate-limited — re-run the verification later.");
          process.exitCode = 1;
          return;
        }
        await sleep(300 * attempt);
      }
      process.stdout.write(`\r  fetched ${Math.min(i + FETCH_CHUNK, fdcIds.length)}/${fdcIds.length}   `);
      await sleep(120);
    }
    process.stdout.write("\n");
    const unfetchable = fdcIds.filter((id) => !fetched.has(id));
    if (unfetchable.length > 0) {
      // Which ingredients point at each unfetchable id?
      for (const id of unfetchable) {
        const names = matched
          .filter((r) => (r.nutritionRefPerUnit as { fdcId: number }).fdcId === id)
          .map((r) => r.canonicalName);
        failures.push(`UNFETCHABLE fdcId ${id} still pointed at by: ${names.join(", ")}`);
      }
    }
    console.log(`  ASSERT zero by-id 404s: ${unfetchable.length === 0 ? "PASS ✓" : `FAIL (${unfetchable.length})`}`);

    // ── Assertion 2 — no known-dead Foundation id remains ──
    const deadRemaining = fdcIds.filter((id) => DEAD_FOUNDATION_IDS.has(id));
    if (deadRemaining.length > 0) failures.push(`known-dead Foundation ids still present: ${deadRemaining.join(", ")}`);
    console.log(`  ASSERT no dead-Foundation ids: ${deadRemaining.length === 0 ? "PASS ✓" : `FAIL (${deadRemaining.join(", ")})`}`);

    // ── Assertion 3 — the ratified re-matches landed ──
    const csvPath = latest("bug032-rematch-");
    const rows = parseCsv(readFileSync(csvPath, "utf8")).slice(1);
    const byId = new Map(all.map((r) => [r.id, r]));
    let landed = 0;
    let landFail = 0;
    for (const r of rows) {
      const bucket = r[0];
      const id = r[1];
      const name = r[2];
      const oldFdcId = r[4] ? Number(r[4]) : null;
      const newFdcId = r[6] ? Number(r[6]) : null;
      const dbRow = byId.get(id);
      if (!dbRow) { failures.push(`row ${name}: ingredient ${id} not found`); landFail++; continue; }
      const ref = dbRow.nutritionRefPerUnit as { fdcId?: number; matched?: boolean } | null;
      if (bucket === "MISS") {
        if (isMatchedRef(ref)) { failures.push(`${name}: expected miss-marker, still matched`); landFail++; }
        else landed++;
        continue;
      }
      if (newFdcId !== null && newFdcId === oldFdcId) {
        // no-op (lime zest): must be unchanged
        if (ref?.fdcId !== oldFdcId) { failures.push(`${name}: no-op row changed unexpectedly`); landFail++; }
        else landed++;
        continue;
      }
      if (ref?.fdcId !== newFdcId) {
        failures.push(`${name}: expected fdcId ${newFdcId}, got ${ref?.fdcId ?? "none"}`);
        landFail++;
      } else landed++;
    }
    console.log(`  ASSERT ratified re-matches landed: ${landFail === 0 ? `PASS ✓ (${landed}/${rows.length})` : `FAIL (${landFail})`}`);

    console.log(`\n${failures.length === 0 ? "ALL ASSERTIONS PASSED ✓" : `VERIFICATION FAILED — ${failures.length} issue(s):`}`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

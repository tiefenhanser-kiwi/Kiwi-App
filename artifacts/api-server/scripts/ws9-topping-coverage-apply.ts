// D-WS9-053 §4.0 — apply the ratified CURATED_PROPOSED volume factors from
// ws9-topping-coverage-dryrun.csv into Ingredient.conversionRef.
//
// Writes ONLY the gramsPerCup for rows marked source=CURATED_PROPOSED, MERGED
// into any existing conversionRef (preserves purchase*/gramsPerEach/subUnit),
// stamped source:'curated'. Rows marked NO_PROPOSAL / USDA_DERIVED are ignored.
// Idempotent: a second run writes nothing. NO USDA/AI calls.
//
// Run: node --env-file=.env --import tsx scripts/ws9-topping-coverage-apply.ts [--apply]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { parseCsv } from "./ws7-8b-usda-backfill";

const APPLY = process.argv.includes("--apply");
const CSV = join(process.cwd(), "scripts", "output", "ws9-topping-coverage-dryrun.csv");

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

const prisma = new PrismaClient();
try {
  const rows = parseCsv(readFileSync(CSV, "utf8"));
  const [header, ...data] = rows;
  // columns: 0 rank,1 ingredientId,2 canonicalName,...,8 source,9 gramsPerCup
  if (header[8] !== "source" || header[9] !== "gramsPerCup") throw new Error(`unexpected CSV header: ${header.join(",")}`);
  const proposed = data.filter((r) => r[8] === "CURATED_PROPOSED");
  const other = data.filter((r) => r[8] !== "CURATED_PROPOSED");
  console.log(`CSV rows: ${data.length}  CURATED_PROPOSED: ${proposed.length}  other (must stay untouched): ${other.length}`);

  let written = 0, unchanged = 0, skipped = 0;
  const priorSourceNote: string[] = [];
  const ops: Prisma.PrismaPromise<unknown>[] = [];
  for (const r of proposed) {
    const id = r[1], name = r[2], gc = Number(r[9]);
    if (!id || !Number.isFinite(gc) || gc <= 0) { console.warn(`  skip (bad row): ${name}`); skipped++; continue; }
    const ing = await prisma.ingredient.findUnique({ where: { id }, select: { conversionRef: true } });
    if (!ing) { console.warn(`  skip (ingredient gone): ${name}`); skipped++; continue; }
    const existing = (ing.conversionRef as Record<string, unknown> | null) ?? {};
    if (existing.source && existing.source !== "curated") priorSourceNote.push(`${name}: prior source=${existing.source as string}`);
    const next = { ...existing, gramsPerCup: gc, source: "curated" as const };
    if (stable(existing) === stable(next)) { unchanged++; continue; }
    if (APPLY) ops.push(prisma.ingredient.update({ where: { id }, data: { conversionRef: next as unknown as Prisma.InputJsonValue } }));
    written++;
    console.log(`  ${APPLY ? "WRITE" : "would-write"}: ${name.padEnd(30)} gramsPerCup=${gc}  (merged into ${Object.keys(existing).length ? JSON.stringify(existing) : "null"})`);
  }
  if (APPLY && ops.length) await prisma.$transaction(ops);

  console.log(`\n--- ${APPLY ? "APPLIED" : "DRY-RUN (pass --apply to write)"} ---`);
  console.log(`  written:   ${written}`);
  console.log(`  unchanged: ${unchanged} (idempotent)`);
  console.log(`  skipped:   ${skipped}`);
  if (priorSourceNote.length) { console.log(`  NOTE — rows that had a non-curated prior source (merged, now curated):`); for (const s of priorSourceNote) console.log(`    ${s}`); }
} finally { await prisma.$disconnect(); }

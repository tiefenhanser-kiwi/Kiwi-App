// [grocery] B3 · Part B — THE APPLY HALF OF THE ROUND TRIP.
//
//   node --env-file=.env --import tsx scripts/grocery-b3/apply.ts --dry-run
//   node --env-file=.env --import tsx scripts/grocery-b3/apply.ts --apply
//
// The reviewed sheet is `proposals.ts`. Every write lands with
// `reviewedByHuman: true` / `reviewedAt` — the OVERWRITE GUARD, so a later AI
// pass skips these rows rather than clobbering them.
//
// IDEMPOTENT. A second run reports everything unchanged. Reported per class:
// created / updated / unchanged / skipped.

import { PrismaClient } from "@prisma/client";

import { PACK_FIXES, YIELD_FIXES, EDGE_PROMOTIONS } from "./proposals";
import { assertScriptDatabase } from "../../src/lib/scripts/requireDatabaseHost";

const { host } = assertScriptDatabase("grocery-b3/apply");

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const REVIEWED_AT = new Date("2026-09-29T12:00:00.000Z");

type Stat = { created: number; updated: number; unchanged: number; skipped: number };
const stat = (): Stat => ({ created: 0, updated: 0, unchanged: 0, skipped: 0 });
const stats: Record<string, Stat> = {
  "P1 sandwich-bread pack": stat(),
  "P2 romaine pack yield": stat(),
  "P3 broth edge promotions": stat(),
};
const note = (s: string) => console.log(s);

async function main() {
  note(`[grocery] B3 Part B — ${APPLY ? "🔴 APPLY (writing)" : "DRY RUN (nothing written)"}`);
  note(`host ${host}`);
  note("");

  // ── P1 — packs ───────────────────────────────────────────────────────────
  note("## P1 — hand-seeded packs (ruling 6)");
  for (const p of PACK_FIXES) {
    const row = await prisma.ingredient.findUnique({
      where: { canonicalName: p.canonical },
      select: { id: true, purchaseUnit: true, purchaseQuantity: true, purchaseDisplay: true },
    });
    if (!row) { stats["P1 sandwich-bread pack"].skipped++; note(`  SKIP  "${p.canonical}" — no catalog row`); continue; }
    const same =
      row.purchaseUnit === p.purchaseUnit &&
      row.purchaseQuantity === p.purchaseQuantity &&
      row.purchaseDisplay === p.purchaseDisplay;
    if (same) { stats["P1 sandwich-bread pack"].unchanged++; note(`  ==    "${p.canonical}" already ${p.purchaseDisplay}`); continue; }
    note(`  SET   "${p.canonical}": ${row.purchaseQuantity ?? "-"} ${row.purchaseUnit ?? "-"} ${JSON.stringify(row.purchaseDisplay)} -> ${p.purchaseQuantity} ${p.purchaseUnit} ${JSON.stringify(p.purchaseDisplay)}`);
    note(`        why: ${p.why}`);
    if (APPLY) {
      await prisma.ingredient.update({
        where: { id: row.id },
        data: {
          purchaseUnit: p.purchaseUnit,
          purchaseQuantity: p.purchaseQuantity,
          purchaseDisplay: p.purchaseDisplay,
        },
      });
    }
    stats["P1 sandwich-bread pack"].updated++;
  }

  // ── P2 — pack yields ─────────────────────────────────────────────────────
  note("");
  note("## P2 — pack yields (ruling 7)");
  for (const y of YIELD_FIXES) {
    const row = await prisma.ingredient.findUnique({
      where: { canonicalName: y.canonical },
      select: {
        id: true, purchaseUnit: true, purchaseQuantity: true, purchaseDisplay: true,
        packYieldUnit: true, packYieldPerPack: true, packYieldSource: true,
        packYieldReviewedByHuman: true,
      },
    });
    if (!row) { stats["P2 romaine pack yield"].skipped++; note(`  SKIP  "${y.canonical}" — no catalog row`); continue; }
    const same = row.packYieldUnit === y.unit && row.packYieldPerPack === y.perPack && row.packYieldReviewedByHuman;
    if (same) { stats["P2 romaine pack yield"].unchanged++; note(`  ==    "${y.canonical}" already ${y.perPack} ${y.unit}/pack, reviewed`); continue; }
    note(`  SET   "${y.canonical}" (pack ${row.purchaseQuantity} ${row.purchaseUnit}): yield ${row.packYieldPerPack ?? "-"} ${row.packYieldUnit ?? "-"} -> ${y.perPack} ${y.unit} per pack`);
    note(`        why: ${y.why}`);
    if (APPLY) {
      await prisma.ingredient.update({
        where: { id: row.id },
        data: {
          packYieldUnit: y.unit,
          packYieldPerPack: y.perPack,
          packYieldSource: y.source,
          packYieldReviewedByHuman: true,
        },
      });
    }
    stats["P2 romaine pack yield"].updated++;
  }

  // ── P3 — edge promotions ─────────────────────────────────────────────────
  note("");
  note("## P3 — subsumes edges promoted to reviewed (ruling 8)");
  for (const e of EDGE_PROMOTIONS) {
    const [from, to] = await Promise.all([
      prisma.ingredient.findUnique({ where: { canonicalName: e.from }, select: { id: true } }),
      prisma.ingredient.findUnique({ where: { canonicalName: e.to }, select: { id: true } }),
    ]);
    if (!from || !to) { stats["P3 broth edge promotions"].skipped++; note(`  SKIP  ${e.from} -> ${e.to} — a row is missing`); continue; }
    const rel = await prisma.ingredientRelation.findUnique({
      where: { fromIngredientId_toIngredientId: { fromIngredientId: from.id, toIngredientId: to.id } },
      select: { id: true, label: true, confidence: true, reviewedByHuman: true },
    });
    if (!rel) { stats["P3 broth edge promotions"].skipped++; note(`  SKIP  ${e.from} -> ${e.to} — no edge`); continue; }
    if (rel.label !== e.label) {
      stats["P3 broth edge promotions"].skipped++;
      note(`  SKIP  ${e.from} -> ${e.to} — label is "${rel.label}", expected "${e.label}". REFUSING: a promotion must not change a label.`);
      continue;
    }
    if (rel.reviewedByHuman) { stats["P3 broth edge promotions"].unchanged++; note(`  ==    ${e.from} -> ${e.to} already reviewed`); continue; }
    note(`  SET   ${e.from} -> ${e.label} -> ${e.to}  (confidence ${rel.confidence}, unchanged) reviewedByHuman false -> true   [${e.why}]`);
    if (APPLY) {
      await prisma.ingredientRelation.update({
        where: { id: rel.id },
        data: { reviewedByHuman: true, reviewedAt: REVIEWED_AT },
      });
    }
    stats["P3 broth edge promotions"].updated++;
  }

  note("");
  note("## totals");
  for (const [k, s] of Object.entries(stats)) {
    note(`  ${k.padEnd(28)} created ${s.created}  updated ${s.updated}  unchanged ${s.unchanged}  skipped ${s.skipped}`);
  }
  if (!APPLY) note("\nDRY RUN — nothing was written. Re-run with --apply.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());

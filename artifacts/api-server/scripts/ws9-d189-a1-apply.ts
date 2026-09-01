// WS9 D-WS9-189 A1 — the apply half of the round trip.
//
// Reads a review sheet (or a -REVIEWED.csv edited in place per the BUG-096
// convention) and reports exactly what WOULD be written to
// `ingredient_relations`.
//
// Run (from artifacts/api-server):
//   node --env-file=.env --import tsx scripts/ws9-d189-a1-apply.ts --dry-run <sheet.csv>
//
// 🔴 --apply IS STILL GATED. Without --dry-run this exits 1 and writes nothing.
// Block A1 commits no relation rows; the write is a separate, explicit decision.
//
// THE REVIEW CONVENTION IT HONOURS (BUG-096, which Hans has completed by hand):
// the reviewer edits IN PLACE — overwrites `label`, overwrites `generic_is`
// where the label is SUBSUMES, and rewrites `judge_reason` as
// "reviewed YYYY-MM-DD: <why>".
//
// 🔴 THE `reviewed ` PREFIX IS THE MARKER, and honouring it is the whole point:
// a row carrying it is written with reviewedByHuman = true and is NEVER
// overwritten by an AI verdict, on this run or any future one.
//
// ⚠️ A MALFORMED EDIT MUST FAIL LOUDLY, NOT BE SKIPPED. A silently-ignored edit
// is the worst outcome available here: Hans would believe he had corrected
// something he had not, and the wrong row would ship under his name. Every
// validation below aborts the run rather than dropping the row.

import { readFileSync } from "node:fs";

import { PrismaClient } from "@prisma/client";

import { parseCsv } from "./ws7-8b-usda-backfill";

const VALID_LABELS = new Set(["SYNONYM", "COMPONENT", "DISTINCT", "SUBSUMES"]);
const HUMAN_MARKER = /^reviewed\s/i;

interface SheetRow {
  lineNo: number;
  rowKind: string;
  nameA: string;
  nameB: string;
  label: string;
  confidence: string;
  baseIs: string;
  genericIs: string;
  yieldQty: string;
  yieldUnit: string;
  coHarvestable: string;
  judgeReason: string;
}

interface Problem {
  lineNo: number;
  pair: string;
  message: string;
}

function col(header: string[], row: string[], name: string): string {
  const i = header.indexOf(name);
  return i === -1 ? "" : (row[i] ?? "").trim();
}

/**
 * Validate one row. Returns every problem found rather than the first, so a
 * reviewer fixing a sheet sees the whole list in one pass.
 */
function validate(r: SheetRow): Problem[] {
  const out: Problem[] = [];
  const pair = `"${r.nameA}" ~ "${r.nameB}"`;
  const label = r.label.toUpperCase();

  if (!VALID_LABELS.has(label)) {
    out.push({
      lineNo: r.lineNo,
      pair,
      message: `unknown label "${r.label}" — must be one of ${[...VALID_LABELS].join(", ")}`,
    });
    // No point checking label-specific fields against a label we do not know.
    return out;
  }

  if (label === "SUBSUMES") {
    if (r.genericIs.length === 0) {
      out.push({
        lineNo: r.lineNo,
        pair,
        message: "SUBSUMES with no generic_is — the direction IS the assertion, so a blank one is not a partial row, it is a different claim",
      });
    } else if (r.genericIs !== r.nameA && r.genericIs !== r.nameB) {
      out.push({
        lineNo: r.lineNo,
        pair,
        message: `generic_is "${r.genericIs}" is neither endpoint of the pair`,
      });
    }
    if (r.yieldQty.length > 0 || r.yieldUnit.length > 0 || r.coHarvestable.length > 0) {
      out.push({
        lineNo: r.lineNo,
        pair,
        message: "SUBSUMES carries a magnitude — it is satisfiability, not yield; leave yield_qty / yield_unit / co_harvestable blank",
      });
    }
  }

  if (label === "COMPONENT") {
    if (r.baseIs.length === 0) {
      out.push({ lineNo: r.lineNo, pair, message: "COMPONENT with no base_is — which side do you buy?" });
    } else if (r.baseIs !== r.nameA && r.baseIs !== r.nameB) {
      out.push({ lineNo: r.lineNo, pair, message: `base_is "${r.baseIs}" is neither endpoint of the pair` });
    }
    if (r.yieldQty.length === 0 || Number.isNaN(Number(r.yieldQty))) {
      out.push({ lineNo: r.lineNo, pair, message: `COMPONENT needs a numeric yield_qty (D-WS9-194), got "${r.yieldQty}"` });
    }
    if (r.yieldUnit.length === 0) {
      out.push({ lineNo: r.lineNo, pair, message: "COMPONENT needs a yield_unit (D-WS9-194)" });
    }
    if (r.coHarvestable !== "true" && r.coHarvestable !== "false") {
      out.push({
        lineNo: r.lineNo,
        pair,
        message: `COMPONENT needs co_harvestable true/false (D-WS9-194) — it is what makes the pool take max rather than sum; got "${r.coHarvestable}"`,
      });
    }
  }

  if ((label === "SYNONYM" || label === "DISTINCT") && r.genericIs.length > 0) {
    out.push({
      lineNo: r.lineNo,
      pair,
      message: `${label} carries a generic_is — only SUBSUMES is directed that way`,
    });
  }

  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const sheetPath = argv.find((a) => !a.startsWith("--"));

  if (!sheetPath) {
    console.error("usage: ws9-d189-a1-apply.ts --dry-run <sheet.csv>");
    process.exitCode = 1;
    return;
  }

  if (!dryRun) {
    console.error(
      "\n🔴 --apply is GATED. Block A1 commits NO relation rows to the database.\n" +
        "   Re-run with --dry-run to see the plan. Writing requires an explicit\n" +
        "   written GO-AHEAD, which this block does not have.\n",
    );
    process.exitCode = 1;
    return;
  }

  const text = readFileSync(sheetPath, "utf8");
  const parsed = parseCsv(text);
  if (parsed.length < 2) {
    console.error("sheet has no data rows");
    process.exitCode = 1;
    return;
  }
  const header = parsed[0]!.map((h) => h.trim());
  const rows: SheetRow[] = parsed.slice(1).map((row, i) => ({
    lineNo: i + 2,
    rowKind: col(header, row, "row_kind"),
    nameA: col(header, row, "name_a"),
    nameB: col(header, row, "name_b"),
    label: col(header, row, "label"),
    confidence: col(header, row, "confidence"),
    baseIs: col(header, row, "base_is"),
    genericIs: col(header, row, "generic_is"),
    yieldQty: col(header, row, "yield_qty"),
    yieldUnit: col(header, row, "yield_unit"),
    coHarvestable: col(header, row, "co_harvestable"),
    judgeReason: col(header, row, "judge_reason"),
  }));

  console.log(`\n=== APPLY (DRY RUN) — ${sheetPath} ===`);
  console.log(`  rows in sheet: ${rows.length}`);

  const problems = rows.flatMap(validate);
  const reviewed = rows.filter((r) => HUMAN_MARKER.test(r.judgeReason));
  console.log(`  human-reviewed (judge_reason starts "reviewed "): ${reviewed.length}`);
  console.log(`  AI verdicts:                                     ${rows.length - reviewed.length}`);

  if (problems.length > 0) {
    console.error(`\n🔴 ABORTING — ${problems.length} malformed row(s). NOTHING WOULD BE WRITTEN.`);
    console.error(`   A malformed edit is not skipped: a silently-dropped correction is a`);
    console.error(`   wrong row shipped under a reviewer's name.\n`);
    for (const p of problems) {
      console.error(`   line ${p.lineNo}: ${p.pair}`);
      console.error(`      ${p.message}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`  validation: OK — 0 malformed rows`);

  // Resolve endpoints so the plan reports what could not be matched, rather
  // than discovering it at write time.
  const prisma = new PrismaClient();
  try {
    const catalog = await prisma.ingredient.findMany({ select: { id: true, canonicalName: true } });
    const byName = new Map(catalog.map((c) => [c.canonicalName.toLowerCase(), c.id]));
    const unresolved = rows.filter(
      (r) => !byName.has(r.nameA.toLowerCase()) || !byName.has(r.nameB.toLowerCase()),
    );

    const existing = await prisma.ingredientRelation.count();
    console.log(`\n  ingredient_relations rows currently in DB: ${existing}`);
    if (unresolved.length > 0) {
      console.log(`  ⚠️ ${unresolved.length} row(s) name an ingredient not in the catalog — they would be skipped:`);
      for (const r of unresolved.slice(0, 5)) console.log(`      line ${r.lineNo}: "${r.nameA}" ~ "${r.nameB}"`);
    }

    console.log(`\n  PLAN:`);
    console.log(`    would upsert ${rows.length - unresolved.length} relation row(s)`);
    console.log(`      of which reviewedByHuman = true: ${reviewed.length}`);
    console.log(`    ⚠️ an existing row with reviewedByHuman = true is SKIPPED, never overwritten`);

    // Show the human-reviewed rows explicitly — they are the ones whose whole
    // purpose is to survive.
    if (reviewed.length > 0) {
      console.log(`\n  HUMAN VERDICTS CARRIED (AI verdict NOT reapplied):`);
      for (const r of reviewed) {
        const dir =
          r.label.toUpperCase() === "SUBSUMES"
            ? `  generic=${r.genericIs}`
            : r.label.toUpperCase() === "COMPONENT"
              ? `  base=${r.baseIs} yield=${r.yieldQty} ${r.yieldUnit} coHarvest=${r.coHarvestable}`
              : "";
        console.log(`    "${r.nameA}" ~ "${r.nameB}"  =>  ${r.label.toUpperCase()}${dir}`);
        console.log(`        ${r.judgeReason}`);
      }
    }

    console.log(`\n  DRY RUN — nothing written.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

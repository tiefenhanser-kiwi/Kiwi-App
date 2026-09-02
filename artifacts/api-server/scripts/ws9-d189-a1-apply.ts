// WS9 D-WS9-189 A1 — the apply half of the round trip.
//
// Reads a review sheet (or a -REVIEWED.csv edited in place per the BUG-096
// convention) and reports exactly what WOULD be written to
// `ingredient_relations`.
//
// Run (from artifacts/api-server):
//   node --env-file=.env --import tsx scripts/ws9-d189-a1-apply.ts --dry-run <sheet.csv>
//
// GO-AHEAD, September 1 2026: the write is authorised. `--dry-run` plans;
// without it, rows land. Idempotent, and human-reviewed rows are never touched.
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
import { JUDGE_MODEL, PROMPT_VERSION } from "./ws9-d189-a1/judge";
import { stripProvenance } from "./ws9-d189-a1/pairUniverse";

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
  family: string;
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

  // GO-AHEAD, September 1 2026: the write is authorised. `--dry-run` still
  // plans without writing; without it, rows land.

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
    family: col(header, row, "family"),
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
    // §3 SHORTENED NAMES MUST STILL RESOLVE. The universe strips redundant
    // provenance qualifiers, so `store-bought naan` is judged as `naan` — but
    // the CATALOG still holds the long name, and a plain lookup misses it.
    // Without this, 4 relations would be silently skipped at write time, which
    // is exactly the quiet loss this pipeline keeps being corrected for.
    for (const c of catalog) {
      const stripped = stripProvenance(c.canonicalName);
      if (stripped && !byName.has(stripped.toLowerCase())) {
        byName.set(stripped.toLowerCase(), c.id);
      }
    }
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

    if (dryRun) {
      console.log(`\n  DRY RUN — nothing written.`);
      return;
    }

    // ── the write ───────────────────────────────────────────────────────────
    //
    // 🔴 IDEMPOTENT, AND IT HAS TO STAY THAT WAY FOR MORE THAN ONE RUN. Hans:
    // "I'll probably run the process again closer to the holidays for Paleo,
    // Keto, Whole30". So this is authored once and EXTENDED, not a one-shot
    // backfill, and every future run must leave settled rows alone:
    //
    //   · upsert keyed on the ORDERED pair, so a re-run updates rather than
    //     duplicates (the @@unique([fromIngredientId, toIngredientId]));
    //   · a stored row with reviewedByHuman = true is SKIPPED ENTIRELY, so a
    //     later AI verdict can never overwrite a human decision. Re-judging
    //     settled rows would re-open decisions someone already made.
    const stats = {
      created: 0,
      updated: 0,
      unchanged: 0,
      skippedHuman: 0,
      skippedUnresolved: unresolved.length,
      byLabel: new Map<string, number>(),
      byProvenance: new Map<string, number>(),
    };

    const existingRows = await prisma.ingredientRelation.findMany({
      select: {
        fromIngredientId: true,
        toIngredientId: true,
        reviewedByHuman: true,
        label: true,
        yieldQuantity: true,
        yieldUnit: true,
        coHarvestable: true,
        confidence: true,
        rationale: true,
      },
    });
    const existingByPair = new Map(
      existingRows.map((r) => [`${r.fromIngredientId}::${r.toIngredientId}`, r]),
    );

    for (const r of rows) {
      const aId = byName.get(r.nameA.toLowerCase());
      const bId = byName.get(r.nameB.toLowerCase());
      if (!aId || !bId) continue;

      const label = r.label.toUpperCase() as
        | "SYNONYM"
        | "COMPONENT"
        | "DISTINCT"
        | "SUBSUMES";
      const reviewed = HUMAN_MARKER.test(r.judgeReason);

      // Direction. COMPONENT points base -> derived; SUBSUMES points generic ->
      // specific; the symmetric labels are stored in canonical name order so one
      // pair is always one row.
      let fromId = aId;
      let toId = bId;
      if (label === "COMPONENT" && r.baseIs.length > 0) {
        [fromId, toId] = r.baseIs === r.nameA ? [aId, bId] : [bId, aId];
      } else if (label === "SUBSUMES" && r.genericIs.length > 0) {
        [fromId, toId] = r.genericIs === r.nameA ? [aId, bId] : [bId, aId];
      } else if (r.nameA.localeCompare(r.nameB) > 0) {
        [fromId, toId] = [bId, aId];
      }

      const prior =
        existingByPair.get(`${fromId}::${toId}`) ?? existingByPair.get(`${toId}::${fromId}`);
      if (prior?.reviewedByHuman && !reviewed) {
        stats.skippedHuman += 1;
        continue;
      }

      const data = {
        label: label.toLowerCase() as "synonym" | "component" | "distinct" | "subsumes",
        yieldQuantity: label === "COMPONENT" ? Number(r.yieldQty) : null,
        yieldUnit: label === "COMPONENT" ? r.yieldUnit : null,
        coHarvestable: label === "COMPONENT" ? r.coHarvestable === "true" : null,
        source: (reviewed ? "human" : "ai_judge") as "human" | "ai_judge",
        confidence: (r.confidence === "high" || r.confidence === "medium" || r.confidence === "low"
          ? r.confidence
          : "medium") as "high" | "medium" | "low",
        judgeModel: reviewed ? null : JUDGE_MODEL,
        promptVersion: reviewed ? null : PROMPT_VERSION,
        rationale: r.judgeReason,
        familyKey: r.family || null,
        reviewedByHuman: reviewed,
        reviewedAt: reviewed ? new Date() : null,
      };

      // A row already holding these exact values is left alone entirely, so a
      // re-run genuinely writes NOTHING rather than rewriting every row with
      // itself. This matters because the pipeline is now periodic, not one-shot.
      if (
        prior &&
        prior.label === data.label &&
        prior.yieldQuantity === data.yieldQuantity &&
        prior.yieldUnit === data.yieldUnit &&
        prior.coHarvestable === data.coHarvestable &&
        prior.confidence === data.confidence &&
        prior.rationale === data.rationale
      ) {
        stats.unchanged += 1;
        continue;
      }

      const wasThere = Boolean(prior);
      await prisma.ingredientRelation.upsert({
        where: { fromIngredientId_toIngredientId: { fromIngredientId: fromId, toIngredientId: toId } },
        create: { fromIngredientId: fromId, toIngredientId: toId, ...data },
        update: data,
      });
      if (wasThere) stats.updated += 1;
      else stats.created += 1;
      stats.byLabel.set(label, (stats.byLabel.get(label) ?? 0) + 1);
      const prov = reviewed ? "human-reviewed" : "ai";
      stats.byProvenance.set(prov, (stats.byProvenance.get(prov) ?? 0) + 1);
    }

    const finalCount = await prisma.ingredientRelation.count();
    const humanCount = await prisma.ingredientRelation.count({ where: { reviewedByHuman: true } });
    console.log(`\n=== WRITTEN ===`);
    console.log(`  created: ${stats.created}  ·  updated: ${stats.updated}  ·  unchanged (left alone): ${stats.unchanged}`);
    console.log(`  skipped (stored row is human-reviewed, AI verdict refused): ${stats.skippedHuman}`);
    console.log(`  skipped (endpoint not in catalog): ${stats.skippedUnresolved}`);
    console.log(
      `  by label: ${[...stats.byLabel].sort().map(([k, v]) => `${k}:${v}`).join("  ")}`,
    );
    console.log(
      `  by provenance: ${[...stats.byProvenance].sort().map(([k, v]) => `${k}:${v}`).join("  ")}`,
    );
    console.log(`\n  ingredient_relations total:  ${finalCount}`);
    console.log(`  reviewedByHuman = true:      ${humanCount}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

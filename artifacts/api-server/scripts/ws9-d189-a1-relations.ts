// WS9 D-WS9-189 Block A1 — the ingredient-relationship authoring pipeline.
//
// THE SHIPPED IDIOM, third time: --dry-run (writes nothing, emits the CSV) ->
// human review -> --apply. Same shape as ws7-8b-b1-recategorize-ingredients.ts
// and ws7-8b-bug032-nutrition-audit.ts.
//
// Run (PowerShell, from artifacts/api-server):
//   PHASE 0 (free, no API):  node --env-file=.env --import tsx scripts/ws9-d189-a1-relations.ts --phase0
//   §27.4 GUARD (free):      node --env-file=.env --import tsx scripts/ws9-d189-a1-relations.ts --fixture
//   PILOT (spends):          node --env-file=.env --import tsx scripts/ws9-d189-a1-relations.ts --dry-run --pilot
//   FULL DRY-RUN (spends):   node --env-file=.env --import tsx scripts/ws9-d189-a1-relations.ts --dry-run
//   WRITE:                   node --env-file=.env --import tsx scripts/ws9-d189-a1-relations.ts --apply
//
// 🔴 --apply IS GATED ON A HUMAN GO-AHEAD. It is not part of Block A1. The full
// run is a spend decision Hans makes against the MEASURED pilot error rate, not
// against an estimate — because a measurement taken under a known-defective
// instrument is not a measurement, and the earlier 3/31 pilot rate was
// attributable to a rubric D-WS9-197 has since fixed.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";
import { PrismaClient } from "@prisma/client";

import { encodeCsvRow } from "./ws7-8b-usda-backfill";
import {
  batchByFamily,
  buildPairUniverse,
  familyOf,
  type CatalogRow,
  type NormalizedRow,
  type Pair,
} from "./ws9-d189-a1/pairUniverse";
import {
  costUsd,
  judgeBatch,
  JUDGE_MODEL,
  PROMPT_VERSION,
  type JudgedPair,
  type Usage,
} from "./ws9-d189-a1/judge";
import { formatDetectorReport, runDetectors } from "./ws9-d189-a1/contradiction";

const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "output");

// A family batch bigger than this is split. Splits are LOGGED — a split family
// loses the intra-call consistency guarantee, and a cap that quietly truncates
// coverage reads as "covered everything" when it did not.
//
// ⚠️ 40 WAS AN UNFORCED GUESS AND THE MEASUREMENT SAYS SO. It was picked to fit
// a hardcoded max_tokens of 16,000, not any ceiling the model has. Measured
// against claude-opus-5: tomato's whole 224-pair family is 8,720 INPUT tokens
// against a 1M context window, and all 2,253 pairs in one call would be 65,562
// (6.6% of context). The binding constraint was only ever OUTPUT tokens, which
// judge.ts now sizes from the batch and streams. `--no-cap` removes the cap
// entirely, which is what Part 2 measures.
const MAX_PAIRS_PER_BATCH = 40;

// Concurrent judge calls. Same lever as BUG-032's JUDGE_CONCURRENCY, kept low
// because each call is a high-effort Opus request.
const JUDGE_CONCURRENCY = 4;

// Size of the marked spot-check sample drawn from the AUTO-ACCEPTED verdicts.
// ⚠️ WITHOUT THIS, "the judge approved it" IS AN UNFALSIFIABLE CLAIM. It is the
// only part of the CSV that validates the judge rather than the catalog.
// Raised 30 -> 60: chat-Claude now pre-triages the sheet, so the sample is read
// by something that can actually work through 60 rows.
const SPOTCHECK_SIZE = 60;

// ── the pilot sample ───────────────────────────────────────────────────────
// Families the pilot MUST cover, because each is a place the rubric is known to
// be hard or where Hans has already ruled and the judge must agree with him:
//   citrus       the D-WS9-197 defect itself (lime/lemon juice + zest + wedges)
//   salt         "iodized salt is NOT kosher is NOT flaky sea salt"
//   pepper_corn  "peppercorns as an ingredient are different than black pepper"
//   sugar        "granulated and white are probably always the same thing"
//   oil_fat      the one family STAPLE_VARIANT_TO_BASE gets RIGHT — a
//                regression check, not a hard case
//   tomato       the `[whole]` signature: diced vs whole peeled
//   allium       garlic head / clove — the component case head-noun clustering
//                structurally misses
const PILOT_FAMILIES = [
  "citrus",
  "salt",
  "pepper_corn",
  "sugar",
  "oil_fat",
  "tomato",
  "allium",
] as const;

// Plus a deterministic slice of the remaining families, so the measured error
// rate is not read purely off the hardest cases. Taken by stable hash rather
// than at random, so a re-run measures the same sample.
const PILOT_EXTRA_FAMILIES = 5;

function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface Row {
  kind: "RESIDUE" | "SPOTCHECK";
  reason: string;
  judged: JudgedPair;
  contradictionDetail: string;
}

const CSV_HEADER = [
  "row_kind",
  "reason",
  "family",
  "name_a",
  "name_b",
  "label",
  "confidence",
  "base_is",
  "yield_qty",
  "yield_unit",
  "co_harvestable",
  "judge_reason",
  "signature",
  "straddles_processing",
  "contradiction_detail",
  "hans_verdict",
  "hans_notes",
] as const;

function toCsvRow(r: Row): string {
  const { pair, verdict, familyKey } = r.judged;
  const baseIs =
    verdict.label === "COMPONENT" && typeof verdict.baseIsA === "boolean"
      ? verdict.baseIsA
        ? pair.a.canonicalName
        : pair.b.canonicalName
      : "";
  return encodeCsvRow([
    r.kind,
    r.reason,
    familyKey,
    pair.a.canonicalName,
    pair.b.canonicalName,
    verdict.label,
    verdict.confidence,
    baseIs,
    verdict.yieldQuantity ?? "",
    verdict.yieldUnit ?? "",
    verdict.coHarvestable === null || verdict.coHarvestable === undefined
      ? ""
      : String(verdict.coHarvestable),
    verdict.reason,
    pair.signature,
    String(pair.straddlesProcessing),
    r.contradictionDetail,
    "",
    "",
  ]);
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * The auto-accept rule (Hans, August 31). A confident, non-contradictory,
 * DECIDED verdict writes its row and never reaches him. Everything else is
 * residue.
 *
 * A COMPONENT verdict missing its magnitude is NOT auto-accepted regardless of
 * confidence — D-WS9-194 is not advisory, and a component row without
 * yieldQuantity/yieldUnit/coHarvestable is a table Block B cannot compute from.
 */
function isAutoAcceptable(j: JudgedPair, flagged: boolean): { ok: boolean; reason: string } {
  if (flagged) return { ok: false, reason: "contradiction_flagged" };
  if (j.verdict.label === "UNSURE") return { ok: false, reason: "unsure" };
  if (j.verdict.confidence !== "high") return { ok: false, reason: `confidence_${j.verdict.confidence}` };
  if (j.verdict.label === "COMPONENT") {
    const hasMagnitude =
      typeof j.verdict.yieldQuantity === "number" &&
      Number.isFinite(j.verdict.yieldQuantity) &&
      typeof j.verdict.yieldUnit === "string" &&
      j.verdict.yieldUnit.length > 0 &&
      typeof j.verdict.coHarvestable === "boolean" &&
      typeof j.verdict.baseIsA === "boolean";
    if (!hasMagnitude) return { ok: false, reason: "component_missing_magnitude" };
  }
  return { ok: true, reason: "auto_accepted" };
}

// ── Phase 0 ────────────────────────────────────────────────────────────────

function reportPhase0(normalized: NormalizedRow[], pairs: Pair[]): void {
  const rowsInPair = new Set<string>();
  for (const p of pairs) {
    rowsInPair.add(p.a.id);
    rowsInPair.add(p.b.id);
  }
  const straddle = pairs.filter((p) => p.straddlesProcessing);
  const viaCore = pairs.filter((p) => p.via === "same_core").length;

  console.log(`\n=== PHASE 0 — pair universe (D-WS9-196) ===`);
  console.log(`  catalog rows:               ${normalized.length}`);
  console.log(`  PAIRS:                      ${pairs.length}`);
  console.log(`    via same_core:            ${viaCore}`);
  console.log(`    via containment:          ${pairs.length - viaCore}`);
  console.log(`  rows in >= 1 pair:          ${rowsInPair.size}`);
  console.log(
    `  processing-boundary straddle: ${straddle.length}  (${((straddle.length / pairs.length) * 100).toFixed(1)}% of ${pairs.length})`,
  );

  const bySignature = new Map<string, number>();
  for (const p of pairs) bySignature.set(p.signature, (bySignature.get(p.signature) ?? 0) + 1);
  console.log(`  distinct signatures:        ${bySignature.size}`);
  console.log(
    `  top signatures:             ${[...bySignature]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([s, c]) => `[${s}]:${c}`)
      .join("  ")}`,
  );

  const batches = batchByFamily(pairs, MAX_PAIRS_PER_BATCH);
  const families = new Set(batches.map((b) => b.familyKey));
  const splitFamilies = new Set(batches.filter((b) => b.split).map((b) => b.familyKey));
  console.log(`  families:                   ${families.size}`);
  console.log(`  judge batches:              ${batches.length}`);
  console.log(
    `  SPLIT families (lose the intra-call consistency guarantee; the detector covers them): ${
      splitFamilies.size === 0 ? "none" : [...splitFamilies].sort().join(", ")
    }`,
  );
}

// ── §27.4 fixture ──────────────────────────────────────────────────────────

function fakeRow(id: string, canonicalName: string): NormalizedRow {
  return {
    id,
    canonicalName,
    category: "fixture",
    tokens: canonicalName.split(" "),
    tokenSet: new Set(canonicalName.split(" ")),
    core: canonicalName,
    head: canonicalName.split(" ").at(-1) ?? "",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fixturePair(aName: string, bName: string, signature: string, family: string): Pair {
  return {
    a: fakeRow(`fx-${aName}`, aName),
    b: fakeRow(`fx-${bName}`, bName),
    via: "containment",
    signature,
    straddlesProcessing: true,
    familyKey: family,
  };
}

/**
 * §27.4 — the deliberate-contradiction fixture.
 *
 * Reproduces the exact D-WS9-197 defect (lime/lemon juice given divergent
 * labels) plus a transitivity conflict, then requires the detector to go RED.
 * A guard that has never been seen to fail is not a guard.
 */
function buildContradictoryFixture(): JudgedPair[] {
  const mk = (
    pair: Pair,
    label: "SYNONYM" | "COMPONENT" | "DISTINCT",
  ): JudgedPair => ({
    pair,
    familyKey: pair.familyKey,
    batchSplit: false,
    verdict: {
      pairIndex: 0,
      label,
      confidence: "high",
      reason: "fixture",
      yieldQuantity: null,
      yieldUnit: null,
      coHarvestable: null,
    },
  });

  return [
    // Detector 1: identical signature `juice` inside one family, divergent
    // labels. THE D-WS9-197 defect, reproduced verbatim.
    mk(fixturePair("lime", "lime juice", "juice", "citrus"), "COMPONENT"),
    mk(fixturePair("lemon", "lemon juice", "juice", "citrus"), "DISTINCT"),
    // Detector 2: a synonym chain that contradicts a distinct.
    mk(fixturePair("granulated sugar", "white sugar", "granulated|white", "sugar"), "SYNONYM"),
    mk(fixturePair("white sugar", "cane sugar", "cane|white", "sugar"), "SYNONYM"),
    mk(fixturePair("granulated sugar", "cane sugar", "cane|granulated", "sugar"), "DISTINCT"),
    // Detector 3: same base `onion`, both differences one colour word, split
    // labels. Taken from the pilot, where the judge produced exactly this.
    mk(fixturePair("onion", "white onion", "white", "allium"), "DISTINCT"),
    mk(fixturePair("onion", "yellow onion", "yellow", "allium"), "SYNONYM"),
  ];
}

/** Same shape, deliberately coherent — the detector must stay green on it. */
function buildCoherentFixture(): JudgedPair[] {
  const mk = (pair: Pair, label: "SYNONYM" | "COMPONENT" | "DISTINCT"): JudgedPair => ({
    pair,
    familyKey: pair.familyKey,
    batchSplit: false,
    verdict: {
      pairIndex: 0,
      label,
      confidence: "high",
      reason: "fixture",
      yieldQuantity: null,
      yieldUnit: null,
      coHarvestable: null,
    },
  });
  return [
    mk(fixturePair("lime", "lime juice", "juice", "citrus"), "COMPONENT"),
    mk(fixturePair("lemon", "lemon juice", "juice", "citrus"), "COMPONENT"),
    mk(fixturePair("granulated sugar", "white sugar", "granulated|white", "sugar"), "SYNONYM"),
    mk(fixturePair("white sugar", "cane sugar", "cane|white", "sugar"), "SYNONYM"),
    mk(fixturePair("granulated sugar", "cane sugar", "cane|granulated", "sugar"), "SYNONYM"),
    mk(fixturePair("onion", "white onion", "white", "allium"), "DISTINCT"),
    mk(fixturePair("onion", "yellow onion", "yellow", "allium"), "DISTINCT"),
    // The scoping control: a `white` difference in a DIFFERENT family. An
    // unscoped signature detector flags this against `onion ~ white onion`
    // above; a scoped one must not, because the two are not analogous.
    mk(fixturePair("sugar", "white sugar", "white", "sugar"), "SYNONYM"),
  ];
}

function runFixture(): number {
  console.log(`\n=== §27.4 — PROVING THE GUARD ===`);
  console.log(`\n--- 1. deliberately contradictory fixture (MUST go RED on all three) ---`);
  const bad = buildContradictoryFixture();
  const badReport = runDetectors(bad);
  console.log(formatDetectorReport(badReport, bad));

  console.log(`\n--- 2. coherent control fixture (MUST stay green) ---`);
  const good = buildCoherentFixture();
  const goodReport = runDetectors(good);
  console.log(formatDetectorReport(goodReport, good));

  const redOk =
    badReport.bySignature > 0 && badReport.byTransitivity > 0 && badReport.bySameBase > 0;
  const greenOk = goodReport.contradictions.length === 0;
  console.log(
    `\n  RESULT: contradictory fixture ${redOk ? "RED ✓ (all 3 detectors)" : "DID NOT GO RED ✗"} · coherent control ${
      greenOk ? "green ✓" : "FALSE POSITIVE ✗"
    }`,
  );
  return redOk && greenOk ? 0 : 1;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const wantPhase0 = argv.includes("--phase0");
  const wantFixture = argv.includes("--fixture");
  const wantDryRun = argv.includes("--dry-run");
  const wantApply = argv.includes("--apply");
  const pilotOnly = argv.includes("--pilot");
  // Part 2: judge each family WHOLE, one call, no cap.
  const noCap = argv.includes("--no-cap");
  const runTag = (argv.find((a) => a.startsWith("--tag=")) ?? "--tag=").slice("--tag=".length);

  if (wantFixture) {
    process.exitCode = runFixture();
    if (!wantPhase0 && !wantDryRun && !wantApply) return;
  }

  const prisma = new PrismaClient();
  try {
    const catalog: CatalogRow[] = await prisma.ingredient.findMany({
      select: { id: true, canonicalName: true, category: true },
      orderBy: { canonicalName: "asc" },
    });
    const { normalized, pairs } = buildPairUniverse(catalog);

    if (wantPhase0) {
      reportPhase0(normalized, pairs);
      const aliasCount = await prisma.ingredientAlias.count();
      console.log(
        `\n  D-WS9-193 check — ingredient_aliases rows: ${aliasCount} (read at ingredientLookup.ts:119/:159, ingredientSearch.ts:58/:73; this pipeline never touches them)`,
      );
      if (!wantDryRun && !wantApply) return;
    }

    if (!wantDryRun && !wantApply) {
      console.log("Nothing to do. Pass --phase0, --fixture, --dry-run or --apply.");
      return;
    }

    if (wantApply) {
      console.error(
        "\n🔴 --apply is GATED. Block A1 commits NO relation rows: the full run is a spend\n" +
          "   decision Hans makes against the measured pilot error rate. Re-enable this path\n" +
          "   only under an explicit written GO-AHEAD.\n",
      );
      process.exitCode = 1;
      return;
    }

    // ── select the run scope ────────────────────────────────────────────────
    let scoped = pairs;
    // --only=<family>[,<family>] — a single-family smoke call, so the judge
    // wiring (structured output, schema, magnitude fields) is verified for a
    // few cents before a multi-family run commits real spend.
    const onlyArg = argv.find((a) => a.startsWith("--only="));
    if (onlyArg) {
      const wanted = new Set(onlyArg.slice("--only=".length).split(",").map((s) => s.trim()));
      scoped = pairs.filter((p) => wanted.has(p.familyKey));
      console.log(`\n=== SCOPED to families: ${[...wanted].join(", ")} — ${scoped.length} pairs ===`);
    } else if (pilotOnly) {
      const allFamilies = [...new Set(pairs.map((p) => p.familyKey))];
      const core = new Set<string>(PILOT_FAMILIES);
      const extras = allFamilies
        .filter((f) => !core.has(f))
        .sort((a, b) => stableHash(a) - stableHash(b))
        .slice(0, PILOT_EXTRA_FAMILIES);
      for (const f of extras) core.add(f);
      scoped = pairs.filter((p) => core.has(p.familyKey));
      console.log(`\n=== PILOT SAMPLE ===`);
      console.log(`  known-hard families: ${PILOT_FAMILIES.join(", ")}`);
      console.log(`  + ${extras.length} hash-selected long-tail families: ${extras.join(", ")}`);
      console.log(`  pairs in sample: ${scoped.length} of ${pairs.length} (${((scoped.length / pairs.length) * 100).toFixed(1)}%)`);
    }

    const batches = batchByFamily(scoped, noCap ? Number.MAX_SAFE_INTEGER : MAX_PAIRS_PER_BATCH);
    const splits = batches.filter((b) => b.split);
    console.log(`\n=== DRY-RUN — judging ${scoped.length} pairs in ${batches.length} calls ===`);
    console.log(`  model: ${JUDGE_MODEL}  prompt: ${PROMPT_VERSION}`);
    if (splits.length > 0) {
      const names = [...new Set(splits.map((b) => b.familyKey))].sort();
      console.log(`  ⚠️ SPLIT families (${names.length}): ${names.join(", ")} — these lose the`);
      console.log(`     intra-call consistency guarantee; the contradiction detector covers them.`);
    }

    const anthropic = new Anthropic();
    const usage: Usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
    const results: JudgedPair[][] = new Array(batches.length);
    const startedAt = Date.now();

    // Bounded concurrency, same shape as BUG-032's JUDGE_CONCURRENCY. High
    // effort on claude-opus-5 runs minutes per call, and 176 sequential calls on
    // the full run would be hours of wall time for no reason. Results are
    // written back BY INDEX so the judged order stays deterministic regardless
    // of completion order — the contradiction detector's output has to be
    // reproducible across runs.
    let next = 0;
    let done = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const n = next++;
        if (n >= batches.length) return;
        const batch = batches[n]!;
        const verdicts = await judgeBatch(anthropic, batch.familyKey, batch.pairs, usage);
        results[n] = batch.pairs.map((pair, i) => ({
          pair,
          verdict: verdicts[i]!,
          familyKey: batch.familyKey,
          batchSplit: batch.split,
        }));
        done += 1;
        const label = batch.split ? `${batch.familyKey}#${batch.partIndex}` : batch.familyKey;
        console.log(
          `  [${done}/${batches.length}] ${label} — ${batch.pairs.length} pairs · $${costUsd(usage).toFixed(2)} so far`,
        );
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(JUDGE_CONCURRENCY, batches.length) }, worker),
    );
    const judged: JudgedPair[] = results.flat();
    const wallMs = Date.now() - startedAt;

    // ── the guard ───────────────────────────────────────────────────────────
    console.log(`\n=== §27.4 — the guard on the real run ===`);
    const report = runDetectors(judged);
    console.log(formatDetectorReport(report, judged));

    // ── split residue vs auto-accept ────────────────────────────────────────
    const contradictionDetailByIndex = new Map<number, string>();
    for (const c of report.contradictions) {
      const prior = contradictionDetailByIndex.get(c.index);
      contradictionDetailByIndex.set(c.index, prior ? `${prior} | ${c.detail}` : c.detail);
    }

    const residue: Row[] = [];
    const accepted: JudgedPair[] = [];
    judged.forEach((j, i) => {
      const { ok, reason } = isAutoAcceptable(j, report.flagged.has(i));
      if (ok) {
        accepted.push(j);
      } else {
        residue.push({
          kind: "RESIDUE",
          reason,
          judged: j,
          contradictionDetail: contradictionDetailByIndex.get(i) ?? "",
        });
      }
    });

    // ⚠️ The spot-check sample. Drawn from the AUTO-ACCEPTED verdicts by stable
    // hash, so a re-run audits the same rows and Hans is not re-reading a fresh
    // random draw each time. Without it, "the judge approved it" is
    // unfalsifiable.
    const spotcheck: Row[] = [...accepted]
      .sort(
        (x, y) =>
          stableHash(`${x.pair.a.canonicalName}~${x.pair.b.canonicalName}`) -
          stableHash(`${y.pair.a.canonicalName}~${y.pair.b.canonicalName}`),
      )
      .slice(0, SPOTCHECK_SIZE)
      .map((j) => ({
        kind: "SPOTCHECK" as const,
        reason: "auto_accepted_spot_check",
        judged: j,
        contradictionDetail: "",
      }));

    mkdirSync(OUTPUT_DIR, { recursive: true });

    // ⚠️ PERSIST EVERY VERDICT, not just the ones that reach the CSV. The first
    // pilot run emitted only the 213 CSV rows, so re-scoping the contradiction
    // detector meant re-judging all 660 pairs and paying for them a second
    // time. A dry-run's verdicts are the expensive artefact; the CSV is a view
    // of them. This file makes any later re-analysis free.
    const stamp = timestamp();
    const jsonPath = join(
      OUTPUT_DIR,
      `ws9-d189-a1-verdicts-${runTag || (pilotOnly ? "pilot" : "full")}-${stamp}.json`,
    );
    writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          model: JUDGE_MODEL,
          promptVersion: PROMPT_VERSION,
          usage,
          wallMs,
          judged: judged.map((j) => ({
            a: j.pair.a.canonicalName,
            b: j.pair.b.canonicalName,
            aId: j.pair.a.id,
            bId: j.pair.b.id,
            family: j.familyKey,
            batchSplit: j.batchSplit,
            signature: j.pair.signature,
            straddlesProcessing: j.pair.straddlesProcessing,
            verdict: j.verdict,
          })),
        },
        null,
        1,
      ),
      "utf8",
    );

    const csvPath = join(
      OUTPUT_DIR,
      `ws9-d189-a1-relations-${runTag || (pilotOnly ? "pilot" : "full")}-${stamp}.csv`,
    );
    const csv = [
      encodeCsvRow([...CSV_HEADER]),
      ...residue.map(toCsvRow),
      ...spotcheck.map(toCsvRow),
    ].join("\n");
    writeFileSync(csvPath, `${csv}\n`, "utf8");

    // ── measurements ────────────────────────────────────────────────────────
    const byLabel = new Map<string, number>();
    for (const j of judged) byLabel.set(j.verdict.label, (byLabel.get(j.verdict.label) ?? 0) + 1);
    const componentsWithMagnitude = judged.filter(
      (j) =>
        j.verdict.label === "COMPONENT" &&
        typeof j.verdict.yieldQuantity === "number" &&
        typeof j.verdict.coHarvestable === "boolean",
    ).length;

    const spend = costUsd(usage);
    const perPair = spend / Math.max(1, judged.length);
    const projectedFull = perPair * pairs.length;

    console.log(`\n=== MEASUREMENTS ===`);
    console.log(`  pairs judged:          ${judged.length}`);
    console.log(
      `  labels:                ${[...byLabel]
        .sort()
        .map(([l, c]) => `${l}:${c}`)
        .join("  ")}`,
    );
    console.log(
      `  component magnitude:   ${componentsWithMagnitude}/${byLabel.get("COMPONENT") ?? 0} carry yield + coHarvestable (D-WS9-194)`,
    );
    console.log(`  AUTO-ACCEPTED:         ${accepted.length}  (${((accepted.length / judged.length) * 100).toFixed(1)}%)`);
    console.log(`  RESIDUE (to Hans):     ${residue.length}  (${((residue.length / judged.length) * 100).toFixed(1)}%)`);
    const residueReasons = new Map<string, number>();
    for (const r of residue) residueReasons.set(r.reason, (residueReasons.get(r.reason) ?? 0) + 1);
    console.log(
      `    by reason:           ${[...residueReasons].sort((a, b) => b[1] - a[1]).map(([r, c]) => `${r}:${c}`).join("  ")}`,
    );
    console.log(`  spot-check rows:       ${spotcheck.length}`);
    console.log(`  CSV rows for Hans:     ${residue.length + spotcheck.length}`);
    console.log(
      `  PROJECTED FULL residue: ${Math.round((residue.length / judged.length) * pairs.length)} of ${pairs.length} pairs`,
    );
    console.log(`\n  API calls:             ${usage.calls}`);
    console.log(`  tokens:                in ${usage.inputTokens.toLocaleString()} / out ${usage.outputTokens.toLocaleString()}`);
    console.log(`  MEASURED COST:         $${spend.toFixed(2)}  ($${perPair.toFixed(4)}/pair)`);
    console.log(`  wall time:             ${(wallMs / 1000 / 60).toFixed(1)} min`);
    console.log(`  PROJECTED FULL RUN:    $${projectedFull.toFixed(2)} standard`);
    console.log(
      `                         $${(projectedFull / 2).toFixed(2)} via the Batch API (50% off; this run is NOT user-blocking, so it applies)`,
    );
    console.log(`\n  CSV:      ${csvPath}`);
    console.log(`  verdicts: ${jsonPath}  (every verdict, so re-analysis costs nothing)`);
    console.log(`\n  DRY-RUN — nothing written to ingredient_relations.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

// Re-exported so the family assignment stays inspectable from a REPL without
// re-deriving the vocabulary.
export { familyOf };

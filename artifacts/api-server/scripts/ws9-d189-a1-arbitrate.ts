// WS9 D-WS9-189 A1 Part 3 — drive the arbiter over a persisted verdict dump.
//
// Run (from artifacts/api-server):
//   PROVE IT CAN DECLINE:  node --env-file=.env --import tsx scripts/ws9-d189-a1-arbitrate.ts --fixture
//   ARBITRATE A RUN:       node --env-file=.env --import tsx scripts/ws9-d189-a1-arbitrate.ts <verdicts.json>
//   AGREEMENT AUDIT:       node --env-file=.env --import tsx scripts/ws9-d189-a1-arbitrate.ts <verdicts.json> --audit-accepted
//
// Writes NOTHING to the database. This is measurement only.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";

import { encodeCsvRow } from "./ws7-8b-usda-backfill";
import {
  arbitrateBatch,
  ARBITER_PROMPT_VERSION,
  UNDECIDABLE_FIXTURE,
  type ArbiterVerdict,
  type ContextVerdict,
  type DisputedPair,
} from "./ws9-d189-a1/arbiter";
import { costUsd, type JudgedPair, type Usage, type Verdict } from "./ws9-d189-a1/judge";
import { runDetectors } from "./ws9-d189-a1/contradiction";
import type { NormalizedRow } from "./ws9-d189-a1/pairUniverse";

const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "output");

interface DumpRow {
  a: string;
  b: string;
  aId: string;
  bId: string;
  family: string;
  batchSplit: boolean;
  signature: string;
  straddlesProcessing: boolean;
  verdict: Verdict;
}

function rehydrate(rows: DumpRow[]): JudgedPair[] {
  return rows.map((r) => ({
    familyKey: r.family,
    batchSplit: r.batchSplit,
    verdict: r.verdict,
    pair: {
      a: { id: r.aId, canonicalName: r.a, tokens: r.a.split(" ") } as unknown as NormalizedRow,
      b: { id: r.bId, canonicalName: r.b, tokens: r.b.split(" ") } as unknown as NormalizedRow,
      via: "same_core" as const,
      signature: r.signature,
      straddlesProcessing: r.straddlesProcessing,
      familyKey: r.family,
    },
  }));
}

function residueReasonOf(j: JudgedPair, flagged: boolean): string | null {
  if (flagged) return "contradiction_flagged";
  if (j.verdict.label === "UNSURE") return "unsure";
  if (j.verdict.confidence !== "high") return `confidence_${j.verdict.confidence}`;
  if (j.verdict.label === "COMPONENT") {
    const ok =
      typeof j.verdict.yieldQuantity === "number" &&
      typeof j.verdict.yieldUnit === "string" &&
      typeof j.verdict.coHarvestable === "boolean" &&
      typeof j.verdict.baseIsA === "boolean";
    if (!ok) return "component_missing_magnitude";
  }
  return null;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * §27.4 for the arbiter. Feeds it three pairs that are undecidable for three
 * different reasons and requires it to decline. Quoted verbatim in the report,
 * because "the arbiter can say no" is a claim, and a claim about a model is
 * worth exactly the transcript behind it.
 */
async function runArbiterFixture(client: Anthropic): Promise<number> {
  console.log(`\n=== §27.4 FOR THE ARBITER — can it decline? ===`);
  console.log(`  fixture: 3 genuinely undecidable pairs (regional ambiguity, contested`);
  console.log(`  domain usage, and two names with no determinable content).\n`);
  const usage: Usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  const verdicts = await arbitrateBatch(
    client,
    "undecidable-fixture",
    UNDECIDABLE_FIXTURE,
    [],
    usage,
  );
  let declined = 0;
  verdicts.forEach((v, i) => {
    const d = UNDECIDABLE_FIXTURE[i]!;
    if (v.label === "STILL_UNSURE") declined += 1;
    console.log(`  "${d.a}" ~ "${d.b}"`);
    console.log(`      => ${v.label} (${v.confidence})`);
    console.log(`      "${v.reason}"`);
  });
  console.log(
    `\n  RESULT: ${declined}/${UNDECIDABLE_FIXTURE.length} declined. ${
      declined > 0
        ? "STILL_UNSURE is reachable ✓"
        : "🔴 THE ARBITER NEVER DECLINES — every 'resolved' number below is suspect ✗"
    }`,
  );
  console.log(`  cost $${costUsd(usage).toFixed(4)}`);
  return declined > 0 ? 0 : 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const client = new Anthropic();

  if (argv.includes("--fixture")) {
    process.exitCode = await runArbiterFixture(client);
    return;
  }

  const path = argv.find((a) => !a.startsWith("--"));
  if (!path) {
    console.error("usage: ws9-d189-a1-arbitrate.ts <verdicts.json> [--audit-accepted]");
    process.exitCode = 1;
    return;
  }
  const auditAccepted = argv.includes("--audit-accepted");
  // ⚠️ THE ANCHOR TEST. The arbiter is normally SHOWN the first-pass verdict,
  // so 100% agreement and 0 overturns is exactly what anchoring would look
  // like — the arbiter ratifying a label it was handed rather than judging.
  // --blind withholds the first-pass label for the pairs under test AND
  // removes them from the family context, so the arbiter has to answer cold.
  // Agreement that survives blinding is agreement; agreement that collapses
  // under it was never a second opinion.
  const blind = argv.includes("--blind");

  const dump = JSON.parse(readFileSync(path, "utf8")) as { judged: DumpRow[] };
  const judged = rehydrate(dump.judged);
  const report = runDetectors(judged);
  const detailByIndex = new Map<number, string>();
  for (const c of report.contradictions) {
    const prior = detailByIndex.get(c.index);
    detailByIndex.set(c.index, prior ? `${prior} | ${c.detail}` : c.detail);
  }

  // ── build the arbiter's input ───────────────────────────────────────────
  const residueIdx: number[] = [];
  const acceptedIdx: number[] = [];
  judged.forEach((j, i) => {
    const reason = residueReasonOf(j, report.flagged.has(i));
    if (reason) residueIdx.push(i);
    else acceptedIdx.push(i);
  });

  // The agreement audit re-asks the arbiter about rows the first pass
  // AUTO-ACCEPTED. ⚠️ Disagreement here is a finding about the FIRST PASS, not
  // a defect in the arbiter: those rows would have been written to the database
  // with nobody looking at them.
  const spotcheckIdx = auditAccepted
    ? [...acceptedIdx]
        .sort(
          (x, y) =>
            stableHash(`${judged[x]!.pair.a.canonicalName}~${judged[x]!.pair.b.canonicalName}`) -
            stableHash(`${judged[y]!.pair.a.canonicalName}~${judged[y]!.pair.b.canonicalName}`),
        )
        .slice(0, 60)
    : [];

  const targets = [...residueIdx, ...spotcheckIdx];
  console.log(`\n=== ARBITER PASS — ${ARBITER_PROMPT_VERSION} ===`);
  console.log(`  source:            ${path}`);
  console.log(`  first-pass pairs:  ${judged.length}`);
  console.log(`  residue to settle: ${residueIdx.length}`);
  if (auditAccepted) console.log(`  + auto-accepted rows re-asked (agreement audit): ${spotcheckIdx.length}`);

  const byFamily = new Map<string, number[]>();
  for (const i of targets) {
    const f = judged[i]!.familyKey;
    const bucket = byFamily.get(f);
    if (bucket) bucket.push(i);
    else byFamily.set(f, [i]);
  }

  const usage: Usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  const resolved = new Map<number, ArbiterVerdict>();
  const startedAt = Date.now();

  for (const [family, indices] of [...byFamily].sort((a, b) => a[0].localeCompare(b[0]))) {
    const disputed: DisputedPair[] = indices.map((i) => {
      const j = judged[i]!;
      return {
        key: String(i),
        a: j.pair.a.canonicalName,
        b: j.pair.b.canonicalName,
        family,
        firstLabel: blind ? "(withheld)" : j.verdict.label,
        firstConfidence: blind ? "(withheld)" : j.verdict.confidence,
        firstReason: blind ? "(withheld — judge this pair cold)" : j.verdict.reason,
        residueReason: residueReasonOf(j, report.flagged.has(i)) ?? "auto_accepted (agreement audit)",
        contradictionDetail: detailByIndex.get(i) ?? "",
      };
    });
    const underTest = new Set(indices.map((i) => `${judged[i]!.pair.a.id}::${judged[i]!.pair.b.id}`));
    const context: ContextVerdict[] = judged
      .filter((j) => j.familyKey === family)
      .filter((j) => !blind || !underTest.has(`${j.pair.a.id}::${j.pair.b.id}`))
      .map((j) => ({
        a: j.pair.a.canonicalName,
        b: j.pair.b.canonicalName,
        label: j.verdict.label,
        confidence: j.verdict.confidence,
      }));

    const verdicts = await arbitrateBatch(client, family, disputed, context, usage);
    indices.forEach((globalIdx, k) => resolved.set(globalIdx, verdicts[k]!));
    console.log(`  [${family}] ${indices.length} pairs · $${costUsd(usage).toFixed(2)} so far`);
  }
  const wallMs = Date.now() - startedAt;

  // ── measurements ────────────────────────────────────────────────────────
  const resolvedResidue = residueIdx.filter((i) => resolved.get(i)!.label !== "STILL_UNSURE");
  const stillUnsure = residueIdx.filter((i) => resolved.get(i)!.label === "STILL_UNSURE");
  const changed = residueIdx.filter((i) => {
    const v = resolved.get(i)!;
    return v.label !== "STILL_UNSURE" && v.label !== judged[i]!.verdict.label;
  });

  console.log(`\n=== ARBITER RESULTS ===`);
  console.log(`  residue in:        ${residueIdx.length}`);
  console.log(
    `  RESOLVED:          ${resolvedResidue.length}  (${((resolvedResidue.length / Math.max(1, residueIdx.length)) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  STILL_UNSURE:      ${stillUnsure.length}  (${((stillUnsure.length / Math.max(1, residueIdx.length)) * 100).toFixed(1)}%)  <- these reach a human`,
  );
  console.log(`  overturned first pass: ${changed.length}`);

  if (auditAccepted && spotcheckIdx.length > 0) {
    const agree = spotcheckIdx.filter(
      (i) => resolved.get(i)!.label === judged[i]!.verdict.label,
    ).length;
    const disagree = spotcheckIdx.filter(
      (i) => resolved.get(i)!.label !== "STILL_UNSURE" && resolved.get(i)!.label !== judged[i]!.verdict.label,
    );
    console.log(`\n  === AGREEMENT AUDIT on ${spotcheckIdx.length} AUTO-ACCEPTED rows ===`);
    console.log(
      `  agrees with first pass: ${agree}/${spotcheckIdx.length}  (${((agree / spotcheckIdx.length) * 100).toFixed(1)}%)`,
    );
    console.log(`  DISAGREES:              ${disagree.length}`);
    console.log(
      `  ⚠️ every disagreement is a row the first pass would have written to the database unreviewed.`,
    );
    for (const i of disagree) {
      const j = judged[i]!;
      const v = resolved.get(i)!;
      console.log(
        `    "${j.pair.a.canonicalName}" ~ "${j.pair.b.canonicalName}"  first=${j.verdict.label}/${j.verdict.confidence}  arbiter=${v.label}/${v.confidence}`,
      );
      console.log(`        arbiter: "${v.reason}"`);
    }
  }

  console.log(`\n  API calls: ${usage.calls} · tokens in ${usage.inputTokens.toLocaleString()} / out ${usage.outputTokens.toLocaleString()}`);
  console.log(`  COST: $${costUsd(usage).toFixed(2)} · wall ${(wallMs / 1000 / 60).toFixed(1)} min`);

  // ── the sheet a human actually receives ─────────────────────────────────
  const header = [
    "row_kind",
    "family",
    "name_a",
    "name_b",
    "residue_reason",
    "first_label",
    "first_confidence",
    "first_reason",
    "arbiter_label",
    "arbiter_confidence",
    "arbiter_reason",
    "base_is",
    "yield_qty",
    "yield_unit",
    "co_harvestable",
    "contradiction_detail",
    "hans_verdict",
    "hans_notes",
  ];
  const rowFor = (i: number, kind: string): string => {
    const j = judged[i]!;
    const v = resolved.get(i)!;
    const baseIs =
      v.label === "COMPONENT" && typeof v.baseIsA === "boolean"
        ? v.baseIsA
          ? j.pair.a.canonicalName
          : j.pair.b.canonicalName
        : "";
    return encodeCsvRow([
      kind,
      j.familyKey,
      j.pair.a.canonicalName,
      j.pair.b.canonicalName,
      residueReasonOf(j, report.flagged.has(i)) ?? "auto_accepted",
      j.verdict.label,
      j.verdict.confidence,
      j.verdict.reason,
      v.label,
      v.confidence,
      v.reason,
      baseIs,
      v.yieldQuantity ?? "",
      v.yieldUnit ?? "",
      v.coHarvestable === null || v.coHarvestable === undefined ? "" : String(v.coHarvestable),
      detailByIndex.get(i) ?? "",
      "",
      "",
    ]);
  };
  const csv = [
    encodeCsvRow(header),
    ...stillUnsure.map((i) => rowFor(i, "TO_HUMAN")),
    ...spotcheckIdx.map((i) => rowFor(i, "SPOTCHECK")),
  ].join("\n");
  const csvPath = join(OUTPUT_DIR, `ws9-d189-a1-arbitrated-${timestamp()}.csv`);
  writeFileSync(csvPath, `${csv}\n`, "utf8");
  console.log(`\n  SHEET (STILL_UNSURE + spot-check): ${csvPath}`);

  // Inline paste, so chat-Claude can triage without filesystem access.
  if (stillUnsure.length > 0 && stillUnsure.length <= 80) {
    console.log(`\n  === ROWS REACHING A HUMAN (${stillUnsure.length}) ===`);
    for (const i of stillUnsure) {
      const j = judged[i]!;
      const v = resolved.get(i)!;
      console.log(
        `  [${j.familyKey}] "${j.pair.a.canonicalName}" ~ "${j.pair.b.canonicalName}"`,
      );
      console.log(
        `      residue reason: ${residueReasonOf(j, report.flagged.has(i))} · first pass: ${j.verdict.label}/${j.verdict.confidence}`,
      );
      console.log(`      arbiter declined: "${v.reason}"`);
    }
  }

  console.log(`\n  NOTHING WRITTEN. Measurement only.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

// WS9 D-WS9-189 A1 — zero-cost analysis over a persisted verdict dump.
//
// Every question this answers was previously answerable only by re-judging, at
// ~$3 a time. The verdict JSON exists so that stops being true.
//
// Run: node --env-file=.env --import tsx scripts/ws9-d189-a1-analyze.ts <verdicts.json> [--universe]
//
// ⚠️ THE DECOMPOSITION THIS EXISTS FOR. The A1 report attributed a residue move
// of 183 -> 245 to "run-to-run variance… identical scope and prompt". The scope
// and prompt were identical; THE DETECTOR CODE WAS NOT. Run 1 scored two
// detectors with an unscoped signature matcher; run 2 scored three with a
// family-scoped one. Attributing the whole delta to judge non-determinism was
// wrong, and the direction gives it away: an over-broad matcher invents
// contradictions, so it should have made run 1 the HIGHER number, not the
// lower. Something else moved, and only a decomposition finds it.
//
// To separate the two causes, this replays run 1's detector logic (reproduced
// verbatim below) over run 2's labels. That isolates:
//   run1 labels + run1 code   (known, 61 flagged — from run 1's console output)
//   run2 labels + run1 code   (computed here)
//   run2 labels + run2 code   (known, 122 flagged)

import { readFileSync } from "node:fs";

import { PrismaClient } from "@prisma/client";

import { buildPairUniverse, type NormalizedRow } from "./ws9-d189-a1/pairUniverse";
import { runDetectors } from "./ws9-d189-a1/contradiction";
import type { JudgedPair, Verdict } from "./ws9-d189-a1/judge";

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

const DECIDED = new Set(["SYNONYM", "COMPONENT", "DISTINCT"]);

/**
 * RUN 1'S DETECTOR, reproduced exactly as it stood when it scored 61 flagged
 * pairs: signature grouping NOT scoped to a family, and no same-base check.
 * Kept here rather than in contradiction.ts because it is a historical artefact
 * used for one comparison — it is not a detector anyone should run again.
 */
function run1Detectors(judged: JudgedPair[]): {
  flagged: Set<number>;
  signature: number;
  transitivity: number;
} {
  // -- unscoped signature divergence --
  const bySignature = new Map<string, number[]>();
  judged.forEach((j, i) => {
    if (!DECIDED.has(j.verdict.label)) return;
    if (j.pair.signature === "(identical)") return;
    const bucket = bySignature.get(j.pair.signature);
    if (bucket) bucket.push(i);
    else bySignature.set(j.pair.signature, [i]);
  });
  const sigFlags: number[] = [];
  for (const indices of bySignature.values()) {
    if (indices.length < 2) continue;
    if (new Set(indices.map((i) => judged[i]!.verdict.label)).size < 2) continue;
    sigFlags.push(...indices);
  }

  // -- transitivity, unchanged between runs --
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) {
      const next = parent.get(root)!;
      parent.set(root, parent.get(next)!);
      root = next;
    }
    return root;
  };
  for (const j of judged) {
    if (j.verdict.label === "SYNONYM") {
      const ra = find(j.pair.a.id);
      const rb = find(j.pair.b.id);
      if (ra !== rb) parent.set(ra, rb);
    }
  }
  const transFlags: number[] = [];
  judged.forEach((j, i) => {
    if (j.verdict.label !== "DISTINCT") return;
    if (!parent.has(j.pair.a.id) || !parent.has(j.pair.b.id)) return;
    if (find(j.pair.a.id) !== find(j.pair.b.id)) return;
    transFlags.push(i);
  });

  return {
    flagged: new Set([...sigFlags, ...transFlags]),
    signature: sigFlags.length,
    transitivity: transFlags.length,
  };
}

/**
 * Size of the largest synonym equivalence class. The transitivity detector is
 * SUPER-LINEAR in this: every DISTINCT verdict with both endpoints inside one
 * class is a flag, so a class of size k can flag up to k(k-1)/2 pairs. A
 * handful of extra SYNONYM edges that MERGE two classes therefore multiplies
 * the flag count rather than adding to it.
 */
function synonymClassStats(judged: JudgedPair[]): { classes: number; largest: number; sizes: number[] } {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) {
      const next = parent.get(root)!;
      parent.set(root, parent.get(next)!);
      root = next;
    }
    return root;
  };
  for (const j of judged) {
    if (j.verdict.label === "SYNONYM") {
      const ra = find(j.pair.a.id);
      const rb = find(j.pair.b.id);
      if (ra !== rb) parent.set(ra, rb);
    }
  }
  const counts = new Map<string, number>();
  for (const id of parent.keys()) {
    const r = find(id);
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  const sizes = [...counts.values()].filter((n) => n > 1).sort((a, b) => b - a);
  return { classes: sizes.length, largest: sizes[0] ?? 0, sizes };
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: ws9-d189-a1-analyze.ts <verdicts.json> [--universe]");
    process.exitCode = 1;
    return;
  }
  const dump = JSON.parse(readFileSync(path, "utf8")) as { judged: DumpRow[] };
  const judged = rehydrate(dump.judged);

  // ── Q1 ──────────────────────────────────────────────────────────────────
  console.log(`\n=== Q1 — decomposing the 183 -> 245 residue move ===`);
  const nowRep = runDetectors(judged);
  const thenRep = run1Detectors(judged);
  console.log(`  run 2 labels under RUN 2 code: ${nowRep.flagged.size} flagged`);
  console.log(
    `      signature ${nowRep.bySignature} · transitivity ${nowRep.byTransitivity} · same-base ${nowRep.bySameBase}`,
  );
  console.log(`  run 2 labels under RUN 1 code: ${thenRep.flagged.size} flagged`);
  console.log(`      signature ${thenRep.signature} · transitivity ${thenRep.transitivity} · same-base n/a`);
  console.log(`  run 1 labels under RUN 1 code: 61 flagged  (signature 60 · transitivity 4)`);
  console.log(
    `\n  => LABEL effect (run1->run2 labels, code held at run 1): 61 -> ${thenRep.flagged.size}  (${thenRep.flagged.size - 61 >= 0 ? "+" : ""}${thenRep.flagged.size - 61})`,
  );
  console.log(
    `  => CODE effect  (run 2 labels, run1 code -> run2 code):  ${thenRep.flagged.size} -> ${nowRep.flagged.size}  (${nowRep.flagged.size - thenRep.flagged.size >= 0 ? "+" : ""}${nowRep.flagged.size - thenRep.flagged.size})`,
  );

  const stats = synonymClassStats(judged);
  console.log(
    `\n  synonym equivalence classes: ${stats.classes}, largest ${stats.largest} rows` +
      ` (top: ${stats.sizes.slice(0, 6).join(", ")})`,
  );
  console.log(
    `  a class of ${stats.largest} can flag up to ${(stats.largest * (stats.largest - 1)) / 2} DISTINCT pairs — the transitivity detector is super-linear in synonym density.`,
  );

  // ── Q3 ──────────────────────────────────────────────────────────────────
  console.log(`\n=== Q3 — residue reconciled to causes ===`);
  const reasonOf = (j: JudgedPair, flagged: boolean): string => {
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
    return "auto_accepted";
  };
  const tally = new Map<string, number>();
  judged.forEach((j, i) => {
    const r = reasonOf(j, nowRep.flagged.has(i));
    tally.set(r, (tally.get(r) ?? 0) + 1);
  });
  let residueTotal = 0;
  for (const [r, c] of [...tally].sort((a, b) => b[1] - a[1])) {
    if (r === "auto_accepted") continue;
    residueTotal += c;
    console.log(`  ${r.padEnd(28)} ${c}`);
  }
  console.log(`  ${"TOTAL RESIDUE".padEnd(28)} ${residueTotal}`);
  console.log(`  ${"auto-accepted".padEnd(28)} ${tally.get("auto_accepted") ?? 0}`);

  // Masking: reasons are assigned first-match, so a flagged pair that is ALSO
  // low-confidence is counted only once. Quantify how much that hides.
  let flaggedAndNotHigh = 0;
  judged.forEach((j, i) => {
    if (nowRep.flagged.has(i) && j.verdict.confidence !== "high") flaggedAndNotHigh += 1;
  });
  console.log(
    `\n  MASKING: reasons are first-match, so a pair carries exactly ONE. ${flaggedAndNotHigh} of the ${nowRep.flagged.size} contradiction-flagged pairs are ALSO below high confidence,`,
  );
  console.log(
    `  so the reported confidence_* counts are "and not flagged" and understate the true low-confidence population by that much.`,
  );

  // ── SYNONYM transitive-closure classes, size >= 3 ─────────────────────
  // ⚠️ THE EXHAUSTIVE OVER-MERGE CHECK, and the one thing a 60-row spot check
  // cannot do. `lard ~ avocado oil` was found here, not in a sample: no single
  // verdict was wrong, the CLOSURE was. Printed largest-first so the worst
  // offenders are the first thing a reviewer sees.
  //
  // 🔴 Computed HERE as a diagnostic only — D-WS9-201 forbids the READER from
  // ever folding transitively.
  {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      if (!parent.has(x)) parent.set(x, x);
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root)!;
      return root;
    };
    const nameOf = new Map<string, string>();
    for (const j of judged) {
      nameOf.set(j.pair.a.id, j.pair.a.canonicalName);
      nameOf.set(j.pair.b.id, j.pair.b.canonicalName);
      if (j.verdict.label === "SYNONYM") {
        const ra = find(j.pair.a.id);
        const rb = find(j.pair.b.id);
        if (ra !== rb) parent.set(ra, rb);
      }
    }
    const cls = new Map<string, string[]>();
    for (const id of parent.keys()) {
      const r = find(id);
      if (!cls.has(r)) cls.set(r, []);
      cls.get(r)!.push(nameOf.get(id)!);
    }
    const big = [...cls.values()].filter((c) => c.length >= 3).sort((a, b) => b.length - a.length);
    console.log(`\n=== SYNONYM TRANSITIVE-CLOSURE CLASSES, size >= 3 (${big.length}) ===`);
    for (const c of big) console.log(`  [${c.length}] ${c.sort().join(" | ")}`);
    if (big.length === 0) console.log("  (none)");
  }

  // ── Q2 ──────────────────────────────────────────────────────────────────
  if (process.argv.includes("--universe")) {
    console.log(`\n=== Q2 — what sits just OUTSIDE the universe ===`);
    const prisma = new PrismaClient();
    try {
      const rows = await prisma.ingredient.findMany({
        select: { id: true, canonicalName: true, category: true },
        orderBy: { canonicalName: "asc" },
      });
      const { normalized, pairs } = buildPairUniverse(rows);
      const inUniverse = new Set(pairs.map((p) => `${p.a.id}::${p.b.id}`));
      console.log(`  universe: ${pairs.length} pairs`);

      // The nearest excluded class: same head noun, small token difference, but
      // neither same-core nor containment. If the missing 32 are anywhere, the
      // boundary is here.
      const near: Array<{ a: string; b: string; diff: string[] }> = [];
      for (let i = 0; i < normalized.length; i++) {
        for (let j = i + 1; j < normalized.length; j++) {
          const a = normalized[i]!;
          const b = normalized[j]!;
          if (inUniverse.has(`${a.id}::${b.id}`)) continue;
          if (!a.head || a.head !== b.head) continue;
          const diff = [
            ...a.tokens.filter((t) => !b.tokenSet.has(t)),
            ...b.tokens.filter((t) => !a.tokenSet.has(t)),
          ];
          if (diff.length > 2) continue;
          near.push({ a: a.canonicalName, b: b.canonicalName, diff: [...new Set(diff)].sort() });
        }
      }
      console.log(`  EXCLUDED but adjacent (same head noun, <=2 differing tokens): ${near.length}`);
      for (const n of near.slice(0, 25)) {
        console.log(`    "${n.a}" ~ "${n.b}"   [${n.diff.join("|")}]`);
      }
      if (near.length > 25) console.log(`    ... and ${near.length - 25} more`);
    } finally {
      await prisma.$disconnect();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

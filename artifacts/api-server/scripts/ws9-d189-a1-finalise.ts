// WS9 D-WS9-189 A1 — build THE sheet.
//
// Hans's ruling: "if the process creates a CSV that you review and CC loads into
// Prisma that's as good or better than a process writing the data directly."
// So this file produces ONE artefact that is simultaneously what everyone
// reviews and what `--apply` consumes. It is not a byproduct of the run; it IS
// the deliverable.
//
// 🔴 IT SERIALISES THE STATE THAT WOULD ACTUALLY BE WRITTEN, which previously
// existed in no file at all: first-pass verdicts, with arbiter overrides applied
// on top, plus the rows nobody judged because a rule authored them, plus Hans's
// own rulings pre-seeded as human-reviewed. Before this, the merged JSON was
// pre-arbitration and the arbitrated CSV held only the leftovers — the actual
// end state was unauditable.
//
// Run:
//   node --env-file=.env --import tsx scripts/ws9-d189-a1-finalise.ts \
//     <firstpass-verdicts.json> <arbiter-verdicts.json>

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { encodeCsvRow } from "./ws7-8b-usda-backfill";
import { buildPairUniverse, type CatalogRow } from "./ws9-d189-a1/pairUniverse";
import { runDetectors } from "./ws9-d189-a1/contradiction";
import type { JudgedPair, Verdict } from "./ws9-d189-a1/judge";
import type { NormalizedRow } from "./ws9-d189-a1/pairUniverse";

const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "output");
const REVIEW_DATE = "2026-09-01";

type Provenance = "ai-judged" | "arbiter-resolved" | "rule-authored" | "human-reviewed";

interface FinalRow {
  provenance: Provenance;
  family: string;
  a: string;
  b: string;
  label: string;
  confidence: string;
  baseIs: string;
  genericIs: string;
  yieldQty: string;
  yieldUnit: string;
  coHarvestable: string;
  reason: string;
  /** Why a human must read this row, or AUTO. */
  needsReview: string;
}

// ── §2 — Hans's four rulings, pre-seeded as human-reviewed ────────────────
//
// These carry the `reviewed ` marker so --apply treats them as human verdicts
// and never re-judges them. Ruling 2 is deliberately absent: Hans resolved that
// pair by NORMALISATION rather than by a label, and §3 strips `store-bought`,
// so `store-bought flour tortillas (8-inch)` no longer exists as an entity to
// relate. Seeding a label for it would re-create the row the normalisation
// removed.
const HANS_RULINGS: Array<{ a: string; b: string; label: string; why: string }> = [
  {
    a: "flour tortillas (8-inch)",
    b: "small flour tortillas",
    label: "DISTINCT",
    why: "small flour tortillas is specific to taquitos vs. large tortillas for burritos, and 'tortillas' for all purpose small burritos and regular tacos",
  },
  {
    a: "mild italian pork sausage",
    b: "sweet italian pork sausage",
    label: "SYNONYM",
    why: "the internet seems to think they're basically the same thing and possibly have a barely discernable difference",
  },
  {
    a: "chicken broth",
    b: "chicken poaching broth",
    label: "DISTINCT",
    why: "chicken broth is probably 99.5% of the stuff we'll see, and poaching broth sounds more like the liquid leftover from poaching chicken",
  },
];

// ── §5.2 — garlic, with the magnitude D-WS9-194 requires ──────────────────
//
// A3 stayed open for two passes: `garlic ~ head of garlic` was labelled SYNONYM,
// which is defensible for shopping and LOSES the cloves-per-head number. A label
// without its magnitude is exactly what D-WS9-194 exists to prevent, and nothing
// else supplies the figure to Block B.
const GARLIC_RULINGS: Array<{ a: string; b: string; base: string; qty: number; unit: string; why: string }> = [
  {
    a: "garlic",
    b: "head of garlic",
    base: "head of garlic",
    qty: 10,
    unit: "clove",
    why: "a recipe's 'garlic' means cloves and the purchase is a head; ~10 cloves per head is the magnitude Block B needs (D-WS9-194)",
  },
  {
    a: "garlic",
    b: "garlic head",
    base: "garlic head",
    qty: 10,
    unit: "clove",
    why: "same relation as head of garlic — the purchase is a head, the recipe wants cloves (D-WS9-194)",
  },
];

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

interface ArbRow {
  aId: string;
  bId: string;
  a: string;
  b: string;
  family: string;
  wasResidue: boolean;
  firstLabel: string;
  verdict: { label: string; confidence: string; reason: string; baseIsA?: boolean | null; genericIsA?: boolean | null; yieldQuantity?: number | null; yieldUnit?: string | null; coHarvestable?: boolean | null };
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

function sideName(a: string, b: string, flag: boolean | null | undefined): string {
  if (typeof flag !== "boolean") return "";
  return flag ? a : b;
}

async function main(): Promise<void> {
  const [firstPath, arbPath] = process.argv.slice(2).filter((x) => !x.startsWith("--"));
  if (!firstPath || !arbPath) {
    console.error("usage: ws9-d189-a1-finalise.ts <firstpass.json> <arbiter.json>");
    process.exitCode = 1;
    return;
  }

  const first = JSON.parse(readFileSync(firstPath, "utf8")) as { judged: DumpRow[] };
  const arb = JSON.parse(readFileSync(arbPath, "utf8")) as { resolutions: ArbRow[] };
  const judged = rehydrate(first.judged);
  const report = runDetectors(judged);
  const detailByIndex = new Map<number, string>();
  for (const c of report.contradictions) {
    const prior = detailByIndex.get(c.index);
    detailByIndex.set(c.index, prior ? `${prior} | ${c.detail}` : c.detail);
  }

  // Arbiter overrides, keyed on the unordered pair.
  const arbByPair = new Map<string, ArbRow>();
  for (const r of arb.resolutions) arbByPair.set([r.aId, r.bId].sort().join("::"), r);

  const rows: FinalRow[] = [];
  const changed = { arbiterOverride: 0, hans: 0, garlic: 0, ruleAuthored: 0 };

  judged.forEach((j, i) => {
    const key = [j.pair.a.id, j.pair.b.id].sort().join("::");
    const a = j.pair.a.canonicalName;
    const b = j.pair.b.canonicalName;
    const over = arbByPair.get(key);

    let label = j.verdict.label;
    let confidence = j.verdict.confidence;
    let reason = j.verdict.reason;
    let provenance: Provenance = "ai-judged";
    let baseIsA = j.verdict.baseIsA ?? null;
    let genericIsA = j.verdict.genericIsA ?? null;
    let qty = j.verdict.yieldQuantity ?? null;
    let unit = j.verdict.yieldUnit ?? null;
    let coh = j.verdict.coHarvestable ?? null;

    // The arbiter's verdict wins where it ran and settled the pair. STILL_UNSURE
    // leaves the first-pass verdict in place and sends the row to a human.
    let stillUnsure = false;
    if (over && over.wasResidue) {
      if (over.verdict.label === "STILL_UNSURE") {
        stillUnsure = true;
      } else {
        if (over.verdict.label !== j.verdict.label) changed.arbiterOverride += 1;
        label = over.verdict.label as Verdict["label"];
        confidence = over.verdict.confidence as Verdict["confidence"];
        reason = over.verdict.reason;
        provenance = "arbiter-resolved";
        baseIsA = over.verdict.baseIsA ?? null;
        genericIsA = over.verdict.genericIsA ?? null;
        qty = over.verdict.yieldQuantity ?? null;
        unit = over.verdict.yieldUnit ?? null;
        coh = over.verdict.coHarvestable ?? null;
      }
    }

    // Why a human must read this row — or AUTO.
    let needsReview = "AUTO";
    if (stillUnsure) needsReview = "arbiter_still_unsure";
    else if (label === "UNSURE") needsReview = "unsure";
    else if (provenance === "ai-judged" && report.flagged.has(i)) needsReview = "contradiction_flagged";
    else if (provenance === "ai-judged" && confidence !== "high") needsReview = `confidence_${confidence}`;
    // §4 — every size-qualified SUBSUMES goes to a human regardless of
    // confidence. A default-variety misread produces a confident wrong row, and
    // confident wrong rows are exactly what auto-accept cannot catch.
    const SIZE_WORDS = /\b(small|large|medium|mini|jumbo|big|thin|thick)\b/i;
    if (label === "SUBSUMES" && (SIZE_WORDS.test(a) || SIZE_WORDS.test(b))) {
      needsReview = needsReview === "AUTO" ? "size_qualified_subsumes" : needsReview;
    }
    if (label === "COMPONENT" && (qty === null || unit === null || coh === null)) {
      needsReview = "component_missing_magnitude";
    }
    if (label === "SUBSUMES" && genericIsA === null) needsReview = "subsumes_missing_direction";

    rows.push({
      provenance,
      family: j.familyKey,
      a,
      b,
      label,
      confidence,
      baseIs: sideName(a, b, baseIsA),
      genericIs: sideName(a, b, genericIsA),
      yieldQty: qty === null ? "" : String(qty),
      yieldUnit: unit ?? "",
      coHarvestable: coh === null ? "" : String(coh),
      reason,
      needsReview,
    });
  });

  // ── §5.1 — rule-authored SYNONYM rows for the normalised-away entities ───
  // Deterministic, never judged, so their provenance says so. Without them
  // nothing records `carrots, diced` ≡ `carrots` and Block B has no edge.
  const prisma = new PrismaClient();
  try {
    const catalog: CatalogRow[] = await prisma.ingredient.findMany({
      select: { id: true, canonicalName: true, category: true },
      orderBy: { canonicalName: "asc" },
    });
    const { exclusions } = buildPairUniverse(catalog);
    for (const c of [...exclusions.collapsed, ...exclusions.provenanceDeduped]) {
      changed.ruleAuthored += 1;
      rows.push({
        provenance: "rule-authored",
        family: "(normalisation)",
        a: c.from.canonicalName,
        b: c.intoName,
        label: "SYNONYM",
        confidence: "high",
        baseIs: "",
        genericIs: "",
        yieldQty: "",
        yieldUnit: "",
        coHarvestable: "",
        reason:
          "rule-authored, not judged: the qualifier is a preparation note or a redundant provenance word, so both names are one purchase",
        needsReview: "AUTO",
      });
    }

    // ── §2 + §5.2 — human verdicts, pre-seeded ────────────────────────────
    const seed = (r: FinalRow): void => {
      // Replace any AI row for the same pair rather than duplicating it.
      const idx = rows.findIndex(
        (x) =>
          (x.a === r.a && x.b === r.b) || (x.a === r.b && x.b === r.a),
      );
      if (idx >= 0) rows.splice(idx, 1);
      rows.push(r);
    };
    for (const r of HANS_RULINGS) {
      changed.hans += 1;
      seed({
        provenance: "human-reviewed",
        family: "(hans)",
        a: r.a,
        b: r.b,
        label: r.label,
        confidence: "high",
        baseIs: "",
        genericIs: "",
        yieldQty: "",
        yieldUnit: "",
        coHarvestable: "",
        reason: `reviewed ${REVIEW_DATE}: ${r.why}`,
        needsReview: "AUTO",
      });
    }
    for (const r of GARLIC_RULINGS) {
      changed.garlic += 1;
      seed({
        provenance: "human-reviewed",
        family: "(ruling)",
        a: r.a,
        b: r.b,
        label: "COMPONENT",
        confidence: "high",
        baseIs: r.base,
        genericIs: "",
        yieldQty: String(r.qty),
        yieldUnit: r.unit,
        coHarvestable: "false",
        reason: `reviewed ${REVIEW_DATE}: ${r.why}`,
        needsReview: "AUTO",
      });
    }

    // ── seeded rulings must not be silently contradicted ───────────────────
    //
    // 🔴 SEEDING A HUMAN RULING DOES NOT UPDATE THE AI's OTHER EDGES, and the
    // first build of this sheet proved it: `garlic ~ garlic head` was seeded
    // COMPONENT (10 cloves) while `garlic ~ whole garlic head` sat next to it
    // as an arbiter-resolved SYNONYM. The same relation stated two ways, with
    // nothing pointing at the conflict.
    //
    // So: close the SYNONYM edges, and for every human-reviewed row whose label
    // is NOT synonym, if its two endpoints land in the same synonym class, that
    // class contains an edge contradicting the ruling. Flag every synonym edge
    // in it for review rather than guessing which one to drop — the human made
    // one call, and which of the machine's edges must yield is a second call.
    {
      const parent = new Map<string, string>();
      const find = (x: string): string => {
        if (!parent.has(x)) parent.set(x, x);
        let root = x;
        while (parent.get(root) !== root) root = parent.get(root)!;
        return root;
      };
      for (const r of rows) {
        if (r.label !== "SYNONYM") continue;
        const ra = find(r.a);
        const rb = find(r.b);
        if (ra !== rb) parent.set(ra, rb);
      }
      const conflicted = new Set<string>();
      for (const r of rows) {
        if (r.provenance !== "human-reviewed" || r.label === "SYNONYM") continue;
        if (!parent.has(r.a) || !parent.has(r.b)) continue;
        if (find(r.a) === find(r.b)) conflicted.add(find(r.a));
      }
      let flagged = 0;
      for (const r of rows) {
        if (r.label !== "SYNONYM" || r.provenance === "human-reviewed") continue;
        if (!parent.has(r.a)) continue;
        if (!conflicted.has(find(r.a))) continue;
        r.needsReview = "contradicts_human_ruling";
        flagged += 1;
      }
      if (flagged > 0) {
        console.log(
          `\n  ⚠️ ${flagged} SYNONYM edge(s) flagged: they close a chain that contradicts a human ruling`,
        );
      }
    }

    // ── emit ────────────────────────────────────────────────────────────────
    const header = [
      "provenance",
      "needs_review",
      "family",
      "name_a",
      "name_b",
      "label",
      "confidence",
      "base_is",
      "generic_is",
      "yield_qty",
      "yield_unit",
      "co_harvestable",
      "judge_reason",
    ];
    // Rows a human must read first, then the rest.
    rows.sort((x, y) => {
      const xr = x.needsReview === "AUTO" ? 1 : 0;
      const yr = y.needsReview === "AUTO" ? 1 : 0;
      if (xr !== yr) return xr - yr;
      return `${x.family}${x.a}${x.b}`.localeCompare(`${y.family}${y.a}${y.b}`);
    });
    const csv = [
      encodeCsvRow(header),
      ...rows.map((r) =>
        encodeCsvRow([
          r.provenance,
          r.needsReview,
          r.family,
          r.a,
          r.b,
          r.label,
          r.confidence,
          r.baseIs,
          r.genericIs,
          r.yieldQty,
          r.yieldUnit,
          r.coHarvestable,
          r.reason,
        ]),
      ),
    ].join("\n");
    const outPath = join(OUTPUT_DIR, `ws9-d189-a1-FINAL-${REVIEW_DATE.replace(/-/g, "")}.csv`);
    writeFileSync(outPath, `${csv}\n`, "utf8");

    // ── report ─────────────────────────────────────────────────────────────
    const byLabel = new Map<string, number>();
    for (const r of rows) byLabel.set(r.label, (byLabel.get(r.label) ?? 0) + 1);
    const byProv = new Map<string, number>();
    for (const r of rows) byProv.set(r.provenance, (byProv.get(r.provenance) ?? 0) + 1);
    const toRead = rows.filter((r) => r.needsReview !== "AUTO");
    const byReason = new Map<string, number>();
    for (const r of toRead) byReason.set(r.needsReview, (byReason.get(r.needsReview) ?? 0) + 1);

    console.log(`\n=== FINAL SHEET ===`);
    console.log(`  rows: ${rows.length}`);
    console.log(`  labels:     ${[...byLabel].sort().map(([k, v]) => `${k}:${v}`).join("  ")}`);
    console.log(`  provenance: ${[...byProv].sort().map(([k, v]) => `${k}:${v}`).join("  ")}`);
    console.log(`  changed under §3/§4/§5: arbiter overrides ${changed.arbiterOverride} · rule-authored ${changed.ruleAuthored} · Hans ${changed.hans} · garlic ${changed.garlic}`);
    console.log(`\n  🔴 ROWS A HUMAN MUST READ: ${toRead.length}`);
    console.log(`     ${[...byReason].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  ")}`);

    // ── the over-merge gate, on the FINAL state ────────────────────────────
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      if (!parent.has(x)) parent.set(x, x);
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root)!;
      return root;
    };
    for (const r of rows) {
      if (r.label !== "SYNONYM" || r.needsReview !== "AUTO") continue;
      const ra = find(r.a);
      const rb = find(r.b);
      if (ra !== rb) parent.set(ra, rb);
    }
    const cls = new Map<string, string[]>();
    for (const n of parent.keys()) {
      const r = find(n);
      if (!cls.has(r)) cls.set(r, []);
      cls.get(r)!.push(n);
    }
    const big = [...cls.values()].filter((c) => c.length >= 3).sort((a, b) => b.length - a.length);
    console.log(`\n=== AUTO-ACCEPT SYNONYM CLOSURE, size >= 3 (${big.length}) — the over-merge gate ===`);
    for (const c of big) console.log(`  [${c.length}] ${c.sort().join(" | ")}`);
    if (big.length === 0) console.log("  (none)");

    console.log(`\n  SHEET: ${outPath}`);
    console.log(`  NOTHING WRITTEN — --apply still exits 1.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

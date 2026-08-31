// WS9 D-WS9-189 Block A1 — D-WS9-197, half 2: the contradiction detector.
//
// Family granularity (half 1) is the MECHANISM that stops the model
// contradicting itself. This is the GUARD that proves the mechanism worked —
// a structural check, no model involved, that flags analogous pairs which
// received divergent labels.
//
// ⚠️ §27.4 — A GREEN DETECTOR ON A FAMILY-JUDGED RUN IS MEANINGLESS UNLESS A
// DELIBERATELY CONTRADICTORY FIXTURE TURNS IT RED. A guard nobody has seen fail
// is not a guard, it is a function that returns an empty array. `--fixture` on
// the CLI feeds this module a hand-built contradictory verdict set and requires
// it to go red; the real run is only trusted afterwards.
//
// THREE DETECTORS, because there are three ways the labels can be incoherent:
//
//   1. SIGNATURE DIVERGENCE — the D-WS9-197 case exactly. Two pairs whose token
//      difference is identical received different labels. `lime ~ lime juice`
//      and `lemon ~ lemon juice` both carry the signature `juice`; one
//      COMPONENT and one DISTINCT is a contradiction no matter which is right.
//
//      ⚠️ SCOPED TO ONE FAMILY, and the pilot is why. An unscoped version reads
//      a shared modifier token as an analogy when there is none: it grouped
//      `green onions ~ onion` with `cardamom pods ~ green cardamom pods` on the
//      signature `[green]`, and `onion ~ white onion` with `sugar ~ white
//      sugar` on `[white]`. Those pairs are not analogous, so their labels have
//      no obligation to agree, and flagging them spends a human decision on
//      nothing. Scoping costs no coverage on the case the guard exists for:
//      lime and lemon are both `citrus`, which is exactly why the culinary
//      families in pairUniverse.ts group them.
//
//   2. TRANSITIVITY CONFLICT — A~B synonym and B~C synonym but A~C distinct. If
//      A and B are the same purchase and B and C are the same purchase, then A
//      and C cannot be different products. A hard logical conflict, and it
//      fires where signature divergence cannot.
//
//   3. SAME-BASE DIVERGENCE — two pairs off the SAME ingredient whose
//      differences are the same KIND of modifier, given different labels. The
//      pilot surfaced `onion ~ yellow onion` SYNONYM beside `onion ~ white
//      onion` DISTINCT: both are one colour word off `onion`, so one cannot be
//      the same purchase while the other is a different product. Detector 1
//      misses this because the two signatures differ (`[yellow]` vs `[white]`),
//      and detector 2 misses it because no synonym chain closes. Without this
//      the guard has a hole the pilot walked straight into.
//
// A signature group that legitimately splits still gets flagged, and that is
// correct rather than a false positive: `[whole]` covers both
// `canned diced tomatoes ~ canned whole peeled tomatoes` (distinct) and
// `black peppercorns ~ whole black peppercorns` (synonym), which is the exact
// class where the answer needs a human. Surfacing them is the point.

import { modifierClassOf } from "./pairUniverse";
import type { JudgedPair } from "./judge";

export type ContradictionKind =
  | "signature_divergence"
  | "transitivity_conflict"
  | "same_base_divergence";

export interface Contradiction {
  kind: ContradictionKind;
  /** Index into the judged array. */
  index: number;
  detail: string;
}

/** Only decided labels participate; UNSURE already routes to the human. */
const DECIDED = new Set(["SYNONYM", "COMPONENT", "DISTINCT"]);

function pairKey(j: JudgedPair): string {
  return `${j.pair.a.canonicalName} ~ ${j.pair.b.canonicalName}`;
}

/**
 * Detector 1 — analogous pairs, divergent labels.
 *
 * Groups on the pair's token-difference signature. A signature seen with two or
 * more distinct labels flags EVERY member of the group, not just the minority:
 * the detector knows the labels disagree, not which one is wrong, and picking a
 * "majority" would quietly assert an answer it has no basis for.
 *
 * Singleton signatures cannot diverge and are skipped, which is what keeps the
 * residue in the tens rather than flagging the whole run.
 */
export function detectSignatureDivergence(judged: JudgedPair[]): Contradiction[] {
  // Keyed on family + signature, not signature alone — see the scoping note in
  // the header. The analogy claim only holds inside one food family.
  const bySignature = new Map<string, number[]>();
  judged.forEach((j, i) => {
    if (!DECIDED.has(j.verdict.label)) return;
    if (j.pair.signature === "(identical)") return;
    const key = `${j.familyKey}::${j.pair.signature}`;
    const bucket = bySignature.get(key);
    if (bucket) bucket.push(i);
    else bySignature.set(key, [i]);
  });

  const out: Contradiction[] = [];
  for (const [key, indices] of bySignature) {
    const signature = key.slice(key.indexOf("::") + 2);
    if (indices.length < 2) continue;
    const labels = new Set(indices.map((i) => judged[i]!.verdict.label));
    if (labels.size < 2) continue;

    const breakdown = indices
      .map((i) => `${pairKey(judged[i]!)} => ${judged[i]!.verdict.label}`)
      .join("; ");
    for (const i of indices) {
      out.push({
        kind: "signature_divergence",
        index: i,
        detail: `signature [${signature}] received ${[...labels].sort().join(" + ")} — ${breakdown}`,
      });
    }
  }
  return out;
}

/**
 * Detector 2 — synonym chain contradicts a distinct.
 *
 * Builds the transitive closure of synonym edges (union-find), then flags any
 * `distinct` verdict whose two endpoints landed in the same synonym class.
 */
export function detectTransitivityConflicts(judged: JudgedPair[]): Contradiction[] {
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
  const union = (x: string, y: string): void => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };

  for (const j of judged) {
    if (j.verdict.label === "SYNONYM") union(j.pair.a.id, j.pair.b.id);
  }

  const out: Contradiction[] = [];
  judged.forEach((j, i) => {
    if (j.verdict.label !== "DISTINCT") return;
    if (!parent.has(j.pair.a.id) || !parent.has(j.pair.b.id)) return;
    if (find(j.pair.a.id) !== find(j.pair.b.id)) return;
    out.push({
      kind: "transitivity_conflict",
      index: i,
      detail: `${pairKey(j)} labelled DISTINCT, but a chain of SYNONYM edges already makes them the same purchase`,
    });
  });
  return out;
}

/**
 * Detector 3 — same base, same kind of difference, different label.
 *
 * For every pair, the SHARED endpoint is whichever of the two is the shorter
 * name (the base), and the difference is the signature. Two pairs off the same
 * base whose signatures are single tokens of the same modifier class are
 * analogous by construction: `onion ~ white onion` and `onion ~ yellow onion`
 * are each one colour word off `onion`. They must carry the same label.
 *
 * Restricted to SINGLE-token signatures of a KNOWN class deliberately.
 * Multi-token differences ("large yellow") and unclassified tokens are not
 * reliably analogous, and flagging them would spend human decisions on pairs
 * whose labels are free to differ.
 */
export function detectSameBaseDivergence(judged: JudgedPair[]): Contradiction[] {
  const byBaseAndClass = new Map<string, number[]>();
  judged.forEach((j, i) => {
    if (!DECIDED.has(j.verdict.label)) return;
    const tokens = j.pair.signature.split("|");
    if (tokens.length !== 1) return;
    const cls = modifierClassOf(tokens[0]!);
    if (cls === "other") return;
    // The base is the shorter of the two names; the modifier hangs off it.
    const base =
      j.pair.a.tokens.length <= j.pair.b.tokens.length ? j.pair.a.id : j.pair.b.id;
    const key = `${base}::${cls}`;
    const bucket = byBaseAndClass.get(key);
    if (bucket) bucket.push(i);
    else byBaseAndClass.set(key, [i]);
  });

  const out: Contradiction[] = [];
  for (const [key, indices] of byBaseAndClass) {
    if (indices.length < 2) continue;
    const labels = new Set(indices.map((i) => judged[i]!.verdict.label));
    if (labels.size < 2) continue;
    const cls = key.slice(key.indexOf("::") + 2);
    const breakdown = indices
      .map((i) => `${pairKey(judged[i]!)} [${judged[i]!.pair.signature}] => ${judged[i]!.verdict.label}`)
      .join("; ");
    for (const i of indices) {
      out.push({
        kind: "same_base_divergence",
        index: i,
        detail: `same base, ${cls} difference, received ${[...labels].sort().join(" + ")} — ${breakdown}`,
      });
    }
  }
  return out;
}

export interface DetectorReport {
  contradictions: Contradiction[];
  /** judged-array indices carrying at least one contradiction. */
  flagged: Set<number>;
  bySignature: number;
  byTransitivity: number;
  bySameBase: number;
}

export function runDetectors(judged: JudgedPair[]): DetectorReport {
  const signature = detectSignatureDivergence(judged);
  const transitivity = detectTransitivityConflicts(judged);
  const sameBase = detectSameBaseDivergence(judged);
  const contradictions = [...signature, ...transitivity, ...sameBase];
  return {
    contradictions,
    flagged: new Set(contradictions.map((c) => c.index)),
    bySignature: signature.length,
    byTransitivity: transitivity.length,
    bySameBase: sameBase.length,
  };
}

/** Human-readable block for the console. Prints RED or green, never silence. */
export function formatDetectorReport(report: DetectorReport, judged: JudgedPair[]): string {
  if (report.contradictions.length === 0) {
    return "  CONTRADICTION DETECTOR: green — 0 contradictions across 0 divergent signatures.";
  }
  const lines: string[] = [
    `  CONTRADICTION DETECTOR: RED — ${report.contradictions.length} contradiction(s) on ${report.flagged.size} pair(s)`,
    `    signature divergence:  ${report.bySignature}`,
    `    transitivity conflict: ${report.byTransitivity}`,
    `    same-base divergence:  ${report.bySameBase}`,
  ];
  const seen = new Set<string>();
  for (const c of report.contradictions) {
    const key = `${c.kind}::${c.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`    [${c.kind}] ${pairKey(judged[c.index]!)}`);
    lines.push(`        ${c.detail}`);
  }
  return lines.join("\n");
}

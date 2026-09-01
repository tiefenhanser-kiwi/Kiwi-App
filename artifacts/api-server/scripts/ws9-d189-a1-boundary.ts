// WS9 D-WS9-189 A1 Phase 4b — characterise D-WS9-196's excluded boundary band.
//
// The universe predicate (same-core OR containment) leaves 1,021 pairs just
// outside: same head noun, <= 2 differing tokens, but neither condition met —
// "adobo sauce ~ soy sauce", "american cheese ~ cheddar cheese".
//
// ⚠️ FOUR HAND-PICKED EXAMPLES IS NOT A CHARACTERISATION OF 1,021. The prior
// report showed four obviously-DISTINCT pairs and inferred the whole band was
// obvious. That is selection, not measurement — and this arc's own undecidable
// fixture, `scallions ~ spring onions`, is exactly the shape that could be
// hiding in there: same head noun, two differing tokens, and genuinely hard.
//
// So: a RANDOM sample of 40, judged by the same Opus rubric, reporting what
// fraction is non-obvious. If the band is uniformly DISTINCT-at-high-confidence
// then excluding it costs nothing and D-WS9-196's boundary is safe. If it is
// not, the boundary is hiding real relationships and that is a finding.
//
// Run: node --env-file=.env --import tsx scripts/ws9-d189-a1-boundary.ts

import { PrismaClient } from "@prisma/client";
import Anthropic from "@anthropic-ai/sdk";

import {
  buildPairUniverse,
  pairFamily,
  type NormalizedRow,
  type Pair,
} from "./ws9-d189-a1/pairUniverse";
import { costUsd, judgeBatch, type Usage } from "./ws9-d189-a1/judge";

const SAMPLE_SIZE = 40;

// Deterministic PRNG so the "random" sample is reproducible and a re-run
// measures the same 40 rather than a fresh draw that cannot be compared.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.ingredient.findMany({
      select: { id: true, canonicalName: true, category: true },
      orderBy: { canonicalName: "asc" },
    });
    const { normalized, pairs } = buildPairUniverse(rows);
    const inUniverse = new Set(pairs.map((p) => `${p.a.id}::${p.b.id}`));

    // Rebuild the adjacent band: same head noun, <= 2 differing tokens, and
    // NOT already in the universe.
    const band: Pair[] = [];
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
        const uniq = [...new Set(diff)].sort();
        if (uniq.length > 2) continue;
        band.push({
          a,
          b,
          via: "same_core",
          signature: uniq.join("|"),
          straddlesProcessing: false,
          familyKey: pairFamily(a, b),
        });
      }
    }
    console.log(`\n=== D-WS9-196 BOUNDARY BAND ===`);
    console.log(`  universe:      ${pairs.length}`);
    console.log(`  adjacent band: ${band.length} (excluded)`);

    const rand = mulberry32(0xd189a1);
    const shuffled = [...band];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const sample = shuffled.slice(0, SAMPLE_SIZE);
    console.log(`  random sample: ${sample.length} (seeded, reproducible)\n`);

    const client = new Anthropic();
    const usage: Usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
    const verdicts = await judgeBatch(client, "boundary-band-sample", sample, usage);

    let obvious = 0;
    const nonObvious: string[] = [];
    verdicts.forEach((v, i) => {
      const p = sample[i]!;
      // "Obvious" = DISTINCT at high confidence. That is the answer the
      // exclusion silently assumes for all 1,021.
      const isObvious = v.label === "DISTINCT" && v.confidence === "high";
      if (isObvious) obvious += 1;
      else
        nonObvious.push(
          `  "${p.a.canonicalName}" ~ "${p.b.canonicalName}"  => ${v.label}/${v.confidence}\n      ${v.reason}`,
        );
    });

    console.log(`=== RESULT ===`);
    console.log(
      `  DISTINCT/high ("obvious", what the exclusion assumes): ${obvious}/${sample.length}  (${((obvious / sample.length) * 100).toFixed(0)}%)`,
    );
    console.log(
      `  NON-OBVIOUS:                                          ${nonObvious.length}/${sample.length}  (${((nonObvious.length / sample.length) * 100).toFixed(0)}%)`,
    );
    console.log(
      `\n  projected non-obvious across the whole band: ~${Math.round((nonObvious.length / sample.length) * band.length)} of ${band.length}`,
    );
    if (nonObvious.length > 0) {
      console.log(`\n=== THE NON-OBVIOUS ONES ===`);
      for (const line of nonObvious) console.log(line);
    }
    console.log(`\n  cost $${costUsd(usage).toFixed(2)}  ·  NOTHING WRITTEN.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

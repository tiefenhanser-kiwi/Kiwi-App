import { prisma } from "../src/lib/prisma";

type Row = {
  id: string;
  promptKey: string;
  model: string;
  latencyMs: number;
  createdAt: Date;
};

const SONNET_KEY = "wizard.candidate.expand";
const HAIKU_KEY = "nutrition.ingredient_estimate";
const LIMIT = 200;
const WINDOW_MS = 60_000;
const LAST_WINDOWS = 10;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function stats(label: string, rows: Row[]) {
  const lat = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  const n = lat.length;
  if (n === 0) {
    console.log(`  ${label}: n=0 (no rows)`);
    return;
  }
  const min = lat[0];
  const max = lat[n - 1];
  const mean = Math.round(lat.reduce((a, b) => a + b, 0) / n);
  const p50 = Math.round(quantile(lat, 0.5));
  const p95 = Math.round(quantile(lat, 0.95));
  console.log(
    `  ${label}: n=${n}  min=${min}ms  p50=${p50}ms  p95=${p95}ms  max=${max}ms  mean=${mean}ms`
  );
}

async function main() {
  const [sonnet, haiku] = await Promise.all([
    prisma.lLMCallLog.findMany({
      where: { promptKey: SONNET_KEY },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
      select: {
        id: true,
        promptKey: true,
        model: true,
        latencyMs: true,
        createdAt: true,
      },
    }),
    prisma.lLMCallLog.findMany({
      where: { promptKey: HAIKU_KEY },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
      select: {
        id: true,
        promptKey: true,
        model: true,
        latencyMs: true,
        createdAt: true,
      },
    }),
  ]);

  console.log("=== Per-model latency stats (last ~200 rows each) ===");
  console.log(`promptKey = "${SONNET_KEY}" (Sonnet)`);
  stats("sonnet", sonnet as Row[]);
  console.log(`promptKey = "${HAIKU_KEY}" (Haiku)`);
  stats("haiku ", haiku as Row[]);
  console.log("");

  if (sonnet.length === 0 && haiku.length === 0) {
    console.log("No rows for either promptKey. Run a fresh expand from the app first.");
    return;
  }

  const all: Row[] = [...(sonnet as Row[]), ...(haiku as Row[])];
  if (all.length === 0) {
    return;
  }

  const buckets = new Map<
    number,
    {
      windowStart: Date;
      sonnetLats: number[];
      haikuLats: number[];
    }
  >();

  for (const r of all) {
    const bucketKey = Math.floor(r.createdAt.getTime() / WINDOW_MS);
    let b = buckets.get(bucketKey);
    if (!b) {
      b = {
        windowStart: new Date(bucketKey * WINDOW_MS),
        sonnetLats: [],
        haikuLats: [],
      };
      buckets.set(bucketKey, b);
    }
    if (r.promptKey === SONNET_KEY) b.sonnetLats.push(r.latencyMs);
    else if (r.promptKey === HAIKU_KEY) b.haikuLats.push(r.latencyMs);
  }

  const sortedBuckets = Array.from(buckets.entries())
    .sort((a, b) => b[0] - a[0])
    .slice(0, LAST_WINDOWS)
    .reverse();

  console.log(
    `=== Per-session wall-clock table (60s windows, last ~${LAST_WINDOWS}, oldest→newest) ===`
  );
  console.log(
    "window (UTC)             sonnetSlowMs  sonnetN  haikuSlowMs  haikuN  estWallMs"
  );
  console.log(
    "------------------------ ------------  -------  -----------  ------  ---------"
  );
  for (const [, b] of sortedBuckets) {
    const sSlow = b.sonnetLats.length ? Math.max(...b.sonnetLats) : 0;
    const hSlow = b.haikuLats.length ? Math.max(...b.haikuLats) : 0;
    const sCount = b.sonnetLats.length;
    const hCount = b.haikuLats.length;
    const wall = sSlow + hSlow;
    const ts = b.windowStart.toISOString().replace("T", " ").slice(0, 19);
    console.log(
      `${ts}   ${String(sSlow).padStart(12)}  ${String(sCount).padStart(7)}  ${String(hSlow).padStart(11)}  ${String(hCount).padStart(6)}  ${String(wall).padStart(9)}`
    );
  }
}

main()
  .catch((e) => {
    console.error("ERROR:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

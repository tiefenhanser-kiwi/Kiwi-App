// WS9-019 — READ-ONLY LLMCallLog cost + latency audit.
//
// SELECT-ONLY. No INSERT/UPDATE/DELETE, no schema changes, no writes of any
// kind. Grounds the D-WS9-019 AI cost/latency efficiency program in observed
// facts (per-key, per-version cost + latency attribution) instead of guesses.
//
// The dev table is small (dev-scale, hundreds to low thousands of rows), so we
// fetch all rows once and aggregate in memory. If the count is ever unexpectedly
// large (>50k) this would need to switch to prisma.groupBy aggregates.
//
// Run (from repo root, PowerShell-safe):
//   pnpm --filter @workspace/api-server exec tsx scripts/ws9-019-llm-cost-audit.ts
//
// (The required run command does NOT pass --env-file, so the script self-loads
// .env from the package cwd. @prisma/client only resolves from artifacts/api-server,
// which is why the script must live here.)

import { PrismaClient } from "@prisma/client";

// ── self-load .env (run command omits --env-file) ────────────────────────────
if (!process.env.DATABASE_URL) {
  try {
    // Node 20.12+/25 built-in; cwd is the package dir under pnpm --filter exec.
    process.loadEnvFile(".env");
  } catch {
    // fall through — if DATABASE_URL is set some other way, Prisma still works.
  }
}

const prisma = new PrismaClient();

const LARGE_TABLE_THRESHOLD = 50_000;

// ── small numeric / formatting helpers ───────────────────────────────────────
function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** Nearest-rank percentile (p in [0,100]). Returns 0 for empty input. */
function percentile(nums: number[], p: number): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

const fmtCost = (n: number): string => n.toFixed(4);
const fmtMs = (n: number): string => String(Math.round(n));
const fmtTok = (n: number): string => String(Math.round(n));
const fmtPct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** YYYY-MM-DD (UTC) */
function fmtDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Render an aligned monospace table. `aligns[i]` is 'l' or 'r' per column. */
function table(headers: string[], aligns: ("l" | "r")[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const pad = (s: string, i: number): string =>
    aligns[i] === "r" ? s.padStart(widths[i]) : s.padEnd(widths[i]);
  const line = (cells: string[]): string => cells.map((c, i) => pad(c, i)).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [line(headers), sep, ...rows.map(line)].join("\n");
}

const indent = (s: string, by = "    "): string =>
  s.split("\n").map((l) => by + l).join("\n");

// ── row shape we pull from the DB ────────────────────────────────────────────
interface LogRow {
  promptKey: string;
  promptVersion: number | null;
  model: string;
  mode: string;
  userId: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cost: number; // Decimal.toNumber()
  retryCount: number;
  success: boolean;
  failureReason: string | null;
  createdAt: Date;
}

function uniqSorted(vals: string[]): string[] {
  return [...new Set(vals)].sort();
}

async function main(): Promise<void> {
  const total = await prisma.lLMCallLog.count();

  if (total > LARGE_TABLE_THRESHOLD) {
    console.log(
      `[ws9-019] llm_call_logs has ${total} rows (> ${LARGE_TABLE_THRESHOLD}). ` +
        `In-memory aggregation is disabled above this threshold; the script needs ` +
        `a groupBy rewrite before it can safely run at this scale. Aborting.`,
    );
    return;
  }

  const raw = await prisma.lLMCallLog.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      promptKey: true,
      promptVersion: true,
      model: true,
      mode: true,
      userId: true,
      latencyMs: true,
      inputTokens: true,
      outputTokens: true,
      costEstimateUsd: true,
      retryCount: true,
      success: true,
      failureReason: true,
      createdAt: true,
    },
  });

  const rows: LogRow[] = raw.map((r) => ({
    promptKey: r.promptKey,
    promptVersion: r.promptVersion,
    model: r.model,
    mode: String(r.mode),
    userId: r.userId,
    latencyMs: r.latencyMs,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cost: r.costEstimateUsd.toNumber(),
    retryCount: r.retryCount,
    success: r.success,
    failureReason: r.failureReason,
    createdAt: r.createdAt,
  }));

  console.log("========================================================================");
  console.log("  WS9-019 — LLMCallLog cost + latency audit (READ-ONLY)");
  console.log("========================================================================");

  // ═══ SECTION 1 — Data-quality header (§27 gate) ════════════════════════════
  console.log("\n\n### SECTION 1 — Data-quality header (the §27 gate)\n");

  const dates = rows.map((r) => r.createdAt);
  const minDate = dates.length ? dates[0] : null;
  const maxDate = dates.length ? dates[dates.length - 1] : null;
  const distinctUsers = new Set(rows.filter((r) => r.userId !== null).map((r) => r.userId));
  const nullUserRows = rows.filter((r) => r.userId === null).length;
  const distinctKeys = new Set(rows.map((r) => r.promptKey));
  const successCount = rows.filter((r) => r.success).length;
  const failCount = rows.length - successCount;
  const totalRetries = rows.reduce((a, r) => a + r.retryCount, 0);
  const totalCost = rows.reduce((a, r) => a + r.cost, 0);

  console.log(`  total rows:                 ${total}`);
  console.log(
    `  date range (createdAt):     ${minDate ? minDate.toISOString() : "-"}  ..  ${maxDate ? maxDate.toISOString() : "-"}`,
  );
  console.log(
    `  distinct userId (non-null): ${distinctUsers.size}   (rows with null userId: ${nullUserRows})`,
  );
  console.log(`  distinct promptKey:         ${distinctKeys.size}`);
  console.log(
    `  success / failure:          ${successCount} success  /  ${failCount} failure  (${fmtPct(rows.length ? successCount / rows.length : 0)} success)`,
  );
  console.log(`  total retries (sum):        ${totalRetries}`);
  console.log(`  total cost (all rows):      $${fmtCost(totalCost)}`);

  // Calls per day, last 14 days (anchored on the max date present, not wall clock).
  console.log("\n  Calls per day (last 14 calendar days of data):");
  if (maxDate) {
    const byDay = new Map<string, { calls: number; cost: number }>();
    for (const r of rows) {
      const d = fmtDay(r.createdAt);
      const cur = byDay.get(d) ?? { calls: 0, cost: 0 };
      cur.calls += 1;
      cur.cost += r.cost;
      byDay.set(d, cur);
    }
    const dayRows: string[][] = [];
    const endMs = Date.parse(fmtDay(maxDate) + "T00:00:00Z");
    for (let i = 13; i >= 0; i--) {
      const day = fmtDay(new Date(endMs - i * 86_400_000));
      const rec = byDay.get(day);
      dayRows.push([
        day,
        rec ? String(rec.calls) : "0",
        rec ? `$${fmtCost(rec.cost)}` : "$0.0000",
      ]);
    }
    console.log(indent(table(["day", "calls", "cost"], ["l", "r", "r"], dayRows)));
  } else {
    console.log("    (no rows)");
  }

  // ═══ SECTION 2 — Per-key rollup ════════════════════════════════════════════
  console.log("\n\n### SECTION 2 — Per-key rollup\n");

  const keyGroups = new Map<string, LogRow[]>();
  for (const r of rows) {
    const arr = keyGroups.get(r.promptKey) ?? [];
    arr.push(r);
    keyGroups.set(r.promptKey, arr);
  }

  interface KeyStat {
    key: string;
    calls: number;
    successRate: number;
    retries: number;
    models: string;
    modes: string;
    inAvg: number;
    inP95: number;
    outAvg: number;
    outP95: number;
    costAvg: number;
    costTotal: number;
    latP50: number;
    latP95: number;
    first: Date;
    last: Date;
  }

  const keyStats: KeyStat[] = [];
  for (const [key, grp] of keyGroups) {
    const inTok = grp.map((r) => r.inputTokens);
    const outTok = grp.map((r) => r.outputTokens);
    const lat = grp.map((r) => r.latencyMs);
    const costs = grp.map((r) => r.cost);
    const succ = grp.filter((r) => r.success).length;
    keyStats.push({
      key,
      calls: grp.length,
      successRate: succ / grp.length,
      retries: grp.reduce((a, r) => a + r.retryCount, 0),
      models: uniqSorted(grp.map((r) => r.model)).join(","),
      modes: uniqSorted(grp.map((r) => r.mode)).join(","),
      inAvg: avg(inTok),
      inP95: percentile(inTok, 95),
      outAvg: avg(outTok),
      outP95: percentile(outTok, 95),
      costAvg: avg(costs),
      costTotal: costs.reduce((a, b) => a + b, 0),
      latP50: percentile(lat, 50),
      latP95: percentile(lat, 95),
      first: grp[0].createdAt,
      last: grp[grp.length - 1].createdAt,
    });
  }

  const HEADERS = [
    "promptKey",
    "calls",
    "succ%",
    "retry",
    "model(s)",
    "mode",
    "inAvg",
    "inP95",
    "outAvg",
    "outP95",
    "costAvg",
    "costTot",
    "latP50",
    "latP95",
    "first",
    "last",
  ];
  const ALIGNS: ("l" | "r")[] = [
    "l", "r", "r", "r", "l", "l", "r", "r", "r", "r", "r", "r", "r", "r", "l", "l",
  ];
  const toRow = (s: KeyStat): string[] => [
    s.key,
    String(s.calls),
    fmtPct(s.successRate),
    String(s.retries),
    s.models,
    s.modes,
    fmtTok(s.inAvg),
    fmtTok(s.inP95),
    fmtTok(s.outAvg),
    fmtTok(s.outP95),
    fmtCost(s.costAvg),
    fmtCost(s.costTotal),
    fmtMs(s.latP50),
    fmtMs(s.latP95),
    fmtDay(s.first),
    fmtDay(s.last),
  ];

  const bySpend = [...keyStats].sort((a, b) => b.costTotal - a.costTotal);
  console.log("(a) Ranked by TOTAL spend (costTot) descending:\n");
  console.log(table(HEADERS, ALIGNS, bySpend.map(toRow)));

  const byAvg = [...keyStats].sort((a, b) => b.costAvg - a.costAvg);
  console.log("\n\n(b) Ranked by AVG per-call cost (costAvg) descending:\n");
  console.log(table(HEADERS, ALIGNS, byAvg.map(toRow)));

  // Third table: top keys by p95 latency (user-visible wait hot-spots).
  const byLat = [...keyStats].sort((a, b) => b.latP95 - a.latP95);
  console.log("\n\n(c) Top keys by p95 latency (user-visible wait hot-spots):\n");
  console.log(
    table(
      ["promptKey", "calls", "latP50", "latP95", "costAvg"],
      ["l", "r", "r", "r", "r"],
      byLat.map((s) => [
        s.key,
        String(s.calls),
        fmtMs(s.latP50),
        fmtMs(s.latP95),
        fmtCost(s.costAvg),
      ]),
    ),
  );

  // ═══ SECTION 3 — Per-version split ═════════════════════════════════════════
  console.log("\n\n### SECTION 3 — Per-version split (keys with >1 promptVersion)\n");

  const multiVersionKeys = [...keyGroups.entries()].filter(([, grp]) => {
    const versions = new Set(grp.map((r) => String(r.promptVersion)));
    return versions.size > 1;
  });

  if (multiVersionKeys.length === 0) {
    console.log("  (no promptKey has more than one distinct promptVersion present)");
  } else {
    for (const [key, grp] of multiVersionKeys) {
      console.log(`\n  promptKey: ${key}`);
      const versionGroups = new Map<string, LogRow[]>();
      for (const r of grp) {
        const v = r.promptVersion === null ? "null" : String(r.promptVersion);
        const arr = versionGroups.get(v) ?? [];
        arr.push(r);
        versionGroups.set(v, arr);
      }
      const sortedVersions = [...versionGroups.entries()].sort((a, b) => {
        const an = a[0] === "null" ? -1 : Number(a[0]);
        const bn = b[0] === "null" ? -1 : Number(b[0]);
        return an - bn;
      });
      const vRows: string[][] = sortedVersions.map(([v, vg]) => [
        v,
        String(vg.length),
        fmtTok(avg(vg.map((r) => r.inputTokens))),
        fmtTok(avg(vg.map((r) => r.outputTokens))),
        fmtCost(avg(vg.map((r) => r.cost))),
        fmtMs(percentile(vg.map((r) => r.latencyMs), 50)),
        fmtDay(vg[0].createdAt),
        fmtDay(vg[vg.length - 1].createdAt),
      ]);
      console.log(
        indent(
          table(
            ["version", "calls", "inAvg", "outAvg", "costAvg", "latP50", "first", "last"],
            ["r", "r", "r", "r", "r", "r", "l", "l"],
            vRows,
          ),
        ),
      );
    }
  }

  // ═══ SECTION 4 — Failure detail ════════════════════════════════════════════
  console.log("\n\n### SECTION 4 — Failure detail (success = false)\n");

  const failures = rows.filter((r) => !r.success);
  if (failures.length === 0) {
    console.log("  (no failed rows)");
  } else {
    const failMap = new Map<string, { pk: string; reason: string; count: number }>();
    for (const r of failures) {
      const reason = r.failureReason ?? "(null)";
      const k = `${r.promptKey} ${reason}`;
      const cur = failMap.get(k) ?? { pk: r.promptKey, reason, count: 0 };
      cur.count += 1;
      failMap.set(k, cur);
    }
    const failRows = [...failMap.values()].sort((a, b) => b.count - a.count);
    console.log(
      table(
        ["promptKey", "failureReason", "count"],
        ["l", "l", "r"],
        failRows.map((f) => [f.pk, f.reason, String(f.count)]),
      ),
    );
  }

  console.log("\n========================================================================");
  console.log("  end of audit");
  console.log("========================================================================");
}

main()
  .catch((err) => {
    console.error("[ws9-019-llm-cost-audit] FAILED:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

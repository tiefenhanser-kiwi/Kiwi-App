// WS9 §2 — READ-ONLY LLMCallLog probe for the prep.narrate_steps subset run.
//
// SELECT-ONLY. No writes of any kind. Answers: did the 2-of-4 subset run reach
// the AI smaller than the 4-meal full week, what is the fixed prompt floor, and
// does latency track output tokens.
//
// Run (from repo root):
//   pnpm --filter @workspace/api-server exec tsx scripts/ws9-prep-subset-probe.ts

import { PrismaClient } from "@prisma/client";

if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* DATABASE_URL may be set some other way */
  }
}

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.lLMCallLog.findMany({
    where: { promptKey: "prep.narrate_steps" },
    orderBy: { createdAt: "asc" },
  });

  console.log(`prep.narrate_steps rows: ${rows.length}\n`);
  console.log(
    [
      "createdAt".padEnd(24),
      "v".padStart(3),
      "in".padStart(7),
      "cacheR".padStart(7),
      "cacheC".padStart(7),
      "out".padStart(6),
      "ms".padStart(7),
      "cost".padStart(9),
      "ok".padStart(3),
      "rty".padStart(4),
      "model",
    ].join(" ")
  );
  for (const r of rows) {
    console.log(
      [
        r.createdAt.toISOString().padEnd(24),
        String(r.promptVersion ?? "-").padStart(3),
        String(r.inputTokens).padStart(7),
        String(r.cacheReadInputTokens ?? "-").padStart(7),
        String(r.cacheCreationInputTokens ?? "-").padStart(7),
        String(r.outputTokens).padStart(6),
        String(r.latencyMs).padStart(7),
        String(r.costEstimateUsd).padStart(9),
        String(r.success).padStart(3),
        String(r.retryCount).padStart(4),
        r.model,
      ].join(" ")
    );
  }

  // ── per-version aggregate (never all-time) ────────────────────────────────
  console.log("\n── per promptVersion, successful rows only ──");
  const byVersion = new Map<string, typeof rows>();
  for (const r of rows.filter((x) => x.success)) {
    const k = String(r.promptVersion ?? "-");
    if (!byVersion.has(k)) byVersion.set(k, []);
    byVersion.get(k)!.push(r);
  }
  for (const [v, rs] of [...byVersion.entries()].sort()) {
    const msPerOut = rs.map((r) => r.latencyMs / r.outputTokens);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    console.log(
      `v${v}: n=${rs.length} ` +
        `in avg=${Math.round(avg(rs.map((r) => r.inputTokens)))} ` +
        `out avg=${Math.round(avg(rs.map((r) => r.outputTokens)))} ` +
        `ms/outTok avg=${avg(msPerOut).toFixed(2)} ` +
        `range=[${Math.min(...msPerOut).toFixed(2)}, ${Math.max(...msPerOut).toFixed(2)}]`
    );
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });

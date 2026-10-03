// Sonnet 5.5 side-by-side · P1 — READ-ONLY census. Which model each AIPrompt
// row runs today (the DB row is what production resolves, not the seed), and
// what each Sonnet key has cost in LLMCallLog over the last 90 days.
// Run: node --env-file=.env --import tsx scripts/_scratch/sonnet55/p1-census.ts
import { PrismaClient } from "@prisma/client";

const host = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!host.includes("ep-broad-haze")) throw new Error("refusing: not the dev branch");

const prisma = new PrismaClient();
const rows = await prisma.aIPrompt.findMany({
  select: { key: true, defaultModel: true, defaultMode: true },
  orderBy: { key: "asc" },
});
console.log("── AIPrompt rows (live) ──");
for (const r of rows) console.log(`${r.defaultModel.padEnd(28)} ${r.defaultMode.padEnd(5)} ${r.key}`);

const rates = await prisma.systemSetting.findMany({
  where: { key: { startsWith: "ai.model_rate." } },
  select: { key: true, value: true },
});
console.log("\n── SystemSetting model rates ──");
for (const r of rates) console.log(`${r.key} = ${JSON.stringify(r.value)}`);

const since = new Date(Date.now() - 90 * 864e5);
const logs = await prisma.lLMCallLog.groupBy({
  by: ["promptKey", "model"],
  where: { createdAt: { gte: since }, model: { contains: "sonnet" } },
  _count: { _all: true },
  _avg: { inputTokens: true, outputTokens: true, latencyMs: true, costEstimateUsd: true, cacheReadInputTokens: true },
  _max: { createdAt: true },
});
console.log("\n── LLMCallLog, sonnet, last 90d ──");
for (const l of logs.sort((a, b) => b._count._all - a._count._all)) {
  const a = l._avg;
  console.log(
    `${l.promptKey.padEnd(34)} ${l.model.padEnd(20)} n=${String(l._count._all).padStart(5)}` +
      ` in=${Math.round(a.inputTokens ?? 0)} cacheRd=${Math.round(a.cacheReadInputTokens ?? 0)} out=${Math.round(a.outputTokens ?? 0)}` +
      ` lat=${Math.round(a.latencyMs ?? 0)}ms $=${Number(a.costEstimateUsd ?? 0).toFixed(4)} last=${l._max.createdAt?.toISOString().slice(0, 10)}`,
  );
}
await prisma.$disconnect();

// TRIAGE-0 — read-only spend for the walk's throwaway account (dev only).
// Run from artifacts/api-server: node --env-file=.env scripts/_scratch/triage-0/spend.mjs <secrets.json>
// Prints per-promptKey rows/cost/latency; never prints the email or the DB URL.
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";

const host = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!host.includes("ep-broad-haze")) throw new Error("REFUSING: not the dev branch");
const { email } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const p = new PrismaClient();
const u = await p.user.findUnique({ where: { email }, select: { id: true } });
if (!u) { console.log("no user"); process.exit(0); }
const rows = await p.lLMCallLog.findMany({
  where: { userId: u.id },
  select: { promptKey: true, promptVersion: true, costEstimateUsd: true, latencyMs: true, success: true, retryCount: true, createdAt: true },
  orderBy: { createdAt: "asc" },
});
let total = 0;
for (const r of rows) {
  total += Number(r.costEstimateUsd);
  console.log(`${r.createdAt.toISOString()} ${r.promptKey} v${r.promptVersion} $${Number(r.costEstimateUsd).toFixed(4)} ${r.latencyMs}ms ok=${r.success} retry=${r.retryCount}`);
}
console.log(`userId=${u.id} rows=${rows.length} total=$${total.toFixed(4)}`);
await p.$disconnect();

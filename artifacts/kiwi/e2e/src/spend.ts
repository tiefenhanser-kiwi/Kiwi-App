// ─────────────────────────────────────────────────────────────────────────────
// WHAT A RUN COST — measured from the ledger, per surface.
//
// The grocery census measures cost from the SDK's own token counts because it
// calls the pipeline in-process and can see them. This harness cannot: it goes
// through HTTP, and the only record of what the server spent is the row the
// server wrote. So cost here is read from LLMCallLog, windowed by (userId,
// createdAt >= the moment the harness started that surface).
//
// ⚠️ THE WINDOW IS THE MEASUREMENT, AND IT IS NOT AIRTIGHT. LLMCallLog carries
// no planId (it never has), so a row cannot be attributed to a plan directly —
// it is attributed by TIME plus promptKey. That is sound while this harness is
// the only thing spending on this account, and it is wrong the moment Hans uses
// the app on his phone mid-run. The window is recorded with every figure so a
// reader can see the assumption rather than inherit it, and `promptKeys` lists
// what actually landed in the window so an unexpected spender is visible.
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from "node:child_process";

import { API_SERVER_ROOT } from "./env";

export interface LedgerRow {
  promptKey: string;
  promptVersion: number | null;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number | null;
  costEstimateUsd: string;
  retryCount: number;
  success: boolean;
  createdAt: string;
}

export interface SurfaceSpend {
  surface: string;
  sinceIso: string;
  untilIso: string;
  rows: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  retries: number;
  failures: number;
  promptKeys: Record<string, number>;
  latencyMsTotal: number;
}

/** One read-only SELECT over the window, run with cwd = artifacts/api-server. */
export function ledgerBetween(userId: string, sinceIso: string, untilIso: string): LedgerRow[] {
  const script = `
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const host = new URL(process.env.DATABASE_URL ?? "").hostname;
if (!host.includes("ep-broad-haze")) throw new Error("REFUSING: not the dev branch");
const rows = await p.lLMCallLog.findMany({
  where: {
    userId: process.env.KIWI_E2E_UID,
    createdAt: { gte: new Date(process.env.KIWI_E2E_SINCE), lte: new Date(process.env.KIWI_E2E_UNTIL) },
  },
  select: {
    promptKey: true, promptVersion: true, model: true, latencyMs: true,
    inputTokens: true, outputTokens: true, cacheReadInputTokens: true,
    costEstimateUsd: true, retryCount: true, success: true, createdAt: true,
  },
  orderBy: { createdAt: "asc" },
});
process.stdout.write(JSON.stringify(rows.map((r) => ({ ...r, costEstimateUsd: String(r.costEstimateUsd), createdAt: r.createdAt.toISOString() }))));
await p.$disconnect();
`;
  const out = execFileSync(
    process.execPath,
    ["--env-file=.env", "--input-type=module", "-e", script],
    {
      cwd: API_SERVER_ROOT,
      env: {
        ...process.env,
        KIWI_E2E_UID: userId,
        KIWI_E2E_SINCE: sinceIso,
        KIWI_E2E_UNTIL: untilIso,
      },
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return JSON.parse(out) as LedgerRow[];
}

export function summarise(surface: string, sinceIso: string, rows: LedgerRow[]): SurfaceSpend {
  const promptKeys: Record<string, number> = {};
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let retries = 0;
  let failures = 0;
  let latencyMsTotal = 0;
  for (const r of rows) {
    promptKeys[r.promptKey] = (promptKeys[r.promptKey] ?? 0) + 1;
    costUsd += Number(r.costEstimateUsd);
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    cacheReadInputTokens += r.cacheReadInputTokens ?? 0;
    retries += r.retryCount;
    if (!r.success) failures++;
    latencyMsTotal += r.latencyMs;
  }
  return {
    surface,
    sinceIso,
    untilIso: new Date().toISOString(),
    rows: rows.length,
    // Six decimals: the column is Decimal(10,6) and a per-surface figure this
    // small is the input to A4's projection, where rounding compounds.
    costUsd: Number(costUsd.toFixed(6)),
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    retries,
    failures,
    promptKeys,
    latencyMsTotal,
  };
}

/** Measure one surface: run `fn`, then read the ledger rows it produced. */
export async function measured<T>(
  userId: string,
  surface: string,
  fn: () => Promise<T>,
): Promise<{ value: T; spend: SurfaceSpend; wallMs: number }> {
  // One second of slack on each side: the row is written after the response is
  // composed, and clocks between this process and Postgres are not identical.
  const since = new Date(Date.now() - 1000).toISOString();
  const t0 = Date.now();
  const value = await fn();
  const wallMs = Date.now() - t0;
  const until = new Date(Date.now() + 1000).toISOString();
  const spend = summarise(surface, since, ledgerBetween(userId, since, until));
  return { value, spend, wallMs };
}

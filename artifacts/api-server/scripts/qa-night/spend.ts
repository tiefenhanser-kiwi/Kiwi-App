// QA-NIGHT-1 — AI spend, counted from the server's own LLMCallLog rows (QA-7's aiTally).
//
// A row is the run's when its userId is one of the run's accounts, or its
// guestSessionId is one of the run's guest sessions. NOT by time window alone:
// Hans's :3000 shares the dev database and may spend during the night.
//
// ⚠️ READ BEFORE DELETE. LLMCallLog.userId is an optional relation with no
// onDelete, so deleting the account nulls it (Prisma's SetNull default) and the
// row can no longer be attributed. run.ts tallies each household before its
// account is deleted.
import type { PrismaClient } from "@prisma/client";

export interface SpendTally {
  calls: number;
  usd: number;
  byPrompt: Record<string, { calls: number; usd: number }>;
  failures: number;
}

export const EMPTY_TALLY: SpendTally = { calls: 0, usd: 0, byPrompt: {}, failures: 0 };

export async function tallySpend(
  prisma: PrismaClient,
  who: { userIds: string[]; guestSessionIds: string[] },
  since: Date,
): Promise<SpendTally> {
  const or: object[] = [];
  if (who.userIds.length) or.push({ userId: { in: who.userIds } });
  if (who.guestSessionIds.length) or.push({ guestSessionId: { in: who.guestSessionIds } });
  if (or.length === 0) return { ...EMPTY_TALLY, byPrompt: {} };
  const rows = await prisma.lLMCallLog.findMany({
    where: { createdAt: { gte: since }, OR: or },
    select: { promptKey: true, costEstimateUsd: true, success: true },
  });
  const out: SpendTally = { calls: 0, usd: 0, byPrompt: {}, failures: 0 };
  for (const r of rows) {
    const usd = Number(r.costEstimateUsd);
    out.calls++;
    out.usd += usd;
    if (!r.success) out.failures++;
    const b = (out.byPrompt[r.promptKey] ??= { calls: 0, usd: 0 });
    b.calls++;
    b.usd += usd;
  }
  return out;
}

export function addTally(a: SpendTally, b: SpendTally): SpendTally {
  const byPrompt: SpendTally["byPrompt"] = {};
  for (const t of [a, b]) {
    for (const [k, v] of Object.entries(t.byPrompt)) {
      const x = (byPrompt[k] ??= { calls: 0, usd: 0 });
      x.calls += v.calls;
      x.usd += v.usd;
    }
  }
  return { calls: a.calls + b.calls, usd: a.usd + b.usd, failures: a.failures + b.failures, byPrompt };
}

/**
 * The cap rule: start the next household only when spent + its worst-case
 * estimate stays at or under the budget. The estimate is the household's own
 * plan from households.json, raised to the largest per-household spend seen so
 * far tonight (a household that ran over its estimate teaches the next one).
 */
export function mayStart(spentUsd: number, nextEstimateUsd: number, budgetUsd: number): boolean {
  return spentUsd + nextEstimateUsd <= budgetUsd;
}

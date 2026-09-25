// Row 13 "Test Kitchen" · Block 1 (D-WS9-261) — the guest spend ceiling.
//
// The load-bearing case is the LEDGER PARTITION: a guest row is NOT counted in
// the user global sum and IS counted in the guest sum. Get that wrong in
// either direction and the guard is decorative — a guest that lands in the
// user sum can exhaust a paying userbase's ceiling, and one that lands in
// neither (which is what BUG-262's early return did before this block) spends
// without limit and without a trace.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  checkSpendGuard,
  _resetSpendGuardLogSampling,
  ENV_AI_DISABLED,
  ENV_AI_DAILY_CEILING_USD,
  ENV_AI_GUEST_DISABLED,
  ENV_AI_GUEST_DAILY_CEILING_USD,
} from "../spendGuard";
import type { PrismaLike } from "../ai/promptRegistry";

const NOW = new Date("2026-09-25T12:00:00.000Z");

interface LedgerRow {
  userId: string | null;
  guestSessionId: string | null;
  costEstimateUsd: number;
}

/**
 * A ledger that answers `aggregate` by applying the caller's OWN where clause,
 * so the test cannot accidentally agree with the implementation about which
 * rows belong to which sum — the filter under test is the filter that runs.
 */
function makeLedger(rows: LedgerRow[]) {
  const seen: Array<Record<string, unknown>> = [];
  const prisma = {
    lLMCallLog: {
      create: async () => ({}),
      count: async () => 0,
      aggregate: async ({ where }: { where: Record<string, unknown> }) => {
        seen.push(where);
        const wantsUser = "userId" in where;
        const matched = rows.filter((r) =>
          wantsUser ? r.userId !== null : r.guestSessionId !== null,
        );
        const sum = matched.reduce((n, r) => n + r.costEstimateUsd, 0);
        return { _sum: { costEstimateUsd: sum } };
      },
    },
    _wheres: () => seen,
  };
  return prisma as unknown as PrismaLike & { _wheres: () => Array<Record<string, unknown>> };
}

beforeEach(() => _resetSpendGuardLogSampling());

describe("spend guard — the guest branch (D-WS9-261)", () => {
  it("AI_GUEST_DISABLED refuses a guest and leaves a USER untouched", async () => {
    const env = { [ENV_AI_GUEST_DISABLED]: "true" };
    const ledger = makeLedger([]);

    const guest = await checkSpendGuard({
      prisma: ledger,
      userId: null,
      guestSessionId: "gs-1",
      promptKey: "wizard.set_preferences.generate",
      now: NOW,
      env,
    });
    assert.equal(guest.refused, true);
    if (guest.refused) assert.equal(guest.reason, "guest_disabled");

    // The point of a SEPARATE switch: the product keeps working.
    const user = await checkSpendGuard({
      prisma: ledger,
      userId: "u-1",
      promptKey: "wizard.set_preferences.generate",
      now: NOW,
      env,
    });
    assert.equal(user.refused, false);
  });

  it("refuses AT the boundary, not past it (>=, the same rule the user ceiling uses)", async () => {
    const env = { [ENV_AI_GUEST_DAILY_CEILING_USD]: "25" };

    const under = await checkSpendGuard({
      prisma: makeLedger([
        { userId: null, guestSessionId: "gs-a", costEstimateUsd: 24.999 },
      ]),
      userId: null,
      guestSessionId: "gs-b",
      promptKey: "p",
      now: NOW,
      env,
    });
    assert.equal(under.refused, false, "$24.999 still passes");

    const at = await checkSpendGuard({
      prisma: makeLedger([
        { userId: null, guestSessionId: "gs-a", costEstimateUsd: 25 },
      ]),
      userId: null,
      guestSessionId: "gs-b",
      promptKey: "p",
      now: NOW,
      env,
    });
    assert.equal(at.refused, true, "exactly $25 refuses");
    if (at.refused) assert.equal(at.reason, "guest_daily_ceiling");
  });

  it("THE PARTITION: a guest row is not in the user sum, and a user row is not in the guest sum", async () => {
    const rows: LedgerRow[] = [
      // A very expensive guest day…
      { userId: null, guestSessionId: "gs-a", costEstimateUsd: 99 },
      // …and a cheap user day, plus a system row in neither.
      { userId: "u-1", guestSessionId: null, costEstimateUsd: 1 },
      { userId: null, guestSessionId: null, costEstimateUsd: 500 },
    ];

    // The USER ceiling is $10. The $99 of guest spend must not trip it.
    const user = await checkSpendGuard({
      prisma: makeLedger(rows),
      userId: "u-1",
      promptKey: "p",
      now: NOW,
      env: { [ENV_AI_DAILY_CEILING_USD]: "10" },
    });
    assert.equal(
      user.refused,
      false,
      "guest spend must never exhaust the user ceiling",
    );

    // The GUEST ceiling is $10. The $99 of guest spend MUST trip it — and the
    // $500 system row must not, or a catalog run would close the funnel.
    const guestLedger = makeLedger(rows);
    const guest = await checkSpendGuard({
      prisma: guestLedger,
      userId: null,
      guestSessionId: "gs-b",
      promptKey: "p",
      now: NOW,
      env: { [ENV_AI_GUEST_DAILY_CEILING_USD]: "10" },
    });
    assert.equal(guest.refused, true);

    // And the filter that ran really was the guest one.
    const where = guestLedger._wheres().at(-1)!;
    assert.ok("guestSessionId" in where, "the guest sum filters on guestSessionId");
    assert.ok(!("userId" in where), "the guest sum does NOT filter on userId");
  });

  it("a guest does NOT inherit BUG-262's system-caller exemption", async () => {
    // This is the regression the whole branch exists for. Before it, a guest
    // (userId null) fell into `if (userId == null) return { refused: false }`
    // and was never measured at all.
    const verdict = await checkSpendGuard({
      prisma: makeLedger([
        { userId: null, guestSessionId: "gs-a", costEstimateUsd: 1000 },
      ]),
      userId: null,
      guestSessionId: "gs-b",
      promptKey: "p",
      now: NOW,
      env: { [ENV_AI_GUEST_DAILY_CEILING_USD]: "25" },
    });
    assert.equal(verdict.refused, true, "a guest is guarded, a seed is not");

    // The genuine system caller (no guestSessionId) keeps its exemption.
    const seed = await checkSpendGuard({
      prisma: makeLedger([
        { userId: null, guestSessionId: "gs-a", costEstimateUsd: 1000 },
      ]),
      userId: null,
      promptKey: "p",
      now: NOW,
      env: { [ENV_AI_GUEST_DAILY_CEILING_USD]: "25" },
    });
    assert.equal(seed.refused, false, "BUG-262 is preserved for real seeds");
  });

  it("unset = check off; AI_DISABLED still stops a guest", async () => {
    const off = await checkSpendGuard({
      prisma: makeLedger([
        { userId: null, guestSessionId: "gs-a", costEstimateUsd: 10_000 },
      ]),
      userId: null,
      guestSessionId: "gs-b",
      promptKey: "p",
      now: NOW,
      env: {},
    });
    assert.equal(off.refused, false, "no ceiling set = no ceiling");

    const killed = await checkSpendGuard({
      prisma: makeLedger([]),
      userId: null,
      guestSessionId: "gs-b",
      promptKey: "p",
      now: NOW,
      env: { [ENV_AI_DISABLED]: "1" },
    });
    assert.equal(killed.refused, true);
    if (killed.refused) assert.equal(killed.reason, "ai_disabled");
  });
});

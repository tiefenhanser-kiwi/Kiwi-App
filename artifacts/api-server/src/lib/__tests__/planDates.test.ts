// WS7-5b-mobile-PRE — unit tests for the shared currentWeekRange() helper.
// "This week" is Sun-Saturday per PRD §8; both PATCH /plans/:id auto-date
// and POST /api/wizard/drafts/:id/activate consume the helper, so the
// envelope tests in plans.test.ts and wizard.test.ts cover the wiring —
// these tests pin the helper's own semantics.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  currentWeekRange,
  didNewlyCoverNow,
  isInstanceActiveThisWeek,
  resolveThisWeekPlan,
  resolveThisWeekWinnerId,
  type CoveringCandidate,
} from "../planDates";

describe("currentWeekRange — Sunday-Saturday calendar week (UTC)", () => {
  it("on a Sunday, startDate is that Sunday and endDate is the following Saturday", () => {
    // 2026-05-24 is a Sunday (UTC).
    const sun = new Date("2026-05-24T00:00:00.000Z");
    const r = currentWeekRange(sun);
    assert.equal(r.startDate, "2026-05-24");
    assert.equal(r.endDate, "2026-05-30");
  });

  it("on a mid-week day, startDate is the prior Sunday and endDate is the following Saturday", () => {
    // 2026-05-27 is a Wednesday (UTC).
    const wed = new Date("2026-05-27T12:00:00.000Z");
    const r = currentWeekRange(wed);
    assert.equal(r.startDate, "2026-05-24");
    assert.equal(r.endDate, "2026-05-30");
  });

  it("on a Saturday, endDate is that Saturday and startDate is the prior Sunday", () => {
    // 2026-05-30 is a Saturday (UTC).
    const sat = new Date("2026-05-30T23:00:00.000Z");
    const r = currentWeekRange(sat);
    assert.equal(r.startDate, "2026-05-24");
    assert.equal(r.endDate, "2026-05-30");
  });

  it("emits YYYY-MM-DD strings (not ISO 8601) symmetric with toYmd", () => {
    const r = currentWeekRange(new Date("2026-01-07T00:00:00.000Z"));
    // 2026-01-07 is a Wednesday; week is 2026-01-04 (Sun) … 2026-01-10 (Sat).
    assert.equal(r.startDate, "2026-01-04");
    assert.equal(r.endDate, "2026-01-10");
    // Format invariants — zero-padded month/day, no time component.
    assert.match(r.startDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(r.endDate, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("spans exactly 7 calendar days (Sun → Sat is +6)", () => {
    const r = currentWeekRange(new Date("2026-05-27T00:00:00.000Z"));
    const start = new Date(r.startDate);
    const end = new Date(r.endDate);
    const diffDays = (end.getTime() - start.getTime()) / 86_400_000;
    assert.equal(diffDays, 6);
  });

  it("handles month boundary (Sunday in one month, Saturday in next)", () => {
    // 2026-07-30 is a Thursday; week is 2026-07-26 (Sun) … 2026-08-01 (Sat).
    const r = currentWeekRange(new Date("2026-07-30T00:00:00.000Z"));
    assert.equal(r.startDate, "2026-07-26");
    assert.equal(r.endDate, "2026-08-01");
  });

  it("handles year boundary (Sunday in one year, Saturday in next)", () => {
    // 2026-12-30 is a Wednesday; week is 2026-12-27 (Sun) … 2027-01-02 (Sat).
    const r = currentWeekRange(new Date("2026-12-30T00:00:00.000Z"));
    assert.equal(r.startDate, "2026-12-27");
    assert.equal(r.endDate, "2027-01-02");
  });
});

// WS7-6 (E) Block 1 — date-range predicate that replaces the dropped
// isActiveThisWeek column. The boolean still ships on the wire (decision
// #2); these tests pin the predicate's edge cases so the readers in
// plans.ts / home.ts / groceryLists.ts / planQueries.ts agree on
// semantics with the Postgres EXCLUDE constraint (`tsrange '[]'`).
describe("isInstanceActiveThisWeek — date-range predicate", () => {
  const NOW = new Date("2026-06-03T12:00:00.000Z");

  it("returns true when now is strictly inside the range", () => {
    assert.equal(
      isInstanceActiveThisWeek(
        {
          startDate: new Date("2026-05-31T00:00:00.000Z"),
          endDate: new Date("2026-06-06T00:00:00.000Z"),
        },
        NOW,
      ),
      true,
    );
  });

  it("returns true on the inclusive start edge", () => {
    assert.equal(
      isInstanceActiveThisWeek(
        { startDate: NOW, endDate: new Date("2026-06-09T00:00:00.000Z") },
        NOW,
      ),
      true,
    );
  });

  it("returns true on the inclusive end edge", () => {
    assert.equal(
      isInstanceActiveThisWeek(
        { startDate: new Date("2026-05-31T00:00:00.000Z"), endDate: NOW },
        NOW,
      ),
      true,
    );
  });

  it("returns false when now is before the range", () => {
    assert.equal(
      isInstanceActiveThisWeek(
        {
          startDate: new Date("2026-07-01T00:00:00.000Z"),
          endDate: new Date("2026-07-07T00:00:00.000Z"),
        },
        NOW,
      ),
      false,
    );
  });

  it("returns false when now is after the range", () => {
    assert.equal(
      isInstanceActiveThisWeek(
        {
          startDate: new Date("2026-05-01T00:00:00.000Z"),
          endDate: new Date("2026-05-07T00:00:00.000Z"),
        },
        NOW,
      ),
      false,
    );
  });

  it("returns false when startDate is null (null-dated plan)", () => {
    assert.equal(
      isInstanceActiveThisWeek(
        { startDate: null, endDate: new Date("2026-06-09T00:00:00.000Z") },
        NOW,
      ),
      false,
    );
  });

  it("returns false when endDate is null (null-dated plan)", () => {
    assert.equal(
      isInstanceActiveThisWeek(
        { startDate: new Date("2026-05-31T00:00:00.000Z"), endDate: null },
        NOW,
      ),
      false,
    );
  });

  it("returns false when both dates are null", () => {
    assert.equal(
      isInstanceActiveThisWeek({ startDate: null, endDate: null }, NOW),
      false,
    );
  });
});

describe("didNewlyCoverNow — re-pointed plan_activated_this_week trigger", () => {
  const NOW = new Date("2026-06-03T12:00:00.000Z");
  const covers = {
    startDate: new Date("2026-05-31T00:00:00.000Z"),
    endDate: new Date("2026-06-06T00:00:00.000Z"),
  };
  const past = {
    startDate: new Date("2026-05-01T00:00:00.000Z"),
    endDate: new Date("2026-05-07T00:00:00.000Z"),
  };
  const future = {
    startDate: new Date("2026-07-01T00:00:00.000Z"),
    endDate: new Date("2026-07-07T00:00:00.000Z"),
  };
  const undated = { startDate: null, endDate: null };

  it("undated → covers-now: fires", () => {
    assert.equal(didNewlyCoverNow(undated, covers, NOW), true);
  });

  it("past → covers-now: fires", () => {
    assert.equal(didNewlyCoverNow(past, covers, NOW), true);
  });

  it("future → covers-now: fires", () => {
    assert.equal(didNewlyCoverNow(future, covers, NOW), true);
  });

  it("covers-now → covers-now (same-state re-date): does NOT fire", () => {
    assert.equal(didNewlyCoverNow(covers, covers, NOW), false);
  });

  it("covers-now → past: silent demotion, does NOT fire", () => {
    assert.equal(didNewlyCoverNow(covers, past, NOW), false);
  });

  it("past → future (both non-covering): does NOT fire", () => {
    assert.equal(didNewlyCoverNow(past, future, NOW), false);
  });

  it("undated → undated: does NOT fire", () => {
    assert.equal(didNewlyCoverNow(undated, undated, NOW), false);
  });

  it("covers-now → undated: does NOT fire (silent demotion)", () => {
    assert.equal(didNewlyCoverNow(covers, undated, NOW), false);
  });
});

// WS7-6 (E) Block 1 REWORK — collection-level resolver under Model 2.
// Active-ness is COMPUTED: among rows whose [startDate, endDate] covers
// now, the winner has the newest activatedAt (nulls last → newest
// createdAt). Plans MAY share date ranges; this resolver is the only
// arbiter. These tests are load-bearing proofs of:
//   - auto-roll-with-null-activatedAt (a sole covering plan with null
//     activatedAt STILL wins → zero-write activation as time passes);
//   - newest-activatedAt wins (Model 2's primary rule);
//   - null-tiebreak by newest createdAt (deterministic — no coin-flip).
describe("resolveThisWeekPlan — Model 2 winner among covering rows", () => {
  const NOW = new Date("2026-06-03T12:00:00.000Z");
  const COVERING = {
    startDate: new Date("2026-05-31T00:00:00.000Z"),
    endDate: new Date("2026-06-06T00:00:00.000Z"),
  };
  const FUTURE = {
    startDate: new Date("2026-07-01T00:00:00.000Z"),
    endDate: new Date("2026-07-07T00:00:00.000Z"),
  };
  const PAST = {
    startDate: new Date("2026-05-01T00:00:00.000Z"),
    endDate: new Date("2026-05-07T00:00:00.000Z"),
  };

  function row(
    id: string,
    overrides: Partial<CoveringCandidate> = {},
  ): CoveringCandidate {
    return {
      id,
      startDate: COVERING.startDate,
      endDate: COVERING.endDate,
      activatedAt: null,
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      ...overrides,
    };
  }

  it("returns null when there are no rows", () => {
    assert.equal(resolveThisWeekPlan([], NOW), null);
  });

  it("AUTO-ROLL: one covering row with NULL activatedAt still wins (zero-write activation)", () => {
    const sole = row("p-sole", { activatedAt: null });
    const winner = resolveThisWeekPlan([sole], NOW);
    assert.ok(winner);
    assert.equal(winner.id, "p-sole");
  });

  it("one covering row with set activatedAt wins", () => {
    const sole = row("p-sole", {
      activatedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    const winner = resolveThisWeekPlan([sole], NOW);
    assert.equal(winner?.id, "p-sole");
  });

  it("NEWEST ACTIVATEDAT wins among two covering rows with non-null activatedAt", () => {
    const older = row("p-older", {
      activatedAt: new Date("2026-06-01T08:00:00.000Z"),
    });
    const newer = row("p-newer", {
      activatedAt: new Date("2026-06-02T08:00:00.000Z"),
    });
    const winner = resolveThisWeekPlan([older, newer], NOW);
    assert.equal(winner?.id, "p-newer");
  });

  it("FLIP: re-stamp the older row with a fresher activatedAt → winner flips", () => {
    const a = row("p-a", { activatedAt: new Date("2026-06-01T08:00:00.000Z") });
    const b = row("p-b", { activatedAt: new Date("2026-06-02T08:00:00.000Z") });
    assert.equal(resolveThisWeekPlan([a, b], NOW)?.id, "p-b");
    // Restamp a to be even newer than b.
    const aFresh = { ...a, activatedAt: new Date("2026-06-03T08:00:00.000Z") };
    assert.equal(resolveThisWeekPlan([aFresh, b], NOW)?.id, "p-a");
  });

  it("NULL TIEBREAK: covering row with set activatedAt beats covering row with null", () => {
    const nullRow = row("p-null", { activatedAt: null });
    const setRow = row("p-set", {
      activatedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    const winner = resolveThisWeekPlan([nullRow, setRow], NOW);
    assert.equal(winner?.id, "p-set");
  });

  it("ALL-NULL TIEBREAK: among rows with null activatedAt, newest createdAt wins", () => {
    const oldCreated = row("p-old-created", {
      activatedAt: null,
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    const newCreated = row("p-new-created", {
      activatedAt: null,
      createdAt: new Date("2026-05-20T00:00:00.000Z"),
    });
    const winner = resolveThisWeekPlan([oldCreated, newCreated], NOW);
    assert.equal(winner?.id, "p-new-created");
  });

  it("NON-COVERING with newest activatedAt cannot beat a covering row with null activatedAt", () => {
    const nonCoveringFresh = row("p-future", {
      startDate: FUTURE.startDate,
      endDate: FUTURE.endDate,
      activatedAt: new Date("2026-06-10T00:00:00.000Z"),
    });
    const coveringNull = row("p-covering", { activatedAt: null });
    const winner = resolveThisWeekPlan(
      [nonCoveringFresh, coveringNull],
      NOW,
    );
    assert.equal(winner?.id, "p-covering");
  });

  it("returns null when only non-covering rows exist (no This Week's plan)", () => {
    const past = row("p-past", {
      startDate: PAST.startDate,
      endDate: PAST.endDate,
      activatedAt: new Date("2026-06-10T00:00:00.000Z"),
    });
    const future = row("p-future", {
      startDate: FUTURE.startDate,
      endDate: FUTURE.endDate,
      activatedAt: new Date("2026-06-10T00:00:00.000Z"),
    });
    assert.equal(resolveThisWeekPlan([past, future], NOW), null);
  });

  it("inclusive start edge counts as covering (startDate === now)", () => {
    const edge = row("p-edge", {
      startDate: NOW,
      endDate: new Date("2026-06-09T00:00:00.000Z"),
      activatedAt: null,
    });
    assert.equal(resolveThisWeekPlan([edge], NOW)?.id, "p-edge");
  });

  it("inclusive end edge counts as covering (endDate === now)", () => {
    const edge = row("p-edge", {
      startDate: new Date("2026-05-31T00:00:00.000Z"),
      endDate: NOW,
      activatedAt: null,
    });
    assert.equal(resolveThisWeekPlan([edge], NOW)?.id, "p-edge");
  });

  it("null startDate is never covering (never wins, even with newest activatedAt)", () => {
    const nullStart = row("p-null-start", {
      startDate: null,
      endDate: COVERING.endDate,
      activatedAt: new Date("2026-06-10T00:00:00.000Z"),
    });
    assert.equal(resolveThisWeekPlan([nullStart], NOW), null);
  });

  it("null endDate is never covering", () => {
    const nullEnd = row("p-null-end", {
      startDate: COVERING.startDate,
      endDate: null,
      activatedAt: new Date("2026-06-10T00:00:00.000Z"),
    });
    assert.equal(resolveThisWeekPlan([nullEnd], NOW), null);
  });
});

// D-WS7-103 — §27 regression proofs for read-time UTC-day-granular coverage.
// Mobile sends date-only YYYY-MM-DD wire strings; Prisma round-trips those
// through `new Date("YYYY-MM-DD")` which canonicalizes to UTC midnight per
// the JS spec. Coverage must therefore compare UTC calendar days, not raw
// instants, otherwise a plan whose endDate is "today" resolves as expired
// the moment now passes 00:00 UTC of the same calendar day. These tests
// pin the day-granular semantics in all three consumers: the helper, the
// in-memory resolver eligibility filter, and the SQL pre-filter inside
// resolveThisWeekWinnerId.
describe("D-WS7-103 — UTC-day-granular coverage (boundary proofs)", () => {
  // Mid-day mid-week mid-month — `now` falls inside a UTC day whose 00:00
  // midnight is in the past, so any endDate stored as that day's midnight
  // would be `< now` under the old instant comparison.
  const NOW_MIDDAY = new Date("2026-06-06T12:00:00.000Z");
  const TODAY_UTC_MIDNIGHT = new Date("2026-06-06T00:00:00.000Z");
  const NEXT_DAY_UTC_MIDNIGHT = new Date("2026-06-07T00:00:00.000Z");
  const YESTERDAY_END_OF_DAY = new Date("2026-06-05T23:59:59.999Z");

  it("end-day boundary mid-day: endDate=today UTC-midnight, now=midday today → covers (the failing case)", () => {
    assert.equal(
      isInstanceActiveThisWeek(
        {
          startDate: new Date("2026-05-31T00:00:00.000Z"),
          endDate: TODAY_UTC_MIDNIGHT,
        },
        NOW_MIDDAY,
      ),
      true,
    );
  });

  it("start-day boundary mid-day: startDate=today UTC-midnight, now=midday today → covers (start edge)", () => {
    assert.equal(
      isInstanceActiveThisWeek(
        {
          startDate: TODAY_UTC_MIDNIGHT,
          endDate: new Date("2026-06-12T00:00:00.000Z"),
        },
        NOW_MIDDAY,
      ),
      true,
    );
  });

  it("end-day just before next UTC midnight: endDate=today UTC-midnight, now=23:59:59.999Z same day → covers", () => {
    assert.equal(
      isInstanceActiveThisWeek(
        {
          startDate: new Date("2026-05-31T00:00:00.000Z"),
          endDate: TODAY_UTC_MIDNIGHT,
        },
        new Date("2026-06-06T23:59:59.999Z"),
      ),
      true,
    );
  });

  it("end-day past next UTC midnight: endDate=today UTC-midnight, now=next UTC midnight → does NOT cover", () => {
    assert.equal(
      isInstanceActiveThisWeek(
        {
          startDate: new Date("2026-05-31T00:00:00.000Z"),
          endDate: TODAY_UTC_MIDNIGHT,
        },
        NEXT_DAY_UTC_MIDNIGHT,
      ),
      false,
    );
  });

  it("day-before start: startDate=today UTC-midnight, now=yesterday 23:59:59.999Z → does NOT cover", () => {
    assert.equal(
      isInstanceActiveThisWeek(
        {
          startDate: TODAY_UTC_MIDNIGHT,
          endDate: new Date("2026-06-12T00:00:00.000Z"),
        },
        YESTERDAY_END_OF_DAY,
      ),
      false,
    );
  });

  it("didNewlyCoverNow: prev=undated → next={start=Sunday, end=today UTC-midnight}, now=midday today → fires (seam-B gate)", () => {
    assert.equal(
      didNewlyCoverNow(
        { startDate: null, endDate: null },
        {
          startDate: new Date("2026-05-31T00:00:00.000Z"),
          endDate: TODAY_UTC_MIDNIGHT,
        },
        NOW_MIDDAY,
      ),
      true,
    );
  });

  it("resolveThisWeekPlan: endDate=today UTC-midnight, now=midday today → row is winner (not null)", () => {
    const row: CoveringCandidate = {
      id: "p-end-today",
      startDate: new Date("2026-05-31T00:00:00.000Z"),
      endDate: TODAY_UTC_MIDNIGHT,
      activatedAt: new Date("2026-06-06T11:00:00.000Z"),
      createdAt: new Date("2026-05-15T00:00:00.000Z"),
    };
    const winner = resolveThisWeekPlan([row], NOW_MIDDAY);
    assert.equal(winner?.id, "p-end-today");
  });
});

// D-WS7-103 — SQL-vs-helper alignment lock. resolveThisWeekWinnerId issues
// a narrow indexed findMany whose WHERE clause pre-filters by date bounds
// BEFORE the in-memory resolver runs. This test isolates the SQL boundary
// (not just the combined helper) by simulating real Prisma `lte`/`gte`
// semantics in the stub. A covering plan with endDate=today UTC-midnight
// must be admitted by the SQL pre-filter when `now` is midday today —
// otherwise the in-memory helper never gets a chance to see it.
//
// This locks the SQL filter and the in-memory helper to the same UTC-day
// granularity. Bug history: the SQL filter passed raw `now` as the gte
// bound, so a Prisma row whose endDate was today's UTC midnight was
// excluded server-side any time `now > 00:00:00.000 UTC` of that day —
// the in-memory helper fix alone would have left the five route call
// sites (home / plans / groceryLists / DELETE-tx / W5) broken via this
// SQL pre-filter. Locking both layers to UTC-day prevents that divergence
// from reappearing.
describe("D-WS7-103 — resolveThisWeekWinnerId SQL pre-filter day-granularity", () => {
  const NOW_MIDDAY = new Date("2026-06-06T12:00:00.000Z");

  interface StubRow {
    id: string;
    userId: string;
    isWizardDraft: boolean;
    startDate: Date | null;
    endDate: Date | null;
    activatedAt: Date | null;
    createdAt: Date;
  }

  // Real Prisma semantics: `lte`/`gte` are instant comparisons on the
  // stored DateTime column. Mirroring that here means the stub MUST
  // exclude a row whose endDate < args.where.endDate.gte (or whose
  // startDate > args.where.startDate.lte). If the bound is raw `now`
  // (pre-fix), an end=today UTC-midnight row is excluded. If the bound is
  // UTC-day-truncated `nowDay` (post-fix), the row is admitted.
  function makeStubPrisma(rows: StubRow[]) {
    return {
      mealPlanInstance: {
        findMany: async (args: {
          where: {
            userId?: string;
            isWizardDraft?: boolean;
            startDate?: { lte?: Date; not?: null };
            endDate?: { gte?: Date; not?: null };
          };
          select?: Record<string, boolean>;
        }) => {
          return rows.filter((r) => {
            if (args.where.userId && r.userId !== args.where.userId) return false;
            if (
              args.where.isWizardDraft !== undefined &&
              r.isWizardDraft !== args.where.isWizardDraft
            ) {
              return false;
            }
            if (args.where.startDate?.not === null && r.startDate === null) {
              return false;
            }
            if (args.where.endDate?.not === null && r.endDate === null) {
              return false;
            }
            if (args.where.startDate?.lte && r.startDate !== null) {
              if (r.startDate.getTime() > args.where.startDate.lte.getTime()) {
                return false;
              }
            }
            if (args.where.endDate?.gte && r.endDate !== null) {
              if (r.endDate.getTime() < args.where.endDate.gte.getTime()) {
                return false;
              }
            }
            return true;
          });
        },
      },
    };
  }

  it("ALIGNMENT LOCK: endDate=today UTC-midnight, now=midday today → SQL admits the row and resolver returns its id", async () => {
    const stub = makeStubPrisma([
      {
        id: "p-end-today",
        userId: "u-1",
        isWizardDraft: false,
        startDate: new Date("2026-05-31T00:00:00.000Z"),
        endDate: new Date("2026-06-06T00:00:00.000Z"),
        activatedAt: new Date("2026-06-05T08:00:00.000Z"),
        createdAt: new Date("2026-05-15T00:00:00.000Z"),
      },
    ]);
    const winnerId = await resolveThisWeekWinnerId(
      stub as never,
      "u-1",
      NOW_MIDDAY,
    );
    assert.equal(
      winnerId,
      "p-end-today",
      "SQL pre-filter must admit end=today UTC-midnight rows at midday — proves the SQL bound and the in-memory helper share UTC-day granularity",
    );
  });

  it("ALIGNMENT LOCK: end-day past next UTC midnight → SQL excludes the row (next day → returns null)", async () => {
    // Same row as above, but now is the very next UTC midnight — past the
    // inclusive UTC-day boundary. The SQL filter must exclude it; the
    // resolver returns null. Pins that the day-granular fix did not
    // accidentally widen the bound by a full day past end.
    const stub = makeStubPrisma([
      {
        id: "p-end-today",
        userId: "u-1",
        isWizardDraft: false,
        startDate: new Date("2026-05-31T00:00:00.000Z"),
        endDate: new Date("2026-06-06T00:00:00.000Z"),
        activatedAt: new Date("2026-06-05T08:00:00.000Z"),
        createdAt: new Date("2026-05-15T00:00:00.000Z"),
      },
    ]);
    const winnerId = await resolveThisWeekWinnerId(
      stub as never,
      "u-1",
      new Date("2026-06-07T00:00:00.000Z"),
    );
    assert.equal(winnerId, null);
  });
});

// ── BUG-109 — a composted plan is not This Week's plan ────────────────────
//
// DELETE /plans/:id soft-deletes a plan (status "past", compostedAt set,
// isArchived: true) and deliberately LEAVES startDate/endDate intact. Before
// this fix resolveThisWeekWinnerId filtered only on userId / isWizardDraft /
// date coverage, so a composted plan whose dates still covered today stayed
// the winner — Home rendered a dead plan as "This Week" with live actions,
// and the dead row could out-rank a live sibling.
//
// The stub below honours `isArchived` the way Prisma does: an explicit
// `isArchived: false` in the WHERE clause excludes archived rows, and its
// ABSENCE admits them. That is what makes this a real lock — delete the gate
// from planDates.ts and the archived row flows through and these assertions
// go red, rather than the stub quietly re-implementing the fix.
describe("BUG-109 — resolveThisWeekWinnerId excludes composted plans", () => {
  const NOW = new Date("2026-06-03T12:00:00.000Z"); // Wednesday, midday UTC

  interface ArchRow {
    id: string;
    userId: string;
    isWizardDraft: boolean;
    isArchived: boolean;
    startDate: Date | null;
    endDate: Date | null;
    activatedAt: Date | null;
    createdAt: Date;
  }

  // Covers 2026-05-31 .. 2026-06-06 (the week containing NOW).
  const COVERS_NOW = {
    startDate: new Date("2026-05-31T00:00:00.000Z"),
    endDate: new Date("2026-06-06T00:00:00.000Z"),
  };

  function makeStub(rows: ArchRow[]) {
    return {
      mealPlanInstance: {
        findMany: async (args: {
          where: {
            userId?: string;
            isWizardDraft?: boolean;
            isArchived?: boolean;
            startDate?: { lte?: Date; not?: null };
            endDate?: { gte?: Date; not?: null };
          };
        }) =>
          rows.filter((r) => {
            if (args.where.userId && r.userId !== args.where.userId) return false;
            if (
              args.where.isWizardDraft !== undefined &&
              r.isWizardDraft !== args.where.isWizardDraft
            ) {
              return false;
            }
            // Prisma semantics: the predicate applies only when present.
            if (
              args.where.isArchived !== undefined &&
              r.isArchived !== args.where.isArchived
            ) {
              return false;
            }
            if (args.where.startDate?.not === null && r.startDate === null) {
              return false;
            }
            if (args.where.endDate?.not === null && r.endDate === null) {
              return false;
            }
            if (
              args.where.startDate?.lte &&
              r.startDate !== null &&
              r.startDate.getTime() > args.where.startDate.lte.getTime()
            ) {
              return false;
            }
            if (
              args.where.endDate?.gte &&
              r.endDate !== null &&
              r.endDate.getTime() < args.where.endDate.gte.getTime()
            ) {
              return false;
            }
            return true;
          }),
      },
    };
  }

  it("a composted plan covering today is NOT the winner (sole row → null)", async () => {
    const stub = makeStub([
      {
        id: "p-composted",
        userId: "u-1",
        isWizardDraft: false,
        isArchived: true,
        ...COVERS_NOW,
        activatedAt: new Date("2026-06-01T08:00:00.000Z"),
        createdAt: new Date("2026-05-20T00:00:00.000Z"),
      },
    ]);
    assert.equal(
      await resolveThisWeekWinnerId(stub as never, "u-1", NOW),
      null,
      "a soft-deleted plan must never be This Week's plan",
    );
  });

  it("a LIVE plan covering today is still the winner (the gate did not over-filter)", async () => {
    const stub = makeStub([
      {
        id: "p-live",
        userId: "u-1",
        isWizardDraft: false,
        isArchived: false,
        ...COVERS_NOW,
        activatedAt: new Date("2026-06-01T08:00:00.000Z"),
        createdAt: new Date("2026-05-20T00:00:00.000Z"),
      },
    ]);
    assert.equal(
      await resolveThisWeekWinnerId(stub as never, "u-1", NOW),
      "p-live",
    );
  });

  it("a composted plan does NOT block a live sibling from winning, even with a fresher activatedAt", async () => {
    // Pre-fix this is the damaging shape: the composted row has the greatest
    // activatedAt, so resolveThisWeekPlan hands it the tiebreak and the live
    // plan the user actually has is silently not "This Week".
    const stub = makeStub([
      {
        id: "p-composted-fresher",
        userId: "u-1",
        isWizardDraft: false,
        isArchived: true,
        ...COVERS_NOW,
        activatedAt: new Date("2026-06-02T09:00:00.000Z"),
        createdAt: new Date("2026-05-28T00:00:00.000Z"),
      },
      {
        id: "p-live-older",
        userId: "u-1",
        isWizardDraft: false,
        isArchived: false,
        ...COVERS_NOW,
        activatedAt: new Date("2026-06-01T08:00:00.000Z"),
        createdAt: new Date("2026-05-20T00:00:00.000Z"),
      },
    ]);
    assert.equal(
      await resolveThisWeekWinnerId(stub as never, "u-1", NOW),
      "p-live-older",
      "the live plan wins once the composted sibling is excluded",
    );
  });

  it("the WHERE clause actually carries isArchived:false (call-shape lock)", async () => {
    // Guards the seam the stub above depends on: if the gate is ever removed
    // from the query the stub would admit archived rows silently in a future
    // rewrite. Pin the emitted predicate directly.
    let seen: Record<string, unknown> | null = null;
    const spy = {
      mealPlanInstance: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          seen = args.where;
          return [];
        },
      },
    };
    await resolveThisWeekWinnerId(spy as never, "u-1", NOW);
    assert.deepEqual(
      (seen as Record<string, unknown> | null)?.["isArchived"],
      false,
      "resolveThisWeekWinnerId must pre-filter archived (composted) plans in SQL",
    );
  });
});

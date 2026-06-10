// WS7-5b-mobile-PRE — shared "this week" definition for plan auto-dating.
// Single source of truth for Sunday-Saturday week boundaries, consumed by
// both PATCH /plans/:id (auto-fill on flip-to-active) and POST /api/wizard/
// drafts/:id/activate (date the freshly-activated draft).
//
// Wire shape: YYYY-MM-DD strings, symmetric with the read-path toYmd helper
// in lib/planQueries.ts (UTC components). Routes turn these into Date values
// for the DB via `new Date("YYYY-MM-DD")`, which canonicalizes to UTC
// midnight per the JS spec — the round-trip back through toYmd returns the
// same YYYY-MM-DD regardless of server TZ.
//
// "Current week" is computed against UTC to line up with the rest of the
// calendar-date pipeline (toYmd reads via getUTC*; planDateString accepts
// YYYY-MM-DD canonicalized as UTC midnight). Using local-time getDay() here
// would skew the Sun-Sat boundary against the stored UTC midnights on
// non-UTC servers.

import type { Prisma, PrismaClient } from "@prisma/client";

export interface WeekRange {
  startDate: string;
  endDate: string;
}

const ymd = (d: Date): string => {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

export function currentWeekRange(now: Date = new Date()): WeekRange {
  const day = now.getUTCDay();
  const sunday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day),
  );
  const saturday = new Date(
    Date.UTC(
      sunday.getUTCFullYear(),
      sunday.getUTCMonth(),
      sunday.getUTCDate() + 6,
    ),
  );
  return { startDate: ymd(sunday), endDate: ymd(saturday) };
}

// WS7-6 (E) Block 1 REWORK — single-row date-range predicate. Retained as
// the cheap building block for didNewlyCoverNow (the analytics emit gate
// in POST /plans + PATCH /plans/:id). Bounds inclusive on both ends.
// Null-dated rows are never "covering". This predicate does NOT decide
// "is This Week's plan" by itself — see resolveThisWeekPlan for that.
//
// D-WS7-103: coverage is UTC-day-granular. Mobile sends date-only
// YYYY-MM-DD wire strings; Prisma round-trips those through
// `new Date("YYYY-MM-DD")` → UTC midnight per the JS spec. A raw instant
// compare reports endDate < now the moment `now` passes 00:00 UTC of the
// stored day, so a plan whose endDate is "today" wrongly evaluates as
// expired. Truncating all three to their UTC calendar day matches the
// canonical stored basis and the Sun–Sat bounds from currentWeekRange.
export function isInstanceActiveThisWeek(
  row: { startDate: Date | null; endDate: Date | null },
  now: Date = new Date(),
): boolean {
  if (row.startDate === null || row.endDate === null) {
    return false;
  }
  const toUtcDay = (d: Date): number =>
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const startDay = toUtcDay(row.startDate);
  const endDay = toUtcDay(row.endDate);
  const nowDay = toUtcDay(now);
  return startDay <= nowDay && nowDay <= endDay;
}

// WS7-6 (E) Block 1 — analytics predicate gating plan_activated_this_week.
// REWORK note: under Model 2 the spec phrasing is "fires when a plan newly
// becomes the resolver winner". Under the stamp invariant (every activation
// seam stamps activatedAt = now in the SAME write that sets dates covering
// now → freshest activatedAt → wins), "newly covers now" is equivalent to
// "newly became winner" for the row being written. We therefore keep the
// cheaper single-row date-range gate here; the equivalence is proven by
// a route-level test in plans.test.ts (the §27 equivalence proof) rather
// than asserted by reasoning alone. Same-state writes (covers → covers,
// past → past) do not emit; silent demotion (covers → not-covering) does
// not emit either.
export function didNewlyCoverNow(
  prev: { startDate: Date | null; endDate: Date | null },
  next: { startDate: Date | null; endDate: Date | null },
  now: Date = new Date(),
): boolean {
  return !isInstanceActiveThisWeek(prev, now)
    && isInstanceActiveThisWeek(next, now);
}

// WS7-6 (E) Block 1 REWORK — collection-level "This Week's plan" resolver
// under Model 2. Active-ness is COMPUTED, not stored. Caller scopes rows
// to ONE user (cross-user resolution is meaningless).
//
// Tiebreak rule:
//   1. eligible = rows where startDate AND endDate are non-null AND
//      now ∈ [startDate, endDate] (both bounds inclusive — matches the
//      Sun-Sat boundary stored as UTC-midnight YYYY-MM-DD).
//   2. winner = greatest activatedAt among eligible.
//   3. null activatedAt loses to any non-null activatedAt (auto-roll
//      property: a sole covering plan with null activatedAt still wins
//      because it's the only candidate, but loses any contested tiebreak).
//   4. Among rows with all-null activatedAt, fall back to greatest
//      createdAt (deterministic — avoids a coin-flip when seeded data or
//      pre-rework rows have no activation timestamp).
//   5. No eligible rows → null.
//
// Wire shape: every response site that ships isActiveThisWeek: boolean
// derives it as `row.id === resolveThisWeekPlan(userCoveringRows, now)?.id`.
// Decision #2 (Phase 0): mobile parsers see the boolean unchanged.
export interface CoveringCandidate {
  id: string;
  startDate: Date | null;
  endDate: Date | null;
  activatedAt: Date | null;
  createdAt: Date;
}

export function resolveThisWeekPlan<T extends CoveringCandidate>(
  rows: readonly T[],
  now: Date = new Date(),
): T | null {
  const eligible = rows.filter((r) => isInstanceActiveThisWeek(r, now));
  if (eligible.length === 0) return null;

  const withActivated = eligible.filter((r) => r.activatedAt !== null);
  if (withActivated.length > 0) {
    // Greatest activatedAt wins. activatedAt is non-null here.
    return withActivated.reduce((best, cur) =>
      (cur.activatedAt as Date).getTime() > (best.activatedAt as Date).getTime()
        ? cur
        : best,
    );
  }

  // All eligible rows have null activatedAt → fall back to newest createdAt.
  return eligible.reduce((best, cur) =>
    cur.createdAt.getTime() > best.createdAt.getTime() ? cur : best,
  );
}

// WS7-6 (E) Block 1 REWORK — convenience helper for wire sites that only
// need the winner's id. Issues ONE narrow indexed findMany over the user's
// covering subset selecting {id, startDate, endDate, activatedAt, createdAt}
// only — NOT full instance hydration. Returns null when no plan covers
// `now`. Backed by the (userId, startDate, endDate) index from the c1
// migration. Accepts either the outer PrismaClient or a TransactionClient
// (the DELETE /plans/:id W5 wasActive metadata path runs the resolver
// inside the soft-delete transaction for consistent "was winner at delete
// time" semantics).
export async function resolveThisWeekWinnerId(
  db: PrismaClient | Prisma.TransactionClient,
  userId: string,
  now: Date = new Date(),
): Promise<string | null> {
  // D-WS7-103: SQL pre-filter is UTC-day-granular. Storage canonicalizes
  // YYYY-MM-DD wire strings to UTC midnight, so the bounds compare like
  // with like — `endDate >= nowDay` admits a plan whose endDate is today.
  // Passing raw `now` would exclude end=today rows server-side any time
  // `now > 00:00 UTC` of that day, before the in-memory resolver
  // (isInstanceActiveThisWeek under the same UTC-day rule) ever sees them.
  // The in-memory pass still receives the un-truncated `now` so its own
  // day truncation runs against the actual moment, not the bound.
  const nowDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const candidates = await db.mealPlanInstance.findMany({
    where: {
      userId,
      isWizardDraft: false,
      startDate: { lte: nowDay, not: null },
      endDate: { gte: nowDay, not: null },
    },
    select: {
      id: true,
      startDate: true,
      endDate: true,
      activatedAt: true,
      createdAt: true,
    },
  });
  return resolveThisWeekPlan(candidates, now)?.id ?? null;
}

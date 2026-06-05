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

// WS7-6 (E) Block 1 — single canonical predicate for "is this plan in the
// current week?". Replaces the stored MealPlanInstance.isActiveThisWeek flag
// dropped in migration 20260605120000_ws7_6e_this_week_computed. All readers
// — GET /plans active summary, GET /plans/:id, GET /home, grocery list
// planInstance projection, instanceToListItem — call this; the wire shape
// still ships a boolean (decision #2) so mobile parsers do not change.
//
// Null-dated plans (use-template, wizard-draft, undated save) are never
// active by this predicate, which matches the DB-side EXCLUDE constraint's
// null-exempt WHERE clause: an undated plan cannot overlap and cannot
// auto-roll.
//
// Bounds are inclusive on both ends, mirroring the EXCLUDE constraint's
// `tsrange(..., '[]')` shape so the predicate and the constraint agree on
// edge instants.
export function isInstanceActiveThisWeek(
  row: { startDate: Date | null; endDate: Date | null },
  now: Date = new Date(),
): boolean {
  if (row.startDate === null || row.endDate === null) {
    return false;
  }
  return row.startDate.getTime() <= now.getTime()
    && now.getTime() <= row.endDate.getTime();
}

// WS7-6 (E) Block 1 c2 — analytics predicate for re-pointing the
// plan_activated_this_week event. Replaces the legacy "isActiveThisWeek
// flag flipped to true" trigger, which is meaningless after the column
// drop. Fires only on the not-current → current transition: a date set
// (POST /plans, wizard activate) or a date change (PATCH /plans/:id)
// that causes the plan to NEWLY cover `now`. Same-state writes
// (current → current re-date, not-current → not-current re-date) do
// not emit; the not-current → current transition does. Preserves the
// "user committed to a plan this week" analytics signal across the
// model change.
export function didNewlyCoverNow(
  prev: { startDate: Date | null; endDate: Date | null },
  next: { startDate: Date | null; endDate: Date | null },
  now: Date = new Date(),
): boolean {
  return !isInstanceActiveThisWeek(prev, now)
    && isInstanceActiveThisWeek(next, now);
}

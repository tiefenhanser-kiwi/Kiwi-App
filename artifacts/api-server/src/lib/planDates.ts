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

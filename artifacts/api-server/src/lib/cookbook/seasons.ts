// BOOK-1C1 (D-WS9-312) — the Cookbook's seasonal collections: GET /cookbook/seasons.
//
// A season is a PROMOTION, not a filter (Hans, Oct 14: "clearly a promotional
// fun feature that's not a permanent piece — we're not a thanksgiving app,
// we're a meal app"). It is config: a tag the catalog already carries, a label,
// a yearly date window in one time zone, and the course chips its collection
// view offers. Christmas is one more entry below, not new code.
//
// The window recurs every year: a season names month-days, and the route
// resolves them against the year it is in that zone. The response carries the
// resolved instants AND the instant the server evaluated them at (`asOf`), so a
// client decides visibility against the same clock the server used — which is
// what lets the dev-only preview below move both halves at once.

import type { PrismaClient } from "@prisma/client";

import { pageCookbook, readCookbookRows, type LightRow } from "./search";

export interface SeasonCourse {
  label: string;
  /** A Meal.tags value; the course chip filters the collection by it. */
  tag: string;
}

export interface SeasonConfig {
  /** The Meal.tags value that defines the collection. */
  tag: string;
  label: string;
  /** The band's headline and subline. */
  headline: string;
  /** "N recipes · <this>". */
  blurb: string;
  /** First day, "MM-DD", inclusive. */
  startsOn: string;
  /** Last day, "MM-DD", inclusive (the window ends at the next midnight). */
  endsOn: string;
  timeZone: string;
  courses: SeasonCourse[];
}

/**
 * The seasons. Thanksgiving: Nov 2 through the end of Nov 30, New York time.
 *
 * ⚠️ COURSE TAGS ARE WHAT THX-2G WRITES (scripts/thx2/thx2Core.ts COURSE_TAGS),
 * and only an ALTERNATE carries one; a feast, a Friday leftovers meal and the
 * Wednesday pizza night carry `thanksgiving` alone. So "Feasts" and "Leftovers"
 * name tags nothing writes yet (`thanksgiving-feast`, `thanksgiving-leftovers`):
 * the route counts every course, and the client hides a chip whose count is 0,
 * so they appear the day the generator tags them and never before. Cranberry
 * (`course-cranberry`) has no chip in the ruled row; those dishes show under
 * the unfiltered collection.
 */
export const SEASONS: readonly SeasonConfig[] = [
  {
    tag: "thanksgiving",
    label: "Thanksgiving",
    headline: "Thanksgiving feasts & dishes",
    blurb: "turkeys, sides, pies",
    startsOn: "11-02",
    endsOn: "11-30",
    timeZone: "America/New_York",
    courses: [
      { label: "Feasts", tag: "thanksgiving-feast" },
      { label: "Turkey", tag: "course-turkey" },
      { label: "Stuffing", tag: "course-stuffing" },
      { label: "Potatoes", tag: "course-potatoes" },
      { label: "Sides", tag: "course-sides" },
      { label: "Desserts", tag: "course-dessert" },
      { label: "Leftovers", tag: "thanksgiving-leftovers" },
    ],
  },
];

// ── the window ──────────────────────────────────────────────────────────────

/** The zone's UTC offset, in ms, at an instant (positive east of Greenwich). */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant a local midnight happens in a zone. */
export function zonedMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day);
  // Two passes: the offset at the guess, then at the corrected instant (they
  // differ only when a DST change falls between the two).
  const first = guess - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess - zoneOffsetMs(new Date(first), timeZone));
}

/** The year it is, in a zone, at an instant. */
function zonedYear(at: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(at));
}

export interface SeasonWindow {
  startsAt: Date;
  /** Exclusive: the midnight after `endsOn`. */
  endsAt: Date;
  /** The last day, "YYYY-MM-DD", for the "until Nov 30" copy. */
  endsOn: string;
}

/** This year's window (the year `at` falls in, in the season's zone). */
export function seasonWindow(season: SeasonConfig, at: Date): SeasonWindow {
  const year = zonedYear(at, season.timeZone);
  const [sm, sd] = season.startsOn.split("-").map(Number);
  const [em, ed] = season.endsOn.split("-").map(Number);
  const startsAt = zonedMidnight(year, sm, sd, season.timeZone);
  // The midnight after the last day: Date.UTC normalises day overflow, so
  // Nov 31 is Dec 1 and Dec 32 is Jan 1 of the next year.
  const next = new Date(Date.UTC(year, em - 1, ed + 1));
  const endsAt = zonedMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), season.timeZone);
  return { startsAt, endsAt, endsOn: `${year}-${season.endsOn}` };
}

export function isSeasonActive(season: SeasonConfig, at: Date): boolean {
  const w = seasonWindow(season, at);
  return at.getTime() >= w.startsAt.getTime() && at.getTime() < w.endsAt.getTime();
}

/**
 * The clock the route evaluates seasons at.
 *
 * `COOKBOOK_SEASON_PREVIEW_AT` (an ISO instant) moves it, so the band and the
 * collection can be looked at on a device in October. IGNORED IN PRODUCTION
 * (NODE_ENV=production): a promotional window is a fact about the calendar
 * there, and nobody should be able to open it early by setting an env var.
 */
export function seasonClock(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): Date {
  const preview = env.COOKBOOK_SEASON_PREVIEW_AT;
  if (env.NODE_ENV === "production" || !preview) return now;
  const at = new Date(preview);
  return Number.isNaN(at.getTime()) ? now : at;
}

// ── the response ────────────────────────────────────────────────────────────

export interface SeasonView {
  tag: string;
  label: string;
  headline: string;
  blurb: string;
  startsAt: string;
  endsAt: string;
  endsOn: string;
  /** Meals in the collection this user can see (allergen filter applied). */
  count: number;
  courses: Array<SeasonCourse & { count: number }>;
}

export interface SeasonsResult {
  /** The instant the windows were evaluated at. */
  asOf: string;
  seasons: SeasonView[];
}

const DEFAULT_PAGE = { sort: "popular" as const, limit: 1 };

/** Count a tag over the light rows exactly as a search for it would. */
function countTag(rows: LightRow[], tag: string): number {
  return pageCookbook(rows, { ...DEFAULT_PAGE, tag }).total;
}

/**
 * The active seasons, each with this user's count. A season outside its
 * window is not returned at all; one inside it with a count of 0 IS returned
 * (the client hides the band, but the collection is still addressable).
 */
export async function activeSeasons(
  prisma: Pick<PrismaClient, "meal" | "userPreferences">,
  userId: string,
  at: Date,
  seasons: readonly SeasonConfig[] = SEASONS,
): Promise<SeasonsResult> {
  const live = seasons.filter((s) => isSeasonActive(s, at));
  if (live.length === 0) return { asOf: at.toISOString(), seasons: [] };

  // One read, the same eligible set (and allergen filter) a search reads.
  const rows = await readCookbookRows(prisma, userId);
  return {
    asOf: at.toISOString(),
    seasons: live.map((s) => {
      const w = seasonWindow(s, at);
      const inSeason = rows.filter((r) => r.tags.some((t) => t.toLowerCase() === s.tag));
      return {
        tag: s.tag,
        label: s.label,
        headline: s.headline,
        blurb: s.blurb,
        startsAt: w.startsAt.toISOString(),
        endsAt: w.endsAt.toISOString(),
        endsOn: w.endsOn,
        count: inSeason.length,
        courses: s.courses.map((c) => ({ ...c, count: countTag(inSeason, c.tag) })),
      };
    }),
  };
}

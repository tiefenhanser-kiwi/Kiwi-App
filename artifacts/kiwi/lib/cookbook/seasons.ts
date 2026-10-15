// BOOK-1C1 (D-WS9-312) — the seasonal band's rules. Pure apart from the two
// storage calls at the bottom, which go through lib/storage.ts exactly as the
// billing banner dismissals do (lib/billing/dismissals.ts).
//
// A season is a promotion (Hans: "not a permanent piece — we're a meal app").
// The band shows only inside the window and only with something in it, and a
// dismissal is remembered per USER on this DEVICE: the key carries the user id
// (a shared tablet: one cook's ✕ does not hide it for another) and the season's
// last day (next year's Thanksgiving comes back on its own).

import { formatShortDate } from "@/lib/plans/planRowMeta";
import { loadJSON, saveJSON } from "@/lib/storage";

import type { Season } from "@/lib/api/cookbook";

/** Through lib/storage.ts, which prefixes "kiwi:". */
export const SEASON_DISMISSED_DEVICE_KEY = "cookbookSeasonsDismissed";

/**
 * Whether the band shows. The window is checked against the SERVER's clock
 * (`asOf`, sent with the seasons), not this device's: the server already
 * returned only live seasons, and comparing against the same instant it used
 * is what lets a dev preview clock move both halves together.
 */
export function seasonBandVisible(
  season: Pick<Season, "startsAt" | "endsAt" | "count">,
  asOf: string,
  dismissed: boolean,
): boolean {
  if (dismissed || season.count <= 0) return false;
  const at = Date.parse(asOf);
  const start = Date.parse(season.startsAt);
  const end = Date.parse(season.endsAt);
  if ([at, start, end].some(Number.isNaN)) return false;
  return at >= start && at < end;
}

/** "2026-11-30" → "Nov 30" (a calendar date, so no time zone is involved). */
export function shortDate(ymd: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? formatShortDate(ymd) : ymd;
}

/** The band's eyebrow: "SEASONAL · UNTIL NOV 30". */
export function seasonEyebrow(season: Pick<Season, "endsOn">): string {
  return `SEASONAL · UNTIL ${shortDate(season.endsOn).toUpperCase()}`;
}

/** The band's subline: "12 recipes · turkeys, sides, pies". */
export function seasonSubline(season: Pick<Season, "count" | "blurb">): string {
  return `${season.count} ${season.count === 1 ? "recipe" : "recipes"} · ${season.blurb}`;
}

/** The collection header's subline: "Seasonal collection · until Nov 30". */
export function collectionSubline(season: Pick<Season, "endsOn">): string {
  return `Seasonal collection · until ${shortDate(season.endsOn)}`;
}

/** The course chips worth showing: a course with nothing in it is hidden. */
export function visibleCourses<C extends { count: number }>(courses: readonly C[]): C[] {
  return courses.filter((c) => c.count > 0);
}

export function dismissalKey(userId: string, season: Pick<Season, "tag" | "endsOn">): string {
  return `${userId}|${season.tag}|${season.endsOn}`;
}

/** Exported for the test: garbage reads as nothing dismissed. */
export function parseSeasonDismissals(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((x): x is string => typeof x === "string"));
}

export async function loadSeasonDismissals(): Promise<Set<string>> {
  return parseSeasonDismissals(await loadJSON<unknown>(SEASON_DISMISSED_DEVICE_KEY, []));
}

export async function dismissSeason(
  key: string,
  current: ReadonlySet<string>,
): Promise<Set<string>> {
  const next = new Set(current);
  next.add(key);
  await saveJSON(SEASON_DISMISSED_DEVICE_KEY, [...next]);
  return next;
}

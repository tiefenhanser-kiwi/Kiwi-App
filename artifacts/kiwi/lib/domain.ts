// Pure domain utilities for the Kiwi client.
// Previously colocated with mock recipe data in mockData.ts.

import type { DayAssignment, DayKey, DayOfWeek } from "./types";

export const DAYS: DayKey[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** PRD §2.4 Sunday-Saturday day-strip order, used by Plan Review rows. */
export const DAY_OF_WEEK_ORDER: DayOfWeek[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * Build a 7-pill day strip with at most one pill marked assigned.
 * Pass `null` to produce an empty (all-unassigned) strip — used when
 * a meal lands in the unscheduled cluster.
 */
export function buildDayStrip(
  assignedDay: DayOfWeek | null,
): DayAssignment[] {
  return DAY_OF_WEEK_ORDER.map((day) => ({
    day,
    isAssigned: assignedDay === day,
  }));
}

export function getMondayISO(): string {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

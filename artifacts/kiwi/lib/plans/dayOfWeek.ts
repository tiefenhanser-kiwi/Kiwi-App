// WS7-3 C4 c1 — pure narrowing of server-supplied day-of-week strings to the
// typed DayOfWeek union. Used by the Plan Review adapter to decide whether a
// PlanDetailItem lands in the scheduled or unscheduled cluster.
//
// The server stores `assignedDayOfWeek` as a nullable string column; only the
// seven canonical labels (Sunday-Saturday) are valid. Anything else (legacy
// data, accidental lowercasing) narrows to null and falls through to the
// unscheduled cluster — same UX as no assignment.

import type { DayOfWeek } from "@/lib/types";

export const DAY_OF_WEEK_VALUES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const satisfies readonly DayOfWeek[];

export function toDayOfWeek(value: string | null | undefined): DayOfWeek | null {
  if (!value) return null;
  return (DAY_OF_WEEK_VALUES as readonly string[]).includes(value)
    ? (value as DayOfWeek)
    : null;
}

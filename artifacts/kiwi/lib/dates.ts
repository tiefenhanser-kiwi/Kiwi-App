// WS7-6 (E) Block 2 §2 — shared Sunday-based date helpers.
//
// Extracted from PlanDateRangeEditor.tsx so the chip / activation paths and
// any future caller can compute "this week's Sunday" without forking the
// local-time-safe implementation. NOTE: deliberately routes around the
// TZ-buggy getMondayISO() in lib/domain.ts (D-WS7-102) — the wizard /
// PlanDateRangeEditor pair already settled on Sunday-based weeks.

/**
 * Format a Date as YYYY-MM-DD using LOCAL time (not UTC).
 * toISOString() converts to UTC, which can shift the date by one day
 * depending on local timezone offset and time of day — making "this
 * Sunday" land on Saturday in the rendered string.
 */
export function toLocalDateString(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Parse "YYYY-MM-DD" as a LOCAL-time Date. JS's default `new Date(iso)`
 * treats bare-date strings as UTC midnight, which lands on the previous
 * local day for users west of UTC and breaks downstream getDate() /
 * toLocaleDateString() calls.
 */
export function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function computeThisWeekStart(): string {
  const today = new Date();
  const day = today.getDay(); // 0 = Sunday
  const start = new Date(today);
  start.setDate(today.getDate() - day);
  return toLocalDateString(start);
}

export function computeNextWeekStart(): string {
  const today = new Date();
  const day = today.getDay();
  const start = new Date(today);
  start.setDate(today.getDate() + (7 - day));
  return toLocalDateString(start);
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d + days);
  return toLocalDateString(date);
}

// WS7-4-D c15 — server-canonical plan-item ordering for client-facing reads.
//
// Locked spec (Hans 2026-05-27 device-test, PRD §8.3.6 redline at
// WS7-4-D close):
//   * Assigned items sort by assignedDayOfWeek Sunday → Saturday.
//   * Unscheduled items (assignedDayOfWeek === null) pin to the bottom.
//   * Tiebreaker within the same day (and within the unscheduled cluster):
//     positionIndex ASC — preserves explicit user reordering.
//
// Applied in:
//   * GET /plans/:id          — Plan Review composite read.
//   * GET /plans/templates/:id — Template detail for the Use Plan preview.
//
// Both paths still fetch with `orderBy: { positionIndex: "asc" }` so the
// stable-sort tiebreaker has a predictable starting order; the comparator
// below then reorders by day. The dataset is small (PRD typical 5-15 items
// per plan), so an O(n log n) JS sort is the right tradeoff over Prisma raw
// SQL with CASE WHEN day mapping.

const DAY_ORDINAL: Record<string, number> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

function dayOrdinal(day: string | null): number {
  if (day === null) return 7;
  const idx = DAY_ORDINAL[day];
  // Unknown day strings (shouldn't happen — schema constrains the column,
  // and the mobile DayOfWeek union matches) sort with the unscheduled
  // cluster rather than throwing.
  return idx === undefined ? 7 : idx;
}

export interface SortableItem {
  assignedDayOfWeek: string | null;
  positionIndex: number;
}

/**
 * Sort plan items canonically: Sun → Sat by assignedDayOfWeek, then
 * positionIndex ASC. Items with `assignedDayOfWeek === null` group at the
 * bottom in positionIndex order. Returns a new array; does not mutate input.
 */
export function sortPlanItemsCanonical<T extends SortableItem>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const da = dayOrdinal(a.assignedDayOfWeek);
    const db = dayOrdinal(b.assignedDayOfWeek);
    if (da !== db) return da - db;
    return a.positionIndex - b.positionIndex;
  });
}

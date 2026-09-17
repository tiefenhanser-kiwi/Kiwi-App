// WS9 Plan-flow redesign (D-WS9-191) Block 3 Part B — BUG-290.
//
// The picks-plan name is deterministic per user per week ("Hans's meals, week
// of Sep 16"), so two plans built in one week were byte-identical in My Plans.
// The server now suffixes the second " (2)"; this line makes the row
// self-distinguishing regardless: "5 meals · Sep 16 – Sep 21". Instance rows
// only — a catalog template has no dates and no count of its own.

import type { PlanListItem } from "@/lib/api/plans";
import { parseLocalDate } from "@/lib/dates";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "Sep 16" from a YYYY-MM-DD calendar date (local, no TZ shift). */
export function formatShortDate(ymd: string): string {
  const d = parseLocalDate(ymd);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** "Sep 16 – Sep 21", or "Sep 16" when the range is one day; null without both ends. */
export function formatPlanDateRange(start: string | null | undefined, end: string | null | undefined): string | null {
  if (!start || !end) return null;
  const s = formatShortDate(start);
  if (start === end) return s;
  return `${s} – ${formatShortDate(end)}`;
}

/**
 * The My Plans row's second line: the meal count and the date range, joined by
 * " · ", whichever of the two the row has. Null when it has neither (a
 * template row, or an instance the server sent without a count or dates).
 */
export function planRowMeta(
  plan: Pick<PlanListItem, "source" | "startDate" | "endDate"> & { mealCount?: number | null },
): string | null {
  if (plan.source !== "instance") return null;
  const parts: string[] = [];
  const n = plan.mealCount;
  if (typeof n === "number" && Number.isFinite(n) && n >= 0) {
    parts.push(`${n} ${n === 1 ? "meal" : "meals"}`);
  }
  const range = formatPlanDateRange(plan.startDate, plan.endDate);
  if (range) parts.push(range);
  return parts.length > 0 ? parts.join(" · ") : null;
}

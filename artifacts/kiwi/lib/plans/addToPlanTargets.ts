// BOOK-1C1 (D-WS9-312) — which plans "Add to a plan" offers, and which days.
//
// THE LIST IS LIVE PLANS ONLY: the active plan and the upcoming ones. A
// composted plan answers 409 plan_closed (BUG-411) and GET /plans my_plans
// already drops it (isArchived); a PAST plan still takes a meal server-side,
// but nobody adding a meal from the Cookbook means last month's plan, so it is
// not offered. An UNDATED plan (a "Save for Later" draft) is not active or
// upcoming either, and has no days to choose from, so it is not offered — the
// sheet's "Create a new plan" card is the path for a meal without a week.
//
// The day step lists the plan's own days (a 5-day plan offers 5), in order,
// one per weekday: POST /plans/:id/items takes `assignedDayOfWeek`, a weekday
// NAME, so a plan longer than a week cannot address its second Monday and the
// step does not pretend it can.

import type { PlanListItem } from "@/lib/api/plans";
import { addDays, parseLocalDate } from "@/lib/dates";
import { formatShortDate } from "@/lib/plans/planRowMeta";
import type { DayOfWeek } from "@/lib/types";

const WEEKDAYS: readonly DayOfWeek[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

type PlanDates = Pick<PlanListItem, "source" | "startDate" | "endDate">;

/** Active or upcoming: an instance whose last day is today or later. */
export function isLivePlan(plan: PlanDates, todayYmd: string): boolean {
  if (plan.source !== "instance") return false;
  const last = plan.endDate ?? plan.startDate;
  if (!last) return false;
  return last >= todayYmd;
}

/** The live plans, soonest first (the active plan leads). */
export function livePlans<P extends PlanDates>(plans: readonly P[], todayYmd: string): P[] {
  return plans
    .filter((p) => isLivePlan(p, todayYmd))
    .sort((a, b) => (a.startDate ?? "").localeCompare(b.startDate ?? ""));
}

export interface PlanDayOption {
  day: DayOfWeek;
  /** "YYYY-MM-DD" of the first date in the plan on this weekday. */
  date: string;
  /** "Monday · Nov 3". */
  label: string;
}

/** The plan's days, in order, one per weekday (at most seven). */
export function planDayOptions(plan: Pick<PlanListItem, "startDate" | "endDate">): PlanDayOption[] {
  if (!plan.startDate) return [];
  const end = plan.endDate ?? plan.startDate;
  const out: PlanDayOption[] = [];
  const seen = new Set<DayOfWeek>();
  for (let date = plan.startDate; date <= end && out.length < 7; date = addDays(date, 1)) {
    const day = WEEKDAYS[parseLocalDate(date).getDay()];
    if (seen.has(day)) continue;
    seen.add(day);
    out.push({ day, date, label: `${day} · ${formatShortDate(date)}` });
  }
  return out;
}

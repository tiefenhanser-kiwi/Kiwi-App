// BOOK-1C1 (D-WS9-312) — which plans "Add to a plan" offers, and which days.
//
// BOOK-1C2 — THE LIST IS THE USER'S LIVE PLANS: the active plan, the upcoming
// ones, AND the undated ones. BOOK-1C1 left undated plans out ("no week, no
// days"), and that is exactly the plan the sheet's own "Create a new plan"
// makes: POST /plans with no dates is born `draft`, startDate/endDate null.
// Hans made one from the + flow, saw it in Plans, and on the next + it was not
// in "Pick an existing plan" — on dev it was "My plan this week 1016": draft,
// no dates. The rule now:
//   • an instance (a template is never a target);
//   • not composted — GET /plans my_plans already drops isArchived, and a
//     composted plan answers 409 plan_closed (BUG-411) anyway;
//   • dated: its last day is today or later (active or upcoming). A PAST plan
//     still takes a meal server-side, but nobody adding a meal from the
//     Cookbook means last month's plan, so it is not offered;
//   • undated: offered (a plan without a week yet, e.g. the one + just made).
// Status is not consulted: "draft" is every POST /plans plan's status, dated
// or not, so it says nothing about whether the user is still planning it.
//
// The day step lists the plan's own days (a 5-day plan offers 5), in order,
// one per weekday: POST /plans/:id/items takes `assignedDayOfWeek`, a weekday
// NAME, so a plan longer than a week cannot address its second Monday and the
// step does not pretend it can. An undated plan offers the seven weekday names
// without dates (the server stores the weekday; it maps when the plan gets
// its week).

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

/** Active or upcoming: a dated instance whose last day is today or later. */
export function isLivePlan(plan: PlanDates, todayYmd: string): boolean {
  if (plan.source !== "instance") return false;
  const last = plan.endDate ?? plan.startDate;
  if (!last) return false;
  return last >= todayYmd;
}

/** An instance with no week yet. */
export function isUndatedPlan(plan: PlanDates): boolean {
  return plan.source === "instance" && !plan.startDate && !plan.endDate;
}

/** The live dated plans, soonest first (the active plan leads). */
export function livePlans<P extends PlanDates>(plans: readonly P[], todayYmd: string): P[] {
  return plans
    .filter((p) => isLivePlan(p, todayYmd))
    .sort((a, b) => (a.startDate ?? "").localeCompare(b.startDate ?? ""));
}

/**
 * What "Pick an existing plan" lists: the live dated plans soonest first, then
 * the undated ones in the order the list arrived (GET /plans my_plans is
 * newest first, so a plan just made leads them).
 */
export function addToPlanTargets<P extends PlanDates>(plans: readonly P[], todayYmd: string): P[] {
  return [...livePlans(plans, todayYmd), ...plans.filter(isUndatedPlan)];
}

export interface PlanDayOption {
  day: DayOfWeek;
  /** "YYYY-MM-DD" of the first date in the plan on this weekday; null on an undated plan. */
  date: string | null;
  /** "Monday · Nov 3"; "Monday" on an undated plan. */
  label: string;
}

/** The plan's days, in order, one per weekday (at most seven). */
export function planDayOptions(plan: Pick<PlanListItem, "startDate" | "endDate">): PlanDayOption[] {
  if (!plan.startDate) {
    if (plan.endDate) return [];
    return WEEKDAYS.map((day) => ({ day, date: null, label: day }));
  }
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

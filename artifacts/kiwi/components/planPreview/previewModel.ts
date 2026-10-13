// PREVIEW-1 — the featured-plan preview's view model. Pure: TemplateDetail in,
// what the sheet renders out. Lives beside the sheet (not in lib/plans) because
// it is the preview's own reading of a template, not a shared plan rule.
//
// ORDER — mirrors Plan Review, which does NOT sort on the client: the server
// hands both GET /plans/:id and GET /plans/templates/:id through
// sortPlanItemsCanonical (api-server src/lib/planItemSort.ts), Sun → Sat then
// positionIndex, null days last. Re-sorting here with the same rule keeps the
// preview honest even if a template ever arrives unsorted. Unscheduled items
// split into their own group, newest-first, exactly as Plan Review's
// sortUnscheduledNewestFirst renders that bucket.
//
// Items whose meal is null (archived) are dropped, as planDetailToReviewPlan
// drops them — a preview row for a meal that will not be in the plan is a lie.

import type { MealDetail } from "@/lib/api/meals";
import type { TemplateDetail } from "@/lib/api/plans";
import { formatMealTime } from "@/lib/mealTimeLine";
import { DAY_OF_WEEK_VALUES, toDayOfWeek } from "@/lib/plans/dayOfWeek";
import type { DayOfWeek } from "@/lib/types";

export interface PreviewMealRow {
  itemId: string;
  mealId: string;
  /** Full day name ("Monday"), or null for an unscheduled item. */
  day: DayOfWeek | null;
  /** The meal's photo url, or null → TreatedImage's warm placeholder. */
  imageUrl: string | null;
  /** The meal's derived total time (server `minutes` = estimatedTimeMinutes). */
  minutes: number;
  /** "Easy · 30 min · serves 4" — Plan Review's row meta, same parts. */
  metaLine: string;
  /** The full meal, for the in-sheet meal view. */
  meal: MealDetail;
}

export interface PlanPreviewModel {
  /** "5 dinners · Mon–Fri · avg 34 min" — parts omitted when unknown. */
  metaLine: string;
  scheduled: PreviewMealRow[];
  unscheduled: PreviewMealRow[];
}

const DAY_ABBR: Record<DayOfWeek, string> = {
  Sunday: "Sun",
  Monday: "Mon",
  Tuesday: "Tue",
  Wednesday: "Wed",
  Thursday: "Thu",
  Friday: "Fri",
  Saturday: "Sat",
};

function dayOrdinal(day: DayOfWeek | null): number {
  return day === null ? DAY_OF_WEEK_VALUES.length : DAY_OF_WEEK_VALUES.indexOf(day);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Plan Review's row meta (reviewPlanAdapter formatMealDetailMetaLine), same
 *  parts and the same shared time formatter. A template has no servings
 *  override, so the meal's own servings is the effective value. */
export function previewRowMetaLine(meal: MealDetail): string {
  const parts = [
    meal.difficulty ? capitalize(meal.difficulty) : null,
    formatMealTime(meal.minutes, meal.activeTimeMinutes),
    `serves ${meal.servings}`,
  ];
  return parts.filter((p): p is string => !!p).join(" · ");
}

/** "Mon–Fri" for a contiguous run, "Mon, Wed, Fri" otherwise, "Mon" for one
 *  day, null for none. Input in any order; duplicates collapse. */
export function formatDaySpan(days: readonly DayOfWeek[]): string | null {
  const ordinals = [...new Set(days.map(dayOrdinal))].sort((a, b) => a - b);
  if (ordinals.length === 0) return null;
  const abbr = (o: number) => DAY_ABBR[DAY_OF_WEEK_VALUES[o]];
  if (ordinals.length === 1) return abbr(ordinals[0]);
  const first = ordinals[0];
  const last = ordinals[ordinals.length - 1];
  if (last - first === ordinals.length - 1) return `${abbr(first)}–${abbr(last)}`;
  return ordinals.map(abbr).join(", ");
}

export function buildPlanPreview(template: TemplateDetail): PlanPreviewModel {
  const live = template.items.filter(
    (item): item is typeof item & { meal: MealDetail } => item.meal !== null,
  );

  const rows = live.map((item) => ({
    positionIndex: item.positionIndex,
    allDinner: item.isDinner && !item.isBreakfast && !item.isLunch,
    row: {
      itemId: item.id,
      mealId: item.mealId,
      day: toDayOfWeek(item.assignedDayOfWeek),
      imageUrl: item.meal.image ?? null,
      minutes: item.meal.minutes,
      metaLine: previewRowMetaLine(item.meal),
      meal: item.meal,
    } satisfies PreviewMealRow,
  }));

  const scheduled = rows
    .filter((r) => r.row.day !== null)
    .sort(
      (a, b) =>
        dayOrdinal(a.row.day) - dayOrdinal(b.row.day) ||
        a.positionIndex - b.positionIndex,
    )
    .map((r) => r.row);
  const unscheduled = rows
    .filter((r) => r.row.day === null)
    .sort((a, b) => b.positionIndex - a.positionIndex)
    .map((r) => r.row);

  const count = rows.length;
  const noun =
    count > 0 && rows.every((r) => r.allDinner)
      ? count === 1 ? "dinner" : "dinners"
      : count === 1 ? "meal" : "meals";
  const timed = rows.map((r) => r.row.minutes).filter((m) => m > 0);
  const avg =
    timed.length > 0
      ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length)
      : null;

  const metaLine = [
    `${count} ${noun}`,
    formatDaySpan(scheduled.map((r) => r.day as DayOfWeek)),
    avg !== null ? `avg ${avg} min` : null,
  ]
    .filter((p): p is string => !!p)
    .join(" · ");

  return { metaLine, scheduled, unscheduled };
}

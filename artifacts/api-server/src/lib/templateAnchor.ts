// THX-2S (D-WS9-311) — dated templates: the Thanksgiving week.
//
// A template with an `anchorDate` is built around one day (the Thursday feast).
// Adopted ON OR BEFORE that day, the copy is dated in the anchor's week by each
// item's own `assignedDayOfWeek`: Monday → anchor − 3, Friday → anchor + 1, and
// so on. The template's weekday order is the plan's order. There is NO
// perishability re-sort (planDayAssignment.ts) — the feast is Thursday because
// the template says Thursday, not because of what it contains.
//
// After the anchor day the template is outside its window, and adoption
// behaves exactly as an unanchored template (undated copy; the caller's usual
// dating rules). Taking it off the rail is the featuring window's job
// (featuredEndDate, set by scripts/featured/applyFeaturedTemplates.ts, which
// refuses an anchored template whose window outlives its anchor).
//
// "The anchor's week" = the Sunday–Saturday week containing it, the same
// Sunday-indexed DAY_NAMES vocabulary MealPlanItem.assignedDayOfWeek uses.
// Dates are UTC calendar days at midnight (lib/planDates.ts convention).

import type { Prisma } from "@prisma/client";

import { DAY_NAMES, addUtcDays } from "./planDayAssignment";

function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Adopted on or before the anchor day (both as UTC calendar days). */
export function isWithinAnchorWindow(anchorDate: Date, today: Date): boolean {
  return utcDay(today).getTime() <= utcDay(anchorDate).getTime();
}

const DAY_INDEX = new Map<string, number>(
  DAY_NAMES.map((name, i) => [name.toLowerCase(), i]),
);

/** The date of `dayName` in the anchor's Sunday–Saturday week; null for no day. */
export function dateInAnchorWeek(anchorDate: Date, dayName: string | null): Date | null {
  if (!dayName) return null;
  const idx = DAY_INDEX.get(dayName.trim().toLowerCase());
  if (idx === undefined) return null;
  const anchor = utcDay(anchorDate);
  return addUtcDays(anchor, idx - anchor.getUTCDay());
}

export interface AnchoredDating {
  /** First … last dated item (Monday 23 … Friday 27 for Thanksgiving 2026). */
  window: { startDate: Date; endDate: Date };
  /** One entry per input item, in input order; null = the item has no day. */
  itemDates: (Date | null)[];
}

/**
 * The dating an anchored template gives a copy adopted `today`, or null when it
 * gives none: no anchor, past the anchor, or no item carries a day.
 */
export function anchoredDatingFor(
  template: {
    anchorDate: Date | null;
    items: { assignedDayOfWeek: string | null }[];
  },
  today: Date,
): AnchoredDating | null {
  const anchor = template.anchorDate;
  if (!anchor || !isWithinAnchorWindow(anchor, today)) return null;
  const itemDates = template.items.map((it) => dateInAnchorWeek(anchor, it.assignedDayOfWeek));
  const dated = itemDates
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());
  if (dated.length === 0) return null;
  return {
    window: { startDate: dated[0], endDate: dated[dated.length - 1] },
    itemDates,
  };
}

/**
 * The "Cook This Week" hold: is this plan still sitting on the dates its
 * anchored template gave it, inside the window? Then activating it keeps those
 * dates (and the template's day order) instead of re-assigning from tomorrow.
 *
 * Once the user moves the dates, the stored range no longer equals the anchored
 * window and this returns false — their edit wins, and every later action gets
 * today's behaviour.
 */
export async function isHeldByAnchor(
  tx: Pick<Prisma.TransactionClient, "mealPlanTemplate">,
  plan: {
    mealPlanTemplateId: string | null | undefined;
    startDate: Date | null;
    endDate: Date | null;
  },
  today: Date,
): Promise<boolean> {
  if (!plan.mealPlanTemplateId || !plan.startDate || !plan.endDate) return false;
  const template = await tx.mealPlanTemplate.findUnique({
    where: { id: plan.mealPlanTemplateId },
    select: {
      anchorDate: true,
      items: { orderBy: { positionIndex: "asc" }, select: { assignedDayOfWeek: true } },
    },
  });
  if (!template) return false;
  const dating = anchoredDatingFor(template, today);
  if (!dating) return false;
  return (
    utcDay(plan.startDate).getTime() === dating.window.startDate.getTime() &&
    utcDay(plan.endDate).getTime() === dating.window.endDate.getTime()
  );
}

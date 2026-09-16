// WS9 Redesign Arc post-pass Part D ([WS9-arc-PS-D]) — the name of a plan
// built from picks. Ruled (Hans): deterministic, NO AI call — an AI-authored
// name is a later block's job. "{first name}'s meals, week of {start date}"
// from the user's stored first name and the plan's startDate; with no name
// stored, "Meals for the week of {start date}".
//
// The date reads as a short month + day ("Sep 16"), UTC — plan dates are
// stored as UTC midnight (lib/planDates.ts), so the calendar day is exact.

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** The client's sentinel for "I did not name this" — treated as no title. */
export const UNNAMED_PICKS_TITLE = "Your picks";

export function formatWeekOfDate(startDate: Date): string {
  return `${MONTHS[startDate.getUTCMonth()]} ${startDate.getUTCDate()}`;
}

export function picksPlanTitle(
  firstName: string | null | undefined,
  startDate: Date,
): string {
  const name = firstName?.trim() ?? "";
  const weekOf = formatWeekOfDate(startDate);
  return name.length > 0
    ? `${name}'s meals, week of ${weekOf}`
    : `Meals for the week of ${weekOf}`;
}

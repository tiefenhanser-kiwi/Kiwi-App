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

// ── BUG-290 — two plans, one name ────────────────────────────────────────
//
// The name above is deterministic per user per week, so EVERY plan built in
// the same week was byte-identical in My Plans (Hans: "I have a duplicate plan
// for Hans's meals, week of Sep 16. one was active, the other wasn't"). The
// probe showed two legitimate builds 137s apart on different templates with
// different meal sets — not a double-submit, so no idempotency guard: the
// defect is that two real plans were indistinguishable. Fix: when the user
// already has a non-archived plan whose STORED title (titleOverride ??
// template.title — what the UI shows) equals the base, append " (2)", then
// " (3)", … Deterministic, no AI call, no schema change. A simultaneous
// double-build can still tie — accepted pre-launch, no locking.

/** The stored title of a plan row as My Plans renders it. */
export function storedPlanTitle(row: {
  titleOverride: string | null;
  template?: { title: string } | null;
}): string {
  return row.titleOverride ?? row.template?.title ?? "";
}

/**
 * `base` when it is free; else the first of `base (2)`, `base (3)`, … not in
 * `taken`. Never `base (1)`. Pure — the caller supplies the titles in play.
 */
export function disambiguatePlanTitle(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  let n = 2;
  while (set.has(`${base} (${n})`)) n += 1;
  return `${base} (${n})`;
}

/** The minimum of a Prisma client this helper reads through. */
export interface PlanTitleReader {
  mealPlanInstance: {
    findMany(args: {
      where: { userId: string; isArchived: boolean; isWizardDraft: boolean };
      select: { titleOverride: true; template: { select: { title: true } } };
    }): Promise<Array<{ titleOverride: string | null; template: { title: string } | null }>>;
  };
}

/**
 * The user's stored titles that a new plan must not repeat: every non-archived
 * real plan (wizard drafts are not in My Plans and never consume a number).
 */
export async function loadTakenPlanTitles(db: PlanTitleReader, userId: string): Promise<Set<string>> {
  const rows = await db.mealPlanInstance.findMany({
    where: { userId, isArchived: false, isWizardDraft: false },
    select: { titleOverride: true, template: { select: { title: true } } },
  });
  return new Set(rows.map(storedPlanTitle).filter((t) => t.length > 0));
}

/** `base` made unique among the user's live plans — the one call site's helper. */
export async function uniquePlanTitle(db: PlanTitleReader, userId: string, base: string): Promise<string> {
  return disambiguatePlanTitle(base, await loadTakenPlanTitles(db, userId));
}

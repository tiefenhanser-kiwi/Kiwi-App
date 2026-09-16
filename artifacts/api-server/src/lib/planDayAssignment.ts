// WS9 Redesign Arc Block 1 — D-WS7-213 half 1: deterministic day assignment
// for a freshly created plan. Hans (July 18 + September 4, 2026):
//
//   "perishability first (fish and short-shelf-life early), shelf-stable/canned
//    later, easiest last; the first day defaults to TOMORROW — you have to shop
//    before you can cook."
//
// NOT AI. A pure function over what the meal graph already stores:
//   • perishability from the dishes' ingredients' `Ingredient.category`
//     (the write-once inferCategory vocabulary — see PERISHABILITY_BY_CATEGORY),
//     the MOST perishable ingredient governing the meal (a fresh fish beside a
//     bag of rice is a fish dinner);
//   • effort from the DERIVED `activeTimeMinutes` (D-WS9-235), never an
//     authored claim; a never-derived meal falls back to its stored total;
//   • difficulty as the effort tie-break.
//
// Sort = perishability tier ascending, then HARDER FIRST within a tier (so the
// easiest meal of the least-perishable tier lands on the last day), then
// difficulty fancy→easy, then the caller's order. "Easiest last" is therefore
// enforced within the perishability order, not across it: the ruling names
// perishability first, and a fresh-fish dinner does not move to day 7 for
// being quick.
//
// ⚠️ `Ingredient.category` has ONE tier for all fresh protein — "Protein"
// covers seafood AND meat/poultry (ingredientResolve.ts CATEGORY_RULES), and
// `subcategory` is never written (0 of 1,773 rows on 2026-09-16). So "fish
// before chicken" is NOT expressible from the category alone.
//
// Post-pass Part B (BUG-280, [WS9-arc-PS-B]) — fish first, ruled: the FRESH
// tier is split in two, SEAFOOD ahead of other fresh protein and produce, by a
// NAMED word list over the ingredient names (SEAFOOD_INGREDIENT_TERMS below).
// A name list is sanctioned HERE because the blast radius is one day of
// ordering, not a health claim — the D-WS9-211 ban on name-based allergen
// classification stands and this licence must not be generalised. The check
// runs on the NAME regardless of `category` because inferCategory mis-stamps
// some seafood (ahi tuna steaks → Canned, mahi-mahi / flounder fillets →
// Pantry). Forward-compatible: when `Ingredient.subcategory` is ever stamped,
// read it in loadAssignableMeals and let the list become its FALLBACK.
//
// Timezone: dates follow lib/planDates.ts — UTC calendar days, stored as UTC
// midnight, day names from getUTCDay(). (routes/home.ts resolves "today's
// meal" by LOCAL getDay(); on a non-UTC server the two can disagree for a few
// hours around midnight — flagged.)
//
// WS9 Redesign Arc Block 2 (Part D, D-WS7-213 amendment 2) — "today" is the
// CLIENT's local calendar day when it sends one (`localDate: "YYYY-MM-DD"`),
// else the server's UTC day. Block 1 assigned in UTC days only, so a plan made
// Saturday 9:26 PM ET (01:26Z Sunday) put its first meal on MONDAY, not
// Sunday. The rule set the routes apply (Hans, 2026-09-16):
//   (a) built or activated FOR NOW (/plans/from-meals, /activate, the "Cook
//       This Week" PATCH): the window opens TODAY (startDate = today), the
//       first meal is TOMORROW, endDate = the last assigned day;
//   (b) a start date the user CHOSE (the date editor): the window opens on
//       that day and the first meal is THAT day (they will shop before it);
//   (c) any change to a plan's date range RE-RUNS assignPlanDays from the new
//       start — same function, same order, only the dates move; a range
//       shorter than the meal count leaves the overflow unassigned, never an
//       error;
//   (d) /save and "Use again" are unchanged — a saved-for-later plan gets its
//       days when it is activated or dated.

import type { Prisma } from "@prisma/client";

export type PerishabilityTier = 0 | 1 | 2 | 3;

/**
 * `Ingredient.category` → perishability tier. The named table Hans asked for,
 * with the Part B split at the top:
 *   0 = SEAFOOD (earliest): fresh fish & shellfish — by NAME, see
 *                           SEAFOOD_INGREDIENT_TERMS (no category says it)
 *   1 = FRESH:              other fresh meat & poultry ("Protein"), fresh produce
 *   2 = CHILLED (middle):   dairy & eggs
 *   3 = STABLE  (latest):   pantry, canned, frozen, dried, bakery, snacks,
 *                           household — and anything unknown.
 */
export const PERISHABILITY_SEAFOOD: PerishabilityTier = 0;
export const PERISHABILITY_BY_CATEGORY: Readonly<Record<string, PerishabilityTier>> = {
  Protein: 1,
  Produce: 1,
  Dairy: 2,
  Bakery: 3,
  Pantry: 3,
  Canned: 3,
  Frozen: 3,
  Snacks: 3,
  Household: 3,
};
export const PERISHABILITY_UNKNOWN: PerishabilityTier = 3;

/**
 * Part B (BUG-280) — the seafood name list. Matched as WHOLE WORDS (a term's
 * words must appear as a contiguous run of the ingredient name's words, so
 * "sea bass" hits "chilean sea bass" and "cod" does not hit "codfish cakes"
 * nor "coddled"). Seeded per the ruling plus "fish" and "prawn" (generic
 * names an import writes). ⚠️ NOT an allergen classifier — see the header.
 */
export const SEAFOOD_INGREDIENT_TERMS: readonly string[] = [
  "salmon",
  "shrimp",
  "prawn",
  "prawns",
  "cod",
  "tuna",
  "tilapia",
  "halibut",
  "trout",
  "scallop",
  "scallops",
  "mussel",
  "mussels",
  "clam",
  "clams",
  "crab",
  "lobster",
  "oyster",
  "oysters",
  "snapper",
  "sea bass",
  "swordfish",
  "mahi",
  "sole",
  "flounder",
  "squid",
  "calamari",
  "octopus",
  "fish",
];

/**
 * Names that carry a seafood word but are flavourings, shelf-stable or frozen
 * goods, or something else entirely — exactly what a naive substring match
 * gets wrong. Word-boundary matched like the terms. Pinned by tests (the six
 * ruled negatives) and seeded from the live ingredient table (oyster
 * mushrooms, clam juice, crab boil seasoning, albacore tuna "in water").
 */
export const SEAFOOD_EXCLUSION_TERMS: readonly string[] = [
  "sauce",
  "paste",
  "juice",
  "base",
  "seasoning",
  "crackers",
  "mushroom",
  "mushrooms",
  "imitation",
  "canned",
  "tinned",
  "in water",
  "in oil",
  "in olive oil",
  "in brine",
  "dried",
  "frozen",
  "sticks",
  "powder",
  "stock",
  "broth",
  "chowder",
  "extract",
  "flakes",
  "smoked",
];

function nameWords(name: string): string[] {
  return name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 0);
}

function hasWordRun(words: string[], term: string): boolean {
  const tw = nameWords(term);
  if (tw.length === 0) return false;
  for (let i = 0; i + tw.length <= words.length; i++) {
    let ok = true;
    for (let j = 0; j < tw.length; j++) {
      if (words[i + j] !== tw[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** Is this ingredient NAME fresh seafood for day-ordering purposes? */
export function isSeafoodIngredientName(name: string): boolean {
  const words = nameWords(name);
  if (!SEAFOOD_INGREDIENT_TERMS.some((t) => hasWordRun(words, t))) return false;
  return !SEAFOOD_EXCLUSION_TERMS.some((t) => hasWordRun(words, t));
}

const DIFFICULTY_EFFORT: Record<string, number> = { easy: 0, medium: 1, fancy: 2 };

// Sunday-indexed (Date.getUTCDay()) → the day-name vocabulary MealPlanItem.
// assignedDayOfWeek already uses (routes/home.ts DAY_NAMES, lib/planItemSort.ts).
export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export interface AssignableMeal {
  mealId: string;
  /** Categories of every (non-optional) ingredient across the meal's dishes. */
  ingredientCategories: string[];
  /**
   * Part B — the canonical NAMES of the same ingredients, for the seafood tier
   * (isSeafoodIngredientName). Optional: a caller without names gets the
   * category tiers only.
   */
  ingredientNames?: string[];
  /** The derived active minutes; null when never derived. */
  activeTimeMinutes: number | null;
  /** The stored total — the fallback effort when activeTimeMinutes is null. */
  estimatedTimeMinutes: number;
  difficulty: string;
}

export interface AssignedDay {
  mealId: string;
  /** 0-based offset from startDate; null = left unassigned (beyond planDurationDays). */
  dayIndex: number | null;
  assignedDayOfWeek: string | null;
  assignedDate: Date | null;
  perishabilityTier: PerishabilityTier;
  effortMinutes: number;
}

export interface AssignPlanDaysOptions {
  /** Defaults to tomorrow (UTC). Any Date is truncated to its UTC calendar day. */
  startDate?: Date;
  /** How many of the meals get a day. Defaults to all of them. */
  planDurationDays?: number;
  /** Test seam for "now". */
  now?: Date;
}

export function perishabilityTierFor(
  categories: string[],
  names: string[] = [],
): PerishabilityTier {
  // Part B — any fresh seafood by name governs the meal (the most perishable
  // ingredient rule), whatever inferCategory stamped on it.
  if (names.some(isSeafoodIngredientName)) return PERISHABILITY_SEAFOOD;
  let tier: PerishabilityTier = PERISHABILITY_UNKNOWN;
  for (const c of categories) {
    const t = PERISHABILITY_BY_CATEGORY[c];
    if (t !== undefined && t < tier) tier = t;
    if (tier === 1) break;
  }
  return tier;
}

export function effortMinutesFor(meal: {
  activeTimeMinutes: number | null;
  estimatedTimeMinutes: number;
}): number {
  return meal.activeTimeMinutes ?? meal.estimatedTimeMinutes;
}

function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** `d` (truncated to its UTC day) + `n` calendar days. */
export function addUtcDays(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
}

/** Inclusive day count of a range, 0 when end precedes start. */
export function inclusiveDayCount(start: Date, end: Date): number {
  const ms = utcDay(end).getTime() - utcDay(start).getTime();
  return Math.max(0, Math.round(ms / 86_400_000) + 1);
}

/** Tomorrow as a UTC calendar day (the plan-date convention of lib/planDates.ts). */
export function tomorrowUtc(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
}

// ── the client's local calendar day (Part D, rule (e)) ───────────────────────

/** The only accepted wire shape for `localDate`. */
export const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "YYYY-MM-DD" → that calendar day as UTC midnight (the stored basis), or null
 * when the string is malformed or names a day that does not exist (2026-02-30
 * round-trips to a different date and is refused).
 */
export function parseLocalDate(value: string): Date | null {
  if (!LOCAL_DATE_PATTERN.test(value)) return null;
  const [y, m, d] = value.split("-").map((n) => Number(n));
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date;
}

/**
 * "Today" for a date decision: the client's local calendar day when it sent
 * one (already validated by the route schema), else the server's UTC day.
 */
export function todayFor(localDate: string | undefined, now: Date = new Date()): Date {
  if (localDate !== undefined) {
    const parsed = parseLocalDate(localDate);
    if (parsed) return parsed;
  }
  return utcDay(now);
}

/**
 * Rule (a) — the active window of a plan built or activated FOR NOW: opens
 * today, ends on the last assigned day. With nothing assigned (a plan with no
 * items) the window is today + 6, the nearest honest "a week from now".
 */
export function activeWindowFromToday(
  today: Date,
  assigned: AssignedDay[],
): { startDate: Date; endDate: Date } {
  const start = utcDay(today);
  const last = assignedDateRange(assigned)?.endDate;
  return {
    startDate: start,
    endDate: last && last.getTime() >= start.getTime() ? last : addUtcDays(start, 6),
  };
}

/**
 * Assign days to the FIRST `planDurationDays` meals (in the given order) and
 * leave the rest unassigned — the user may pick more meals than the plan has
 * days (D-WS9-237 ruling). Returns one entry per input meal, in input order,
 * so the caller can zip it back onto its items.
 */
export function assignPlanDays(
  meals: AssignableMeal[],
  opts: AssignPlanDaysOptions = {},
): AssignedDay[] {
  const start = utcDay(opts.startDate ?? tomorrowUtc(opts.now));
  const days = Math.max(0, Math.min(meals.length, opts.planDurationDays ?? meals.length));

  const scored = meals.map((m, index) => ({
    index,
    mealId: m.mealId,
    tier: perishabilityTierFor(m.ingredientCategories, m.ingredientNames ?? []),
    effort: effortMinutesFor(m),
    difficulty: DIFFICULTY_EFFORT[m.difficulty] ?? DIFFICULTY_EFFORT.fancy,
  }));

  const dated = scored.slice(0, days).sort(
    (a, b) =>
      a.tier - b.tier || // perishability first
      b.effort - a.effort || // harder first → easiest last
      b.difficulty - a.difficulty ||
      a.index - b.index, // ties: the given order
  );
  const dayByIndex = new Map<number, number>();
  dated.forEach((s, dayIndex) => dayByIndex.set(s.index, dayIndex));

  return scored.map((s) => {
    const dayIndex = dayByIndex.get(s.index);
    if (dayIndex === undefined) {
      return {
        mealId: s.mealId,
        dayIndex: null,
        assignedDayOfWeek: null,
        assignedDate: null,
        perishabilityTier: s.tier,
        effortMinutes: s.effort,
      };
    }
    const date = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + dayIndex),
    );
    return {
      mealId: s.mealId,
      dayIndex,
      assignedDayOfWeek: DAY_NAMES[date.getUTCDay()],
      assignedDate: date,
      perishabilityTier: s.tier,
      effortMinutes: s.effort,
    };
  });
}

/**
 * Block 1 follow-up (F3) — first assigned day … last assigned day. Block 2
 * (Part D, rule (a)) amends F3 for a plan built or activated FOR NOW: the
 * window now opens TODAY, not on the first assigned day (activeWindowFromToday
 * above) — "active the day you make it, and tomorrow is the first meal". This
 * helper still supplies the END of that window, and the whole range for a
 * user-chosen start (rule (b)). The "active this week" derivation
 * (D-WS9-147, lib/planDates.ts resolveThisWeekPlan) is range-containment.
 * Unassigned overflow meals do not extend the range. null when nothing was
 * assigned.
 */
export function assignedDateRange(
  assigned: AssignedDay[],
): { startDate: Date; endDate: Date } | null {
  const dates = assigned
    .map((a) => a.assignedDate)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());
  if (dates.length === 0) return null;
  return { startDate: dates[0], endDate: dates[dates.length - 1] };
}

// ── the Prisma-side helper the two write paths share ─────────────────────────

/** The read that turns stored meals into AssignableMeal[] (order = `mealIds`). */
export async function loadAssignableMeals(
  tx: Pick<Prisma.TransactionClient, "meal">,
  mealIds: string[],
): Promise<AssignableMeal[]> {
  if (mealIds.length === 0) return [];
  const rows = await tx.meal.findMany({
    where: { id: { in: [...new Set(mealIds)] } },
    select: {
      id: true,
      activeTimeMinutes: true,
      estimatedTimeMinutes: true,
      difficulty: true,
      dishLinks: {
        select: {
          dish: {
            select: {
              dishIngredients: {
                where: { isOptional: false },
                // Part B — canonicalName feeds the seafood tier. When
                // Ingredient.subcategory is ever stamped, select it here and
                // let SEAFOOD_INGREDIENT_TERMS become its fallback.
                select: {
                  ingredient: { select: { category: true, canonicalName: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return mealIds.map((id) => {
    const r = byId.get(id);
    if (!r) {
      return {
        mealId: id,
        ingredientCategories: [],
        ingredientNames: [],
        activeTimeMinutes: null,
        estimatedTimeMinutes: 0,
        difficulty: "easy",
      };
    }
    return {
      mealId: id,
      ingredientCategories: r.dishLinks.flatMap((l) =>
        l.dish.dishIngredients.map((di) => di.ingredient.category),
      ),
      ingredientNames: r.dishLinks.flatMap((l) =>
        l.dish.dishIngredients.map((di) => di.ingredient.canonicalName),
      ),
      activeTimeMinutes: r.activeTimeMinutes,
      estimatedTimeMinutes: r.estimatedTimeMinutes,
      difficulty: r.difficulty,
    };
  });
}

/**
 * Assign + PERSIST days onto a plan instance's items (in positionIndex order).
 * Items beyond `planDurationDays` (default: every item gets a day) are written
 * with NO day (explicit nulls, so a re-run clears a stale assignment — rule
 * (c): a re-date re-runs this from the new start). Returns the assignment.
 */
export async function assignAndPersistPlanDays(
  tx: Pick<Prisma.TransactionClient, "meal" | "mealPlanItem">,
  planInstanceId: string,
  opts: AssignPlanDaysOptions = {},
): Promise<AssignedDay[]> {
  const items = await tx.mealPlanItem.findMany({
    where: { mealPlanInstanceId: planInstanceId },
    orderBy: { positionIndex: "asc" },
    select: { id: true, mealId: true },
  });
  const meals = await loadAssignableMeals(tx, items.map((i) => i.mealId));
  const assigned = assignPlanDays(meals, opts);
  for (let i = 0; i < items.length; i++) {
    await tx.mealPlanItem.update({
      where: { id: items[i].id },
      data: {
        assignedDayOfWeek: assigned[i].assignedDayOfWeek,
        assignedDate: assigned[i].assignedDate,
      },
    });
  }
  return assigned;
}

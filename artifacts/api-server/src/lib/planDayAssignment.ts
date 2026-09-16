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
// `subcategory` is never written. So "fish before chicken" within the fresh
// tier is NOT expressible from stored data; seafood and fresh meat share the
// earliest tier and fall back to effort + given order. Recorded as a CANDIDATE
// in the Block 1 report; no name-based classifier is invented here.
//
// Timezone: dates follow lib/planDates.ts — UTC calendar days, stored as UTC
// midnight, day names from getUTCDay(). "Tomorrow" = the server's UTC date + 1.
// (routes/home.ts resolves "today's meal" by LOCAL getDay(); on a non-UTC
// server the two can disagree for a few hours around midnight — flagged.)

import type { Prisma } from "@prisma/client";

export type PerishabilityTier = 0 | 1 | 2;

/**
 * `Ingredient.category` → perishability tier. The named table Hans asked for:
 *   0 = FRESH   (earliest): seafood, fresh meat & poultry (both "Protein"),
 *                           fresh produce
 *   1 = CHILLED (middle):   dairy & eggs
 *   2 = STABLE  (latest):   pantry, canned, frozen, dried, bakery, snacks,
 *                           household — and anything unknown.
 */
export const PERISHABILITY_BY_CATEGORY: Readonly<Record<string, PerishabilityTier>> = {
  Protein: 0,
  Produce: 0,
  Dairy: 1,
  Bakery: 2,
  Pantry: 2,
  Canned: 2,
  Frozen: 2,
  Snacks: 2,
  Household: 2,
};
export const PERISHABILITY_UNKNOWN: PerishabilityTier = 2;

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

export function perishabilityTierFor(categories: string[]): PerishabilityTier {
  let tier: PerishabilityTier = PERISHABILITY_UNKNOWN;
  for (const c of categories) {
    const t = PERISHABILITY_BY_CATEGORY[c];
    if (t !== undefined && t < tier) tier = t;
    if (tier === 0) break;
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

/** Tomorrow as a UTC calendar day (the plan-date convention of lib/planDates.ts). */
export function tomorrowUtc(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
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
    tier: perishabilityTierFor(m.ingredientCategories),
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
                select: { ingredient: { select: { category: true } } },
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
      activeTimeMinutes: r.activeTimeMinutes,
      estimatedTimeMinutes: r.estimatedTimeMinutes,
      difficulty: r.difficulty,
    };
  });
}

/**
 * Assign + PERSIST days onto a plan instance's items (in positionIndex order).
 * Items beyond `planDurationDays` are written with NO day (explicit nulls, so a
 * re-run clears a stale assignment). Returns the assignment for the report.
 */
export async function assignAndPersistPlanDays(
  tx: Pick<Prisma.TransactionClient, "meal" | "mealPlanItem">,
  planInstanceId: string,
  opts: AssignPlanDaysOptions & { planDurationDays: number },
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

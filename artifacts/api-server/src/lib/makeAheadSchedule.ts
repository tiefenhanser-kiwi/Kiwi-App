// PREP-1 (D-WS9-314) — Part C. THE THANKSGIVING MAKE-AHEAD SCHEDULE.
//
// Hans, October 14: "making the cranberry sauce ahead of time, or making the
// stock, or assembling a casserole … simmering the gizzards and neck on Tuesday
// night … it said Turkey was brining for 24 hours … that's hands-off time."
//
// Deterministic and free: built from the feast dishes' tags (THX-2G-E's contract)
// and the plan's own dates, no AI. The Hub reads it off GET /plans/:id as the
// optional `makeAhead` field; only a plan holding a `thanksgiving-feast` meal has
// one. Copy is the client's — each row says WHAT and WHEN, in data.
//
// The tag contract, feast dishes only:
//   ahead-mon | ahead-tue | ahead-wed   the day the dish is made
//   keeps-<n>d                          how long it keeps once made
//   thaw-<n>d                           a whole bird: into the fridge n days out
//   brine-<day>                         the day the brine starts (mon…wed)

import type { PrismaClient } from "@prisma/client";

import { FEAST_MEAL_TAG } from "./prepWeekAggregation";

export interface MakeAheadDishInput {
  dishId: string;
  dishName: string;
  tags: readonly string[];
  /** The dish's recipe steps, for the brine's hours. */
  stepTexts: readonly string[];
}

export interface MakeAheadInput {
  /** The plan's start (UTC midnight). Null: rows carry the weekday only. */
  startDate: Date | null;
  feast: {
    mealId: string;
    /** The plan item's weekday. Null (unscheduled) reads as Thursday — it is Thanksgiving. */
    assignedDayOfWeek: string | null;
    dishes: readonly MakeAheadDishInput[];
  };
}

export type MakeAheadKind = "thaw" | "make" | "brine";

export interface MakeAheadRow {
  kind: MakeAheadKind;
  /** "Saturday". */
  dayName: string;
  /** "2026-11-21", or null when the plan has no start date. */
  date: string | null;
  /** Days before the feast — the sort key, and what "Wed night" is relative to. */
  daysBefore: number;
  /** The recipe link. */
  mealId: string;
  dishId: string;
  dishName: string;
  /** `make` — from `keeps-<n>d`. */
  keepsDays?: number;
  /** `thaw` — from `thaw-<n>d`. */
  thawDays?: number;
  /** `brine` — the hands-off window, when the recipe states one ("brine 12 to 24 hours"). */
  brineHours?: { min: number; max: number };
}

export interface MakeAheadSchedule {
  feastMealId: string;
  feastDayName: string;
  feastDate: string | null;
  rows: MakeAheadRow[];
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const THURSDAY = 4;
const DAY_MS = 86_400_000;
const KIND_ORDER: Record<MakeAheadKind, number> = { thaw: 0, make: 1, brine: 2 };

/**
 * The dev catalog's phrases (THX-2G-E): "pour the brine over it … refrigerate
 * overnight (8 to 24 hours)", "rub the dry brine all over … refrigerate uncovered
 * 48 hours". A range or one figure, in the sentence that names the brine.
 */
const BRINE_HOURS = /\bbrine\b[^.]*?\b(\d{1,2})(?:\s*(?:to|–|-)\s*(\d{1,2}))?\s*hours?\b/i;

export function brineHoursOf(texts: readonly string[]): { min: number; max: number } | undefined {
  for (const t of texts) {
    const m = BRINE_HOURS.exec(t);
    if (m) return { min: Number(m[1]), max: Number(m[2] ?? m[1]) };
  }
  return undefined;
}

const tagNumber = (tags: readonly string[], re: RegExp): number | undefined => {
  for (const t of tags) {
    const m = re.exec(t);
    if (m) return Number(m[1]);
  }
  return undefined;
};
const tagDay = (tags: readonly string[], re: RegExp): number | undefined => {
  for (const t of tags) {
    const m = re.exec(t);
    if (m && SHORT[m[1]] !== undefined) return SHORT[m[1]];
  }
  return undefined;
};

export function buildMakeAheadSchedule(input: MakeAheadInput): MakeAheadSchedule {
  const { feast } = input;
  const named = feast.assignedDayOfWeek ? DAY_NAMES.findIndex((d) => d.toLowerCase() === feast.assignedDayOfWeek!.trim().toLowerCase()) : -1;
  const feastDow = named >= 0 ? named : THURSDAY;
  // The loader's rule: the single occurrence of that weekday in the seven days from startDate.
  const feastMs = input.startDate
    ? input.startDate.getTime() + ((feastDow - input.startDate.getUTCDay() + 7) % 7) * DAY_MS
    : null;
  const at = (daysBefore: number) => ({
    dayName: DAY_NAMES[(((feastDow - daysBefore) % 7) + 7) % 7],
    date: feastMs === null ? null : new Date(feastMs - daysBefore * DAY_MS).toISOString().slice(0, 10),
    daysBefore,
  });
  // A make-ahead day the week before the feast; the feast's own weekday is a week out.
  const before = (dow: number) => (feastDow - dow + 7) % 7 || 7;

  const rows: (MakeAheadRow & { pos: number })[] = [];
  feast.dishes.forEach((d, pos) => {
    const base = { mealId: feast.mealId, dishId: d.dishId, dishName: d.dishName, pos };
    const thaw = tagNumber(d.tags, /^thaw-(\d+)d$/);
    if (thaw !== undefined && thaw > 0) rows.push({ kind: "thaw", ...at(thaw), ...base, thawDays: thaw });
    const ahead = tagDay(d.tags, /^ahead-([a-z]{3})$/);
    if (ahead !== undefined) {
      const keeps = tagNumber(d.tags, /^keeps-(\d+)d$/);
      rows.push({ kind: "make", ...at(before(ahead)), ...base, ...(keeps !== undefined ? { keepsDays: keeps } : {}) });
    }
    const brine = tagDay(d.tags, /^brine-([a-z]{3})$/);
    if (brine !== undefined) {
      const hours = brineHoursOf(d.stepTexts);
      rows.push({ kind: "brine", ...at(before(brine)), ...base, ...(hours ? { brineHours: hours } : {}) });
    }
  });
  rows.sort((a, b) => b.daysBefore - a.daysBefore || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.pos - b.pos);

  return {
    feastMealId: feast.mealId,
    feastDayName: DAY_NAMES[feastDow],
    feastDate: feastMs === null ? null : new Date(feastMs).toISOString().slice(0, 10),
    rows: rows.map(({ pos: _pos, ...r }) => r),
  };
}

/** The slice of a GET /plans/:id item the schedule reads (its composed meal). */
export interface MakeAheadPlanItem {
  mealId: string;
  assignedDayOfWeek: string | null;
  meal: {
    tags: readonly string[];
    dishes: readonly { dishId: string; title: string; steps: readonly { text: string }[] }[];
  } | null;
}

/**
 * GET /plans/:id's `makeAhead`: the schedule for the plan's first feast (plan
 * order), or null for a plan without one — which costs no query. The dishes are
 * the composed meal's, so a per-plan recipe edit is what the schedule lists; their
 * tags are one keyed read, because the composed dish carries none.
 */
export async function makeAheadForPlan(
  prisma: Pick<PrismaClient, "dish">,
  plan: { startDate: Date | null; items: readonly MakeAheadPlanItem[] },
): Promise<MakeAheadSchedule | null> {
  const item = plan.items.find((it) => it.meal?.tags.includes(FEAST_MEAL_TAG));
  if (!item?.meal) return null;
  const dishIds = item.meal.dishes.map((d) => d.dishId);
  const rows = dishIds.length === 0
    ? []
    : await prisma.dish.findMany({ where: { id: { in: dishIds } }, select: { id: true, tags: true } });
  const tagsById = new Map(rows.map((r) => [r.id, r.tags]));
  return buildMakeAheadSchedule({
    startDate: plan.startDate,
    feast: {
      mealId: item.mealId,
      assignedDayOfWeek: item.assignedDayOfWeek,
      dishes: item.meal.dishes.map((d) => ({
        dishId: d.dishId,
        dishName: d.title,
        tags: tagsById.get(d.dishId) ?? [],
        stepTexts: d.steps.map((s) => s.text),
      })),
    },
  });
}

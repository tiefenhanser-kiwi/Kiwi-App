// PREP-1 (D-WS9-314) — Part C. THE THANKSGIVING MAKE-AHEAD SCHEDULE.
//
// Hans, October 14: "making the cranberry sauce ahead of time, or making the
// stock, or assembling a casserole … simmering the gizzards and neck on Tuesday
// night … it said Turkey was brining for 24 hours … that's hands-off time."
//
// Deterministic and free: built from the feast dishes' tags (THX-2G-E's contract) and,
// THX-3d, the days their steps name (feastPrefixes)
// and the plan's own dates, no AI. The Hub reads it off GET /plans/:id as the
// optional `makeAhead` field; only a plan holding a `thanksgiving-feast` meal has
// one. Copy is the client's — each row says WHAT and WHEN, in data.
//
// The tag contract, feast dishes only:
//   ahead-mon | ahead-tue | ahead-wed   the day the dish is made
//   keeps-<n>d                          how long it keeps once made
//   thaw-<n>d                           a whole bird: into the fridge n days out
//   brine-<day>                         the day the brine starts (mon…wed)
//   assemble                            PREP-2 — assembled ahead, baked on the day
//                                       (THX-2G-G writes it; read if present)

import type { PrismaClient } from "@prisma/client";

import { FEAST_MEAL_TAG } from "./prepWeekAggregation";
import { prefixDaysOf } from "./feastPrefixes";
import { mealBirdOf, thawLeadDays } from "./birdWeight";
import { authoredLeadDays, DAY_NAMES, feastDowOf } from "./feastWeek";

export { feastDowOf };

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
    /** PREP-1 F — the feast's plan item, so a row opens the recipe at the plan's servings. */
    planItemId?: string;
    /** The plan item's weekday. Null (unscheduled) reads as Thursday — it is Thanksgiving. */
    assignedDayOfWeek: string | null;
    dishes: readonly MakeAheadDishInput[];
    /**
     * THX-4 (D-WS9-324) — the turkey weight the cook chose and the bird's dish: its thaw
     * row is ⌈lb ÷ 4⌉ fridge days before the bird is first handled (birdWeight). Absent:
     * the dish's `thaw-<n>d` tag, as before.
     */
    bird?: { dishId: string; lb: number };
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
  /**
   * `make` — PREP-2: the dish carries `assemble`. Hans: "making it ahead of time does
   * not mean putting it in the oven. oven happens the day of the meal. that's
   * different for a pie." Absent otherwise.
   */
  assemble?: true;
  /** `thaw` — from `thaw-<n>d`. */
  thawDays?: number;
  /** `brine` — the hands-off window, when the recipe states one ("brine 12 to 24 hours"). */
  brineHours?: { min: number; max: number };
}

export interface MakeAheadSchedule {
  feastMealId: string;
  /**
   * PREP-1 F — the feast's plan item. A row opens the FEAST MEAL in plan context
   * (meal detail with planId + planItemId), which is what scales its recipes to the
   * plan's ×10; the dish screen alone reads its own default servings.
   */
  feastPlanItemId: string | null;
  feastDayName: string;
  feastDate: string | null;
  rows: MakeAheadRow[];
}

const SHORT: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DAY_MS = 86_400_000;
const KIND_ORDER: Record<MakeAheadKind, number> = { thaw: 0, make: 1, brine: 2 };

/** "36 to 48 hours", "12–24 hours", "48 hours". */
const HOURS = /\b(\d{1,2})(?:\s*(?:to|–|-)\s*(\d{1,2}))?\s*hours?\b/i;
/** THX-2G-F: the brine's own steps open "Make ahead (Tuesday night):". */
const NIGHT_STEP = /^\s*Make ahead \([A-Za-z]+ night\):/i;
/** The older catalog phrasing: the hours in the sentence that names the brine. */
const BRINE_HOURS = /\bbrine\b[^.]*?\b(\d{1,2})(?:\s*(?:to|–|-)\s*(\d{1,2}))?\s*hours?\b/i;

const hoursOf = (m: RegExpExecArray) => ({ min: Number(m[1]), max: Number(m[2] ?? m[1]) });

/**
 * The brine's hands-off window, as the recipe writes it.
 *
 * QA-1 B19 — THE BRINE'S OWN STEP NEED NOT SAY "BRINE". The dry brine reads "Rub the
 * salt mixture all over the turkey … refrigerate 36 to 48 hours", and the sentence
 * rule found nothing. So the `Make ahead (<Day> night):` steps (THX-2G-F) are read
 * first, whatever their sentence says — the first hours they state; only a recipe
 * without such a step falls back to the sentence that names the brine.
 */
export function brineHoursOf(texts: readonly string[]): { min: number; max: number } | undefined {
  for (const t of texts) {
    if (!NIGHT_STEP.test(t)) continue;
    const m = HOURS.exec(t);
    if (m) return hoursOf(m);
  }
  for (const t of texts) {
    const m = BRINE_HOURS.exec(t);
    if (m) return hoursOf(m);
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

/**
 * THX-4 (D-WS9-324) — A WEIGHED BIRD'S THAW: ⌈lb ÷ 4⌉ fridge days (birdWeight
 * thawLeadDays), ending the day the bird is first handled — its brine (the
 * `brine-<day>` tag, else a "Make ahead (<Day> night):" step), else the feast day.
 * The Hub's thaw row and the thaw step's words both read this.
 *
 * SERVER-8 A (BUG-567) — the handling day is the recipe's, a Thursday plan's weekday:
 * its lead is that plan's (feastWeek authoredLeadDays), and it is said as the weekday
 * that lead lands on before this feast ("Friday night" before a Saturday).
 */
export function weighedThaw(args: { tags: readonly string[]; stepTexts: readonly string[]; feastDow: number; lb: number }): {
  daysBefore: number;
  startDay: string;
  readyBy: string;
} {
  const night = prefixDaysOf(args.stepTexts).night;
  const handled = tagDay(args.tags, /^brine-([a-z]{3})$/) ?? (night.length > 0 ? SHORT[night[0]] : undefined);
  const lead = handled === undefined ? 0 : authoredLeadDays(handled);
  const daysBefore = thawLeadDays(args.lb, lead);
  const dayAt = (n: number) => DAY_NAMES[(((args.feastDow - n) % 7) + 7) % 7];
  return {
    daysBefore,
    startDay: dayAt(daysBefore),
    readyBy: handled === undefined ? DAY_NAMES[args.feastDow] : `${dayAt(lead)} night`,
  };
}

export function buildMakeAheadSchedule(input: MakeAheadInput): MakeAheadSchedule {
  const { feast } = input;
  const feastDow = feastDowOf(feast.assignedDayOfWeek);
  // The loader's rule: the single occurrence of that weekday in the seven days from startDate.
  const feastMs = input.startDate
    ? input.startDate.getTime() + ((feastDow - input.startDate.getUTCDay() + 7) % 7) * DAY_MS
    : null;
  const at = (daysBefore: number) => ({
    dayName: DAY_NAMES[(((feastDow - daysBefore) % 7) + 7) % 7],
    date: feastMs === null ? null : new Date(feastMs - daysBefore * DAY_MS).toISOString().slice(0, 10),
    daysBefore,
  });
  // 🔴 SERVER-8 A (BUG-567) — A DAY THE RECIPE NAMES IS ITS LEAD IN THE AUTHORED
  // THURSDAY PLAN (feastWeek): Wednesday is the day before whatever day the feast is.
  // Measured from the feast's own weekday, a Wednesday feast made its casseroles a week
  // early and dried the stuffing's bread after assembling it, and a Saturday feast made
  // the 1-day casseroles 3 days out. `at` says the weekday the lead lands on.
  const before = authoredLeadDays;

  const rows: (MakeAheadRow & { pos: number })[] = [];
  feast.dishes.forEach((d, pos) => {
    const base = { mealId: feast.mealId, dishId: d.dishId, dishName: d.dishName, pos };
    const named = prefixDaysOf(d.stepTexts);
    const brine = tagDay(d.tags, /^brine-([a-z]{3})$/);
    // THX-4 — a weighed bird thaws by its weight (weighedThaw).
    const weighed = feast.bird?.dishId === d.dishId ? weighedThaw({ tags: d.tags, stepTexts: d.stepTexts, feastDow, lb: feast.bird.lb }).daysBefore : undefined;
    const thaw = weighed ?? tagNumber(d.tags, /^thaw-(\d+)d$/);
    if (thaw !== undefined && thaw > 0) rows.push({ kind: "thaw", ...at(thaw), ...base, thawDays: thaw });
    // THX-3 (BUG-425) — EVERY `ahead-<day>` tag is a row. Make-Ahead's stuffing dries
    // its bread on Tuesday and is assembled on Wednesday; with one row (the first tag)
    // the Wednesday Cook Mode left Tuesday's step out. The keep-days and `assemble`
    // describe the finished dish, so they ride its LAST make-ahead day only.
    const aheads = [...new Set(d.tags.map((t) => /^ahead-([a-z]{3})$/.exec(t)?.[1]).filter((x): x is string => !!x && SHORT[x] !== undefined))]
      .map((x) => SHORT[x])
      .sort((a, b) => before(b) - before(a));
    const keeps = tagNumber(d.tags, /^keeps-(\d+)d$/);
    aheads.forEach((ahead, i) => {
      const last = i === aheads.length - 1;
      rows.push({
        kind: "make",
        ...at(before(ahead)),
        ...base,
        ...(last && keeps !== undefined ? { keepsDays: keeps } : {}),
        ...(last && d.tags.includes("assemble") ? { assemble: true as const } : {}),
      });
    });
    if (brine !== undefined) {
      const hours = brineHoursOf(d.stepTexts);
      rows.push({ kind: "brine", ...at(before(brine)), ...base, ...(hours ? { brineHours: hours } : {}) });
    }
    // THX-3d (F, R6) — AND THE DAYS ITS STEPS NAME, where no tag already gives that
    // row (feastPrefixes): Small's untagged make-ahead steps, and a dish added to the
    // feast. A step-named day carries no keep-days (that is the tag's table).
    if (thaw === undefined && named.thaw !== null) {
      const days = before(SHORT[named.thaw]);
      rows.push({ kind: "thaw", ...at(days), ...base, thawDays: days });
    }
    for (const day of named.make) {
      if (aheads.includes(SHORT[day])) continue;
      rows.push({ kind: "make", ...at(before(SHORT[day])), ...base });
    }
    for (const day of named.night) {
      if (brine === SHORT[day]) continue;
      const hours = brineHoursOf(d.stepTexts);
      rows.push({ kind: "brine", ...at(before(SHORT[day])), ...base, ...(hours ? { brineHours: hours } : {}) });
    }
  });
  rows.sort((a, b) => b.daysBefore - a.daysBefore || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.pos - b.pos);

  return {
    feastMealId: feast.mealId,
    feastPlanItemId: feast.planItemId ?? null,
    feastDayName: DAY_NAMES[feastDow],
    feastDate: feastMs === null ? null : new Date(feastMs).toISOString().slice(0, 10),
    rows: rows.map(({ pos: _pos, ...r }) => r),
  };
}

/** The slice of a GET /plans/:id item the schedule reads (its composed meal). */
export interface MakeAheadPlanItem {
  id: string;
  mealId: string;
  assignedDayOfWeek: string | null;
  /** THX-4 (D-WS9-324) — the turkey weight the cook chose; null/absent = the recipe's weight (SERVER-7 A). */
  birdWeightLb?: number | null;
  meal: {
    tags: readonly string[];
    dishes: readonly {
      dishId: string;
      title: string;
      steps: readonly { text: string }[];
      ingredients?: readonly { name: string; quantity: number; unit: string; preparationNote: string | null }[];
    }[];
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
  // SERVER-7 A (BUG-559, D-WS9-337) — the bird thaws by the weight rule whether or not a
  // weight is chosen: with none, at the recipe's own weight (the `thaw-<n>d` tag's "6
  // days" left a 14-lb bird thawed 2½ days before the roast; USDA keeps it 1–2).
  const bird = mealBirdOf({
    tags: item.meal.tags,
    dishes: item.meal.dishes.map((d) => ({
      dishId: d.dishId,
      title: d.title,
      rows: (d.ingredients ?? []).map((i) => ({ quantity: i.quantity, unit: i.unit, name: i.name, note: i.preparationNote })),
    })),
  });
  return buildMakeAheadSchedule({
    startDate: plan.startDate,
    feast: {
      mealId: item.mealId,
      planItemId: item.id,
      assignedDayOfWeek: item.assignedDayOfWeek,
      ...(bird ? { bird: { dishId: bird.dishId, lb: item.birdWeightLb ?? bird.recipeLb } } : {}),
      dishes: item.meal.dishes.map((d) => ({
        dishId: d.dishId,
        dishName: d.title,
        tags: tagsById.get(d.dishId) ?? [],
        stepTexts: d.steps.map((s) => s.text),
      })),
    },
  });
}

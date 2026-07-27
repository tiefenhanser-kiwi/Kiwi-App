// Cookbook Phase A — planning-context assembly for the two plan-generation
// flows (POST /wizard/build-plans and the build-from-text generate step).
//
// This module is SERVER PLUMBING only. It computes the season / upcoming-event
// nudges and loads recent meal + plan history, then packs them into a single
// `planningContext` object that the routes attach to the generate-input. The
// prompt BODIES do not yet reference these keys (Phase A Block 2 does the
// wording), so the extra JSON is inert until then — this block only makes the
// data available.
//
// Split:
//   - Pure functions (getSeasonContext / getUpcomingEvents): no I/O, no AI,
//     fully deterministic given `now`. Northern-hemisphere / US assumptions are
//     INTENTIONAL — there is no per-user region/weather/geo data yet (that
//     lands later); these are the sensible default for the current user base.
//   - Loaders (buildRecentMealHistory / buildRecentPlanNames): read-only Prisma
//     queries, no migration. They take an explicit `now` for testability.
//   - buildPlanningContext: assembles all of the above for a route handler.

import type { PrismaClient } from "@prisma/client";

import { logger } from "./logger";
import { lookupDishFamily } from "./store/dishFamily";

// ── shared types ─────────────────────────────────────────────────────────

export type Season = "winter" | "spring" | "summer" | "fall";

export interface SeasonContext {
  // ISO calendar date (YYYY-MM-DD), UTC components — symmetric with the rest of
  // the calendar-date pipeline (planQueries.toYmd / planDates.currentWeekRange).
  currentDate: string;
  season: Season;
}

export interface UpcomingEvent {
  name: string;
  // Short generation nudge (e.g. "cookout/grilling favorites"). Kept terse so
  // the prompt can splice a compact hint list without bloating the token count.
  hint: string;
}

export interface RecentMeal {
  title: string;
  source: "cooked" | "planned";
  // ISO date (YYYY-MM-DD) the meal was cooked (activity createdAt) or planned
  // for (item assignedDate, falling back to the instance's dates / createdAt).
  when: string;
}

export interface PlanningContext {
  currentDate: string;
  season: Season;
  upcomingEvents: UpcomingEvent[];
  recentMeals: RecentMeal[];
  recentPlanNames: string[];
}

// ── date helpers (all UTC — see the currentDate comment above) ─────────────

const MS_PER_DAY = 86_400_000;

function toYmdUTC(d: Date | null): string | null {
  if (!d) return null;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// UTC-midnight Date for (year, monthIndex 0-11, day).
function utcDate(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day));
}

// Strip the time component: UTC midnight of the day `d` falls on.
function startOfUtcDay(d: Date): Date {
  return utcDate(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function addDays(d: Date, n: number): Date {
  // All inputs are UTC midnights, so day arithmetic is DST-free.
  return new Date(d.getTime() + n * MS_PER_DAY);
}

// nth (1-based) `weekday` (0=Sun..6=Sat) of a month, as a UTC-midnight Date.
function nthWeekdayOfMonth(
  year: number,
  monthIndex: number,
  weekday: number,
  n: number,
): Date {
  const firstDow = utcDate(year, monthIndex, 1).getUTCDay();
  const offset = (weekday - firstDow + 7) % 7;
  return utcDate(year, monthIndex, 1 + offset + (n - 1) * 7);
}

// Last `weekday` (0=Sun..6=Sat) of a month, as a UTC-midnight Date.
function lastWeekdayOfMonth(
  year: number,
  monthIndex: number,
  weekday: number,
): Date {
  // Day 0 of the next month == last day of this month.
  const lastDay = utcDate(year, monthIndex + 1, 0);
  const back = (lastDay.getUTCDay() - weekday + 7) % 7;
  return addDays(lastDay, -back);
}

// ── season ─────────────────────────────────────────────────────────────

// Meteorological seasons by month (Northern-hemisphere / US assumption is
// intentional — see the module header). Boundaries land on month starts, which
// is coarse but stable and matches how the prompt talks about "this season".
export function getSeasonContext(now: Date): SeasonContext {
  const month = now.getUTCMonth(); // 0=Jan .. 11=Dec
  let season: Season;
  if (month === 11 || month <= 1) {
    season = "winter"; // Dec, Jan, Feb
  } else if (month <= 4) {
    season = "spring"; // Mar, Apr, May
  } else if (month <= 7) {
    season = "summer"; // Jun, Jul, Aug
  } else {
    season = "fall"; // Sep, Oct, Nov
  }
  return { currentDate: toYmdUTC(now) as string, season };
}

// ── upcoming events ──────────────────────────────────────────────────────

interface EventOccurrence extends UpcomingEvent {
  start: Date;
  end: Date;
}

// The concrete [start, end] windows for each event anchored in a given year.
// Multi-day windows (holiday/game weeks, seasons) are inclusive UTC-midnight
// ranges. NFL season is anchored to its OPENING year and runs into the next.
function eventOccurrencesForYear(year: number): EventOccurrence[] {
  const cincoDeMayo = utcDate(year, 4, 5); // May 5
  const memorialDay = lastWeekdayOfMonth(year, 4, 1); // last Mon of May
  const julyFourth = utcDate(year, 6, 4); // Jul 4
  const laborDay = nthWeekdayOfMonth(year, 8, 1, 1); // first Mon of Sep
  const thanksgivingThu = nthWeekdayOfMonth(year, 10, 4, 4); // 4th Thu of Nov
  const superBowlSun = nthWeekdayOfMonth(year, 1, 0, 1); // first Sun of Feb

  return [
    {
      name: "Cinco de Mayo",
      hint: "Mexican favorites — tacos, fajitas, fresh salsas",
      start: cincoDeMayo,
      end: cincoDeMayo,
    },
    {
      name: "Memorial Day",
      hint: "cookout/grilling favorites — burgers, ribs, corn",
      start: memorialDay,
      end: memorialDay,
    },
    {
      name: "Fourth of July",
      hint: "cookout/grilling favorites for the Fourth",
      start: julyFourth,
      end: julyFourth,
    },
    {
      name: "Labor Day",
      hint: "end-of-summer cookout/grilling favorites",
      start: laborDay,
      end: laborDay,
    },
    {
      // Sun–Sat week containing the 4th Thursday of November.
      name: "Thanksgiving week",
      hint: "make-ahead sides and turkey-forward comfort dishes",
      start: addDays(thanksgivingThu, -4),
      end: addDays(thanksgivingThu, 2),
    },
    {
      // The Mon–Sun week ENDING on the first Sunday of February.
      name: "Super Bowl week",
      hint: "game-day finger foods — wings, dips, chili, sliders",
      start: addDays(superBowlSun, -6),
      end: superBowlSun,
    },
    {
      // Sep 1 of `year` → Feb 15 of `year + 1` (spans the year boundary).
      name: "NFL season",
      hint: "weekend game-day snacks and shareable plates",
      start: utcDate(year, 8, 1),
      end: utcDate(year + 1, 1, 15),
    },
    {
      name: "Baseball opening week",
      hint: "ballpark-inspired favorites — hot dogs, nachos, pretzels",
      start: utcDate(year, 2, 25), // Mar 25
      end: utcDate(year, 3, 5), // Apr 5
    },
  ];
}

// Events overlapping [now, now + windowDays]. Plans are generated undated, so
// we assume the upcoming ~10 days is the cooking window and surface anything
// that intersects it. Candidate years span [year-1 .. year+1] so year-boundary
// events (NFL season running into Jan/Feb, a late-Dec window reaching Super
// Bowl week) are caught regardless of which side of Jan 1 `now` sits on.
export function getUpcomingEvents(now: Date, windowDays = 10): UpcomingEvent[] {
  const winStart = startOfUtcDay(now);
  const winEnd = addDays(winStart, windowDays);
  const year = now.getUTCFullYear();

  const seen = new Set<string>();
  const hits: EventOccurrence[] = [];
  for (const y of [year - 1, year, year + 1]) {
    for (const occ of eventOccurrencesForYear(y)) {
      // Inclusive overlap test.
      if (occ.start <= winEnd && occ.end >= winStart && !seen.has(occ.name)) {
        seen.add(occ.name);
        hits.push(occ);
      }
    }
  }
  hits.sort((a, b) => a.start.getTime() - b.start.getTime());
  return hits.map(({ name, hint }) => ({ name, hint }));
}

// ── recent-history loaders (read-only, no migration) ─────────────────────

const RECENT_MEALS_CAP = 30;

// Union of recently-cooked and recently-planned meal titles for the user,
// newest first, deduped by case-insensitive title, capped at 30.
//
// (1) cooked — DEFENSIVE / currently inert. Reads UserActivity `cook_meal`
//     rows (entityType "meal", entityId = Meal.id) and joins to Meal.title.
//     NO code emits `cook_meal` yet, so this branch returns nothing today; it
//     is wired so it lights up for free once the Cook Mode completion writer
//     lands. Planned history is the load-bearing source until then.
// (2) planned — MealPlanItem titles from the user's real (non-draft,
//     non-archived) plans whose item.assignedDate OR whose instance date range
//     overlaps the window. Draft exclusion is a DB predicate; window overlap is
//     computed in JS because both dates are nullable.
export async function buildRecentMealHistory(
  prisma: PrismaClient,
  userId: string,
  now: Date = new Date(),
  windowDays = 28,
): Promise<RecentMeal[]> {
  const winEnd = startOfUtcDay(now);
  const winStart = addDays(winEnd, -windowDays);

  // (1) cooked
  const cookedActivities = await prisma.userActivity.findMany({
    where: {
      userId,
      eventType: "cook_meal",
      entityType: "meal",
      createdAt: { gte: winStart },
    },
    orderBy: { createdAt: "desc" },
    take: RECENT_MEALS_CAP,
    select: { entityId: true, createdAt: true },
  });
  const cookedIds = cookedActivities
    .map((a) => a.entityId)
    .filter((id): id is string => !!id);
  const cookedMeals = cookedIds.length
    ? await prisma.meal.findMany({
        where: { id: { in: cookedIds } },
        select: { id: true, title: true },
      })
    : [];
  const titleById = new Map(cookedMeals.map((m) => [m.id, m.title]));
  const cooked: RecentMeal[] = [];
  for (const a of cookedActivities) {
    const title = a.entityId ? titleById.get(a.entityId) : undefined;
    if (!title) continue;
    cooked.push({ title, source: "cooked", when: toYmdUTC(a.createdAt) ?? "" });
  }

  // (2) planned
  const instances = await prisma.mealPlanInstance.findMany({
    where: { userId, isWizardDraft: false, isArchived: false },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      startDate: true,
      endDate: true,
      createdAt: true,
      items: {
        select: {
          assignedDate: true,
          meal: { select: { title: true } },
        },
      },
    },
  });
  const planned: RecentMeal[] = [];
  for (const inst of instances) {
    const instanceOverlaps =
      inst.startDate && inst.endDate
        ? inst.startDate <= winEnd && inst.endDate >= winStart
        : false;
    for (const item of inst.items) {
      const itemInWindow = item.assignedDate
        ? item.assignedDate >= winStart && item.assignedDate <= winEnd
        : false;
      if (!itemInWindow && !instanceOverlaps) continue;
      const title = item.meal?.title;
      if (!title) continue;
      const whenDate =
        item.assignedDate ?? inst.endDate ?? inst.startDate ?? inst.createdAt;
      planned.push({
        title,
        source: "planned",
        when: toYmdUTC(whenDate) ?? "",
      });
    }
  }

  // Union → newest first → dedupe by case-insensitive title (newest wins) → cap.
  const combined = [...cooked, ...planned].sort((a, b) =>
    a.when < b.when ? 1 : a.when > b.when ? -1 : 0,
  );
  const seen = new Set<string>();
  const deduped: RecentMeal[] = [];
  for (const m of combined) {
    const key = m.title.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(m);
  }
  return deduped.slice(0, RECENT_MEALS_CAP);
}

// Names of the user's most recent real plans (non-draft, non-archived), newest
// first. Name = titleOverride ?? template.title; rows with neither are dropped.
export async function buildRecentPlanNames(
  prisma: PrismaClient,
  userId: string,
  take = 5,
): Promise<string[]> {
  const rows = await prisma.mealPlanInstance.findMany({
    where: { userId, isWizardDraft: false, isArchived: false },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      titleOverride: true,
      template: { select: { title: true } },
    },
  });
  return rows
    .map((r) => r.titleOverride ?? r.template?.title ?? null)
    .filter((n): n is string => n !== null && n.length > 0);
}

// ── recent rotation (Plan-Gen Arc · Block 4b-2, D-WS9-073) ────────────────
//
// The repeat-avoidance NUDGE feed for build-plans + directed. Distinct from
// `recentMeals` above in three deliberate ways the D-WS9-073 ruling requires:
//   1. PLAN-COUNT scoped, not a 28-day window — walk the user's last ~N real
//      plans regardless of calendar age (a light user's history is thin either
//      way; a heavy user's last 3 plans is the meaningful "rotation").
//   2. LINEAGE identity for store-sourced meals — a user's fork of a catalog
//      meal is resolved back to its parent DISH FAMILY, so "another version of
//      the same dish" reads as one recurring thing, not N unrelated titles.
//   3. ONE unit, TWO resolutions — store-lineage meals carry a `dishFamily`;
//      live-generated meals (no catalog lineage) are title-only. Same list,
//      same instruction governs both.
//
// This is a soft PROMPT nudge only (NOT the retrieval hard-filter excludeMealIds
// — that is the rejected hard-exclusion cliff). Efficacy is unverifiable here
// and is logged as an open measurement question in D-WS9-073.

// How many of the user's most recent real plans the rotation walk covers. A
// NAMED constant, not a literal, because it will be tuned against real output —
// with few lineage-carrying forks in the system today there is little history
// to bite on, and the right depth is a real-usage question.
export const RECENT_ROTATION_PLAN_DEPTH = 3;

export interface RecentRotationMeal {
  // The representative title the user actually saw (the fork's own title, from
  // the most recent plan it appeared in).
  title: string;
  // Parent dish-family key — present ONLY for a store-lineage meal, resolved
  // fork → sourceStoreMealId → original.dishFamilyKey → lookupDishFamily().
  // Absent means a live-generated meal (no catalog lineage): title-only.
  dishFamily?: string;
  // The parent dish's popularity rank (1 = most common). Present with dishFamily.
  familyRank?: number;
  // How many times this identity (family for store meals, lowercased title for
  // live meals) recurs across the walked plans — the "is this dominating the
  // rotation?" signal a window cannot express.
  timesRecentlyServed: number;
}

export interface RecentRotation {
  // Actual number of recent real plans walked (≤ RECENT_ROTATION_PLAN_DEPTH;
  // fewer for a new user). Distinguishes "seen nothing yet" from "seen these".
  plansConsidered: number;
  // Recently-served meals, most-recent-first, deduped by identity (dish family
  // for store meals, lowercased title for live meals).
  meals: RecentRotationMeal[];
}

// Walk the user's last ~N real plans and resolve each served meal to a dish
// family (store lineage) or a bare title (live). Best-effort: a query failure
// returns an empty rotation rather than sinking plan generation (D-WS9-073 —
// the nudge must never be load-bearing enough to fail a request).
//
// ⚠️ The family hop MUST go through `sourceStoreMealId` to the ORIGINAL catalog
// meal's `dishFamilyKey`. The fork itself does NOT carry a usable key —
// cloneMealInto never copies `dishFamilyKey` onto a fork (it is null there), and
// even the catalog's own key is unique-per-title, so reading a fork's own key
// would silently produce a per-title nudge that groups nothing.
export async function buildRecentRotation(
  prisma: PrismaClient,
  userId: string,
  planDepth: number = RECENT_ROTATION_PLAN_DEPTH,
): Promise<RecentRotation> {
  try {
    // (1) The last N real (non-draft, non-archived) plans, newest first, with
    //     each item's meal + its catalog-lineage pointer. Plan-COUNT scoping is
    //     the `take` — no date window.
    const plans = await prisma.mealPlanInstance.findMany({
      where: { userId, isWizardDraft: false, isArchived: false },
      orderBy: { createdAt: "desc" },
      take: planDepth,
      select: {
        items: {
          select: {
            meal: {
              select: { id: true, title: true, sourceStoreMealId: true },
            },
          },
        },
      },
    });

    // (2) Batch-resolve store lineage: fork.sourceStoreMealId → the ORIGINAL
    //     catalog meal's dishFamilyKey (one query for all originals).
    const originalIds = new Set<string>();
    for (const p of plans) {
      for (const it of p.items) {
        const src = it.meal?.sourceStoreMealId;
        if (src) originalIds.add(src);
      }
    }
    const originals = originalIds.size
      ? await prisma.meal.findMany({
          where: { id: { in: [...originalIds] } },
          select: { id: true, dishFamilyKey: true },
        })
      : [];
    const familyKeyByOriginalId = new Map(
      originals.map((o) => [o.id, o.dishFamilyKey]),
    );

    // (3) Walk items in recency order; resolve each to a family (store) or a
    //     title (live), deduping by identity and counting recurrences.
    //     Write-back forks are NOT special-cased: a served meal is a served
    //     meal regardless of the meal's sourceType — if it carries lineage it
    //     resolves to a family, otherwise it falls back to title-only. An
    //     original that is archived/absent, or one missing dishFamilyKey (the
    //     measured 1/20 case), also falls back cleanly to title-only.
    const byIdentity = new Map<string, RecentRotationMeal>();
    for (const p of plans) {
      for (const it of p.items) {
        const meal = it.meal;
        if (!meal?.title) continue;
        const src = meal.sourceStoreMealId;
        const familyKey = src ? familyKeyByOriginalId.get(src) ?? null : null;
        const info = familyKey ? lookupDishFamily(familyKey) : null;
        if (info) {
          const key = `fam:${info.parentKey}`;
          const existing = byIdentity.get(key);
          if (existing) {
            existing.timesRecentlyServed += 1;
          } else {
            byIdentity.set(key, {
              title: meal.title,
              dishFamily: info.parentKey,
              familyRank: info.rank,
              timesRecentlyServed: 1,
            });
          }
        } else {
          const key = `title:${meal.title.trim().toLowerCase()}`;
          const existing = byIdentity.get(key);
          if (existing) {
            existing.timesRecentlyServed += 1;
          } else {
            byIdentity.set(key, { title: meal.title, timesRecentlyServed: 1 });
          }
        }
      }
    }

    return { plansConsidered: plans.length, meals: [...byIdentity.values()] };
  } catch (err) {
    logger.warn(
      { event: "recent_rotation_failed", userId, err },
      "Recent-rotation lineage query failed — nudge omitted this run",
    );
    return { plansConsidered: 0, meals: [] };
  }
}

// ── assembly ─────────────────────────────────────────────────────────────

export async function buildPlanningContext(
  prisma: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<PlanningContext> {
  const { currentDate, season } = getSeasonContext(now);
  const [recentMeals, recentPlanNames] = await Promise.all([
    buildRecentMealHistory(prisma, userId, now),
    buildRecentPlanNames(prisma, userId),
  ]);
  return {
    currentDate,
    season,
    upcomingEvents: getUpcomingEvents(now),
    recentMeals,
    recentPlanNames,
  };
}

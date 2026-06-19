// WS7-8b Block 2 — pure view-model for the Prep & Cook Hub (app/prep-cook.tsx).
//
// All hub presentation logic that doesn't touch React/hooks lives here so it
// is unit-testable in node:test without a renderer. The screen wires hooks
// (usePlan / usePlans) → buildPrepCookHubModel → <PrepCookHubView>.
//
// PREP-STATUS SOURCING (PRD §13.3 / §8.3.3) — the cardinal rule of this block:
// every prep signal is READ from the server, never recomputed from checkbox
// counts.
//   - plan-level `prepStatus` is the EFFECTIVE rollup (manual pin when
//     prepStatusIsManual, else the derived per-meal rollup). We consume it as-is.
//   - per-meal `isPrepped` is the server's derived "is every prep step for this
//     meal checked?" flag.
// The server exposes no per-meal *partial* datum (perMeal is boolean), so the
// only "Mostly prepped" signal available at the row level is the plan-level
// `partial` rollup — see mealPrepPill.

import type { PlanDetail, PlanDetailItem, PlanListItem } from "@/lib/api/plans";
import { formatDate } from "@/lib/date";
import { toDayOfWeek } from "@/lib/plans/dayOfWeek";

export type PrepStatus = "not_prepped" | "partial" | "prepped";

// Visual tone for status chips / pills. The screen maps tone → token colors:
//   sage    → sage-tint (prepped)
//   gold    → gold (partial / "mostly")
//   neutral → muted (not prepped / suggestion)
export type PillTone = "sage" | "gold" | "neutral";

export interface PrepPill {
  label: string;
  tone: PillTone;
}

/**
 * Per-meal prep pill for a "This week's meals" row.
 *
 * @param isPrepped       the meal's server-derived isPrepped flag (read, not computed).
 * @param planPrepStatus  the plan's EFFECTIVE prepStatus (read, not computed).
 *
 * `isPrepped` is the primary driver. A meal that isn't fully prepped shows
 * "Mostly prepped" only when the plan AS A WHOLE is `partial` — that plan-level
 * rollup is the only per-meal-mixed signal the server emits (there is no
 * per-meal partial value), so partial is READ off the plan, never derived from
 * how many steps happen to be checked.
 */
export function mealPrepPill(
  isPrepped: boolean,
  planPrepStatus: PrepStatus,
): PrepPill {
  if (isPrepped) return { label: "Prepped ✓", tone: "sage" };
  if (planPrepStatus === "partial") return { label: "Mostly prepped", tone: "gold" };
  return { label: "Not prepped", tone: "neutral" };
}

export interface PrepIndicator {
  label: string;
  tone: PillTone;
  /** not_prepped surfaces a call-to-action ("Start Prep"), not a status badge. */
  isSuggestion: boolean;
}

/**
 * Header prep-status indicator (PRD §8.3.3 style), driven by the EFFECTIVE
 * plan prepStatus. Read, never recomputed.
 */
export function headerPrepIndicator(prepStatus: PrepStatus): PrepIndicator {
  switch (prepStatus) {
    case "prepped":
      return { label: "Prepped this week ✓", tone: "sage", isSuggestion: false };
    case "partial":
      return { label: "Mostly prepped", tone: "gold", isSuggestion: false };
    case "not_prepped":
    default:
      return {
        label: "Start Prep to get ahead on the week",
        tone: "neutral",
        isSuggestion: true,
      };
  }
}

export interface HubMealRow {
  planItemId: string;
  mealId: string;
  title: string;
  thumbnailUrl?: string;
  /** "{day} · {minutes} min · serves {n}" */
  metaLine: string;
  isToday: boolean;
  pill: PrepPill;
}

export interface TodayMeal {
  planItemId: string;
  mealId: string;
  title: string;
}

export interface PrepCookHubModel {
  kind: "hub";
  planId: string;
  planName: string;
  /** Always [] today — PlanDetail carries no tags (see D-WS7-156). */
  tags: string[];
  /** Italic-dash subtitle (PRD §2.1 header). */
  subtitle: string;
  prepStatus: PrepStatus;
  indicator: PrepIndicator;
  /** "Prep the Week" lane is disabled/badged when the week is fully prepped. */
  prepWeekDisabled: boolean;
  todaysMeal: TodayMeal | null;
  meals: HubMealRow[];
}

/** A user plan offered in the empty state as a one-tap "cook this week". */
export interface PromotablePlan {
  id: string;
  name: string;
  /** "Jun 15 – Jun 21", a single date, or null when the plan is undated. */
  dateRangeLabel: string | null;
  thumbnailUrl?: string;
}

/**
 * Rendered when the Hub resolves no plan for this week (Option A fallback).
 * Carries the user's existing instance plans so the empty state can offer
 * promote-to-this-week alongside "Make a Plan".
 */
export interface PrepCookHubEmpty {
  kind: "empty";
  plans: PromotablePlan[];
}

export type HubModel = PrepCookHubModel | PrepCookHubEmpty;

type LiveItem = PlanDetailItem & {
  meal: NonNullable<PlanDetailItem["meal"]>;
};

function isLive(item: PlanDetailItem): item is LiveItem {
  return item.meal !== null;
}

/**
 * Today's meal = a live item whose assignedDayOfWeek is today, preferring a
 * dinner. We match on the day-of-week label (not assignedDate) to stay free of
 * the UTC-vs-local off-by-one that bites bare-date columns — the same choice
 * the Plan Review adapter makes for day clustering.
 */
export function resolveTodaysMeal(
  liveItems: LiveItem[],
  todayDayName: string,
): TodayMeal | null {
  const todays = liveItems.filter(
    (it) => toDayOfWeek(it.assignedDayOfWeek) === todayDayName,
  );
  if (todays.length === 0) return null;
  const pick = todays.find((it) => it.isDinner) ?? todays[0];
  return { planItemId: pick.id, mealId: pick.mealId, title: pick.meal.title };
}

/**
 * Build the full hub model from a PlanDetail. `todayDayName` is injected (a
 * canonical "Sunday".."Saturday" label) so this stays pure/deterministic for
 * tests — the screen passes DAY_OF_WEEK_VALUES[new Date().getDay()].
 *
 * `tags` is injected too: GET /plans/:id carries no tags, so the screen sources
 * them from the discovery list it already loads (PlanListItem.tags), looking
 * the plan up by id. Empty when the plan isn't on the loaded list page. This is
 * the interim D-WS7-156 approach — a detail-endpoint projection bump would let
 * the Hub read tags directly.
 */
export function buildPrepCookHubModel(
  detail: PlanDetail,
  todayDayName: string,
  tags: string[] = [],
): PrepCookHubModel {
  const liveItems = detail.items.filter(isLive);
  const prepStatus = detail.prepStatus;
  const todaysMeal = resolveTodaysMeal(liveItems, todayDayName);

  const meals: HubMealRow[] = liveItems.map((item) => {
    const meal = item.meal;
    const day = item.assignedDayOfWeek ?? "Unscheduled";
    const serves = item.servingsOverride ?? meal.servings;
    return {
      planItemId: item.id,
      mealId: item.mealId,
      title: meal.title,
      thumbnailUrl: meal.image ?? undefined,
      metaLine: `${day} · ${meal.minutes} min · serves ${serves}`,
      isToday: todaysMeal?.planItemId === item.id,
      pill: mealPrepPill(item.isPrepped, prepStatus),
    };
  });

  const mealCount = meals.length;
  return {
    kind: "hub",
    planId: detail.id,
    planName: detail.name,
    // Sourced from the discovery list (PlanListItem.tags) by the screen, since
    // PlanDetail itself carries none. NOTE: tags are slated for removal from the
    // Hub header in the next block (product decision — they don't belong here).
    tags,
    subtitle: `— ${mealCount} ${mealCount === 1 ? "meal" : "meals"} this week`,
    prepStatus,
    indicator: headerPrepIndicator(prepStatus),
    prepWeekDisabled: prepStatus === "prepped",
    todaysMeal,
    meals,
  };
}

// ── Empty-state: promote an existing plan ───────────────────────────────────

/**
 * "Jun 15 – Jun 21" / "Jun 15" / null. Pure; uses lib/date.formatDate so the
 * empty-state cards read the same date format as the rest of the app.
 */
export function formatPlanDateRange(
  startDate: string | null,
  endDate: string | null,
): string | null {
  if (startDate && endDate) {
    return `${formatDate(startDate)} – ${formatDate(endDate)}`;
  }
  if (startDate) return formatDate(startDate);
  if (endDate) return formatDate(endDate);
  return null;
}

/**
 * The user's promotable plans for the null-plan empty state: instance plans
 * only (templates must be instantiated via Use Plan before they can be a week),
 * mapped to the card shape (name + date range; NO meal count — not on the list
 * payload, see D-WS7-156 re: the pagination gap / list projection). Order is
 * preserved from the server list.
 */
export function buildPromotablePlans(plans: PlanListItem[]): PromotablePlan[] {
  return plans
    .filter((p) => p.source === "instance")
    .map((p) => ({
      id: p.id,
      name: p.name,
      dateRangeLabel: formatPlanDateRange(p.startDate, p.endDate),
      thumbnailUrl: p.image ?? undefined,
    }));
}

/**
 * Decide which plan id the Hub should load (Option A). An explicit route param
 * wins; otherwise fall back to the server's "this week" plan. Returned as a
 * pure decision so the promote-then-resolve transition is testable without the
 * screen: before promote `activeThisWeekId` is undefined → null (empty state);
 * after the promote's ["plans"] invalidation refetches, it is the promoted id →
 * the Hub resolves to that plan with no navigation.
 */
export function resolveHubPlanId(
  explicitId: string,
  activeThisWeekId: string | undefined,
  plansLoading: boolean,
): { planId: string } | { planId: null; resolving: boolean } {
  const id = explicitId.length > 0 ? explicitId : activeThisWeekId ?? "";
  if (id.length > 0) return { planId: id };
  return { planId: null, resolving: plansLoading };
}

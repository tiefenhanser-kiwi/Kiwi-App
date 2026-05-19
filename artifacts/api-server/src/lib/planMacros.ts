// WS6 6b-3 — Plan walker + macro aggregator.
// Per kiwi_ws6_plan.md §3 6b-3 + D-WS5-007.
//
// Walks a MealPlanInstance → items → meal → MealDishLink → Dish, runs
// the 6b-2 estimateDishMacros helper per dish (cached when stored macros
// are non-zero AND no per-instance overrides exist), aggregates per
// MealPlanItem, per assignedDayOfWeek, and computes a daily average for
// the Plan Review screen.
//
// Persistence side-effects (when an item has NO overrides and the dish
// was at zero macros):
//   - Dish.{calories,protein,carbs,fat}PerServing written back so the
//     next recalc hits the cache.
//   - dish_macros_estimated activity event emitted per fresh persist.
//
// Override-bearing items always recompute, never persist back (overrides
// are per-instance, not canonical).
//
// One plan_macros_recalculated activity event is emitted per recalc.

import type { PrismaClient } from "@prisma/client";
import type Anthropic from "@anthropic-ai/sdk";

import { estimateDishMacros } from "./dishMacros";
import { logger } from "./logger";
import {
  hasOverrides,
  resolveEffectiveIngredients,
} from "./overrideResolver";

export interface PlanMacrosOptions {
  prisma: PrismaClient;
  userId: string;
  planId: string;
  // DI seam for tests; production callers omit and runAICall builds its
  // own Anthropic client from process.env.
  client?: Pick<Anthropic, "messages">;
}

export interface MacroTotals {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

// Daily-average shape uses the per-day suffix so the field names match
// PRD §11 "per day" framing + the mobile MacroDailyAverage type at
// kiwi/lib/types.ts:188 (consumed by ReviewPlan.macroDailyAverage).
// MacroTotals stays the per-meal / per-day-totals shape — they're rollups,
// not averages, and the bare field names align with Dish.*PerServing.
export interface DailyMacros {
  caloriesPerDay: number;
  proteinGPerDay: number;
  carbsGPerDay: number;
  fatGPerDay: number;
}

export interface DishMacroEntry {
  dishId: string;
  dishTitle: string;
  macros: MacroTotals;
  status: "cached" | "computed" | "failed";
  caveats?: string[];
}

export interface MealMacroEntry {
  mealPlanItemId: string;
  mealId: string;
  mealTitle: string;
  assignedDayOfWeek: string | null;
  dishMacros: DishMacroEntry[];
}

export interface PerDayEntry {
  day: string;
  totals: MacroTotals;
  mealCount: number;
}

export interface PlanMacrosResult {
  dailyAverages: DailyMacros;
  perDay: PerDayEntry[];
  perMeal: MealMacroEntry[];
  computedAt: string; // ISO
  hasEstimatedMacros: boolean;
  estimationCaveats: string[];
}

export class PlanMacrosNotFoundError extends Error {
  constructor(planId: string) {
    super(`plan ${planId} not found`);
    this.name = "PlanMacrosNotFoundError";
  }
}

export class PlanMacrosForbiddenError extends Error {
  constructor(planId: string) {
    super(`plan ${planId} not owned by caller`);
    this.name = "PlanMacrosForbiddenError";
  }
}

const ZERO: MacroTotals = { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 };

function dishHasStoredMacros(dish: {
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
}): boolean {
  return (
    dish.caloriesPerServing > 0 ||
    dish.proteinGPerServing > 0 ||
    dish.carbsGPerServing > 0 ||
    dish.fatGPerServing > 0
  );
}

function roundCalories(v: number): number {
  return Math.round(v);
}

function roundGrams(v: number): number {
  return Math.round(v * 10) / 10;
}

function roundTotals(t: MacroTotals): MacroTotals {
  return {
    calories: roundCalories(t.calories),
    proteinG: roundGrams(t.proteinG),
    carbsG: roundGrams(t.carbsG),
    fatG: roundGrams(t.fatG),
  };
}

function addInto(into: MacroTotals, add: MacroTotals): void {
  into.calories += add.calories;
  into.proteinG += add.proteinG;
  into.carbsG += add.carbsG;
  into.fatG += add.fatG;
}

export async function computePlanMacros(
  opts: PlanMacrosOptions,
): Promise<PlanMacrosResult> {
  const { prisma, userId, planId, client } = opts;

  const plan = await prisma.mealPlanInstance.findUnique({
    where: { id: planId },
    include: {
      items: {
        orderBy: { positionIndex: "asc" },
        include: {
          meal: {
            include: {
              dishLinks: {
                orderBy: { positionIndex: "asc" },
                include: {
                  dish: {
                    include: {
                      dishIngredients: {
                        orderBy: { positionIndex: "asc" },
                        include: { ingredient: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!plan) throw new PlanMacrosNotFoundError(planId);
  if (plan.userId !== userId) throw new PlanMacrosForbiddenError(planId);

  // Build the work list. One entry per (item, dish) pair so we can run
  // them in parallel — Promise.all over async dish work, then aggregate.
  type Pending = {
    itemId: string;
    mealId: string;
    mealTitle: string;
    assignedDayOfWeek: string | null;
    itemHasOverrides: boolean;
    dishId: string;
    dishTitle: string;
    storedMacros: MacroTotals;
    storedHasMacros: boolean;
    effectiveIngredients: ReturnType<typeof resolveEffectiveIngredients>;
    servings: number;
  };

  const pending: Pending[] = [];
  for (const item of plan.items) {
    const itemOverrides = hasOverrides(item);
    for (const link of item.meal.dishLinks) {
      const dish = link.dish;
      const stored: MacroTotals = {
        calories: dish.caloriesPerServing,
        proteinG: dish.proteinGPerServing,
        carbsG: dish.carbsGPerServing,
        fatG: dish.fatGPerServing,
      };
      pending.push({
        itemId: item.id,
        mealId: item.mealId,
        mealTitle: item.meal.title,
        assignedDayOfWeek: item.assignedDayOfWeek,
        itemHasOverrides: itemOverrides,
        dishId: dish.id,
        dishTitle: dish.title,
        storedMacros: stored,
        storedHasMacros: dishHasStoredMacros(dish),
        effectiveIngredients: resolveEffectiveIngredients(item, dish),
        servings:
          item.servingsOverride ??
          dish.servingsDefault ??
          plan.items[0]?.servingsOverride ??
          4,
      });
    }
  }

  // Parallel dish work. Per-dish branches into cached / computed / failed.
  type DishOutcome = DishMacroEntry & {
    pending: Pending;
    persistMacros?: MacroTotals;
  };

  const outcomes: DishOutcome[] = await Promise.all(
    pending.map(async (p): Promise<DishOutcome> => {
      // Cache hit: stored macros are non-zero AND no overrides on item.
      if (p.storedHasMacros && !p.itemHasOverrides) {
        return {
          dishId: p.dishId,
          dishTitle: p.dishTitle,
          macros: p.storedMacros,
          status: "cached",
          pending: p,
        };
      }

      // AI path. Override-bearing items always land here; so do dishes at zero.
      const result = await estimateDishMacros({
        prisma,
        userId,
        client,
        dishTitle: p.dishTitle,
        servings: p.servings,
        ingredients: p.effectiveIngredients,
      });

      if (result.status === "failed") {
        return {
          dishId: p.dishId,
          dishTitle: p.dishTitle,
          macros: ZERO,
          status: "failed",
          pending: p,
        };
      }

      const macros: MacroTotals = {
        calories: result.perServing.calories,
        proteinG: result.perServing.proteinG,
        carbsG: result.perServing.carbsG,
        fatG: result.perServing.fatG,
      };

      // Persist back ONLY when the dish was at zero AND the item has no
      // overrides (canonical macros, not an instance-specific variant).
      const shouldPersist = !p.storedHasMacros && !p.itemHasOverrides;

      return {
        dishId: p.dishId,
        dishTitle: p.dishTitle,
        macros,
        status: "computed",
        caveats: result.caveats,
        pending: p,
        persistMacros: shouldPersist ? macros : undefined,
      };
    }),
  );

  // Persist canonical macros + emit dish_macros_estimated for each fresh
  // compute. Sequential is fine here — small N, low latency, simpler than
  // a transaction across N updates.
  for (const o of outcomes) {
    if (!o.persistMacros) continue;
    try {
      await prisma.dish.update({
        where: { id: o.dishId },
        data: {
          caloriesPerServing: o.persistMacros.calories,
          proteinGPerServing: o.persistMacros.proteinG,
          carbsGPerServing: o.persistMacros.carbsG,
          fatGPerServing: o.persistMacros.fatG,
        },
      });
      await prisma.userActivity.create({
        data: {
          userId,
          eventType: "dish_macros_estimated",
          entityId: o.dishId,
          platform: "api",
        },
      });
    } catch (err) {
      logger.warn(
        { event: "dish_persist_failed", userId, dishId: o.dishId, err },
        "Failed to persist freshly-computed dish macros",
      );
      // Don't fail the whole recalc — the value is still in the response.
    }
  }

  // Aggregate per-meal-item.
  const perMealMap = new Map<string, MealMacroEntry>();
  for (const o of outcomes) {
    const p = o.pending;
    let entry = perMealMap.get(p.itemId);
    if (!entry) {
      entry = {
        mealPlanItemId: p.itemId,
        mealId: p.mealId,
        mealTitle: p.mealTitle,
        assignedDayOfWeek: p.assignedDayOfWeek,
        dishMacros: [],
      };
      perMealMap.set(p.itemId, entry);
    }
    entry.dishMacros.push({
      dishId: o.dishId,
      dishTitle: o.dishTitle,
      macros: roundTotals(o.macros),
      status: o.status,
      caveats: o.caveats,
    });
  }

  // Order perMeal by the original item order (positionIndex was the
  // include's orderBy, so plan.items is already in order).
  const perMeal: MealMacroEntry[] = plan.items
    .map((it) => perMealMap.get(it.id))
    .filter((e): e is MealMacroEntry => !!e);

  // Per-day rollups. Items without an assigned day are excluded from
  // per-day totals (and therefore from the daily-average denominator)
  // but still appear in perMeal so callers can show them as unscheduled.
  const perDayMap = new Map<string, PerDayEntry>();
  for (const meal of perMeal) {
    if (!meal.assignedDayOfWeek) continue;
    const day = meal.assignedDayOfWeek;
    let dayEntry = perDayMap.get(day);
    if (!dayEntry) {
      dayEntry = { day, totals: { ...ZERO }, mealCount: 0 };
      perDayMap.set(day, dayEntry);
    }
    dayEntry.mealCount += 1;
    for (const dm of meal.dishMacros) {
      addInto(dayEntry.totals, dm.macros);
    }
  }

  const perDay: PerDayEntry[] = [...perDayMap.values()].map((e) => ({
    day: e.day,
    totals: roundTotals(e.totals),
    mealCount: e.mealCount,
  }));

  // Daily averages: sum-of-per-day-totals / number of unique days with
  // at least one meal. PRD §11 — whole calories, one-decimal grams.
  const dayCount = perDay.length;
  const summed: MacroTotals = { ...ZERO };
  for (const d of perDay) addInto(summed, d.totals);
  const dailyAverages: DailyMacros =
    dayCount === 0
      ? { caloriesPerDay: 0, proteinGPerDay: 0, carbsGPerDay: 0, fatGPerDay: 0 }
      : {
          caloriesPerDay: roundCalories(summed.calories / dayCount),
          proteinGPerDay: roundGrams(summed.proteinG / dayCount),
          carbsGPerDay: roundGrams(summed.carbsG / dayCount),
          fatGPerDay: roundGrams(summed.fatG / dayCount),
        };

  // Did any dish ship as estimated (cached-from-prior-estimation OR
  // freshly-computed)? Cached dishes that came from a prior recalc count
  // as estimated; we have no provenance flag yet (D-WS6-024 / D-WS6-025
  // will add `dataSource`). For MVP, ANY non-failed dish that went
  // through the AI helper now or before is treated as estimated.
  const hasEstimatedMacros = outcomes.some(
    (o) => o.status !== "failed",
  );

  // Dedupe caveats across all dishes (fresh computes only — cached dishes
  // don't carry caveats today).
  const caveatSet = new Set<string>();
  for (const o of outcomes) {
    if (o.caveats) for (const c of o.caveats) caveatSet.add(c);
  }

  // Single plan-level activity event per recalc.
  try {
    await prisma.userActivity.create({
      data: {
        userId,
        eventType: "plan_macros_recalculated",
        entityId: planId,
        platform: "api",
      },
    });
  } catch (err) {
    logger.warn(
      { event: "plan_macros_activity_failed", userId, planId, err },
      "Failed to emit plan_macros_recalculated activity",
    );
  }

  return {
    dailyAverages,
    perDay,
    perMeal,
    computedAt: new Date().toISOString(),
    hasEstimatedMacros,
    estimationCaveats: [...caveatSet],
  };
}

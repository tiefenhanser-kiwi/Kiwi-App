// WS6 6d-2 / WS7-8a B2 — Prep the Week loader.
// Per kiwi_ws6_plan.md §3 6d-2 + PRD §13.4 / §13.4.6.
//
// Loads a MealPlanInstance into the enriched PrepLoadedPlan shape the
// deterministic combine engine needs: per-ingredient `category` (off the
// Ingredient row), per-dish `baseServings` (dish.servingsDefault), and the
// plan-item `servingsOverride` — so the adapter can scale RAW quantities to
// effective ones. Pure data prep; does NOT invoke the AI. Caller also receives
// the plan's `revisionId` so the cache writer can stamp
// `lastGeneratedFromPlanRevisionId` on the PrepWeekStructure row.
//
// WS7-8a B2: quantities are now left RAW here and scaled in the adapter
// (prepCombineAdapter.ts), mirroring groceryList.ts (base = dish.servingsDefault).
// The old all-AI PrepWeekInput shape (which scaled in the AI prompt) is retired.

import type { DishRole, PrismaClient } from "@prisma/client";

import { resolvePrepCategory } from "./prepCategoryOverride";
import { selectDefaultPathSteps } from "./cookingScheduler";

/** Group already-ordered rows by ownerId, preserving order within each owner. */
function groupByOwner<T extends { ownerId: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const list = out.get(r.ownerId);
    if (list) list.push(r);
    else out.set(r.ownerId, [r]);
  }
  return out;
}

// ── enriched loader output (engine-ready, pre-scaling) ──────────────────────

export interface PrepLoadedIngredient {
  ingredientId: string;
  ingredientName: string;
  // The category the PREP pipeline sees. Normally Ingredient.category (always
  // present — required column); for the BUG-186 override set it is the pinned
  // token instead. Drives phase, blend eligibility AND prep-worthy
  // classification in the engine — all three, which is why the override lands
  // here rather than on any one of them.
  category: string;
  // RAW dish-ingredient quantity (NOT servings-scaled). The adapter scales.
  quantity: number;
  unit: string;
  preparationNote: string | null;
  /**
   * WS9 BUG-338 / D-WS9-297 ruling 8 — where this ingredient COMES FROM, when
   * it is a derived component of a whole one.
   *
   * The census (P-R6): every plan that prepped citrus counted it twice. "Prep
   * all limes" portions 1 juiced lime plus wedges; "Measure all lime juice: 3
   * tbsp + 2 tbsp + 2 tbsp" then asks for juice and NEVER SAYS HOW MANY LIMES.
   * A blind follower has one lime and a demand for 7 tbsp.
   *
   * `ingredient_relations` already answers it: a `component` edge carries
   * yieldQuantity/yieldUnit ("lemon -> lemon juice : 3 tbsp", D-WS9-194), which
   * is exactly the number that was missing. Null for an ingredient with no
   * component parent, which is nearly all of them.
   */
  sourceYield: { fromName: string; quantity: number; unit: string } | null;
}

export interface PrepLoadedDish {
  dishId: string;
  dishName: string;
  // WS7-8b #4 — MealDishLink.roleLabel (DishRole enum: main|side|sauce|
  // topping|base|optional). Available with zero query change (the include
  // returns all MealDishLink scalars). Threaded to the engine so the narrator
  // can judge KEEP-vs-DEMOTE structurally.
  dishRole: DishRole;
  // dish.servingsDefault — the live base; also the numerator's no-override
  // fallback (matches groceryList.ts).
  baseServings: number;
  // WS7-8 BUG-003 — dish.authoredServingsDefault, the immutable scaling
  // DENOMINATOR. Null for legacy/seed rows; the adapter falls back to
  // baseServings so a null anchor degrades to today's behavior.
  authoredBaseServings: number | null;
  ingredients: PrepLoadedIngredient[];
  // WS7-8a B2b (D-WS7-150) — raw instruction-step text for this dish, in
  // stepIndex order, so the narration layer can judge combine-vs-season from
  // prose. Includes the dish's own (ownerType="dish") steps AND its meal's
  // (ownerType="meal") steps folded in — single-dish meals keep meal-owned
  // steps, so a dish-centric consumer would otherwise miss them entirely.
  // RecipeInstructionStep is polymorphic (ownerType/ownerId, app-enforced),
  // so this is a separate keyed query, not a relation traversal.
  stepTexts: string[];
}

export interface PrepLoadedMeal {
  mealId: string;
  mealName: string;
  cuisine: string | null;
  // plan-item servingsOverride (null = use each dish's baseServings).
  servingsOverride: number | null;
  // ── WS9 BUG-338 / D-WS9-297 ruling 13 — THE COOK DAY, AT LAST ─────────────
  //
  // Part A's finding: this loader read NO date field, so every storage note the
  // narrator wrote ("keep up to 2 days") was a guess by a model that could not
  // know when the meal was cooked. Measured: 57 windows that expire before their
  // own cook day across 7 of 13 plans, max lag 5 days, 15 of them raw flesh.
  //
  // MealPlanItem.assignedDate / assignedDayOfWeek, free — the loader's `items`
  // uses `include`, so every scalar was already coming back and being dropped.
  // Null when the plan has no day assignment (6 of the 13 census plans).
  //
  // B1 THREADS IT AND MEASURES IT. It does NOT change what a storage note says:
  // the shape of the fix (a mid-week session / cook-day prep / freezing) is B3's,
  // and Hans's.
  assignedDate: string | null;
  assignedDayOfWeek: string | null;
  dishes: PrepLoadedDish[];
}

export interface PrepLoadedPlan {
  planId: string;
  planName: string;
  /**
   * D-WS9-297 ruling 13 — the day the prep session happens, as an ISO date, and
   * the baseline every `daysUntilCook` is measured from.
   *
   * ⚠️ NO COLUMN STORES THIS. Prep runs before the week, so the plan's own
   * `startDate` is the only answer the data offers; failing that, the earliest
   * assigned meal date. Null when the plan carries neither, and then no lag can
   * be computed at all — which is 6 of the 13 census plans and is why B3's shape
   * has to cope with not knowing.
   */
  prepDay: string | null;
  meals: PrepLoadedMeal[];
}

// Route handler maps NotFoundError → 404; access leak prevention follows
// the cookingSequence pattern (treat missing + forbidden as 404).
export class PrepWeekNotFoundError extends Error {
  constructor(planId: string) {
    super(`plan ${planId} not found`);
    this.name = "PrepWeekNotFoundError";
  }
}

export const EMPTY_PLAN_COPY =
  "Kiwi didn't find anything to prep for this plan — add some meals first.";

export class PrepWeekEmptyPlanError extends Error {
  constructor(planId: string) {
    super(`plan ${planId} has nothing to aggregate`);
    this.name = "PrepWeekEmptyPlanError";
  }
}

// WS9 — Prep Selected Meals. A subset request naming a mealId the plan does not
// contain is REJECTED (route → 400), never silently narrowed: dropping an
// unknown id would prep a different set of meals than the caller asked for and
// return a result that looks entirely correct. Carries the offending ids so the
// error names them.
export class PrepWeekUnknownMealError extends Error {
  readonly unknownMealIds: string[];
  constructor(planId: string, unknownMealIds: string[]) {
    super(
      `plan ${planId} does not contain meal(s) ${unknownMealIds.join(", ")}`,
    );
    this.name = "PrepWeekUnknownMealError";
    this.unknownMealIds = unknownMealIds;
  }
}

export interface LoadPrepWeekInputParams {
  planId: string;
  userId: string;
  prisma: PrismaClient;
  // WS9 — Prep Selected Meals. When present, the aggregation runs over ONLY
  // these plan meals; absent (the default) is the unchanged full-week path.
  // Filtering lives HERE rather than in the route so one code path serves both
  // — the engine, the step plan, the narration input and the assembled result
  // are all built from whatever `meals` this loader returns, and none of them
  // needs to know a subset happened. Every id must belong to the plan
  // (PrepWeekUnknownMealError otherwise).
  mealIds?: string[];
  // D-WS9-049 A2.1 — the isPrepped/prepStatus derivation (loadPrepStepSet →
  // GET /plans/:id) only needs stepKey + contributesToMealIds, which come from
  // ingredients alone; it calls buildStepPlan WITHOUT step text. On that path
  // the two per-owner RecipeInstructionStep queries below are pure waste. Pass
  // false to skip them (each dish keeps stepTexts=[]). Defaults true so the
  // narration generate path (which DOES judge combine-vs-season) is unchanged.
  includeStepTexts?: boolean;
}

export interface LoadPrepWeekInputResult {
  input: PrepLoadedPlan;
  planRevisionId: number;
}

export async function loadPrepWeekInput(
  params: LoadPrepWeekInputParams,
): Promise<LoadPrepWeekInputResult> {
  const { planId, userId, prisma, includeStepTexts = true, mealIds } = params;

  // Minimal include shape mirroring planMacros.ts — items → meal → dishes
  // → dishIngredients → ingredient. No user-prefs branch (pantry / picky
  // avoidances don't shape prep-aggregation scheduling).
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

  // Access check — treat missing + forbidden as NotFound to avoid leaking
  // plan existence to non-owners (matches groceryList.ts / cookingSequence
  // convention).
  if (!plan) throw new PrepWeekNotFoundError(planId);
  if (plan.userId !== userId) throw new PrepWeekNotFoundError(planId);

  // WS9 — subset membership. Checked against the RAW plan items (before any
  // no-dish / no-ingredient filtering below), because "belongs to this plan" is
  // a fact about the plan's contents, not about whether that meal happens to
  // yield prep steps. A selected meal that is in the plan but contributes
  // nothing prep-worthy falls through to the empty-plan 400 further down, which
  // is a different — and accurate — answer than "that meal isn't in this plan".
  // Runs BEFORE the empty-plan check so a bad id is always named precisely.
  const selectedMealIds = mealIds ? new Set(mealIds) : null;
  if (selectedMealIds) {
    const planMealIds = new Set(plan.items.map((i) => i.mealId));
    const unknown = [...selectedMealIds].filter((id) => !planMealIds.has(id));
    if (unknown.length > 0) {
      throw new PrepWeekUnknownMealError(planId, unknown);
    }
  }

  if (plan.items.length === 0) throw new PrepWeekEmptyPlanError(planId);

  // Build the enriched per-meal payload. Quantities stay RAW; the adapter
  // scales per-dish off dish.servingsDefault using item.servingsOverride
  // (carried through here as servingsOverride). category + baseServings are
  // already fetched by the include below — we just stop dropping them.
  const meals: PrepLoadedMeal[] = [];
  for (const item of plan.items) {
    const meal = item.meal;
    // WS9 — the subset filter. The ONLY place a subset differs from a full
    // week; everything downstream consumes `meals` and is untouched.
    if (selectedMealIds && !selectedMealIds.has(item.mealId)) continue;
    if (meal.dishLinks.length === 0) continue;

    const dishes: PrepLoadedDish[] = meal.dishLinks
      .map((link) => {
        const dish = link.dish;
        const ingredients: PrepLoadedIngredient[] = dish.dishIngredients.map(
          (di) => ({
            ingredientId: di.ingredient.id,
            ingredientName: di.ingredient.displayName,
            // WS9 BUG-186 — the PREP pipeline's view of category, which the
            // aisle fix must not disturb. Identity for every row without an
            // override entry. See prepCategoryOverride.ts for the rulings.
            category: resolvePrepCategory(
              di.ingredient.displayName,
              di.ingredient.category,
            ),
            quantity: di.quantity,
            unit: di.unit,
            preparationNote: di.preparationNote ?? null,
            // Filled after the loop — the relation read needs every ingredient
            // id the plan touches, which is not known until the loop is done.
            sourceYield: null,
          }),
        );
        return {
          dishId: dish.id,
          dishName: dish.title,
          dishRole: link.roleLabel,
          baseServings: dish.servingsDefault,
          authoredBaseServings: dish.authoredServingsDefault,
          ingredients,
          stepTexts: [] as string[], // filled below from a keyed step query
        };
      })
      // Skip dishes with no ingredients — nothing to prep.
      .filter((d) => d.ingredients.length > 0);

    if (dishes.length === 0) continue;

    meals.push({
      mealId: meal.id,
      mealName: meal.title,
      cuisine: meal.cuisineType ?? null,
      servingsOverride: item.servingsOverride,
      assignedDate: item.assignedDate ? item.assignedDate.toISOString().slice(0, 10) : null,
      assignedDayOfWeek: item.assignedDayOfWeek ?? null,
      dishes,
    });
  }

  // After filtering empty meals/dishes, we may still have nothing to prep —
  // treat as empty plan.
  if (meals.length === 0) throw new PrepWeekEmptyPlanError(planId);

  // ── WS9 BUG-338 / D-WS9-297 ruling 8 — how many limes is that ─────────────
  //
  // One keyed read, scoped to the ingredient ids this plan actually uses, for
  // the `component` edges that say what a derived ingredient comes FROM. The
  // edge is DIRECTED and the direction matters: `from` is the thing you buy
  // (lime), `to` is the thing the recipe calls for (lime juice) — so the lookup
  // is keyed on `to`.
  //
  // Only `component` carries a yield. `subsumes` deliberately does not
  // (schema.prisma:872 — "the same object under two names" has no quantity), and
  // reading one here would invent arithmetic.
  const allIngredientIds = [
    ...new Set(meals.flatMap((m) => m.dishes.flatMap((d) => d.ingredients.map((i) => i.ingredientId)))),
  ];
  if (allIngredientIds.length > 0) {
    const edges = await prisma.ingredientRelation.findMany({
      where: {
        toIngredientId: { in: allIngredientIds },
        label: "component",
        yieldQuantity: { not: null },
        yieldUnit: { not: null },
      },
      select: {
        toIngredientId: true,
        yieldQuantity: true,
        yieldUnit: true,
        from: { select: { canonicalName: true } },
      },
    });
    // An ingredient can in principle have more than one component parent; take
    // the first by a stable key so a regenerate is deterministic (the prep
    // fingerprint hashes this output).
    const byTo = new Map<string, (typeof edges)[number]>();
    for (const e of [...edges].sort((a, b) => a.from.canonicalName.localeCompare(b.from.canonicalName))) {
      if (!byTo.has(e.toIngredientId)) byTo.set(e.toIngredientId, e);
    }
    for (const meal of meals) {
      for (const dish of meal.dishes) {
        for (const ing of dish.ingredients) {
          const e = byTo.get(ing.ingredientId);
          if (!e || e.yieldQuantity === null || e.yieldUnit === null) continue;
          ing.sourceYield = {
            fromName: e.from.canonicalName,
            quantity: e.yieldQuantity,
            unit: e.yieldUnit,
          };
        }
      }
    }
  }

  // WS7-8a B2b — fetch instruction-step text for BOTH polymorphic owner
  // types (mirrors cookingSequence.ts:107-111). Dish-owned steps cover
  // multi-dish meals; meal-owned steps cover single-dish meals. We can't
  // JOIN (the FK is app-enforced), so it's two keyed findMany calls.
  // D-WS9-049 A2.1 — skipped entirely when the caller doesn't judge step text
  // (the isPrepped/prepStatus path), leaving every dish's stepTexts = [].
  if (includeStepTexts) {
    const dishIds = meals.flatMap((m) => m.dishes.map((d) => d.dishId));
    const mealIds = meals.map((m) => m.mealId);
    const [dishSteps, mealSteps] = await Promise.all([
      prisma.recipeInstructionStep.findMany({
        where: { ownerType: "dish", ownerId: { in: dishIds } },
        orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }],
        // [grocery] B3 (D-WS9-277 Rule 3) — the component tags ride along so the
        // path filter below can run. See the note at that filter.
        select: { ownerId: true, stepTextRaw: true, componentKey: true, pathKey: true },
      }),
      prisma.recipeInstructionStep.findMany({
        where: { ownerType: "meal", ownerId: { in: mealIds } },
        orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }],
        select: { ownerId: true, stepTextRaw: true, componentKey: true, pathKey: true },
      }),
    ]);

    // ── [grocery] B3 (D-WS9-277 Rule 3) — PREP-WEEK READS THE SELECTED PATH ───
    //
    // This read had no path filter, so a dish with a swappable component handed
    // the prep judge BOTH alternatives: "Measure ½ cup basil pesto from the jar"
    // AND the four steps that make pesto from scratch. The judge then proposed
    // prep tasks for a path the cook is not taking. Rule 3 says the recipe, the
    // timing and the prep week all read one path, and this is the third of them.
    const selectOwned = <T extends { componentKey: string | null; pathKey: string | null }>(
      rows: T[],
    ): T[] => selectDefaultPathSteps(rows);
    const dishStepsByOwner = new Map<string, string[]>();
    for (const [owner, rows] of groupByOwner(dishSteps)) {
      dishStepsByOwner.set(owner, selectOwned(rows).map((s) => s.stepTextRaw));
    }
    const mealStepsByOwner = new Map<string, string[]>();
    for (const [owner, rows] of groupByOwner(mealSteps)) {
      mealStepsByOwner.set(owner, selectOwned(rows).map((s) => s.stepTextRaw));
    }

    // Fold a dish's own steps + its meal's steps into one list. For multi-dish
    // meals the meal list is empty; for single-dish meals the dish list is
    // empty — so each dish ends up with the steps that actually cook it.
    for (const meal of meals) {
      const mealOwned = mealStepsByOwner.get(meal.mealId) ?? [];
      for (const dish of meal.dishes) {
        const dishOwned = dishStepsByOwner.get(dish.dishId) ?? [];
        dish.stepTexts = [...dishOwned, ...mealOwned];
      }
    }
  }

  const planName =
    plan.titleOverride ??
    `Plan ${plan.id.slice(0, 8)}`;

  // D-WS9-297 ruling 13 — the prep-day baseline. startDate first (the plan's own
  // claim about when the week begins), else the earliest assigned meal.
  const assignedDates = meals
    .map((m) => m.assignedDate)
    .filter((d): d is string => d !== null)
    .sort();
  const prepDay =
    (plan.startDate ? plan.startDate.toISOString().slice(0, 10) : null) ??
    assignedDates[0] ??
    null;

  return {
    input: {
      planId: plan.id,
      planName,
      prepDay,
      meals,
    },
    planRevisionId: plan.revisionId,
  };
}

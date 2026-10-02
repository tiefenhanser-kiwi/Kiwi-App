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
import type { ComponentStep } from "./prepComponents";

/**
 * H3 item 14 — weekday name → `Date.getUTCDay()` index. Lowercased on lookup so
 * a stored "monday" and a stored "Monday" are one day.
 */
const DAY_INDEX: Readonly<Record<string, number>> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

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
  /**
   * WS9 D-WS9-296 — the same steps, with what the COMPONENT derivation needs:
   * the componentKey tag and the ingredientIds `amountRefs` resolved to.
   * `stepTexts` above stays as it is because the narration input's shared
   * `dishSteps` map is keyed on prose alone and must not change shape.
   *
   * 🔴 THE TEXT HERE IS `stepTextTranslated`, not `stepTextRaw`. There are two
   * columns and `toStepShape` renders the translated one, so that is the
   * sentence the cook reads and the only one a derivation may reason from.
   * They are identical on all 30,718 dev rows, which is exactly why reading
   * the wrong one went unnoticed for a whole block (B1 F).
   */
  componentSteps: ComponentStep[];
}

export interface PrepLoadedMeal {
  mealId: string;
  mealName: string;
  cuisine: string | null;
  // plan-item servingsOverride (null = use each dish's baseServings).
  servingsOverride: number | null;
  dishes: PrepLoadedDish[];
}

// ── WS9 BUG-338 / D-WS9-298 — THE COOK DAY RIDES BESIDE THE INPUT, NOT IN IT ─
//
// 🔴 B1 PUT THESE FIELDS ON `PrepLoadedMeal` AND THAT WAS THE WRONG PLACE.
// `prepCompositionFingerprint` hashes the WHOLE of `PrepLoadedPlan`, on purpose
// and with a long argument in its header for why an allowlist is the worse
// hazard. Adding dates to that object therefore made every day reassignment a
// cache miss — ~73 s and ~$0.125 for a byte-identical payload — which is exactly
// the waste that module exists to remove, and Hans moves days ad hoc all week.
//
// So the dates come back BESIDE the input rather than inside it. The fingerprint
// keeps hashing everything it is given, with no field list to forget; the dates
// reach the engine and the assembly layer, which is where every date-dependent
// behaviour is deterministic and needs no cache at all.
//
// ⚠️ D-WS9-298 MUST APPLY ITS DATE-DEPENDENT OVERLAY ON THE CACHE-HIT PATH TOO.
// The cached blob is the assembled result. The moment a storage note or a
// `skipSuggested` depends on the day, a hit that returns `structureJson`
// untouched serves yesterday's dates. Cache what the AI wrote (date-independent);
// apply the deterministic overlay on every read.
export interface PrepCookDays {
  /**
   * The day the prep session happens, as an ISO date, and the baseline every lag
   * is measured from. NO COLUMN STORES IT: prep runs before the week, so the
   * plan's `startDate` is the only answer the data offers, else the earliest
   * assigned meal date. Null when the plan carries neither — 4 of the 13 census
   * plans, which is why D-WS9-298's shape has to cope with not knowing.
   */
  prepDay: string | null;
  /** mealId → whole days from `prepDay` to that meal's cook day. Absent when undated. */
  lagByMealId: Map<string, number>;
  /** mealId → the assigned day name, for copy that says "Friday" rather than "in 5 days". */
  dayNameByMealId: Map<string, string>;
}

export interface PrepLoadedPlan {
  planId: string;
  planName: string;
  meals: PrepLoadedMeal[];
  // ⚠️ NOTHING DATE-SHAPED BELONGS ON THIS OBJECT. prepCompositionFingerprint
  // hashes every field it has, so a date here makes a day reassignment a cache
  // miss. Cook days ride on LoadPrepWeekInputResult.cookDays instead.
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
  /**
   * H5.0 — "now", for the prep-day anchor only. Injectable because the anchor is
   * the one thing in this loader that depends on the wall clock, and a test that
   * asserts a lag must be able to pin the day it is measured from. Defaults to
   * the real clock.
   *
   * ⚠️ It must stay OUT of `input`: prepCompositionFingerprint hashes every
   * field that object has, and a date in there makes each day a cache miss.
   */
  now?: Date;
}

export interface LoadPrepWeekInputResult {
  input: PrepLoadedPlan;
  planRevisionId: number;
  /** D-WS9-298 — deliberately NOT part of `input`; see PrepCookDays. */
  cookDays: PrepCookDays;
}

export async function loadPrepWeekInput(
  params: LoadPrepWeekInputParams,
): Promise<LoadPrepWeekInputResult> {
  const { planId, userId, prisma, includeStepTexts = true, mealIds, now } = params;

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
  // D-WS9-298 — collected alongside, never onto the meal. First slot wins, the
  // same multi-slot collapse buildMealLabelLookup already documents.
  // H3 item 14 — `assignedDate` is NOT collected any more. The prep lane reads
  // the weekday name and derives the date; keeping a second source around is
  // how the two drifted apart in the first place.
  const dayNameByMealId = new Map<string, string>();
  for (const item of plan.items) {
    const meal = item.meal;
    // WS9 — the subset filter. The ONLY place a subset differs from a full
    // week; everything downstream consumes `meals` and is untouched.
    if (selectedMealIds && !selectedMealIds.has(item.mealId)) continue;
    if (meal.dishLinks.length === 0) continue;
    if (item.assignedDayOfWeek && !dayNameByMealId.has(item.mealId)) {
      dayNameByMealId.set(item.mealId, item.assignedDayOfWeek);
    }

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
          componentSteps: [] as ComponentStep[],
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
        // D-WS9-296 adds stepIndex, stepTextTranslated and amountRefs; the
        // component tags were already here for the path filter below.
        select: {
          ownerId: true, stepIndex: true, stepTextRaw: true, stepTextTranslated: true,
          componentKey: true, pathKey: true, amountRefs: true, phaseType: true,
        },
      }),
      prisma.recipeInstructionStep.findMany({
        where: { ownerType: "meal", ownerId: { in: mealIds } },
        orderBy: [{ ownerId: "asc" }, { stepIndex: "asc" }],
        select: {
          ownerId: true, stepIndex: true, stepTextRaw: true, stepTextTranslated: true,
          componentKey: true, pathKey: true, amountRefs: true, phaseType: true,
        },
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
    /** D-WS9-296 — one persisted row in the shape the derivation reads. */
    const toComponentStep = (r: {
      stepIndex: number;
      stepTextTranslated: string;
      componentKey: string | null;
      amountRefs: unknown;
      phaseType: string;
    }): ComponentStep => ({
      stepIndex: r.stepIndex,
      text: r.stepTextTranslated,
      componentKey: r.componentKey,
      // D-WS9-301 rule 1 — the heat marker that closes a moment.
      phaseType: r.phaseType,
      ingredientIds: Array.isArray(r.amountRefs)
        ? [
            ...new Set(
              (r.amountRefs as { ingredientId?: unknown }[])
                .map((x) => x?.ingredientId)
                .filter((x): x is string => typeof x === "string"),
            ),
          ]
        : [],
    });

    const dishStepsByOwner = new Map<string, string[]>();
    const dishComponentStepsByOwner = new Map<string, ComponentStep[]>();
    for (const [owner, rows] of groupByOwner(dishSteps)) {
      const kept = selectOwned(rows);
      dishStepsByOwner.set(owner, kept.map((s) => s.stepTextRaw));
      dishComponentStepsByOwner.set(owner, kept.map(toComponentStep));
    }
    const mealStepsByOwner = new Map<string, string[]>();
    const mealComponentStepsByOwner = new Map<string, ComponentStep[]>();
    for (const [owner, rows] of groupByOwner(mealSteps)) {
      const kept = selectOwned(rows);
      mealStepsByOwner.set(owner, kept.map((s) => s.stepTextRaw));
      mealComponentStepsByOwner.set(owner, kept.map(toComponentStep));
    }

    // Fold a dish's own steps + its meal's steps into one list. For multi-dish
    // meals the meal list is empty; for single-dish meals the dish list is
    // empty — so each dish ends up with the steps that actually cook it.
    for (const meal of meals) {
      const mealOwned = mealStepsByOwner.get(meal.mealId) ?? [];
      const mealOwnedComponents = mealComponentStepsByOwner.get(meal.mealId) ?? [];
      for (const dish of meal.dishes) {
        const dishOwned = dishStepsByOwner.get(dish.dishId) ?? [];
        dish.stepTexts = [...dishOwned, ...mealOwned];
        dish.componentSteps = [
          ...(dishComponentStepsByOwner.get(dish.dishId) ?? []),
          ...mealOwnedComponents,
        ];
      }
    }
  }

  const planName =
    plan.titleOverride ??
    `Plan ${plan.id.slice(0, 8)}`;

  // ── 🔴 H3 ITEM 14 — THE LAG COMES FROM THE DAY NAME, NOT `assignedDate` ───
  //
  // D-WS9-298 built every cook-day behaviour on `MealPlanItem.assignedDate`.
  // NOTHING WRITES THAT COLUMN AFTER PLAN CREATION. `planDayAssignment` sets it
  // once in the create transaction; the day-change endpoint
  // (`PATCH /plans/:id/items/:itemId`, plans.ts:2439-2448) writes
  // `assignedDayOfWeek` and only that. BUG-114 had already found this in
  // home.ts and removed its own `assignedDate` read for exactly this reason —
  // "a day-change PATCH moves assignedDayOfWeek and leaves the stale
  // assignedDate winning here forever, unfixably from the client" — and
  // D-WS9-298 then built on the column anyway.
  //
  // Measured on Hans's own plan: he moved the Texas-Style Beef Chili four times
  // and the chuck's cube-and-trim step never changed. The row read
  // `assignedDayOfWeek: "Monday"` against `assignedDate: 2026-10-01`, which is a
  // THURSDAY — the label had moved four times and the date had not moved once.
  // The two meals he touched were the only two whose label and date disagreed.
  //
  // So the weekday NAME is the authority, and the date is derived: the single
  // occurrence of that weekday inside the plan's seven-day window from
  // `startDate`. A name earlier in the week than the start wraps forward, which
  // is the right answer — "Monday" on a Wednesday-start plan is next Monday.
  //
  // ⚠️ AND THE DATE IS NOT WRITTEN BACK. A derived value stored beside its
  // source is two truths again, which is the whole of this bug.
  // ── H5.0 — THE PREP SESSION CANNOT HAPPEN IN THE PAST ────────────────────
  //
  // 🔴 THE LAG IS NOT THE WEEKDAY OFFSET. It is the number of days from the prep
  // session to the cook day, and those are the same number only while the
  // session is on `startDate`. The shipped code used the offset, so once the
  // week had begun every lag was inflated by however many days had passed — and
  // judgeProteinStep's window is TWO days. Measured on Hans's own plan on Oct 2
  // with a Sep 30 start: the chicken he was cooking TOMORROW read "3 days out —
  // leave it for cook day", and so did the chuck. The Proteins phase emptied
  // itself, and because moving a meal to Saturday still read as 3, moving days
  // around changed nothing on screen (device items 5.2, 12 and 13 are one bug).
  //
  // So the weekday name still fixes the DATE — the single occurrence of that
  // weekday in the plan's seven-day window from `startDate` — and the lag is
  // measured from the later of `startDate` and today, because you cannot prep on
  // a day that has gone.
  //
  // ⚠️ ISO date strings compare correctly with `<`, and both are UTC midnight
  // here, so no timezone arithmetic is involved and none should be added.
  const DAY_MS = 86_400_000;
  const todayIso = (now ?? new Date()).toISOString().slice(0, 10);
  const startIso = plan.startDate ? plan.startDate.toISOString().slice(0, 10) : null;
  const prepDay = startIso === null ? null : startIso > todayIso ? startIso : todayIso;
  const lagByMealId = new Map<string, number>();
  if (plan.startDate && startIso && prepDay) {
    const startDow = plan.startDate.getUTCDay();
    const startMs = Date.parse(`${startIso}T00:00:00Z`);
    const prepMs = Date.parse(`${prepDay}T00:00:00Z`);
    for (const [mealId, dayName] of dayNameByMealId) {
      const dow = DAY_INDEX[dayName.trim().toLowerCase()];
      if (dow === undefined) continue; // an unrecognised name says nothing
      const cookMs = startMs + ((dow - startDow + 7) % 7) * DAY_MS;
      // A cook day already gone clamps to 0, not to a negative: the soonest the
      // cook can act is now, and a negative lag would read as "keep" by accident
      // rather than on purpose. (A plan whose day has passed is its own question
      // and no device item asks it — this clamp is deliberate, not a guess.)
      lagByMealId.set(mealId, Math.max(0, Math.round((cookMs - prepMs) / DAY_MS)));
    }
  }

  return {
    input: {
      planId: plan.id,
      planName,
      meals,
    },
    planRevisionId: plan.revisionId,
    cookDays: { prepDay, lagByMealId, dayNameByMealId },
  };
}

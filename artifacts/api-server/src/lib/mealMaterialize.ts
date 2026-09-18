// WS7-6 Block 2 — server save-canonical materializer.
//
// Takes a normalized save-canonical payload (the shared shape that Mode A
// ParsedMeal, manual Mode B, and Mode C combined meals all coerce to before
// hitting the server) and writes the full Meal → MealDishLink → Dish →
// DishIngredient → RecipeInstructionStep row graph.
//
// Why a new module rather than extending createMealWithDishes:
// mealCreate.ts requires a sourceMealId (it inherits meta from the source)
// and its ingredient resolver throws IngredientResolutionError on the first
// unmatched canonical name (Q-P1-2 ruling). Save-canonical input is free
// text from the builder / Mode A parse, so most ingredient names will not
// already exist — we need the upsert-on-miss path (shared with
// materializeWizardDraft) instead.
//
// Q1 (link, not clone): for Mode C combined meals the payload supplies
// pre-existing dish ids. We create MealDishLink rows pointing at those ids
// and do NOT clone the dish row. No cascade is added on the link →
// dish edge; behavior on dish deletion is a deliberately deferred decision
// (D-WS7-083 candidate).
//
// Q2 (dinner default): ParsedMeal carries no mealType. When the payload
// omits one we default to "dinner". The picker is a Block-6 concern.
//
// Q3 (extraction risk): ingredient upserts run on the plain PrismaClient
// (NOT the tx) via the shared resolveIngredients helper. This matches the
// wizardActivation Pass 1 / Pass 2 split — upserted Ingredient rows are
// write-once reference content and safe to commit independently of the
// meal-graph tx.
//
// WS7-6 Fix-Block 1A (P2028): Pass 1 (resolveIngredients) was originally
// called inside the prisma.$transaction(...) callback in routes/me.ts. Even
// though the upserts used the outer client, their wall-clock time counted
// against the 5000ms tx budget — N serial upserts + Pass 2 graph writes
// blew the budget on a cold path. The materialize/rematerialize functions
// now require a pre-resolved ingredient map and do NO DB roundtrips other
// than the tx-bound graph writes. The route is responsible for calling the
// collect* mention helper + resolveIngredients BEFORE opening the tx. This
// matches the proven wizardActivation / D-WS7-067 / 5d Block 4 pattern.

import type { Prisma, SourceType } from "@prisma/client";

import { type IngredientMention } from "./ingredientResolve";
import { recomputeAndPersistMealMacros } from "./mealMacros";
import { deriveAmountRefs, type MatcherIngredient } from "./stepAmountRefs";
import { stampAllergens } from "./allergens";
import { stampMealTiming } from "./mealTiming";
import {
  estimateDishMacros,
  shouldEstimateMacros,
  type EstimateDishMacrosOptions,
  type EstimateDishMacrosResult,
} from "./dishMacros";
import { logger } from "./logger";
import {
  ingredientCanonicalKey,
  toEffectiveIngredient,
  type IngredientRowForGrounding,
} from "./overrideResolver";

// ── payload shape ───────────────────────────────────────────────────────
//
// Intentionally narrow — the three callers (Mode A parse-meal result,
// manual Mode B form submit, Mode C combined-meal builder) each coerce
// their internal shape down to this one before reaching the server. The
// Zod schema lives at the route boundary (routes/me.ts) so this module
// only sees pre-validated input.

export interface MaterializeMealIngredient {
  name: string;
  quantity: number;
  unit: string;
  preparationNote?: string | null;
  isOptional?: boolean;
}

export interface MaterializeMealStep {
  text: string;
  estimatedMinutes?: number;
  phaseType?: "prep" | "preheat" | "cook" | "rest" | "assemble" | "hold";
  isTimingSensitive?: boolean;
  // WS9 D-WS9-239 (Phase 1a) — intra-dish overlap token, un-retired: the
  // scheduler now honours it (cookingScheduler.ts header). Three states, all
  // load-bearing at the create sites below: undefined = "not sent" (a builder
  // save that omits it INHERITS the wiped step's tag at the same index, like
  // phaseType); null = "sent, clear it"; a string = the tag. Nothing writes a
  // non-null value until 1b ships the prompt bodies — until then this is a
  // carrier, and the D-WS9-239 §5.1 acceptance was that every stored time is
  // byte-identical with it in place.
  parallelGroup?: string | null;
  // Block 3.7 (D-WS9-066) — swappable-component tags. Null/absent = BASE step
  // (always in the recipe). A tagged step belongs to one component's scratch or
  // bought path; the store-fill finalize call is the only caller that sets these.
  componentKey?: string | null;
  pathKey?: string | null;
}

// Per-serving macro cache (denormalized on Meal/Dish for fast plan-view
// reads). Optional everywhere — when omitted, Prisma defaults the Float
// columns to 0 and the existing planNeedsMacroEstimation predicate
// surfaces the dish for a follow-up recalc. Live recompute on save is a
// Block-7 concern (out of scope here).
export interface MaterializeMealMacrosPerServing {
  caloriesPerServing?: number;
  proteinGPerServing?: number;
  carbsGPerServing?: number;
  fatGPerServing?: number;
}

// Block 3.6 v3 (D-WS9-064) — one store-bought substitution: a convenience
// product replacing a GROUP of a dish's from-scratch ingredients (by name).
// Persisted verbatim to Dish.substitutions (nullable Json).
export interface MaterializeSubstitution {
  product: string;
  quantity: number;
  unit: string;
  replaces: string[];
}

// Block 3.7 (D-WS9-066) — one entry of a dish's swappable-component registry
// (label/order metadata), persisted verbatim to Dish.componentRegistry.
export interface MaterializeComponent {
  key: string;
  label: string;
  order: number;
}

// One dish entry in the payload. Two flavors:
//   - kind: "new"  — create a fresh Dish row from the supplied fields.
//   - kind: "link" — Q1 Mode-C path: reference an existing Dish by id.
//                    No Dish row is created or modified; only the
//                    MealDishLink row is written.
export type MaterializeMealDish =
  | {
      kind: "new";
      title: string;
      role: "main" | "side" | "sauce" | "topping" | "base" | "optional";
      positionIndex: number;
      estimatedTimeMinutes?: number;
      difficulty?: "easy" | "medium" | "fancy";
      servingsDefault?: number;
      ingredients: MaterializeMealIngredient[];
      steps: MaterializeMealStep[];
      macros?: MaterializeMealMacrosPerServing;
      // Block 3.6 v3 (D-WS9-064) — optional store-bought substitutions for this
      // dish. Omitted when the dish has no sensible convenience product.
      substitutions?: MaterializeSubstitution[];
      // Block 3.7 (D-WS9-066) — optional swappable-component registry, present
      // when the dish has at least one component with tagged steps. Persisted to
      // Dish.componentRegistry.
      componentRegistry?: MaterializeComponent[];
    }
  | {
      kind: "link";
      dishId: string;
      role: "main" | "side" | "sauce" | "topping" | "base" | "optional";
      positionIndex: number;
    };

export interface MaterializeMealPayload {
  title: string;
  // WS9 3f-4d Part 1c (D-WS9-123) — short display name, rides alongside the long
  // canonical title. Null = render title as-is.
  displayTitle?: string | null;
  description?: string | null;
  cuisineType?: string | null;
  // Q2: ParsedMeal has no mealType. When omitted, the materializer
  // defaults to "dinner". See the deliberate comment at the create site.
  mealType?: "breakfast" | "lunch" | "dinner" | "snack" | "mixed";
  servingsDefault?: number;
  estimatedTimeMinutes?: number;
  difficulty?: "easy" | "medium" | "fancy";
  tags?: string[];
  // Plan-Gen Arc · Block 3 (D-WS9-042) — structured allergen array. Stamped by
  // the store-fill harness (derived from ingredients); defaults to [] so every
  // existing caller is unchanged.
  allergens?: string[];
  // Plan-Gen Arc · Block 3 (D-WS9-045) — dish-family key (target-dish slug).
  // Stamped by the store-fill harness for dedup + dishFamily grouping; omitted
  // (null) for every other caller.
  dishFamilyKey?: string;
  // Plan-Gen Arc · Block 3 (R1) — union widened to include "batch_generated"
  // so the store-fill harness can stamp its provenance through the same
  // materializer. The Prisma SourceType enum already carries the value
  // (schema.prisma) — this only widens the narrow payload type.
  sourceType?: "manual" | "wizard" | "directed" | "curated" | "batch_generated";
  macros?: MaterializeMealMacrosPerServing;
  dishes: MaterializeMealDish[];
}

// ── WS9 BUG-274 — macros at save ─────────────────────────────────────────
//
// PRD §10.3.2 / §11.10 lock macros as WRITE-TIME on every path, but POST
// /me/meals never estimated them: the builder / parse / import adapters send
// no macros (the client zeroes them), recomputeAndPersistMealMacros below SUMS
// dish macros, and the grounded estimator (dishMacros.ts, D-WS9-050) was only
// ever reached from plan recalc — lazily, when a zero dish was already in a
// plan — and from wizard expansion. Every user-saved meal therefore sat at 0
// until it happened to be planned.
//
// The pre-pass here estimates each `kind:"new"` dish that arrives with all
// four macros zero/absent (shouldEstimateMacros — the same predicate plan
// recalc uses), in parallel, BEFORE any row is written, and the dish create
// stamps the result + macroGroundedPct the way plan recalc / wizard activation
// do; a `dish_macros_estimated` UserActivity row is emitted per estimated dish
// (planMacros.ts). Then the existing meal-level sum runs and the meal has
// macros at save.
//
// Fail SOFT, always: an estimator failure / throw / deadline saves the dish at
// zero with a warn — never blocks the save (plan recalc still picks it up).
//
// Scope: the USER save path only (no `target`). The store-fill harness
// materialises with `target` and userId "" inside a default-timeout tx; its
// dishes carry macros from wizard expansion, where a failed estimate is a
// deliberate `failed:true` at zero — re-estimating it here would put an AI
// call into that tx and re-key the spend guard on an empty user id.
//
// Placement (Block 1 follow-up F2): the pre-pass runs in the ROUTE, between
// resolveIngredients and `$transaction` — never inside the tx. An AI round
// trip (up to the deadline, ×N dishes in parallel) inside a 15 s Neon tx would
// hold a connection through model latency and roll back the LLMCallLog rows
// on a failed save. So estimateZeroMacroDishes takes the PLAIN client, and
// materializeMeal only CONSUMES its result via opts.estimatedMacrosByIndex.
// Dishes run in parallel, the conversion write-back is skipped
// (skipConversionWriteback — no second serial LLM hop and no ingredient row
// mutation; the grounding stamp is ref-based, unaffected), and each dish
// races a deadline so a slow estimate degrades to "zero, warn" rather than
// delaying the save — which would be the opposite of fail-soft.
//
// Hermetic by construction: the estimator reaches the route as
// `MeRouterDeps.estimateDishMacros` (the routes/plans.ts computePlanMacros
// pattern) — production wiring defaults to the real implementation, router
// tests inject a stub — so no opt-in flag guards the live SDK any more.

export const MEAL_SAVE_MACRO_ESTIMATE_DEADLINE_MS = 8000;

export interface MaterializeMealOptions {
  // BUG-274 — the route's pre-computed estimates (estimateZeroMacroDishes),
  // dish-index → macros. Consumed on the user path only; ignored when a store
  // `target` is set (see the scope note above). Absent = nothing estimated.
  estimatedMacrosByIndex?: Map<number, EstimatedDishMacros>;
}

export interface EstimateZeroMacroDishesOptions {
  /** The PLAIN client (the pre-pass runs outside the save tx). */
  prisma: Pick<Prisma.TransactionClient, "ingredient"> & EstimateDishMacrosOptions["prisma"];
  userId: string;
  payload: MaterializeMealPayload;
  ingredientIdByCanonical: Map<string, string>;
  /** The estimator — the route's injected dep (real in production, a stub in tests). */
  estimateImpl: typeof estimateDishMacros;
  /** Deadline override for tests. Production omits. */
  deadlineMs?: number;
}

export interface EstimatedDishMacros {
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
  macroGroundedPct: number;
}

function withDeadline(
  work: Promise<EstimateDishMacrosResult>,
  ms: number,
): Promise<EstimateDishMacrosResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ status: "failed", error: `deadline ${ms}ms` }),
      ms,
    );
    timer.unref?.();
    work.then(
      (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      (err) => {
        clearTimeout(timer);
        resolve({
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
  });
}

/**
 * Estimate macros for every zero-macro `kind:"new"` dish. Returns a map
 * dish-index → estimate (absent = left alone or failed). Never throws. Runs
 * on the PLAIN client, before the save tx opens (see the placement note).
 */
export async function estimateZeroMacroDishes(
  opts: EstimateZeroMacroDishesOptions,
): Promise<Map<number, EstimatedDishMacros>> {
  const out = new Map<number, EstimatedDishMacros>();
  const { prisma: tx, userId, payload, ingredientIdByCanonical, estimateImpl } = opts;
  const deadlineMs = opts.deadlineMs ?? MEAL_SAVE_MACRO_ESTIMATE_DEADLINE_MS;

  const work: Array<{ index: number; dish: Extract<MaterializeMealDish, { kind: "new" }> }> = [];
  payload.dishes.forEach((d, index) => {
    if (d.kind !== "new") return;
    const snapshot = {
      caloriesPerServing: d.macros?.caloriesPerServing ?? 0,
      proteinGPerServing: d.macros?.proteinGPerServing ?? 0,
      carbsGPerServing: d.macros?.carbsGPerServing ?? 0,
      fatGPerServing: d.macros?.fatGPerServing ?? 0,
    };
    if (shouldEstimateMacros(snapshot)) work.push({ index, dish: d });
  });
  if (work.length === 0) return out;

  // Ground the estimate from the Ingredient rows Pass 1 already resolved (one
  // read; the ids are in hand). A miss — or a test tx without `ingredient` —
  // just sends the ingredient ungrounded, never drops it (D-WS9-050 P1.2).
  const rowById = new Map<string, IngredientRowForGrounding>();
  try {
    const ids = [...new Set([...ingredientIdByCanonical.values()])];
    const rows = await tx.ingredient.findMany({
      where: { id: { in: ids } },
      select: { id: true, canonicalName: true, nutritionRefPerUnit: true, conversionRef: true },
    });
    for (const r of rows) rowById.set(r.id, r);
  } catch (err) {
    logger.warn(
      { event: "meal_save_macro_grounding_failed", userId, err },
      "Grounding lookup failed; estimating ungrounded",
    );
  }

  await Promise.all(
    work.map(async ({ index, dish }) => {
      try {
        const result = await withDeadline(
          estimateImpl({
            prisma: tx,
            userId,
            dishTitle: dish.title,
            servings: dish.servingsDefault ?? payload.servingsDefault ?? 4,
            ingredients: dish.ingredients.map((ing) =>
              toEffectiveIngredient(
                ing,
                rowById.get(ingredientIdByCanonical.get(ingredientCanonicalKey(ing.name)) ?? ""),
              ),
            ),
            skipConversionWriteback: true,
          }),
          deadlineMs,
        );
        if (result.status === "failed") {
          logger.warn(
            {
              event: "meal_save_dish_macros_failed",
              userId,
              dishTitle: dish.title,
              error: result.error,
            },
            "Per-dish macro estimate failed at meal save; dish saved at zero",
          );
          return;
        }
        out.set(index, {
          caloriesPerServing: result.perServing.calories,
          proteinGPerServing: result.perServing.proteinG,
          carbsGPerServing: result.perServing.carbsG,
          fatGPerServing: result.perServing.fatG,
          macroGroundedPct: Math.round(result.grounding.ratio * 100),
        });
      } catch (err) {
        logger.warn(
          { event: "meal_save_dish_macros_failed", userId, dishTitle: dish.title, err },
          "Per-dish macro estimate threw at meal save; dish saved at zero",
        );
      }
    }),
  );
  return out;
}

export interface MaterializeMealResult {
  mealId: string;
  // The dish ids in payload order. For "new" entries this is the freshly
  // created Dish.id; for "link" entries it is the supplied dishId echoed
  // back. Lets the route construct a response shape without re-querying.
  dishIds: string[];
  // Count of MealDishLink rows written (always === dishes.length on
  // success; surfaced for assertions in tests).
  linksCreated: number;
}

// ── ownership / visibility / provenance target (Plan-Gen Arc · Block 3, R1) ──
//
// Optional. Mirrors mealFork.ts's CloneTarget. When OMITTED, materializeMeal
// writes a PRIVATE, caller-owned meal exactly as before (userId from the
// `userId` param, isPublic:false, sourceType from the payload). When PROVIDED,
// the store-fill harness mints a SHARED-POOL meal (userId:null, isPublic:true,
// sourceType:"batch_generated"). Nothing else in the graph write changes.
export interface MaterializeTarget {
  userId: string | null;
  isPublic: boolean;
  sourceType: SourceType;
}

/**
 * Resolve owner / pool-visibility / provenance for a materialize call.
 *
 * No target  → legacy behavior: caller-owned (`userId`), private
 *              (`isPublic:false`), payload sourceType (default "manual").
 * With target → the target's userId / isPublic / sourceType verbatim.
 *
 * Exported so the additive-default contract is unit-testable without a DB tx.
 */
export function resolveMaterializeOwnership(
  userId: string,
  payloadSourceType: MaterializeMealPayload["sourceType"],
  target?: MaterializeTarget,
): { ownerUserId: string | null; isPublic: boolean; sourceType: SourceType } {
  if (target) {
    return {
      ownerUserId: target.userId,
      isPublic: target.isPublic,
      sourceType: target.sourceType,
    };
  }
  return {
    ownerUserId: userId,
    isPublic: false,
    sourceType: payloadSourceType ?? "manual",
  };
}

// ── materializeMeal ─────────────────────────────────────────────────────

/**
 * Collect every ingredient mention across the payload's "new" dishes so
 * the route can run `resolveIngredients` BEFORE opening the $transaction.
 * "link" dishes already have DishIngredient rows tied to the existing
 * dish — we don't touch them.
 */
export function collectMealMentions(
  payload: { dishes: MaterializeMealDish[] },
): IngredientMention[] {
  const mentions: IngredientMention[] = [];
  for (const d of payload.dishes) {
    if (d.kind === "new") {
      for (const ing of d.ingredients) {
        mentions.push({ name: ing.name, unit: ing.unit });
      }
    }
  }
  return mentions;
}

/**
 * Write the full Meal → MealDishLink → Dish → DishIngredient →
 * RecipeInstructionStep row graph for a save-canonical payload. Returns
 * the new mealId + the dish ids referenced by each link (in payload
 * order).
 *
 * Pass-1 (ingredient upsert) is the route's responsibility — see
 * collectMealMentions + resolveIngredients. This function does only the
 * tx-bound graph writes (Pass 2): Meal create, then per-dish (Dish create
 * OR existing-id link), then DishIngredient + RecipeInstructionStep.
 *
 * For "link" dishes (Q1 Mode-C combined meals) the materializer creates
 * the MealDishLink row pointing at the supplied dish id. Existence /
 * ownership of that dish are the route's responsibility, not this
 * helper's — the route does the user-scoped findMany before calling.
 */
export async function materializeMeal(
  tx: Prisma.TransactionClient,
  userId: string,
  payload: MaterializeMealPayload,
  ingredientIdByCanonical: Map<string, string>,
  target?: MaterializeTarget,
  opts?: MaterializeMealOptions,
): Promise<MaterializeMealResult> {
  // Plan-Gen Arc · Block 3 (R1) — resolve owner/visibility/provenance once.
  // With no target this is byte-identical to the pre-Block-3 write.
  const { ownerUserId, isPublic: resolvedIsPublic, sourceType: resolvedSourceType } =
    resolveMaterializeOwnership(userId, payload.sourceType, target);

  // WS9 BUG-274 — macros at save: the ROUTE ran estimateZeroMacroDishes
  // before this tx opened (see the placement note above it); this only
  // consumes the result, and only on the user path (never for a store target).
  const estimatedMacrosByIndex =
    target === undefined && opts?.estimatedMacrosByIndex
      ? opts.estimatedMacrosByIndex
      : new Map<number, EstimatedDishMacros>();

  // ── Pass 2 (transactional): meal graph.
  const meal = await tx.meal.create({
    data: {
      userId: ownerUserId,
      title: payload.title,
      displayTitle: payload.displayTitle ?? null,
      description: payload.description ?? null,
      cuisineType: payload.cuisineType ?? null,
      // Deliberate: Mode A has no mealType; picker is a Block-6 concern, not a TODO.
      mealType: payload.mealType ?? "dinner",
      sourceType: resolvedSourceType,
      allergens: payload.allergens ?? [],
      dishFamilyKey: payload.dishFamilyKey ?? null,
      servingsDefault: payload.servingsDefault ?? 4,
      // WS7-8 BUG-003 — anchor frozen == servingsDefault at create.
      authoredServingsDefault: payload.servingsDefault ?? 4,
      // WS9 D-WS9-235 — the `?? 30` invention is RETIRED. An absent number now
      // falls to the column default and is overwritten moments later by
      // stampMealTiming from the persisted steps; it never survives as a claim.
      // BUG-245: that fabricated 30 is the number the meatloaf shipped with
      // against a 58-minute bake.
      ...(payload.estimatedTimeMinutes !== undefined
        ? { estimatedTimeMinutes: payload.estimatedTimeMinutes }
        : {}),
      difficulty: payload.difficulty ?? "easy",
      tags: payload.tags ?? [],
      isPublic: resolvedIsPublic,
      isArchived: false,
      // Row 5 · Block 1c (D-WS9-248) — ENQUEUE. A new meal has no image; the
      // save never calls OpenAI, the scheduled drain generates it within
      // ~a minute and the row renders the gradient meanwhile. Explicit here
      // (it is also the column default) because this is THE save path: manual,
      // URL/photo import, Ask-Kiwi, and the store-fill catalog run all land
      // here. A store-target row (userId null) is a catalog meal owed an image
      // like any other; its generation runs under no user (BUG-262).
      imageStatus: "pending",
      ...(payload.macros
        ? {
            caloriesPerServing: payload.macros.caloriesPerServing ?? 0,
            proteinGPerServing: payload.macros.proteinGPerServing ?? 0,
            carbsGPerServing: payload.macros.carbsGPerServing ?? 0,
            fatGPerServing: payload.macros.fatGPerServing ?? 0,
          }
        : {}),
    },
    select: { id: true },
  });

  const dishIds: string[] = [];
  let linksCreated = 0;

  for (let di = 0; di < payload.dishes.length; di++) {
    const d = payload.dishes[di];

    let dishId: string;

    if (d.kind === "link") {
      // Q1 Mode-C: link to an existing Dish row by id. NO clone, NO
      // mutation of the existing dish. The route layer already
      // confirmed the dish exists and is owned by (or readable to) the
      // user before reaching us.
      dishId = d.dishId;
    } else {
      // kind === "new": create the Dish row + its DishIngredients +
      // RecipeInstructionSteps. Macros at the dish level mirror the
      // wizard activation pattern (default-0 when omitted).
      // WS9 BUG-274 — a zero/absent incoming macro set that the pre-pass
      // estimated is stamped here with its grounding (macroGroundedPct), the
      // same columns plan recalc writes.
      const estimated = estimatedMacrosByIndex.get(di);
      const macros = estimated
        ? estimated
        : d.macros
          ? {
              caloriesPerServing: d.macros.caloriesPerServing ?? 0,
              proteinGPerServing: d.macros.proteinGPerServing ?? 0,
              carbsGPerServing: d.macros.carbsGPerServing ?? 0,
              fatGPerServing: d.macros.fatGPerServing ?? 0,
            }
          : {};

      const dish = await tx.dish.create({
        data: {
          userId: ownerUserId,
          title: d.title,
          sourceType: resolvedSourceType,
          estimatedTimeMinutes:
            d.estimatedTimeMinutes ?? payload.estimatedTimeMinutes ?? 30,
          difficulty: d.difficulty ?? payload.difficulty ?? "easy",
          servingsDefault:
            d.servingsDefault ?? payload.servingsDefault ?? 4,
          // WS7-8 BUG-003 — anchor frozen == servingsDefault at create.
          authoredServingsDefault:
            d.servingsDefault ?? payload.servingsDefault ?? 4,
          isArchived: false,
          ...macros,
          // Block 3.6 v3 (D-WS9-064) — persist substitutions when present; omit
          // the key otherwise so the nullable Json column stays SQL NULL.
          ...(d.substitutions && d.substitutions.length > 0
            ? { substitutions: d.substitutions as unknown as Prisma.InputJsonValue }
            : {}),
          // Block 3.7 (D-WS9-066) — persist the swappable-component registry when
          // present; omit otherwise so the nullable Json column stays SQL NULL.
          ...(d.componentRegistry && d.componentRegistry.length > 0
            ? { componentRegistry: d.componentRegistry as unknown as Prisma.InputJsonValue }
            : {}),
        },
        select: { id: true },
      });
      dishId = dish.id;

      // WS9 BUG-274 — the same event plan recalc emits per fresh estimate
      // (planMacros.ts), so the two write paths are indistinguishable
      // downstream. Warn-and-continue: the macros are already on the row.
      if (estimated) {
        try {
          await tx.userActivity.create({
            data: {
              // Estimation only runs on the user path (no target), where the
              // owner IS the caller — never the store pool's null owner.
              userId,
              eventType: "dish_macros_estimated",
              entityId: dishId,
              platform: "api",
            },
          });
        } catch (err) {
          logger.warn(
            { event: "dish_macros_estimated_event_failed", userId, dishId, err },
            "Could not record dish_macros_estimated at meal save",
          );
        }
      }

      for (let ii = 0; ii < d.ingredients.length; ii++) {
        const ing = d.ingredients[ii];
        const canonical = ing.name.toLowerCase().trim();
        const ingredientId = ingredientIdByCanonical.get(canonical);
        if (!ingredientId) {
          // Pass 1 upserted every non-empty mention. An empty/whitespace
          // name made it past the Zod schema's .min(1) — surface a clear
          // error rather than 500ing on a Prisma FK violation.
          throw new Error(
            `materializeMeal: ingredient missing after upsert: "${ing.name}"`,
          );
        }
        await tx.dishIngredient.create({
          data: {
            dishId,
            ingredientId,
            quantity: ing.quantity,
            unit: ing.unit,
            preparationNote: ing.preparationNote ?? null,
            isOptional: ing.isOptional ?? false,
            positionIndex: ii,
          },
        });
      }

      // WS7-8b BUG-003 Block 1 — the dish's ingredient rows for server-side
      // ref derivation (every id is present; the loop above threw otherwise).
      const matcherIngredients: MatcherIngredient[] = d.ingredients.map((ing) => ({
        ingredientId: ingredientIdByCanonical.get(ing.name.toLowerCase().trim()) ?? "",
        name: ing.name,
        quantity: ing.quantity,
        unit: ing.unit,
      }));

      for (let si = 0; si < d.steps.length; si++) {
        const s = d.steps[si];
        // WS7-8b BUG-003 Block 1 — derive step→ingredient refs (always stored,
        // even [], so reads can tell a derived step from a legacy null one).
        const { amountRefs } = deriveAmountRefs(s.text, matcherIngredients);
        await tx.recipeInstructionStep.create({
          data: {
            ownerType: "dish",
            ownerId: dishId,
            stepIndex: si,
            stepTextRaw: s.text,
            stepTextTranslated: s.text,
            amountRefs: amountRefs as unknown as Prisma.InputJsonValue,
            ...(s.estimatedMinutes !== undefined
              ? { estimatedMinutes: s.estimatedMinutes }
              : {}),
            ...(s.phaseType !== undefined ? { phaseType: s.phaseType } : {}),
            ...(s.isTimingSensitive !== undefined
              ? { isTimingSensitive: s.isTimingSensitive }
              : {}),
            // WS9 D-WS9-239 — intra-dish overlap token (omitted unless sent).
            ...(s.parallelGroup !== undefined ? { parallelGroup: s.parallelGroup } : {}),
            // Block 3.7 (D-WS9-066) — swappable-component tags (store-fill only).
            ...(s.componentKey !== undefined ? { componentKey: s.componentKey } : {}),
            ...(s.pathKey !== undefined ? { pathKey: s.pathKey } : {}),
          },
        });
      }
    }

    // WS7-6: orphan-link behavior deferred — do not add cascade here.
    // Q1 Mode-C link path leaves the link dangling if the referenced
    // Dish is later deleted; that's a D-WS7-083 candidate, not a fix to
    // bundle into Block 2.
    await tx.mealDishLink.create({
      data: {
        mealId: meal.id,
        dishId,
        positionIndex: d.positionIndex,
        roleLabel: d.role,
      },
    });
    linksCreated++;
    dishIds.push(dishId);
  }

  // WS7-6 Fix-Block 3 (Bug 3): write the aggregated meal-level per-serving
  // macros as the simple sum of each linked dish's per-serving values
  // (Hans's ruling — see mealMacros.ts header). Overwrites whatever the
  // create above set from payload.macros — the sum is the truth.
  await recomputeAndPersistMealMacros(tx, meal.id);

  // D-WS9-214 — derive the allergen stamp from the graph just written.
  //
  // ⚠️ THIS IS THE LINE THAT MAKES IMPORT AND THE MEAL BUILDER STAMP. Every
  // meal from a URL import, an image import, a text paste or Mode A/B/C of the
  // builder lands here, via POST /me/meals. Before this, `allergens` came in at
  // create time as `payload.allergens ?? []` — a PASSTHROUGH, not a derivation —
  // and the only caller that ever filled it was the store-fill harness. Every
  // user-created meal therefore took the `[]` branch and carried no stamp.
  //
  // Deriving from the PERSISTED GRAPH rather than from `payload.allergens` is
  // deliberate even for the harness, which supplies correct tokens: the graph is
  // what every other stamping path reads, so one meal cannot end up stamped
  // against a different input than its neighbour. The two agree — the harness
  // derives from the same names — so this is a no-op for it, and it collapses
  // two sources of truth into one. `payload.allergens` survives only as the
  // initial value on the create above, which this immediately reconciles.
  await stampAllergens(tx, meal.id);

  // WS9 D-WS9-235 — the meal's time is DERIVED from the steps just written, with
  // the scheduler's parallelism. Same seam and same argument as stampAllergens
  // above: reconcile from the persisted graph once it exists, rather than trust
  // a number the generator authored before the steps did.
  //
  // BUG-245 measured the alternative at 93.8% of meals under-claiming, median 20
  // minutes. The `?? 30` on the create above is now only a placeholder for the
  // instant between the meal row and this line.
  await stampMealTiming(tx, meal.id, dishIds);

  return { mealId: meal.id, dishIds, linksCreated };
}

// ── materializeDish ─────────────────────────────────────────────────────
// Standalone Dish creation for POST /me/dishes. Reuses the shared
// ingredient resolver. Steps are polymorphic ownerType="dish".

export interface MaterializeDishPayload {
  title: string;
  description?: string | null;
  estimatedTimeMinutes?: number;
  difficulty?: "easy" | "medium" | "fancy";
  servingsDefault?: number;
  tags?: string[];
  sourceType?: "manual" | "wizard" | "directed" | "curated";
  macros?: MaterializeMealMacrosPerServing;
  ingredients: MaterializeMealIngredient[];
  steps: MaterializeMealStep[];
}

export interface MaterializeDishResult {
  dishId: string;
}

// WS9 BUG-278 (server half) — the standalone-dish save never estimated macros.
// Same seam as POST /me/meals (BUG-274): the pre-pass runs in the ROUTE on the
// plain client, before the tx; materializeDish only CONSUMES the result.
export interface MaterializeDishOptions {
  /** The route's pre-computed estimate for a zero-macro payload; absent = nothing estimated. */
  estimatedMacros?: EstimatedDishMacros;
}

/**
 * Estimate macros for a standalone dish payload when its macros are zero /
 * absent — the one-dish form of estimateZeroMacroDishes (same predicate, same
 * deadline, same fail-soft). Returns undefined when nothing was estimated.
 */
export async function estimateZeroMacroDish(
  opts: Omit<EstimateZeroMacroDishesOptions, "payload"> & { payload: MaterializeDishPayload },
): Promise<EstimatedDishMacros | undefined> {
  const { payload, ...rest } = opts;
  const asMeal: MaterializeMealPayload = {
    title: payload.title,
    servingsDefault: payload.servingsDefault,
    dishes: [
      {
        kind: "new",
        title: payload.title,
        role: "main",
        positionIndex: 0,
        servingsDefault: payload.servingsDefault,
        ingredients: payload.ingredients,
        steps: payload.steps,
        macros: payload.macros,
      },
    ],
  };
  const byIndex = await estimateZeroMacroDishes({ ...rest, payload: asMeal });
  return byIndex.get(0);
}

/**
 * Collect ingredient mentions for a standalone Dish payload so the route
 * can resolve them BEFORE opening the $transaction (WS7-6 Fix-Block 1A).
 */
export function collectDishMentions(
  payload: { ingredients: MaterializeMealIngredient[] },
): IngredientMention[] {
  return payload.ingredients.map((ing) => ({ name: ing.name, unit: ing.unit }));
}

export async function materializeDish(
  tx: Prisma.TransactionClient,
  userId: string,
  payload: MaterializeDishPayload,
  ingredientIdByCanonical: Map<string, string>,
  opts?: MaterializeDishOptions,
): Promise<MaterializeDishResult> {
  // WS9 BUG-278 — a zero/absent macro set the route's pre-pass estimated is
  // stamped with its grounding, exactly as materializeMeal does per dish.
  const estimated = opts?.estimatedMacros;
  const macros = estimated
    ? estimated
    : payload.macros
      ? {
          caloriesPerServing: payload.macros.caloriesPerServing ?? 0,
          proteinGPerServing: payload.macros.proteinGPerServing ?? 0,
          carbsGPerServing: payload.macros.carbsGPerServing ?? 0,
          fatGPerServing: payload.macros.fatGPerServing ?? 0,
        }
      : {};

  const dish = await tx.dish.create({
    data: {
      userId,
      title: payload.title,
      description: payload.description ?? null,
      sourceType: payload.sourceType ?? "manual",
      // WS9 D-WS9-235 — the `?? 30` invention is RETIRED. An absent number now
      // falls to the column default and is overwritten moments later by
      // stampMealTiming from the persisted steps; it never survives as a claim.
      // BUG-245: that fabricated 30 is the number the meatloaf shipped with
      // against a 58-minute bake.
      ...(payload.estimatedTimeMinutes !== undefined
        ? { estimatedTimeMinutes: payload.estimatedTimeMinutes }
        : {}),
      difficulty: payload.difficulty ?? "easy",
      servingsDefault: payload.servingsDefault ?? 4,
      // WS7-8 BUG-003 — anchor frozen == servingsDefault at create.
      authoredServingsDefault: payload.servingsDefault ?? 4,
      tags: payload.tags ?? [],
      isArchived: false,
      ...macros,
    },
    select: { id: true },
  });

  // WS9 BUG-278 — the same event plan recalc / the meal save emit per fresh
  // estimate, so the write paths are indistinguishable downstream.
  if (estimated) {
    try {
      await tx.userActivity.create({
        data: {
          userId,
          eventType: "dish_macros_estimated",
          entityId: dish.id,
          platform: "api",
        },
      });
    } catch (err) {
      logger.warn(
        { event: "dish_macros_estimated_event_failed", userId, dishId: dish.id, err },
        "Could not record dish_macros_estimated at dish save",
      );
    }
  }

  for (let ii = 0; ii < payload.ingredients.length; ii++) {
    const ing = payload.ingredients[ii];
    const canonical = ing.name.toLowerCase().trim();
    const ingredientId = ingredientIdByCanonical.get(canonical);
    if (!ingredientId) {
      throw new Error(
        `materializeDish: ingredient missing after upsert: "${ing.name}"`,
      );
    }
    await tx.dishIngredient.create({
      data: {
        dishId: dish.id,
        ingredientId,
        quantity: ing.quantity,
        unit: ing.unit,
        preparationNote: ing.preparationNote ?? null,
        isOptional: ing.isOptional ?? false,
        positionIndex: ii,
      },
    });
  }

  // WS7-8b BUG-003 Block 1 — the dish's ingredient rows for server-side ref
  // derivation (every id is present; the loop above threw otherwise).
  const matcherIngredients: MatcherIngredient[] = payload.ingredients.map((ing) => ({
    ingredientId: ingredientIdByCanonical.get(ing.name.toLowerCase().trim()) ?? "",
    name: ing.name,
    quantity: ing.quantity,
    unit: ing.unit,
  }));

  for (let si = 0; si < payload.steps.length; si++) {
    const s = payload.steps[si];
    // WS7-8b BUG-003 Block 1 — derive step→ingredient refs (always stored,
    // even [], so reads can tell a derived step from a legacy null one).
    const { amountRefs } = deriveAmountRefs(s.text, matcherIngredients);
    await tx.recipeInstructionStep.create({
      data: {
        ownerType: "dish",
        ownerId: dish.id,
        stepIndex: si,
        stepTextRaw: s.text,
        stepTextTranslated: s.text,
        amountRefs: amountRefs as unknown as Prisma.InputJsonValue,
        ...(s.estimatedMinutes !== undefined
          ? { estimatedMinutes: s.estimatedMinutes }
          : {}),
        ...(s.phaseType !== undefined ? { phaseType: s.phaseType } : {}),
        ...(s.isTimingSensitive !== undefined
          ? { isTimingSensitive: s.isTimingSensitive }
          : {}),
        // WS9 D-WS9-239 — intra-dish overlap token (omitted unless sent).
        ...(s.parallelGroup !== undefined ? { parallelGroup: s.parallelGroup } : {}),
        // Block 3.7 (D-WS9-066) — swappable-component tags (omitted unless set).
        ...(s.componentKey !== undefined ? { componentKey: s.componentKey } : {}),
        ...(s.pathKey !== undefined ? { pathKey: s.pathKey } : {}),
      },
    });
  }

  return { dishId: dish.id };
}

// ── step-field preservation on a builder save (D-WS9-235) ───────────────
// The meal-builder and the Dish Builder send steps as { text, estimatedMinutes,
// isTimingSensitive? } — no phaseType — so the wipe-and-recreate paths below
// used to reset every re-created step to the column default `cook`, and the
// D-WS9-235 re-stamp then derived from an all-`cook` step set. Measured
// (September 11, live DB): 9 of 9 dishes re-created by a meal-level save carry
// 50/50 steps `cook` (9/9 dishes all-cook) against the catalog's 36%. The
// fix is server-side: an incoming step that OMITS phaseType / isTimingSensitive
// inherits the existing step's value AT THE SAME stepIndex (read before the
// wipe); a genuinely new step — no existing step at that index — falls to the
// column default as before. A field the client does send always wins.
//
// WS9 D-WS9-239 — `parallelGroup` joins the preserved set, and it is the
// load-bearing carrier of the whole feature: every wipe-and-recreate (meal
// PATCH, Dish Builder save) would otherwise drop a persisted tag, and the
// derived time would jump back UP on the next edit — the meal's number
// silently un-fixing itself. Same three-state rule as the other two: omitted
// inherits, an explicit null clears, a string wins.

type PreservableStepFields = {
  phaseType: NonNullable<MaterializeMealStep["phaseType"]>;
  isTimingSensitive: boolean;
  parallelGroup: string | null;
};

// stepIndex → the fields worth preserving, for one dish.
type PreservableStepsByIndex = Map<number, PreservableStepFields>;

async function readPreservableSteps(
  tx: Prisma.TransactionClient,
  dishIds: string[],
): Promise<Map<string, PreservableStepsByIndex>> {
  const out = new Map<string, PreservableStepsByIndex>();
  if (dishIds.length === 0) return out;
  const rows = await tx.recipeInstructionStep.findMany({
    where: { ownerType: "dish", ownerId: { in: dishIds } },
    select: { ownerId: true, stepIndex: true, phaseType: true, isTimingSensitive: true, parallelGroup: true },
  });
  for (const r of rows) {
    const byIndex = out.get(r.ownerId) ?? new Map<number, PreservableStepFields>();
    byIndex.set(r.stepIndex, {
      phaseType: r.phaseType,
      isTimingSensitive: r.isTimingSensitive,
      parallelGroup: r.parallelGroup,
    });
    out.set(r.ownerId, byIndex);
  }
  return out;
}

// The phaseType / isTimingSensitive / parallelGroup slice of a step-create
// `data`: the incoming value when sent, else the existing step's at this
// index, else omitted (column default).
function preservedStepFields(
  s: MaterializeMealStep,
  existing: PreservableStepFields | undefined,
): Partial<PreservableStepFields> {
  const phaseType = s.phaseType ?? existing?.phaseType;
  const isTimingSensitive = s.isTimingSensitive ?? existing?.isTimingSensitive;
  // `??` would treat a SENT null as "not sent" and resurrect the wiped tag —
  // null is the client clearing it, so only `undefined` falls through.
  const parallelGroup =
    s.parallelGroup !== undefined ? s.parallelGroup : existing?.parallelGroup;
  return {
    ...(phaseType !== undefined ? { phaseType } : {}),
    ...(isTimingSensitive !== undefined ? { isTimingSensitive } : {}),
    ...(parallelGroup !== undefined ? { parallelGroup } : {}),
  };
}

// ── rematerializeMeal (WS7-6 1A) ───────────────────────────────────────
// WS7-6 1A: wipe-and-recreate per Hans ruling; surgical-diff deferred → see
// D-WS7-090 if row-id stability ever needed.
//
// RecipeInstructionStep has NO DB cascade — it's polymorphic ownerType +
// ownerId with NO Prisma relation (schema lines 371-372: Postgres can't
// conditionally reference two tables). Deleting a Meal or Dish does NOT
// remove its steps. The wipe MUST explicitly deleteMany by
// (ownerType, ownerId) for the meal AND for each exclusively-owned dish,
// or step rows orphan.
//
// Dish-deletion guard:
//   - userId === userId (skip catalog/null-owner dishes)
//   - no other MealDishLink (skip dishes linked to other meals)
// Shared/catalog dishes are unlinked but their Dish + sub-rows are kept.

export interface RematerializeMealPayload {
  // Scalar fields — when present, included in meal.update. Mirror the
  // postMeMealSchema accept list (PRD §8.4.4 patchable set).
  title?: string;
  description?: string | null;
  cuisineType?: string | null;
  mealType?: "breakfast" | "lunch" | "dinner" | "snack" | "mixed";
  servingsDefault?: number;
  estimatedTimeMinutes?: number;
  difficulty?: "easy" | "medium" | "fancy";
  tags?: string[];
  macros?: MaterializeMealMacrosPerServing;
  imageUrl?: string | null;
  // dishes[] — REQUIRED for rematerialize; the route uses a scalar-only
  // update path when dishes is absent so the wipe never runs unnecessarily.
  dishes: MaterializeMealDish[];
  sourceType?: "manual" | "wizard" | "directed" | "curated";
}

export async function rematerializeMeal(
  tx: Prisma.TransactionClient,
  userId: string,
  mealId: string,
  payload: RematerializeMealPayload,
  ingredientIdByCanonical: Map<string, string>,
): Promise<MaterializeMealResult> {
  // WS7-8 BUG-003 B2.3 — anchor-preservation guard (Option 1, meal-anchor
  // inheritance). Read the meal's immutable authored anchor BEFORE the scalar
  // update below (which may MOVE servingsDefault on a promoted meal). Recreated
  // exclusive dishes inherit THIS value instead of defaulting to null → the
  // (possibly promoted) servingsDefault, which would silently re-base the anchor
  // and re-introduce the BUG-003 desync. Meal-anchor inheritance is the ruled
  // approach (no per-dish old→new matching): all recreated dishes take the
  // single meal-level anchor. Legacy/seed meals whose anchor is null fall back
  // to the meal's PRIOR servingsDefault (read here, pre-update).
  const mealAnchorRow = await tx.meal.findUnique({
    where: { id: mealId },
    select: { authoredServingsDefault: true, servingsDefault: true },
  });
  const inheritedAuthoredServings =
    mealAnchorRow?.authoredServingsDefault ??
    mealAnchorRow?.servingsDefault ??
    payload.servingsDefault ??
    4;

  // ── Pass 2 (in-tx): wipe.
  // Find currently linked dishes and partition into exclusively-owned
  // (delete) vs shared/catalog (unlink only).
  const currentLinks = await tx.mealDishLink.findMany({
    where: { mealId },
    select: { dishId: true, positionIndex: true },
  });
  const linkedDishIds = currentLinks.map((l) => l.dishId);

  // D-WS9-235 — read the steps that are about to be wiped, keyed by the dish's
  // position in the meal, so a re-created dish at the same position can keep
  // the phaseType / isTimingSensitive a builder save does not send.
  const preservableByDish = await readPreservableSteps(tx, linkedDishIds);
  const preservableByPosition = new Map<number, PreservableStepsByIndex>();
  for (const l of currentLinks) {
    const byIndex = preservableByDish.get(l.dishId);
    if (byIndex) preservableByPosition.set(l.positionIndex, byIndex);
  }

  let exclusiveDishIds: string[] = [];
  if (linkedDishIds.length > 0) {
    const [dishRows, otherLinks] = await Promise.all([
      tx.dish.findMany({
        where: { id: { in: linkedDishIds } },
        select: { id: true, userId: true },
      }),
      tx.mealDishLink.findMany({
        where: { dishId: { in: linkedDishIds }, mealId: { not: mealId } },
        select: { dishId: true },
      }),
    ]);
    const sharedDishIds = new Set(otherLinks.map((l) => l.dishId));
    exclusiveDishIds = dishRows
      .filter((d) => d.userId === userId && !sharedDishIds.has(d.id))
      .map((d) => d.id);
  }

  // RecipeInstructionStep + DishIngredient for dishes we're about to delete.
  // Explicit (ownerType, ownerId) deletion is the no-orphan guarantee.
  if (exclusiveDishIds.length > 0) {
    await tx.recipeInstructionStep.deleteMany({
      where: { ownerType: "dish", ownerId: { in: exclusiveDishIds } },
    });
    await tx.dishIngredient.deleteMany({
      where: { dishId: { in: exclusiveDishIds } },
    });
  }
  // Defensive: meal-owned steps. The current materializer never writes
  // ownerType="meal" rows, but legacy seeds and future writers might.
  await tx.recipeInstructionStep.deleteMany({
    where: { ownerType: "meal", ownerId: mealId },
  });
  // Drop links before dishes (FK ordering). MealDishLink cascades from
  // Meal but we update the Meal — don't delete it — so deleteMany explicitly.
  await tx.mealDishLink.deleteMany({ where: { mealId } });
  if (exclusiveDishIds.length > 0) {
    await tx.dish.deleteMany({ where: { id: { in: exclusiveDishIds } } });
  }

  // ── Scalar update on the Meal row (only fields present in payload).
  const scalarUpdate: Record<string, unknown> = {};
  if (payload.title !== undefined) scalarUpdate.title = payload.title;
  if (payload.description !== undefined)
    scalarUpdate.description = payload.description;
  if (payload.cuisineType !== undefined)
    scalarUpdate.cuisineType = payload.cuisineType;
  if (payload.mealType !== undefined) scalarUpdate.mealType = payload.mealType;
  if (payload.servingsDefault !== undefined)
    scalarUpdate.servingsDefault = payload.servingsDefault;
  if (payload.estimatedTimeMinutes !== undefined)
    scalarUpdate.estimatedTimeMinutes = payload.estimatedTimeMinutes;
  if (payload.difficulty !== undefined)
    scalarUpdate.difficulty = payload.difficulty;
  if (payload.tags !== undefined) scalarUpdate.tags = payload.tags;
  if (payload.imageUrl !== undefined) scalarUpdate.imageUrl = payload.imageUrl;
  if (payload.macros) {
    if (payload.macros.caloriesPerServing !== undefined)
      scalarUpdate.caloriesPerServing = payload.macros.caloriesPerServing;
    if (payload.macros.proteinGPerServing !== undefined)
      scalarUpdate.proteinGPerServing = payload.macros.proteinGPerServing;
    if (payload.macros.carbsGPerServing !== undefined)
      scalarUpdate.carbsGPerServing = payload.macros.carbsGPerServing;
    if (payload.macros.fatGPerServing !== undefined)
      scalarUpdate.fatGPerServing = payload.macros.fatGPerServing;
  }
  if (Object.keys(scalarUpdate).length > 0) {
    await tx.meal.update({ where: { id: mealId }, data: scalarUpdate });
  }

  // ── Recreate the sub-graph — same per-dish loop as materializeMeal.
  const dishIds: string[] = [];
  let linksCreated = 0;

  for (let di = 0; di < payload.dishes.length; di++) {
    const d = payload.dishes[di];

    let dishId: string;

    if (d.kind === "link") {
      dishId = d.dishId;
    } else {
      const macros = d.macros
        ? {
            caloriesPerServing: d.macros.caloriesPerServing ?? 0,
            proteinGPerServing: d.macros.proteinGPerServing ?? 0,
            carbsGPerServing: d.macros.carbsGPerServing ?? 0,
            fatGPerServing: d.macros.fatGPerServing ?? 0,
          }
        : {};

      const dish = await tx.dish.create({
        data: {
          userId,
          title: d.title,
          sourceType: payload.sourceType ?? "manual",
          estimatedTimeMinutes:
            d.estimatedTimeMinutes ?? payload.estimatedTimeMinutes ?? 30,
          difficulty: d.difficulty ?? payload.difficulty ?? "easy",
          servingsDefault:
            d.servingsDefault ?? payload.servingsDefault ?? 4,
          // WS7-8 BUG-003 B2.3 — inherit the meal's immutable authored anchor
          // (read pre-update) so a content edit on a promoted meal does NOT
          // re-base the anchor to the promoted servingsDefault.
          authoredServingsDefault: inheritedAuthoredServings,
          isArchived: false,
          ...macros,
        },
        select: { id: true },
      });
      dishId = dish.id;

      for (let ii = 0; ii < d.ingredients.length; ii++) {
        const ing = d.ingredients[ii];
        const canonical = ing.name.toLowerCase().trim();
        const ingredientId = ingredientIdByCanonical.get(canonical);
        if (!ingredientId) {
          throw new Error(
            `rematerializeMeal: ingredient missing after upsert: "${ing.name}"`,
          );
        }
        await tx.dishIngredient.create({
          data: {
            dishId,
            ingredientId,
            quantity: ing.quantity,
            unit: ing.unit,
            preparationNote: ing.preparationNote ?? null,
            isOptional: ing.isOptional ?? false,
            positionIndex: ii,
          },
        });
      }

      const preservable = preservableByPosition.get(d.positionIndex);
      for (let si = 0; si < d.steps.length; si++) {
        const s = d.steps[si];
        await tx.recipeInstructionStep.create({
          data: {
            ownerType: "dish",
            ownerId: dishId,
            stepIndex: si,
            stepTextRaw: s.text,
            stepTextTranslated: s.text,
            ...(s.estimatedMinutes !== undefined
              ? { estimatedMinutes: s.estimatedMinutes }
              : {}),
            // D-WS9-235 — sent value, else the wiped step's at this index.
            ...preservedStepFields(s, preservable?.get(si)),
            // Block 3.7 (D-WS9-066) — swappable-component tags (omitted unless set).
            ...(s.componentKey !== undefined ? { componentKey: s.componentKey } : {}),
            ...(s.pathKey !== undefined ? { pathKey: s.pathKey } : {}),
          },
        });
      }
    }

    await tx.mealDishLink.create({
      data: {
        mealId,
        dishId,
        positionIndex: d.positionIndex,
        roleLabel: d.role,
      },
    });
    linksCreated++;
    dishIds.push(dishId);
  }

  // WS7-6 Fix-Block 3 (Bug 3): after wipe-and-recreate, overwrite the
  // meal-row macros with the sum of the now-linked dishes' per-serving
  // values. Honors Hans's formula; ignores any payload.macros value.
  await recomputeAndPersistMealMacros(tx, mealId);

  // D-WS9-214 — re-stamp after wipe-and-recreate.
  //
  // ⚠️ BEYOND THE LETTER OF THE BRIEF, AND FLAGGED AS SUCH. The ruling named the
  // CREATE paths; this is the EDIT path. It is here because an edit is precisely
  // what invalidates a stamp: a user adding cheese to a meal they imported makes
  // the stored `dairy`-free stamp actively wrong, and a wrong stamp is worse
  // than a missing one — the missing one fails closed, the wrong one serves the
  // meal to the allergic user. Same argument, same seam, two lines below the
  // macro recompute that already exists for the identical reason.
  await stampAllergens(tx, mealId);

  // WS9 D-WS9-235 — re-derive after a wipe-and-recreate: an edit that changes a
  // step's minutes, adds a dish or drops one must move the meal's time with it,
  // or the scalar silently describes the pre-edit recipe.
  await stampMealTiming(tx, mealId, dishIds);

  return { mealId, dishIds, linksCreated };
}

// ── rematerializeDish (WS7-6 1A) ───────────────────────────────────────
// Wipe-and-recreate a single Dish's sub-graph (DishIngredient + steps).
// Explicit (ownerType, ownerId) step deletion because
// RecipeInstructionStep has no DB cascade.
// ingredients and steps are independent — patching one does not disturb
// the other.

export interface RematerializeDishPayload {
  title?: string;
  description?: string | null;
  estimatedTimeMinutes?: number;
  difficulty?: "easy" | "medium" | "fancy";
  servingsDefault?: number;
  tags?: string[];
  macros?: MaterializeMealMacrosPerServing;
  imageUrl?: string | null;
  ingredients?: MaterializeMealIngredient[];
  steps?: MaterializeMealStep[];
  sourceType?: "manual" | "wizard" | "directed" | "curated";
}

/**
 * Collect ingredient mentions for a dish patch so the route can resolve
 * them BEFORE opening the $transaction (WS7-6 Fix-Block 1A). Returns an
 * empty list when the patch does not touch ingredients — caller can
 * skip the resolveIngredients call entirely.
 */
export function collectRematerializeDishMentions(
  payload: RematerializeDishPayload,
): IngredientMention[] {
  return (
    payload.ingredients?.map((ing) => ({ name: ing.name, unit: ing.unit })) ??
    []
  );
}

export async function rematerializeDish(
  tx: Prisma.TransactionClient,
  _userId: string,
  dishId: string,
  payload: RematerializeDishPayload,
  ingredientIdByCanonical: Map<string, string>,
): Promise<{ dishId: string }> {
  // D-WS9-235 — read the steps about to be wiped so a rewrite that omits
  // phaseType / isTimingSensitive (the Dish Builder does) keeps them per index.
  const preservable =
    payload.steps !== undefined
      ? (await readPreservableSteps(tx, [dishId])).get(dishId)
      : undefined;

  // Pass 2 (in-tx): wipe affected sub-rows.
  if (payload.ingredients !== undefined) {
    await tx.dishIngredient.deleteMany({ where: { dishId } });
  }
  if (payload.steps !== undefined) {
    await tx.recipeInstructionStep.deleteMany({
      where: { ownerType: "dish", ownerId: dishId },
    });
  }

  // Scalar update.
  const scalarUpdate: Record<string, unknown> = {};
  if (payload.title !== undefined) scalarUpdate.title = payload.title;
  if (payload.description !== undefined)
    scalarUpdate.description = payload.description;
  if (payload.estimatedTimeMinutes !== undefined)
    scalarUpdate.estimatedTimeMinutes = payload.estimatedTimeMinutes;
  if (payload.difficulty !== undefined)
    scalarUpdate.difficulty = payload.difficulty;
  if (payload.servingsDefault !== undefined)
    scalarUpdate.servingsDefault = payload.servingsDefault;
  if (payload.tags !== undefined) scalarUpdate.tags = payload.tags;
  if (payload.imageUrl !== undefined) scalarUpdate.imageUrl = payload.imageUrl;
  if (payload.macros) {
    if (payload.macros.caloriesPerServing !== undefined)
      scalarUpdate.caloriesPerServing = payload.macros.caloriesPerServing;
    if (payload.macros.proteinGPerServing !== undefined)
      scalarUpdate.proteinGPerServing = payload.macros.proteinGPerServing;
    if (payload.macros.carbsGPerServing !== undefined)
      scalarUpdate.carbsGPerServing = payload.macros.carbsGPerServing;
    if (payload.macros.fatGPerServing !== undefined)
      scalarUpdate.fatGPerServing = payload.macros.fatGPerServing;
  }
  if (Object.keys(scalarUpdate).length > 0) {
    await tx.dish.update({ where: { id: dishId }, data: scalarUpdate });
  }

  // Recreate sub-rows.
  if (payload.ingredients !== undefined) {
    for (let ii = 0; ii < payload.ingredients.length; ii++) {
      const ing = payload.ingredients[ii];
      const canonical = ing.name.toLowerCase().trim();
      const ingredientId = ingredientIdByCanonical.get(canonical);
      if (!ingredientId) {
        throw new Error(
          `rematerializeDish: ingredient missing after upsert: "${ing.name}"`,
        );
      }
      await tx.dishIngredient.create({
        data: {
          dishId,
          ingredientId,
          quantity: ing.quantity,
          unit: ing.unit,
          preparationNote: ing.preparationNote ?? null,
          isOptional: ing.isOptional ?? false,
          positionIndex: ii,
        },
      });
    }
  }

  if (payload.steps !== undefined) {
    for (let si = 0; si < payload.steps.length; si++) {
      const s = payload.steps[si];
      await tx.recipeInstructionStep.create({
        data: {
          ownerType: "dish",
          ownerId: dishId,
          stepIndex: si,
          stepTextRaw: s.text,
          stepTextTranslated: s.text,
          ...(s.estimatedMinutes !== undefined
            ? { estimatedMinutes: s.estimatedMinutes }
            : {}),
          // D-WS9-235 — sent value, else the wiped step's at this index.
          ...preservedStepFields(s, preservable?.get(si)),
          // Block 3.7 (D-WS9-066) — swappable-component tags (omitted unless set).
          ...(s.componentKey !== undefined ? { componentKey: s.componentKey } : {}),
          ...(s.pathKey !== undefined ? { pathKey: s.pathKey } : {}),
        },
      });
    }

    // D-WS9-235 follow-up — the steps just rewritten are what every linked
    // meal's estimatedTimeMinutes / activeTimeMinutes were derived FROM. Re-stamp
    // each of those meals in the same transaction, over its full dish set, so
    // no meal keeps a time derived from steps that no longer exist. (The Dish
    // Builder sends steps on every edit, so this runs on every dish save.)
    const linked = await tx.mealDishLink.findMany({
      where: { dishId },
      select: { mealId: true },
    });
    for (const { mealId } of linked) {
      const siblings = await tx.mealDishLink.findMany({
        where: { mealId },
        select: { dishId: true },
      });
      await stampMealTiming(tx, mealId, siblings.map((l) => l.dishId));
    }
  }

  return { dishId };
}

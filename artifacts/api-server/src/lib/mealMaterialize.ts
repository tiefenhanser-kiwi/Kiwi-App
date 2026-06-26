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

import type { Prisma } from "@prisma/client";

import { type IngredientMention } from "./ingredientResolve";
import { recomputeAndPersistMealMacros } from "./mealMacros";
import { deriveAmountRefs, type MatcherIngredient } from "./stepAmountRefs";

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
  parallelGroup?: string | null;
  isTimingSensitive?: boolean;
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
    }
  | {
      kind: "link";
      dishId: string;
      role: "main" | "side" | "sauce" | "topping" | "base" | "optional";
      positionIndex: number;
    };

export interface MaterializeMealPayload {
  title: string;
  description?: string | null;
  cuisineType?: string | null;
  // Q2: ParsedMeal has no mealType. When omitted, the materializer
  // defaults to "dinner". See the deliberate comment at the create site.
  mealType?: "breakfast" | "lunch" | "dinner" | "snack" | "mixed";
  servingsDefault?: number;
  estimatedTimeMinutes?: number;
  difficulty?: "easy" | "medium" | "fancy";
  tags?: string[];
  sourceType?: "manual" | "wizard" | "directed" | "curated";
  macros?: MaterializeMealMacrosPerServing;
  dishes: MaterializeMealDish[];
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
): Promise<MaterializeMealResult> {
  // ── Pass 2 (transactional): meal graph.
  const meal = await tx.meal.create({
    data: {
      userId,
      title: payload.title,
      description: payload.description ?? null,
      cuisineType: payload.cuisineType ?? null,
      // Deliberate: Mode A has no mealType; picker is a Block-6 concern, not a TODO.
      mealType: payload.mealType ?? "dinner",
      sourceType: payload.sourceType ?? "manual",
      servingsDefault: payload.servingsDefault ?? 4,
      // WS7-8 BUG-003 — anchor frozen == servingsDefault at create.
      authoredServingsDefault: payload.servingsDefault ?? 4,
      estimatedTimeMinutes: payload.estimatedTimeMinutes ?? 30,
      difficulty: payload.difficulty ?? "easy",
      tags: payload.tags ?? [],
      isPublic: false,
      isArchived: false,
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
          // WS7-8 BUG-003 — anchor frozen == servingsDefault at create.
          authoredServingsDefault:
            d.servingsDefault ?? payload.servingsDefault ?? 4,
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
            ...(s.parallelGroup !== undefined
              ? { parallelGroup: s.parallelGroup }
              : {}),
            ...(s.isTimingSensitive !== undefined
              ? { isTimingSensitive: s.isTimingSensitive }
              : {}),
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
): Promise<MaterializeDishResult> {
  const macros = payload.macros
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
      estimatedTimeMinutes: payload.estimatedTimeMinutes ?? 30,
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
        ...(s.parallelGroup !== undefined
          ? { parallelGroup: s.parallelGroup }
          : {}),
        ...(s.isTimingSensitive !== undefined
          ? { isTimingSensitive: s.isTimingSensitive }
          : {}),
      },
    });
  }

  return { dishId: dish.id };
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
  // ── Pass 2 (in-tx): wipe.
  // Find currently linked dishes and partition into exclusively-owned
  // (delete) vs shared/catalog (unlink only).
  const currentLinks = await tx.mealDishLink.findMany({
    where: { mealId },
    select: { dishId: true },
  });
  const linkedDishIds = currentLinks.map((l) => l.dishId);

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
            ...(s.phaseType !== undefined ? { phaseType: s.phaseType } : {}),
            ...(s.parallelGroup !== undefined
              ? { parallelGroup: s.parallelGroup }
              : {}),
            ...(s.isTimingSensitive !== undefined
              ? { isTimingSensitive: s.isTimingSensitive }
              : {}),
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
          ...(s.phaseType !== undefined ? { phaseType: s.phaseType } : {}),
          ...(s.parallelGroup !== undefined
            ? { parallelGroup: s.parallelGroup }
            : {}),
          ...(s.isTimingSensitive !== undefined
            ? { isTimingSensitive: s.isTimingSensitive }
            : {}),
        },
      });
    }
  }

  return { dishId };
}

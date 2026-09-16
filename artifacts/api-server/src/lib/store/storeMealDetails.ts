// Plan-Gen Arc · Block 2 · D-WS9-038 — store-slot read helpers for the save arc.
//
// composeStoreMealDetails reads a shared-pool Meal into the wizard details-stage
// shape (WizardExpandEnrichedMealDetails) + a sourceStoreMealId marker, so the
// expand path can drop a store-filled slot into the draft for PREVIEW without an
// AI call. The meal is FORKED (not rebuilt from these details) at save, so this
// copy is preview-only — but it must be a valid details-stage meal so the draft
// persists + parses.
//
// filterBindableStoreMealIds is the save-time revalidation — the OWNER-OR-POOL
// predicate (post-pass Part C, BUG-281): a store slot may be a shared-pool meal
// (isPublic:true → forked at save, as always) OR the user's OWN meal by id (a
// user-built playlist go-to → placed DIRECT, the same branch POST
// /plans/from-meals has). A store slot whose id is neither has drifted
// (unpublished/archived) or was tampered — the save path demotes it to a live
// slot. One check covers drift-safety, tamper-safety, and graceful-degrade.

import type { PrismaClient } from "@prisma/client";

import { logger } from "../logger";
import {
  WizardExpandDishIngredientSchema,
  type WizardExpandEnrichedMealDetails,
} from "../ai/schemas/wizard";

// Meal.cuisineType is nullable but the wizard details schema needs a non-empty
// string; fall back to this when the pool meal carries none.
const CUISINE_FALLBACK = "other";

// BUG-040 — the outcome of composing a pool meal into a store slot.
//   ok       → use this meal for the slot.
//   unusable → missing / no dishes / a dish with no ingredients (a coverage
//              miss; the slot goes live — D-WS9-037 graceful-degrade).
//   rejected → an ingredient FAILS the same schema activation enforces (bad
//              catalog data, e.g. an empty unit). The slot goes live too, but
//              this is a data-quality signal (logged + counted), NOT a silent
//              coverage miss — so a batch of bad Block-3 seed data is visible.
export type ComposeStoreMealResult =
  | { status: "ok"; meal: WizardExpandEnrichedMealDetails }
  | { status: "unusable" }
  | { status: "rejected"; reason: string };

/**
 * Read a shared-pool Meal into a details-stage wizard meal (stepless) carrying
 * `sourceStoreMealId`. The assembled ingredients are validated against the SAME
 * WizardExpandDishIngredientSchema the activation gate uses, so a store meal
 * that would 422 at activation is instead REJECTED here → the slot falls back to
 * live generation (never coerced, never persisted). Missing/structurally-empty
 * meals return `unusable`; the caller treats both non-`ok` cases as "go live".
 */
export async function composeStoreMealDetails(
  prisma: PrismaClient,
  storeMealId: string,
): Promise<ComposeStoreMealResult> {
  const meal = await prisma.meal.findUnique({
    where: { id: storeMealId },
    select: {
      id: true,
      title: true,
      // WS9 BUG-163 — the meal's one-line headnote. A store-composed slot is
      // built field-by-field from this select, so a column omitted here is a
      // field the draft payload can never carry, no matter what the wizard
      // schema or the mobile adapter declare downstream.
      description: true,
      cuisineType: true,
      difficulty: true,
      estimatedTimeMinutes: true,
      servingsDefault: true,
      dishLinks: {
        orderBy: { positionIndex: "asc" },
        select: {
          positionIndex: true,
          roleLabel: true,
          dish: {
            select: {
              title: true,
              caloriesPerServing: true,
              proteinGPerServing: true,
              carbsGPerServing: true,
              fatGPerServing: true,
              dishIngredients: {
                orderBy: { positionIndex: "asc" },
                select: {
                  quantity: true,
                  unit: true,
                  preparationNote: true,
                  isOptional: true,
                  ingredient: { select: { displayName: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!meal || meal.dishLinks.length === 0) return { status: "unusable" };

  const dishes: WizardExpandEnrichedMealDetails["dishes"] = [];
  for (const link of meal.dishLinks) {
    const d = link.dish;
    if (d.dishIngredients.length === 0) return { status: "unusable" }; // schema needs .min(1)
    dishes.push({
      title: d.title,
      role: link.roleLabel,
      positionIndex: link.positionIndex,
      ingredients: d.dishIngredients.map((di) => ({
        name: di.ingredient.displayName,
        quantity: di.quantity,
        unit: di.unit,
        ...(di.preparationNote != null
          ? { preparationNote: di.preparationNote }
          : {}),
        isOptional: di.isOptional,
      })),
      macros: {
        caloriesPerServing: d.caloriesPerServing,
        proteinGPerServing: d.proteinGPerServing,
        carbsGPerServing: d.carbsGPerServing,
        fatGPerServing: d.fatGPerServing,
      },
    });
  }

  // BUG-040 reject-to-live gate: validate each assembled ingredient against the
  // SAME WizardExpandDishIngredientSchema the activation gate enforces, so
  // compose-time and activation-time agree by construction. A bad value (e.g.
  // count-only produce seeded unit:"") is REJECTED here — the slot falls back to
  // live rather than 422'ing at activation. No coercion: bad data never
  // launders through.
  for (let di = 0; di < dishes.length; di++) {
    for (let ii = 0; ii < dishes[di].ingredients.length; ii++) {
      const parsed = WizardExpandDishIngredientSchema.safeParse(
        dishes[di].ingredients[ii],
      );
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path.join(".") || "shape";
        const reason = `dishes.${di}.ingredients.${ii}.${field}`;
        logger.warn(
          {
            event: "store_meal_rejected_invalid_ingredient",
            storeMealId: meal.id,
            reason,
          },
          "Store meal rejected at compose (invalid ingredient) — slot falls back to live",
        );
        return { status: "rejected", reason };
      }
    }
  }

  return {
    status: "ok",
    meal: {
      title: meal.title,
      // WS9 BUG-163 — Draft Review renders BEFORE save, from this payload, not
      // from the saved Meal row. The live-expansion path spreads the AI's meal
      // object and so kept `description`; this store-composed path rebuilt the
      // meal field-by-field and silently dropped it. On one observed draft that
      // is exactly what the user saw: 4 store-composed slots with no sub-text
      // and the single live slot with one.
      //
      // `?? undefined` (not `?? null`): the schema field is `.optional()`, and
      // BUG-153's row renders NOTHING rather than a placeholder when it is
      // absent, so an unauthored headnote must be missing, not empty.
      description: meal.description ?? undefined,
      cuisineType: meal.cuisineType ?? CUISINE_FALLBACK,
      estimatedTimeMinutes: meal.estimatedTimeMinutes,
      difficulty: meal.difficulty,
      servings: meal.servingsDefault,
      dishes,
      sourceStoreMealId: meal.id,
    },
  };
}

/** How a revalidated store slot binds at save: fork the pool row, or place the user's own row direct. */
export type StoreSlotBinding = "pool" | "own";

/**
 * Save-time owner-OR-pool revalidation (BUG-281). Given the store meal ids
 * marked on a draft, returns how each STILL-bindable id binds: "own" when the
 * meal is the user's (placed direct, no fork — a user-built playlist meal),
 * "pool" when it is in the shared pool (isPublic:true → forked). Ids absent
 * from the result have drifted, are another user's private meal, or were
 * tampered — and must demote to live.
 */
export async function filterBindableStoreMealIds(
  prisma: PrismaClient,
  ids: string[],
  userId: string,
): Promise<Map<string, StoreSlotBinding>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.meal.findMany({
    where: {
      id: { in: ids },
      isArchived: false,
      OR: [{ isPublic: true }, { userId }],
    },
    select: { id: true, userId: true, isPublic: true },
  });
  return new Map(rows.map((r) => [r.id, r.userId === userId ? "own" : "pool"]));
}

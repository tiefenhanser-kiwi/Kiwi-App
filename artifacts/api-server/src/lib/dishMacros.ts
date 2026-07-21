// WS6 6b-2 server-only AI helper. Consumer wiring lands in WS7 dish
// persistence (see D-WS6-026 for wizard integration, D-WS6-027 for the
// two-step wizard pattern). When WS7 scaffolds POST/PATCH /me/dishes
// endpoints: import { shouldEstimateMacros, estimateDishMacros },
// call shouldEstimateMacros(req.body) before save, if true call
// estimateDishMacros, apply result to dish.caloriesPerServing /
// proteinGPerServing / carbsGPerServing / fatGPerServing in the same
// transaction, and emit the dish_macros_estimated activity event on
// success.

import Anthropic from "@anthropic-ai/sdk";

import { runAICall as productionRunAICall } from "./ai/runAICall";
import {
  MacroEstimateResultSchema,
  type MacroEstimateResult,
} from "./ai/schemas/macros";
import {
  resolveConversionWithFallback,
  type ConversionFallbackPrisma,
} from "./conversionFallback";
import {
  convertToGrams,
  needsConversionFactor,
  resolveConversion,
} from "./ingredientConversions";
import { logger } from "./logger";
import {
  dishGroundingStatus,
  sanityMacroFlags,
  type GroundingStatus,
} from "./macroQuality";

export interface DishMacroSnapshot {
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
  // Optional — mobile-only DishDraft flag (artifacts/kiwi/lib/types.ts:569).
  // When true, the user opted in to AI-generated ingredients/macros even if
  // they manually entered values; we still call the estimator.
  kiwiAssistIngredients?: boolean;
}

/**
 * Pure predicate. Returns true when the caller should invoke
 * {@link estimateDishMacros}:
 *   - the user opted into kiwi-assist for this dish, OR
 *   - all four per-serving macros are 0 (the user did not enter them).
 *
 * Both branches mean "no trustworthy manual values present". A dish with any
 * non-zero macro AND no kiwiAssist flag is treated as user-authored and left
 * alone.
 */
export function shouldEstimateMacros(dish: DishMacroSnapshot): boolean {
  if (dish.kiwiAssistIngredients === true) return true;
  return (
    dish.caloriesPerServing === 0 &&
    dish.proteinGPerServing === 0 &&
    dish.carbsGPerServing === 0 &&
    dish.fatGPerServing === 0
  );
}

export interface DishMacroIngredientInput {
  name: string;
  quantity: number;
  unit: string;
  isOptional?: boolean;
  // WS7-8b USDA Block 1 — per-100g USDA reference macros used to GROUND the
  // AI estimate (the model scales these by the ingredient's gram weight).
  // Present only for ingredients with a matched USDA record; absent ingredients
  // are estimated exactly as before. See the grounding block in the
  // nutrition.ingredient_estimate prompt body.
  nutritionRefPer100g?: {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
  };
  // WS7-8b B2 — authoritative gram weight from the shared conversion table.
  // When present the prompt uses it directly instead of guessing densities.
  resolvedGrams?: number;
  // WS7-8b B2 — identity for the quantity→grams table lookup + AI-fallback
  // write-back (closes D-WS6-024 Step 2). Present on the plan-macro path
  // (persisted Ingredient rows); absent on the wizard path (unpersisted
  // ingredients), which falls back to the AI density guess as before.
  ingredientId?: string | null;
  canonicalName?: string;
  conversionRef?: unknown;
}

export interface EstimateDishMacrosOptions {
  prisma: ConversionFallbackPrisma;
  userId: string;
  // DI seam for tests. Production callers omit and runAICall builds its own
  // module-level Anthropic client from process.env.ANTHROPIC_API_KEY.
  client?: Pick<Anthropic, "messages">;
  dishTitle: string;
  servings: number;
  ingredients: DishMacroIngredientInput[];
  // D-WS9-050 Phase 2 — when true, the grams-grounding step does NOT invoke the
  // AI conversion fallback (which write-backs Ingredient.conversionRef). Used by
  // the read-only recompute dry-run so it never mutates ingredient rows; a
  // volume/count miss simply goes to the model without resolvedGrams (the model
  // derives it), which does not affect the grounding stamp (ref-based).
  skipConversionWriteback?: boolean;
  // D-WS9-053 §2.1 — sampling temperature for the estimator call. DEFAULTS TO 0
  // (Hans D1): a macro estimate is a MEASUREMENT, not a creative output, and a
  // calorie count must not vary between two users generating the same meal, nor
  // between recompute runs. Both the recompute path and the live wizard/dish
  // save path go through here, so the default makes both deterministic. An
  // explicit value can still override (e.g. a future A/B).
  temperature?: number;
}

export type EstimateDishMacrosResult =
  | {
      status: "success";
      perServing: MacroEstimateResult["perServing"];
      confidence?: MacroEstimateResult["confidence"];
      caveats?: MacroEstimateResult["caveats"];
      // D-WS9-050 G1 — plausibility flags on the returned macros (empty when
      // clean). Flag-and-log only; the numbers are NOT clamped.
      sanityFlags: string[];
      // D-WS9-050 G2 — how much of this estimate was grounded in USDA refs.
      grounding: GroundingStatus;
    }
  | {
      status: "failed";
      error: string;
    };

/**
 * Invokes the `nutrition.ingredient_estimate` AI prompt and returns the
 * parsed per-serving macros. Does NOT mutate the database (callers apply the
 * result inside their own dish-save transaction). Does NOT emit activity
 * events (the WS7 endpoint owns that, so the event fires exactly once per
 * persisted dish and references the new dish's id).
 *
 * On AI failure (no API key, SDK error, validation failure after retry) this
 * returns { status: 'failed', error } instead of throwing — the caller is
 * expected to persist the dish with macros at 0 and surface a soft warning,
 * not abort the save.
 */
export async function estimateDishMacros(
  opts: EstimateDishMacrosOptions,
): Promise<EstimateDishMacrosResult> {
  // WS7-8b B2 — ground each ingredient's gram weight from the shared conversion
  // table (curated/usda_derived), filling volume/count misses via the stamped
  // AI-fallback, so the prompt uses an authoritative number instead of its own
  // kitchen-density guess (closes D-WS6-024 Step 2). Weight units resolve with
  // no factor; unmappable units and the wizard path (no canonicalName) fall back
  // to the prompt's guess exactly as before.
  const groundedIngredients = await Promise.all(
    opts.ingredients.map(async (ing) => {
      if (ing.resolvedGrams != null || !ing.canonicalName) return ing;

      let conv = resolveConversion(ing.canonicalName, ing.conversionRef);
      let grams = convertToGrams(ing.quantity, ing.unit, conv);

      if (
        grams == null &&
        !opts.skipConversionWriteback &&
        needsConversionFactor(ing.unit) &&
        ing.ingredientId != null
      ) {
        conv = await resolveConversionWithFallback(
          {
            ingredientId: ing.ingredientId,
            canonicalName: ing.canonicalName,
            conversionRef: ing.conversionRef,
          },
          { prisma: opts.prisma, userId: opts.userId, client: opts.client },
        );
        grams = convertToGrams(ing.quantity, ing.unit, conv);
      }

      return grams != null ? { ...ing, resolvedGrams: grams } : ing;
    }),
  );

  const result = await productionRunAICall(
    "nutrition.ingredient_estimate",
    {
      estimateInput: {
        dishTitle: opts.dishTitle,
        servings: opts.servings,
        ingredients: groundedIngredients.map((ing) => ({
          name: ing.name,
          quantity: ing.quantity,
          unit: ing.unit,
          ...(ing.isOptional !== undefined ? { isOptional: ing.isOptional } : {}),
          ...(ing.nutritionRefPer100g ? { nutritionRefPer100g: ing.nutritionRefPer100g } : {}),
          ...(ing.resolvedGrams != null ? { resolvedGrams: ing.resolvedGrams } : {}),
        })),
      },
    },
    MacroEstimateResultSchema,
    {
      prisma: opts.prisma,
      userId: opts.userId,
      client: opts.client,
      // Default 0 — deterministic macros on both the recompute and live paths.
      temperature: opts.temperature ?? 0,
    },
  );

  if (!result.success) {
    return {
      status: "failed",
      error: result.userFacingMessage,
    };
  }

  // G2 — grounding measured from the ingredients actually sent to the model.
  const grounding = dishGroundingStatus(groundedIngredients);
  // G1 — plausibility flags. Log (do NOT clamp) so an implausible catalog macro
  // is visible in the dry-run/recompute review, never silently shipped.
  const sanityFlags = sanityMacroFlags(result.data.perServing);
  if (sanityFlags.length > 0) {
    logger.warn(
      {
        event: "macro_estimate_implausible",
        userId: opts.userId,
        dishTitle: opts.dishTitle,
        perServing: result.data.perServing,
        sanityFlags,
        grounding,
      },
      "Estimator returned implausible macros (flagged, not clamped)",
    );
  }

  return {
    status: "success",
    perServing: result.data.perServing,
    confidence: result.data.confidence,
    caveats: result.data.caveats,
    sanityFlags,
    grounding,
  };
}

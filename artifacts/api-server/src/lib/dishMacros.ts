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
import type { PrismaLike } from "./ai/promptRegistry";
import {
  MacroEstimateResultSchema,
  type MacroEstimateResult,
} from "./ai/schemas/macros";

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
}

export interface EstimateDishMacrosOptions {
  prisma: PrismaLike;
  userId: string;
  // DI seam for tests. Production callers omit and runAICall builds its own
  // module-level Anthropic client from process.env.ANTHROPIC_API_KEY.
  client?: Pick<Anthropic, "messages">;
  dishTitle: string;
  servings: number;
  ingredients: DishMacroIngredientInput[];
}

export type EstimateDishMacrosResult =
  | {
      status: "success";
      perServing: MacroEstimateResult["perServing"];
      confidence?: MacroEstimateResult["confidence"];
      caveats?: MacroEstimateResult["caveats"];
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
  const result = await productionRunAICall(
    "nutrition.ingredient_estimate",
    {
      estimateInput: {
        dishTitle: opts.dishTitle,
        servings: opts.servings,
        ingredients: opts.ingredients,
      },
    },
    MacroEstimateResultSchema,
    {
      prisma: opts.prisma,
      userId: opts.userId,
      client: opts.client,
    },
  );

  if (!result.success) {
    return {
      status: "failed",
      error: result.userFacingMessage,
    };
  }

  return {
    status: "success",
    perServing: result.data.perServing,
    confidence: result.data.confidence,
    caveats: result.data.caveats,
  };
}

// WS6 6b-4 server-only AI helpers. Consumer wiring is the Dish Builder /
// Meal Builder form's Kiwi-assist checkbox onChange → endpoint call → form
// field population. WS7-ish work.
//
// Per PRD §1.2 these flows are FREE — no SubscriptionService gate. The route
// wrappers in routes/builder.ts deliberately omit any entitlement check.

import Anthropic from "@anthropic-ai/sdk";

import { runAICall as productionRunAICall } from "./ai/runAICall";
import type { PrismaLike } from "./ai/promptRegistry";
import {
  AssistIngredientsResultSchema,
  AssistStepsResultSchema,
  type AssistedIngredient,
  type AssistedStep,
  type AssistIngredientsExistingItem,
  type AssistIngredientsInput,
  type AssistStepsIngredient,
  type AssistStepsInput,
} from "./ai/schemas/mealBuilder";

// ── assist ingredients ────────────────────────────────────────────────

export interface AssistDishIngredientsOptions {
  prisma: PrismaLike;
  userId: string;
  // DI seam for tests. Production callers omit and runAICall builds its own
  // module-level Anthropic client from process.env.ANTHROPIC_API_KEY.
  client?: Pick<Anthropic, "messages">;
  dishTitle: string;
  cuisine?: string;
  existingIngredients: AssistIngredientsExistingItem[];
  servings: number;
  userHints?: AssistIngredientsInput["userHints"];
}

export type AssistDishIngredientsResult =
  | {
      status: "success";
      ingredients: AssistedIngredient[];
      caveats?: string[];
    }
  | {
      status: "failed";
      error: string;
    };

/**
 * Invokes the `meal_builder.assist_ingredients` AI prompt. The Dish Builder /
 * Meal Builder form sends what the user has typed so far; this helper returns
 * a complete ingredient list with isUserProvided / addedByKiwi flags so the
 * form can show a diff. Does NOT throw on failure — returns
 * { status: 'failed', error } so the route layer can surface a soft error.
 */
export async function assistDishIngredients(
  opts: AssistDishIngredientsOptions,
): Promise<AssistDishIngredientsResult> {
  const result = await productionRunAICall(
    "meal_builder.assist_ingredients",
    {
      assistIngredientsInput: {
        dishTitle: opts.dishTitle,
        cuisine: opts.cuisine,
        existingIngredients: opts.existingIngredients,
        servings: opts.servings,
        userHints: opts.userHints,
      },
    },
    AssistIngredientsResultSchema,
    {
      prisma: opts.prisma,
      userId: opts.userId,
      client: opts.client,
    },
  );

  if (!result.success) {
    return { status: "failed", error: result.userFacingMessage };
  }

  return {
    status: "success",
    ingredients: result.data.ingredients,
    caveats: result.data.caveats,
  };
}

// ── assist steps ──────────────────────────────────────────────────────

export interface AssistDishStepsOptions {
  prisma: PrismaLike;
  userId: string;
  client?: Pick<Anthropic, "messages">;
  dishTitle: string;
  cuisine?: string;
  ingredients: AssistStepsIngredient[];
  servings: number;
  prepTimeMinutes?: number;
  cookTimeMinutes?: number;
}

export type AssistDishStepsResult =
  | {
      status: "success";
      steps: AssistedStep[];
      caveats?: string[];
    }
  | {
      status: "failed";
      error: string;
    };

/**
 * Invokes the `meal_builder.assist_steps` AI prompt. Receives the full
 * ingredient list (assumed settled — Mode B's "Help with steps" only fires
 * once ingredients are in place) and returns phase-tagged cooking steps.
 * Does NOT throw on failure.
 */
export async function assistDishSteps(
  opts: AssistDishStepsOptions,
): Promise<AssistDishStepsResult> {
  const result = await productionRunAICall(
    "meal_builder.assist_steps",
    {
      assistStepsInput: {
        dishTitle: opts.dishTitle,
        cuisine: opts.cuisine,
        ingredients: opts.ingredients,
        servings: opts.servings,
        prepTimeMinutes: opts.prepTimeMinutes,
        cookTimeMinutes: opts.cookTimeMinutes,
      },
    },
    AssistStepsResultSchema,
    {
      prisma: opts.prisma,
      userId: opts.userId,
      client: opts.client,
    },
  );

  if (!result.success) {
    return { status: "failed", error: result.userFacingMessage };
  }

  return {
    status: "success",
    steps: result.data.steps,
    caveats: result.data.caveats,
  };
}

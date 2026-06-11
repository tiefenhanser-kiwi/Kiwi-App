// Mobile client for POST /api/builder/* — Mode A parse-meal + the two
// Kiwi-assist endpoints (assist-ingredients, assist-steps).
//
// WS7-6 Block 1C: schemas are transcribed from
// artifacts/api-server/src/lib/ai/schemas/mealBuilder.ts (manual sync — the
// mobile package stays independent of the api-server build, so any
// server-side schema change here needs a corresponding client edit).
//
// Difficulty enum at the client boundary: the mobile UI uses
// `easy | medium | hard`; the server uses `easy | medium | fancy`. parse-meal
// emits `fancy`, so the wrapper maps `fancy → hard` on the way back. The
// save-meal direction (`hard → fancy`) is handled when callers build the
// POST /me/meals payload — `toServerDifficulty` is exported for that use.
//
// AbortSignal: every wrapper threads `opts.signal` to fetch so the calling
// screen can cancel mid-flight (same convention as expandWizardCandidate;
// no client-side timeout — the apiClient layer doesn't impose one).

import { z } from "zod";

import { apiClient } from "./client";

// ── Difficulty mapping (UI ↔ server) ──────────────────────────────────────

export type UiDifficulty = "easy" | "medium" | "hard";
export type ServerDifficulty = "easy" | "medium" | "fancy";

export function toServerDifficulty(d: UiDifficulty): ServerDifficulty {
  return d === "hard" ? "fancy" : d;
}

export function fromServerDifficulty(d: ServerDifficulty): UiDifficulty {
  return d === "fancy" ? "hard" : d;
}

// ── Common nested schemas ────────────────────────────────────────────────
// `cuisine` is left as a permissive string on mobile. The server validates it
// against CuisineTypeEnum (24+Other title-case catalog); rather than mirror
// that list here we pass through whatever the chip-row produced and let the
// server reject malformed values.

const ServerDifficultyEnum = z.enum(["easy", "medium", "fancy"]);
const StepPhaseTypeEnum = z.enum([
  "prep",
  "preheat",
  "cook",
  "rest",
  "assemble",
  "hold",
]);
const SubDishRoleEnum = z.enum(["main", "side", "sauce", "topping", "base"]);

// ── /builder/assist-ingredients ──────────────────────────────────────────

export interface AssistIngredientsExistingItem {
  name: string;
  quantity?: number;
  unit?: string;
}

export interface AssistIngredientsInput {
  dishTitle: string;
  cuisine?: string;
  existingIngredients: AssistIngredientsExistingItem[];
  servings: number;
  userHints?: {
    dietary?: string[];
    allergens?: string[];
  };
}

export const AssistedIngredientSchema = z.object({
  name: z.string(),
  quantity: z.number(),
  unit: z.string(),
  isOptional: z.boolean().optional(),
  isUserProvided: z.boolean(),
  addedByKiwi: z.boolean(),
});
export type AssistedIngredient = z.infer<typeof AssistedIngredientSchema>;

const AssistIngredientsResponseSchema = z.object({
  status: z.literal("success"),
  ingredients: z.array(AssistedIngredientSchema),
  caveats: z.array(z.string()).optional(),
});

export interface AssistIngredientsResult {
  ingredients: AssistedIngredient[];
  caveats?: string[];
}

/**
 * POST /api/builder/assist-ingredients — Kiwi-assist for the Dish Builder
 * "Have Kiwi suggest recipe" toggle. Takes the dish title + cuisine +
 * whatever the user has already typed; the server returns a complete
 * ingredient list with provenance flags so the form can render a diff.
 *
 * Propagates apiClient typed errors: `UnauthenticatedError` (401),
 * `ApiError` (502 ai_failed), `ApiSchemaError` on shape mismatch.
 */
export async function assistIngredients(
  input: AssistIngredientsInput,
  opts: { signal?: AbortSignal } = {},
): Promise<AssistIngredientsResult> {
  const body = await apiClient("/builder/assist-ingredients", {
    method: "POST",
    body: input,
    schema: AssistIngredientsResponseSchema,
    signal: opts.signal,
  });
  return { ingredients: body.ingredients, caveats: body.caveats };
}

// ── /builder/assist-steps ────────────────────────────────────────────────

export interface AssistStepsIngredient {
  name: string;
  quantity: number;
  unit: string;
}

export interface AssistStepsInput {
  dishTitle: string;
  cuisine?: string;
  ingredients: AssistStepsIngredient[];
  servings: number;
  prepTimeMinutes?: number;
  cookTimeMinutes?: number;
}

export const AssistedStepSchema = z.object({
  content: z.string(),
  estimatedMinutes: z.number(),
  phaseType: StepPhaseTypeEnum,
  isTimingSensitive: z.boolean().optional(),
  parallelGroup: z.string().nullable().optional(),
});
export type AssistedStep = z.infer<typeof AssistedStepSchema>;

const AssistStepsResponseSchema = z.object({
  status: z.literal("success"),
  steps: z.array(AssistedStepSchema),
  caveats: z.array(z.string()).optional(),
});

export interface AssistStepsResult {
  steps: AssistedStep[];
  caveats?: string[];
}

/**
 * POST /api/builder/assist-steps — Kiwi-assist for the Dish Builder
 * "Have Kiwi suggest steps" toggle. Runs after the ingredient list is
 * settled; the server returns ordered steps with phaseType + optional
 * parallelGroup so the sequencer can render them later.
 *
 * Propagates apiClient typed errors: `UnauthenticatedError` (401),
 * `ApiError` (502 ai_failed), `ApiSchemaError` on shape mismatch.
 */
export async function assistSteps(
  input: AssistStepsInput,
  opts: { signal?: AbortSignal } = {},
): Promise<AssistStepsResult> {
  const body = await apiClient("/builder/assist-steps", {
    method: "POST",
    body: input,
    schema: AssistStepsResponseSchema,
    signal: opts.signal,
  });
  return { steps: body.steps, caveats: body.caveats };
}

// ── /builder/parse-meal ──────────────────────────────────────────────────
// Mode A: free-text → one Meal with sub-dishes. Premium-gated server-side
// (402 UpgradeRequiredError propagated to caller).

export interface ParseMealInput {
  freeText: string;
  servings?: number;
  userHints?: {
    dietary?: string[];
    allergens?: string[];
    cuisinesLiked?: string[];
  };
}

const ParsedSubDishIngredientSchema = z.object({
  name: z.string(),
  quantity: z.number(),
  unit: z.string(),
  isOptional: z.boolean().optional(),
});
export type ParsedSubDishIngredient = z.infer<
  typeof ParsedSubDishIngredientSchema
>;

const ParsedSubDishStepSchema = z.object({
  content: z.string(),
  estimatedMinutes: z.number(),
  phaseType: StepPhaseTypeEnum,
  isTimingSensitive: z.boolean().optional(),
  parallelGroup: z.string().nullable().optional(),
});
export type ParsedSubDishStep = z.infer<typeof ParsedSubDishStepSchema>;

const ParsedSubDishSchema = z.object({
  title: z.string(),
  role: SubDishRoleEnum,
  positionIndex: z.number(),
  ingredients: z.array(ParsedSubDishIngredientSchema),
  steps: z.array(ParsedSubDishStepSchema),
});
export type ParsedSubDish = z.infer<typeof ParsedSubDishSchema>;

// Server-shaped parsed meal — `difficulty` is the server enum. Wrapper
// transforms to `ParsedMeal` (UI difficulty) before returning to callers.
const ServerParsedMealSchema = z.object({
  title: z.string(),
  cuisine: z.string().nullable(),
  estimatedPrepMinutes: z.number(),
  estimatedCookMinutes: z.number(),
  servingsDefault: z.number(),
  difficulty: ServerDifficultyEnum,
  tags: z.array(z.string()),
  subDishes: z.array(ParsedSubDishSchema),
});

const ParseMealResponseSchema = z.object({
  status: z.literal("success"),
  meal: ServerParsedMealSchema,
  caveats: z.array(z.string()).optional(),
});

export interface ParsedMeal {
  title: string;
  cuisine: string | null;
  estimatedPrepMinutes: number;
  estimatedCookMinutes: number;
  servingsDefault: number;
  /** UI difficulty enum (`fancy → hard` mapped at the wrapper boundary). */
  difficulty: UiDifficulty;
  tags: string[];
  subDishes: ParsedSubDish[];
}

export interface ParseMealResult {
  meal: ParsedMeal;
  caveats?: string[];
}

/**
 * POST /api/builder/parse-meal — Mode A free-text parse. Premium-gated
 * server-side: a 402 surfaces as `UpgradeRequiredError` so the screen
 * can route to the upgrade modal.
 *
 * The server's `difficulty` enum is normalized from `fancy` to `hard` at
 * this boundary so callers downstream (Meal Builder form state, DraftMeal)
 * can speak one UI vocabulary.
 *
 * Propagates apiClient typed errors: `UnauthenticatedError` (401),
 * `UpgradeRequiredError` (402 premium gate), `ApiError` (502 ai_failed),
 * `ApiSchemaError` on shape mismatch.
 */
export async function parseMeal(
  input: ParseMealInput,
  opts: { signal?: AbortSignal } = {},
): Promise<ParseMealResult> {
  const body = await apiClient("/builder/parse-meal", {
    method: "POST",
    body: input,
    schema: ParseMealResponseSchema,
    signal: opts.signal,
  });
  return {
    meal: {
      ...body.meal,
      difficulty: fromServerDifficulty(body.meal.difficulty),
    },
    caveats: body.caveats,
  };
}

// ── /builder/parse-dish ──────────────────────────────────────────────────
// Dish Mode A (WS7-6 G2): free-text → ONE Dish (single dish, no sub-dishes —
// the dish twin of parse-meal, PRD §10.5.8). Premium-gated server-side (402
// UpgradeRequiredError propagated to caller). Reuses the parse-meal sub-dish
// ingredient/step schemas — a dish's ingredients + steps are the same shape.

export interface ParseDishInput {
  freeText: string;
  servings?: number;
  userHints?: {
    dietary?: string[];
    allergens?: string[];
    cuisinesLiked?: string[];
  };
}

// Server-shaped parsed dish — `difficulty` is the server enum. Wrapper
// transforms to `ParsedDish` (UI difficulty) before returning to callers.
const ServerParsedDishSchema = z.object({
  title: z.string(),
  cuisine: z.string().nullable(),
  estimatedPrepMinutes: z.number(),
  estimatedCookMinutes: z.number(),
  servingsDefault: z.number(),
  difficulty: ServerDifficultyEnum,
  tags: z.array(z.string()),
  ingredients: z.array(ParsedSubDishIngredientSchema),
  steps: z.array(ParsedSubDishStepSchema),
});

const ParseDishResponseSchema = z.object({
  status: z.literal("success"),
  dish: ServerParsedDishSchema,
  caveats: z.array(z.string()).optional(),
});

export interface ParsedDish {
  title: string;
  cuisine: string | null;
  estimatedPrepMinutes: number;
  estimatedCookMinutes: number;
  servingsDefault: number;
  /** UI difficulty enum (`fancy → hard` mapped at the wrapper boundary). */
  difficulty: UiDifficulty;
  tags: string[];
  ingredients: ParsedSubDishIngredient[];
  steps: ParsedSubDishStep[];
}

export interface ParseDishResult {
  dish: ParsedDish;
  caveats?: string[];
}

/**
 * POST /api/builder/parse-dish — Dish Mode A free-text parse. Premium-gated
 * server-side: a 402 surfaces as `UpgradeRequiredError` so the screen can
 * route to the upgrade modal. The server's `difficulty` enum is normalized
 * from `fancy` to `hard` at this boundary so downstream callers (Dish Builder
 * form state) speak one UI vocabulary.
 *
 * Propagates apiClient typed errors: `UnauthenticatedError` (401),
 * `UpgradeRequiredError` (402 premium gate), `ApiError` (502 ai_failed),
 * `ApiSchemaError` on shape mismatch.
 */
export async function parseDish(
  input: ParseDishInput,
  opts: { signal?: AbortSignal } = {},
): Promise<ParseDishResult> {
  const body = await apiClient("/builder/parse-dish", {
    method: "POST",
    body: input,
    schema: ParseDishResponseSchema,
    signal: opts.signal,
  });
  return {
    dish: {
      ...body.dish,
      difficulty: fromServerDifficulty(body.dish.difficulty),
    },
    caveats: body.caveats,
  };
}

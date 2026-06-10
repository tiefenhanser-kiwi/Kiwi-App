// Mobile client for the WS7-3 A2 dish reads — GET /me/dishes (the Dishes-tab
// list) and GET /dishes/:id (dish detail).
// WS7-3 Block C1 — API-client + hook foundation; no screens migrate here.
//
// Schemas are transcribed from the real server routes
// (artifacts/api-server/src/routes/me.ts + src/routes/dishes.ts).

import { z } from "zod";

import { apiClient } from "./client";
import { MealDetailIngredientSchema, MealStepSchema } from "./meals";

// ── Filter keys ────────────────────────────────────────────────────────────
// ?filter= accept-list — mirrors the server's DISHES_FILTER_KEYS. No `hosting`
// facet: dishes have no hosting concept (artifacts/api-server/src/routes/me.ts).
export const DISH_FILTER_KEYS = ["my_dishes", "featured", "top_rated"] as const;
export type DishFilterKey = (typeof DISH_FILTER_KEYS)[number];

// ── Schemas ────────────────────────────────────────────────────────────────

// One row of the Dishes-tab list. A Dish has no cuisine; `difficulty` is
// intrinsic to a dish so it is surfaced in the list shape.
export const DishListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  minutes: z.number(),
  servings: z.number(),
  difficulty: z.string(),
  calories: z.number(),
  protein: z.number(),
  carbs: z.number(),
  fat: z.number(),
  tags: z.array(z.string()),
  image: z.string().nullable(),
});
export type DishListItem = z.infer<typeof DishListItemSchema>;

// GET /me/dishes response — the cursor-paginated dish-list union.
const DishListResponseSchema = z.object({
  dishes: z.array(DishListItemSchema),
  nextCursor: z.string().nullable(),
});
export type DishListResponse = z.infer<typeof DishListResponseSchema>;

// GET /dishes/:id detail. `ingredients` / `steps` reuse the meal-detail
// schemas — the server emits an identical shape (shared `toStepShape`; an
// identical ingredient projection). `userId` is nullable (curated dishes).
export const DishDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  image: z.string().nullable(),
  difficulty: z.string(),
  minutes: z.number(),
  servings: z.number(),
  calories: z.number(),
  protein: z.number(),
  carbs: z.number(),
  fat: z.number(),
  tags: z.array(z.string()),
  sourceType: z.string(),
  userId: z.string().nullable(),
  ingredients: z.array(MealDetailIngredientSchema),
  steps: z.array(MealStepSchema),
});
export type DishDetail = z.infer<typeof DishDetailSchema>;

const DishDetailEnvelopeSchema = z.object({ dish: DishDetailSchema });

// ── Getters ────────────────────────────────────────────────────────────────

/**
 * GET /me/dishes — the authenticated user's dish catalog, filtered by the
 * Dishes-tab chips. `filter` is a multi-select subset of DISH_FILTER_KEYS;
 * omitted/empty defers to the server default (`my_dishes`). Returns the
 * cursor-paginated union. Propagates the apiClient typed errors.
 */
export async function getDishes(
  filter?: readonly DishFilterKey[],
): Promise<DishListResponse> {
  const query =
    filter && filter.length > 0
      ? `?filter=${encodeURIComponent(filter.join(","))}`
      : "";
  return apiClient(`/me/dishes${query}`, { schema: DishListResponseSchema });
}

/**
 * GET /dishes/:id — full dish detail. Propagates the apiClient typed errors:
 * `ApiError` (404 for a missing or archived dish), `UnauthenticatedError`
 * (401), `ApiSchemaError` on a response-shape mismatch.
 */
export async function getDish(id: string): Promise<DishDetail> {
  const body = await apiClient(`/dishes/${encodeURIComponent(id)}`, {
    schema: DishDetailEnvelopeSchema,
  });
  return body.dish;
}

// ── Save-canonical (WS7-6 Block 1E) ─────────────────────────────────────
// POST /me/dishes — standalone Dish save from the Dish Builder. Schemas
// mirror postMeDishSchema at artifacts/api-server/src/routes/me.ts.

export interface SaveDishMacrosPerServing {
  caloriesPerServing?: number;
  proteinGPerServing?: number;
  carbsGPerServing?: number;
  fatGPerServing?: number;
}

export interface SaveDishIngredient {
  name: string;
  quantity: number;
  unit: string;
  preparationNote?: string | null;
  isOptional?: boolean;
}

export interface SaveDishStep {
  text: string;
  estimatedMinutes?: number;
  phaseType?: "prep" | "preheat" | "cook" | "rest" | "assemble" | "hold";
  parallelGroup?: string | null;
  isTimingSensitive?: boolean;
}

export interface SaveDishInput {
  title: string;
  description?: string | null;
  estimatedTimeMinutes?: number;
  difficulty?: "easy" | "medium" | "fancy";
  servingsDefault?: number;
  tags?: string[];
  sourceType?: "manual" | "wizard" | "directed" | "curated";
  macros?: SaveDishMacrosPerServing;
  ingredients: SaveDishIngredient[];
  steps: SaveDishStep[];
}

const SaveDishResponseSchema = z.object({
  dish: z.object({ id: z.string() }),
});

export interface SaveDishResponse {
  id: string;
}

/**
 * POST /api/me/dishes — save-canonical entry for the Dish Builder.
 *
 * Returns `{ id }` so the caller can subsequently reference the new dish in
 * a Meal-Builder Mode-C link payload.
 *
 * Propagates apiClient typed errors: `ApiError` (400 validation, 429 rate
 * limit, 500 tx), `UnauthenticatedError` (401), `ApiSchemaError` on a
 * response-shape mismatch.
 */
export async function saveDish(
  input: SaveDishInput,
  opts: { signal?: AbortSignal } = {},
): Promise<SaveDishResponse> {
  const body = await apiClient("/me/dishes", {
    method: "POST",
    body: input,
    schema: SaveDishResponseSchema,
    signal: opts.signal,
  });
  return body.dish;
}

// ── PATCH /me/dishes/:id (WS7-6 1A) ─────────────────────────────────────
// Closes D-WS7-086 on the mobile side. Edit-surface for a saved Dish; the
// server's wipe-and-recreate fires when `ingredients` and/or `steps` are
// present in the patch. Scalar-only patches (title, difficulty, …) skip
// the sub-graph wipe.
//
// Difficulty is server-enum here (`easy | medium | fancy`) — callers translate
// UI's "hard" via `toServerDifficulty` from lib/api/builder at the boundary,
// same convention as `saveDish` / `updateMeal`.

export interface UpdateDishInput {
  title?: string;
  description?: string | null;
  estimatedTimeMinutes?: number;
  difficulty?: "easy" | "medium" | "fancy";
  servingsDefault?: number;
  tags?: string[];
  imageUrl?: string | null;
  macros?: SaveDishMacrosPerServing;
  ingredients?: SaveDishIngredient[];
  steps?: SaveDishStep[];
}

const UpdateDishResponseSchema = z.object({
  dish: z.object({ id: z.string() }),
});

export interface UpdateDishResponse {
  id: string;
}

/**
 * PATCH /api/me/dishes/:id — global edit of a saved dish. Server enforces an
 * at-least-one-field refinement; the wipe-and-recreate sub-graph path runs
 * only when `ingredients` and/or `steps` are present in the patch.
 *
 * Propagates apiClient typed errors: `ApiError` (400 validation, 403 not
 * owned, 404 missing/archived/curated, 429 rate limit, 500 tx),
 * `UnauthenticatedError` (401), `ApiSchemaError` on a response-shape mismatch.
 */
export async function updateDish(
  id: string,
  patch: UpdateDishInput,
  opts: { signal?: AbortSignal } = {},
): Promise<UpdateDishResponse> {
  const body = await apiClient(`/me/dishes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: patch,
    schema: UpdateDishResponseSchema,
    signal: opts.signal,
  });
  return body.dish;
}

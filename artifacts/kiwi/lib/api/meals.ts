// Mobile client for the /api/meals namespace.
// WS6 6b-1 — POST /meals/find-similar: replaces the cuisine-only client
//   filter on FindSimilarSheet with a real semantic-similarity AI call.
// WS7-1 — migrated to apiClient + Zod validation.
// WS7-3 Block B — GET /meals/:id: meal-detail read (see getMeal below).
//
// Contract is client-sends-full-payload: the sheet unions all four candidate
// catalogs (saved + featured + top rated + hosting per PRD §8.4) and posts
// them with each request. WS7 will keep the same server contract while
// switching the client to fetch real data from the API first.

import { z } from "zod";

import { apiClient } from "./client";
import type { MealSummary } from "../types";

// Trim shape sent to the server. Mirror of MealCandidateSchema in
// artifacts/api-server/src/lib/ai/schemas/findSimilar.ts.
export interface MealCandidatePayload {
  id: string;
  title: string;
  cuisine: string | null;
  mealType: string;
  keyIngredients?: string[];
  tags?: string[];
}

// ── Zod schemas ──────────────────────────────────────────────────────────
// Transcribed from server-side findSimilar.ts + route response shape.
// Server's FindSimilarResultSchema has only `matches`; mobile-visible
// `metadata` is attached at the route boundary (artifacts/api-server/src/
// routes/meals.ts:220-225).

const FindSimilarMatchSchema = z.object({
  mealId: z.string(),
  similarityScore: z.number(),
  reason: z.string(),
});

const FindSimilarResponseSchema = z.object({
  matches: z.array(FindSimilarMatchSchema),
  metadata: z
    .object({
      promptVersion: z.number().nullable(),
      latencyMs: z.number(),
      mode: z.enum(["ai", "fallback_cuisine"]),
    })
    .optional(),
});

export interface FindSimilarMatch {
  mealId: string;
  similarityScore: number;
  reason: string;
}

export interface FindSimilarResponse {
  matches: FindSimilarMatch[];
  metadata?: {
    promptVersion: number | null;
    latencyMs: number;
    mode: "ai" | "fallback_cuisine";
  };
}

export interface FindSimilarRequest {
  source: MealCandidatePayload;
  candidates: MealCandidatePayload[];
  limit?: number;
}

// MealSummary doesn't carry mealType today; FindSimilar runs from the Plan
// Review sheet so dinner is the safe default. WS7 surfaces real mealType.
export function mealSummaryToCandidate(meal: MealSummary): MealCandidatePayload {
  return {
    id: meal.id,
    title: meal.title,
    cuisine: meal.cuisineType ?? null,
    mealType: "dinner",
  };
}

export async function findSimilarMeals(
  input: FindSimilarRequest,
): Promise<FindSimilarResponse> {
  return apiClient("/meals/find-similar", {
    method: "POST",
    body: input,
    schema: FindSimilarResponseSchema,
  });
}

// ── Meal detail (GET /api/meals/:id) ──────────────────────────────────────
// WS7-3 Block B — replaces the lib/stubs.ts getMealById fixture with the real
// catalog detail endpoint. Schemas are transcribed from the server's
// composeMealDetail (artifacts/api-server/src/routes/meals.ts): the renamed-
// flat meal envelope (cuisine / minutes / servings / calories… / image) plus
// a dishes[] array carrying per-dish ingredients + steps, and a top-level
// meal-owned steps[] fallback for legacy single-dish meals.

// A recipe step — shared by the per-dish steps and the top-level meal-owned
// fallback array. `stepIndex` is 0-based and restarts per owner.
const MealStepSchema = z.object({
  stepIndex: z.number(),
  text: z.string(),
  estimatedMinutes: z.number(),
  phaseType: z.string(),
  parallelGroup: z.string().nullable(),
  requiresPreheat: z.boolean(),
  requiresRest: z.boolean(),
  requiresMarination: z.boolean(),
  isTimingSensitive: z.boolean(),
});

const MealDetailIngredientSchema = z.object({
  name: z.string(),
  quantity: z.number(),
  unit: z.string(),
  preparationNote: z.string().nullable(),
  category: z.string(),
  isOptional: z.boolean(),
});

// One sub-dish of a meal. `roleLabel` / `difficulty` / `phaseType` are server
// enums kept as plain strings — matches the server's own composeMealDetail
// types and the lib/api/me.ts convention of not over-constraining columns the
// mobile UI only reads.
const MealDetailDishSchema = z.object({
  dishId: z.string(),
  title: z.string(),
  roleLabel: z.string(),
  positionIndex: z.number(),
  minutes: z.number(),
  difficulty: z.string(),
  servings: z.number(),
  ingredients: z.array(MealDetailIngredientSchema),
  steps: z.array(MealStepSchema),
});

// The full meal-detail payload. Shared meal-meta fields use the renamed-flat
// GET /meals list names (cuisine / minutes / servings / bare macros / image);
// detail-only fields keep their DB-style names. `notes` is always null today —
// the server has no meal-notes column (see WS7-3 B report §7).
export const MealDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  cuisine: z.string(),
  minutes: z.number(),
  servings: z.number(),
  calories: z.number(),
  protein: z.number(),
  carbs: z.number(),
  fat: z.number(),
  tags: z.array(z.string()),
  image: z.string().nullable(),
  description: z.string().nullable(),
  difficulty: z.string(),
  mealType: z.string(),
  sourceType: z.string(),
  isPublic: z.boolean(),
  userId: z.string().nullable(),
  dishes: z.array(MealDetailDishSchema),
  steps: z.array(MealStepSchema),
  notes: z.null(),
});

const MealDetailEnvelopeSchema = z.object({ meal: MealDetailSchema });

export type MealStep = z.infer<typeof MealStepSchema>;
export type MealDetailIngredient = z.infer<typeof MealDetailIngredientSchema>;
export type MealDetailDish = z.infer<typeof MealDetailDishSchema>;
export type MealDetail = z.infer<typeof MealDetailSchema>;

/**
 * GET /meals/:id — public meal-catalog detail. Returns the renamed-flat meal
 * envelope with per-dish ingredients + steps. Propagates the apiClient typed
 * errors: `ApiError` (status 404 for a missing or archived meal),
 * `UnauthenticatedError` (401), `ApiSchemaError` on a response-shape mismatch.
 */
export async function getMeal(id: string): Promise<MealDetail> {
  const body = await apiClient(`/meals/${encodeURIComponent(id)}`, {
    schema: MealDetailEnvelopeSchema,
  });
  return body.meal;
}

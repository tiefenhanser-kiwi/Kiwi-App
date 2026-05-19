// Mobile client for POST /api/meals/find-similar.
// WS6 6b-1 — replaces the cuisine-only client filter on FindSimilarSheet
// with a real semantic-similarity AI call.
// WS7-1 — migrated to apiClient + Zod validation.
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

// Mobile client for POST /api/meals/find-similar.
// WS6 6b-1 — replaces the cuisine-only client filter on FindSimilarSheet
// with a real semantic-similarity AI call.
//
// Contract is client-sends-full-payload: the sheet unions all four candidate
// catalogs (saved + featured + top rated + hosting per PRD §8.4) and posts
// them with each request. WS7 will keep the same server contract while
// switching the client to fetch real data from the API first.

import { readToken } from "../auth";
import type { MealSummary } from "../types";

const apiBase =
  process.env.EXPO_PUBLIC_API_BASE_URL ||
  (process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
    : "http://localhost:3000/api");

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
  const token = await readToken();
  if (!token) {
    throw new Error("Not authenticated");
  }
  const res = await fetch(`${apiBase}/meals/find-similar`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === "string") detail = body.error;
    } catch {
      // body wasn't JSON; keep the HTTP-status detail
    }
    throw new Error(detail);
  }
  return (await res.json()) as FindSimilarResponse;
}

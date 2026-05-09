import { z } from "zod";

// PRD §8.4 + D-WS5-006 — Find Similar AI semantic similarity (WS6 6b-1).
//
// Premium-gated. Contract is client-sends-full-payload: the server does NOT
// query the DB for the candidate pool because in WS6 the candidate buckets
// (saved + featured + top rated + hosting) are still mostly stubbed mobile-
// side. WS7 will flip the client to fetch real data first, then pass to this
// endpoint — the server contract stays stable across that flip.
//
// Cuisine-only fallback for premium-deny (artifacts/kiwi/lib/stubs.ts:
// findSimilarMealsByCuisine) stays free for lapsed users; the server returns
// the fallback in the same response shape so the client doesn't branch.

// Trim shape sent for both source and candidates. The mobile client maps
// MealSummary → this shape before posting. keyIngredients is capped at 8
// per item to keep the JSON payload trim — Haiku doesn't need 15 ingredients
// to score similarity.
export const MealCandidateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  cuisine: z.string().max(80).nullable(),
  mealType: z.string().min(1).max(40),
  keyIngredients: z.array(z.string().max(80)).max(8).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});
export type MealCandidate = z.infer<typeof MealCandidateSchema>;

export const FindSimilarRequestSchema = z.object({
  source: MealCandidateSchema,
  candidates: z.array(MealCandidateSchema).min(0).max(200),
  limit: z.number().int().min(1).max(25).optional(),
});
export type FindSimilarRequest = z.infer<typeof FindSimilarRequestSchema>;

export const FindSimilarMatchSchema = z.object({
  mealId: z.string().min(1),
  similarityScore: z.number().min(0).max(1),
  // Short human-readable reason, surfaced in the sheet under each match.
  // Capped at 120 chars so the row stays one line on a phone screen.
  reason: z.string().max(120),
});
export type FindSimilarMatch = z.infer<typeof FindSimilarMatchSchema>;

export const FindSimilarResultSchema = z.object({
  matches: z.array(FindSimilarMatchSchema).max(50),
});
export type FindSimilarResult = z.infer<typeof FindSimilarResultSchema>;

import { z } from "zod";

// PRD §8.4 + D-WS5-006 — Find Similar AI semantic similarity (WS6 6b-1).
//
// Premium-gated. Since FIX-2 (BUG-058) the server builds the candidate pool
// when the client sends `sourceMealId` (see FindSimilarRequestSchema); the
// original client-sends-full-payload shape is kept for the shipped 1.x client.
//
// Cuisine-only fallback for premium-deny (artifacts/kiwi/lib/stubs.ts:
// findSimilarMealsByCuisine) stays free for lapsed users; the server returns
// the fallback in the same response shape so the client doesn't branch.

// What the server-built pool sends the model (FIX-2): a short alias id, the
// title, the cuisine and the dish titles, main dish first. The alias keeps the
// payload small and makes an invented id impossible to mistake for a real one.
export interface PooledMealForPrompt {
  id: string;
  title: string;
  cuisine: string | null;
  dishes: string[];
}

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

// Two request shapes, one endpoint:
//   · FIX-2 (BUG-058) — { sourceMealId, planId? }: the SERVER builds the pool
//     (lib/similar/swapPool.ts: the catalog plus the user's meals, minus the
//     plan's own, pre-filtered on dish form) and each match carries its `meal`.
//   · the original { source, candidates }: the shipped 1.x client builds the
//     pool itself. Kept so a store binary that has not taken the update keeps
//     working; it gets the v2 prompt over its own pool.
export const FindSimilarRequestSchema = z
  .object({
    sourceMealId: z.string().min(1).max(100).optional(),
    planId: z.string().min(1).max(100).optional(),
    source: MealCandidateSchema.optional(),
    candidates: z.array(MealCandidateSchema).min(0).max(200).optional(),
    limit: z.number().int().min(1).max(25).optional(),
  })
  .refine((r) => r.sourceMealId !== undefined || (r.source !== undefined && r.candidates !== undefined), {
    message: "send sourceMealId, or source + candidates",
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

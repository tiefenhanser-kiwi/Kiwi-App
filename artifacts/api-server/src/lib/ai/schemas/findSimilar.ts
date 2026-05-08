import { z } from "zod";

// PRD §8.4 + D-WS5-006 — Find Similar AI semantic similarity.
// Premium-gated; cuisine-only fallback (artifacts/kiwi/lib/stubs.ts:2265)
// stays free for lapsed users.
export const FindSimilarInputSchema = z.object({
  sourceMealId: z.string().min(1),
  // The candidate pool to rank. Server pre-filters before sending.
  candidateMealIds: z.array(z.string()).min(1).max(200),
  // Optional reason hint from the user ("I want something lighter").
  userHint: z.string().max(280).optional(),
});
export type FindSimilarInput = z.infer<typeof FindSimilarInputSchema>;

// PRD §8.4 — ranked similarity result. Server keeps top N for the sheet.
export const FindSimilarMatchSchema = z.object({
  mealId: z.string().min(1),
  similarityScore: z.number().min(0).max(1),
  // Short human-readable reason ("Same cuisine + similar protein").
  reason: z.string().max(140).optional(),
});
export type FindSimilarMatch = z.infer<typeof FindSimilarMatchSchema>;

export const FindSimilarResultSchema = z.object({
  matches: z.array(FindSimilarMatchSchema).max(50),
});
export type FindSimilarResult = z.infer<typeof FindSimilarResultSchema>;

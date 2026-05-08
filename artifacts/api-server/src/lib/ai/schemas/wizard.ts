import { z } from "zod";

// PRD §5.7 — Set Preferences wizard input shape.
// Mirrors WizardPreferencesInput in artifacts/kiwi/lib/types.ts:521.
export const WizardInputSchema = z.object({
  planDurationDays: z.number().int().min(1).max(7),
  householdSize: z.number().int().min(1).max(30),
  wantsLeftovers: z.boolean(),
  cuisines: z.array(z.string()).default([]),
  eatingStyles: z.array(z.string()).default([]),
  allergiesAndAvoidances: z.array(z.string()).default([]),
  difficulty: z.enum(["easy", "medium", "fancy"]),
  weeklyPacing: z.enum([
    "mostly_easy",
    "mixed",
    "one_fancy",
    "minimal_effort",
  ]),
  dietaryNotes: z.string().max(500).optional(),
  additionalNotes: z.string().max(500).optional(),
  // Server-injected hidden context (PRD §5.7).
  hiddenContext: z
    .object({
      equipment: z.array(z.string()).optional(),
      spiceTolerance: z.string().optional(),
      pantryStaples: z.array(z.string()).optional(),
      recentMealIds: z.array(z.string()).optional(),
    })
    .optional(),
});
export type WizardInput = z.infer<typeof WizardInputSchema>;

// PRD §5.7 — preview of one meal inside a candidate plan.
export const WizardMealPreviewSchema = z.object({
  title: z.string().min(1).max(120),
  cuisineType: z.string().optional(),
  estimatedTimeMinutes: z.number().int().positive().optional(),
});
export type WizardMealPreview = z.infer<typeof WizardMealPreviewSchema>;

// PRD §5.7 — single plan candidate.
// Mirrors WizardPlanCandidate in artifacts/kiwi/lib/types.ts:476.
export const WizardPlanCandidateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(120),
  imageUrl: z.string().url().optional(),
  badge: z.enum(["featured", "top_rated"]).optional(),
  tags: z.array(z.string()).max(5),
  whyBullets: z.array(z.string()).min(1).max(3),
  mealTitles: z.array(z.string()).min(1).max(7),
  meals: z.array(WizardMealPreviewSchema).optional(),
  dailyMacros: z.object({
    calories: z.number().nonnegative(),
    proteinG: z.number().nonnegative(),
    carbsG: z.number().nonnegative(),
    fatG: z.number().nonnegative(),
  }),
});
export type WizardPlanCandidate = z.infer<typeof WizardPlanCandidateSchema>;

// PRD §5.5 + §5.8 — wrapper with empty/restrictive-constraint flag.
export const WizardPlanCandidatesResultSchema = z.object({
  candidates: z.array(WizardPlanCandidateSchema).max(3),
  cannotGenerateMore: z.boolean().optional(),
  reason: z.string().max(280).optional(),
});
export type WizardPlanCandidatesResult = z.infer<
  typeof WizardPlanCandidatesResultSchema
>;

import { z } from "zod";

// PRD §7.7 — Cook Now request shape.
export const CookNowInputSchema = z.object({
  // Free-text description of what the user wants to cook tonight.
  description: z.string().min(1).max(500),
  // Time budget in minutes (e.g., "I have 30 minutes").
  timeBudgetMinutes: z.number().int().positive().optional(),
  // Optional pantry context — server-injected from PantryStaple table.
  pantry: z.array(z.string()).optional(),
  // Optional explicit ingredient pool the user has on hand.
  ingredientsOnHand: z.array(z.string()).optional(),
  householdSize: z.number().int().min(1).max(30),
  allergiesAndAvoidances: z.array(z.string()).default([]),
});
export type CookNowInput = z.infer<typeof CookNowInputSchema>;

// PRD §7.7, §10.9 — canonical step shape. phaseType and parallelGroup
// power the Cooking Sequencer (§13.5.4) and Prep the Week (§13.4.6).
// Mirrors RecipeInstructionStep schema fields.
export const StepPhaseSchema = z.enum([
  "prep",
  "cook",
  "rest",
  "preheat",
  "assemble",
  "hold",
]);
export type StepPhase = z.infer<typeof StepPhaseSchema>;

export const TranslatedStepSchema = z.object({
  stepIndex: z.number().int().min(0),
  text: z.string().min(1),
  estimatedMinutes: z.number().int().positive().default(1),
  phaseType: StepPhaseSchema.default("cook"),
  parallelGroup: z.string().optional(),
  requiresPreheat: z.boolean().default(false),
  requiresRest: z.boolean().default(false),
  requiresMarination: z.boolean().default(false),
  isTimingSensitive: z.boolean().default(false),
});
export type TranslatedStep = z.infer<typeof TranslatedStepSchema>;

// PRD §7.7 — single recipe inside a Cook Now result.
export const CookNowRecipeSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  cuisineType: z.string().optional(),
  estimatedTimeMinutes: z.number().int().positive(),
  servings: z.number().int().positive(),
  ingredients: z.array(
    z.object({
      quantity: z.number().nonnegative(),
      unit: z.string(),
      name: z.string().min(1),
    }),
  ),
  steps: z.array(TranslatedStepSchema),
});
export type CookNowRecipe = z.infer<typeof CookNowRecipeSchema>;

// PRD §7.7 — top-level Cook Now response.
export const CookNowResultSchema = z.object({
  recipe: CookNowRecipeSchema,
  source: z.enum(["matched", "generated"]),
  // For matched results, the catalog meal id we matched to.
  matchedMealId: z.string().optional(),
});
export type CookNowResult = z.infer<typeof CookNowResultSchema>;

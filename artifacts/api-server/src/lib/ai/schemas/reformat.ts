import { z } from "zod";
import { TranslatedStepSchema } from "./cookNow";

// PRD §10.9 — Reformat-for-Kiwi pass. Runs after every recipe import
// (URL parse fallback, image parse, manual Mode A) per 6c-1.
// Output writes into Dish/Meal + RecipeInstructionStep.

// Raw upstream recipe — shape varies (URL parse, OCR, manual builder).
export const RawRecipeInputSchema = z.object({
  source: z.enum(["url", "image", "manual"]),
  sourceUrl: z.string().url().optional(),
  // Free-text title; AI normalizes.
  rawTitle: z.string().max(500).optional(),
  rawDescription: z.string().max(2000).optional(),
  // Best-effort upstream ingredient list (may be loosely structured).
  rawIngredients: z
    .array(
      z.union([
        z.string(),
        z.object({
          quantity: z.union([z.number(), z.string()]).optional(),
          unit: z.string().optional(),
          name: z.string(),
        }),
      ]),
    )
    .optional(),
  // Best-effort upstream step list (numbered or paragraph).
  rawSteps: z.array(z.string()).optional(),
  servingsHint: z.number().int().positive().optional(),
});
export type RawRecipeInput = z.infer<typeof RawRecipeInputSchema>;

// PRD §10.9 — canonical normalized recipe ready for Dish/Meal write.
export const CanonicalIngredientSchema = z.object({
  quantity: z.number().nonnegative(),
  unit: z.string(),
  name: z.string().min(1),
  // Optional canonical id resolved against Ingredient table.
  // Populated by post-processing after AI returns.
  canonicalIngredientId: z.string().optional(),
  isOptional: z.boolean().default(false),
  preparationNote: z.string().max(120).optional(),
});
export type CanonicalIngredient = z.infer<typeof CanonicalIngredientSchema>;

export const CanonicalRecipeSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  cuisineType: z.string().optional(),
  difficulty: z.enum(["easy", "medium", "fancy"]).default("easy"),
  estimatedTimeMinutes: z.number().int().positive(),
  servings: z.number().int().positive(),
  tags: z.array(z.string()).max(10).default([]),
  // One Dish per recipe in MVP (matches existing one-dish-per-meal seed).
  // Multi-dish meals are post-MVP.
  ingredients: z.array(CanonicalIngredientSchema),
  // Steps with phaseType / parallelGroup / isTimingSensitive populated.
  steps: z.array(TranslatedStepSchema),
});
export type CanonicalRecipe = z.infer<typeof CanonicalRecipeSchema>;

import { z } from "zod";

// PRD §5 — recipe scaling. The AI rounds scaled amounts to friendly cooking measures
// rather than raw decimals. Route layer guards toServings === fromServings before the call.

export const ScaleIngredientInputSchema = z.object({
  name: z.string(),
  amount: z.string(),
});
export type ScaleIngredientInput = z.infer<typeof ScaleIngredientInputSchema>;

export const ScaleRequestSchema = z.object({
  fromServings: z.number().int().positive(),
  toServings: z.number().int().positive(),
  ingredients: z.array(ScaleIngredientInputSchema),
});
export type ScaleRequest = z.infer<typeof ScaleRequestSchema>;

export const ScaleIngredientOutputSchema = z.object({
  name: z.string(),
  amount: z.string(),
});
export type ScaleIngredientOutput = z.infer<typeof ScaleIngredientOutputSchema>;

export const ScaleResponseSchema = z.object({
  scaled: z.array(ScaleIngredientOutputSchema),
});
export type ScaleResponse = z.infer<typeof ScaleResponseSchema>;

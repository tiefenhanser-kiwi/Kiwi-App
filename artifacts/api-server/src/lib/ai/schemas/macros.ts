import { z } from "zod";

// PRD §11 — per-serving macros. Mirrors Dish.{calories,protein,carbs,fat}
// PerServing in artifacts/api-server/prisma/schema.prisma:248.
export const MacroValuesSchema = z.object({
  calories: z.number().nonnegative(),
  proteinG: z.number().nonnegative(),
  carbsG: z.number().nonnegative(),
  fatG: z.number().nonnegative(),
});
export type MacroValues = z.infer<typeof MacroValuesSchema>;

// D-WS5-003 / 6b-2 — ingredient-level macro estimation, called on dish
// save when kiwiAssistIngredients flag set OR macros are zero.
export const MacroEstimateInputSchema = z.object({
  dishTitle: z.string().min(1).max(200),
  servings: z.number().int().positive(),
  ingredients: z.array(
    z.object({
      quantity: z.number().nonnegative(),
      unit: z.string(),
      name: z.string().min(1),
      // 6b-2 — signals an ingredient the user often omits. The prompt body
      // instructs the model to skip optional ingredients in the math but to
      // still consider them present for any flavor/category caveats.
      isOptional: z.boolean().optional(),
      // WS7-8b USDA Block 1 — per-100g USDA reference macros. Present only for
      // ingredients with a matched USDA record; the prompt uses these as
      // grounding (scaled by gram weight). Documentary — the estimate input is
      // not runtime-validated against this schema, but the shape stays honest.
      nutritionRefPer100g: z
        .object({
          calories: z.number().nonnegative(),
          protein: z.number().nonnegative(),
          carbs: z.number().nonnegative(),
          fat: z.number().nonnegative(),
        })
        .optional(),
      // WS7-8b B2 (closes D-WS6-024 Step 2) — authoritative gram weight for
      // this quantity+unit, resolved from the shared conversion table (curated
      // /usda_derived/ai_estimated). When present the prompt uses it DIRECTLY
      // instead of guessing kitchen densities — the guess was the accuracy seam
      // the USDA per-100g grounding scaled against. Absent = guess as before.
      resolvedGrams: z.number().nonnegative().optional(),
    }),
  ),
});
export type MacroEstimateInput = z.infer<typeof MacroEstimateInputSchema>;

// WS7-8b B2 — runtime conversion gap-fill (nutrition.gap_fill_conversion).
// Cheap Haiku call when an ingredient's quantity→grams conversion misses the
// table (no curated/usda_derived row) AND the unit needs a density/count factor
// (volume or count; weight units never miss). The result is written back to
// Ingredient.conversionRef stamped source:'ai_estimated' so the catalog
// self-populates and a guess is never laundered as curated data.
export const ConversionFillInputSchema = z.object({
  canonicalName: z.string().min(1).max(100),
});
export type ConversionFillInput = z.infer<typeof ConversionFillInputSchema>;

export const ConversionFillResultSchema = z.object({
  // Grams per 1 US cup (volume-measured ingredients); null when N/A.
  gramsPerCup: z.number().positive().nullable(),
  // Grams per one whole "each" (count ingredients); null when N/A.
  gramsPerEach: z.number().positive().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
});
export type ConversionFillResult = z.infer<typeof ConversionFillResultSchema>;

export const MacroEstimateResultSchema = z.object({
  perServing: MacroValuesSchema,
  // Optional confidence + caveat copy (PRD §11 — surface "estimated").
  confidence: z.enum(["high", "medium", "low"]).optional(),
  caveats: z.array(z.string()).max(3).optional(),
});
export type MacroEstimateResult = z.infer<typeof MacroEstimateResultSchema>;

// D-WS5-007 / 6b-3 — plan-level recalc. Endpoint exists in WS6;
// trigger fires on real plan mutations in WS7.
export const MacroRecalcInputSchema = z.object({
  planId: z.string().min(1),
  // Per-day list of dish macro values + servings. Server assembles
  // from Dish + MealPlanItem rows before calling.
  days: z.array(
    z.object({
      day: z.string(),
      dishes: z.array(
        z.object({
          dishId: z.string().min(1),
          servings: z.number().positive(),
          perServing: MacroValuesSchema,
        }),
      ),
    }),
  ),
  userPreferences: z
    .object({
      proteinPriority: z.enum(["low", "medium", "high"]).optional(),
    })
    .optional(),
});
export type MacroRecalcInput = z.infer<typeof MacroRecalcInputSchema>;

export const MacroRecalcResultSchema = z.object({
  // Daily averages across the plan window (PRD §11.7 weighting rules).
  dailyAverage: MacroValuesSchema,
  // Per-day rollups for UI display.
  perDay: z.array(
    z.object({
      day: z.string(),
      totals: MacroValuesSchema,
    }),
  ),
  notes: z.string().max(280).optional(),
});
export type MacroRecalcResult = z.infer<typeof MacroRecalcResultSchema>;

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
    }),
  ),
});
export type MacroEstimateInput = z.infer<typeof MacroEstimateInputSchema>;

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
      dailyCalorieTarget: z.number().positive().optional(),
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

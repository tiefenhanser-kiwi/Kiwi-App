import { z } from "zod";

// PRD §13.4.6 / 6d-2 — AI-assisted prep aggregation.
// Premium-gated (`prep_the_week_orchestrated` entitlement).
// Endpoint runs at Prep the Week start for the active plan.

export const PrepWeekInputSchema = z.object({
  planId: z.string().min(1),
  // Per-meal payload — server assembles from MealPlanItem + Dish rows.
  planMeals: z.array(
    z.object({
      mealId: z.string().min(1),
      title: z.string().min(1),
      day: z.string(),
      servings: z.number().int().positive(),
      dishes: z.array(
        z.object({
          dishId: z.string().min(1),
          title: z.string().min(1),
          ingredients: z.array(
            z.object({
              quantity: z.number().nonnegative(),
              unit: z.string(),
              name: z.string().min(1),
              canonicalIngredientId: z.string().optional(),
            }),
          ),
        }),
      ),
    }),
  ),
  userPreferences: z
    .object({
      maxPrepMinutes: z.number().int().positive().optional(),
      preferLargeBatches: z.boolean().optional(),
    })
    .optional(),
});
export type PrepWeekInput = z.infer<typeof PrepWeekInputSchema>;

// PRD §13.4.1 — 4 phases of Prep the Week.
export const PrepPhaseSchema = z.enum([
  "prep_proteins",
  "prep_produce",
  "make_components",
  "store_and_label",
]);
export type PrepPhase = z.infer<typeof PrepPhaseSchema>;

// One aggregation step (e.g. "Chop all 4 onions across the plan in one pass").
export const PrepStepSchema = z.object({
  text: z.string().min(1).max(280),
  estimatedMinutes: z.number().int().positive(),
  // mealIds this prep step covers — drives the cross-meal callout UI.
  contributesToMealIds: z.array(z.string()).min(1),
  // Storage instruction for the resulting prepped item.
  storageNote: z.string().max(140).optional(),
});
export type PrepStep = z.infer<typeof PrepStepSchema>;

export const PrepWeekResultSchema = z.object({
  totalEstimatedMinutes: z.number().int().positive(),
  phases: z.array(
    z.object({
      phase: PrepPhaseSchema,
      title: z.string().min(1).max(120),
      steps: z.array(PrepStepSchema),
    }),
  ),
});
export type PrepWeekResult = z.infer<typeof PrepWeekResultSchema>;

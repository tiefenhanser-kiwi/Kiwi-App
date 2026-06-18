// WS6 6d-2 — Prep the Week aggregation schemas.
// Per kiwi_ws6_plan.md §3 6d-2 + PRD §13.4.1 / §13.4.3 / §13.4.6.
//
// Server-side endpoint (POST /api/plans/:planId/prep-week) hands the
// plan's meals + ingredients to Sonnet via tool_use; the model returns
// the 4-phase Prep the Week structure with cross-meal aggregation. Premium
// per PRD §1.2 + §13.4.6 (content-generating AI). Phase order is fixed —
// proteins LAST for food safety per PRD §13.4.1.

import { z } from "zod";

// Canonical 4-phase enum, slugified PRD §13.4.1 names. The result schema
// pins length=4 AND order via PrepWeekResultSchema; the prompt is
// independently instructed to emit them in this same order — both checks
// must agree before the response is returned.
export const PrepWeekPhaseKey = z.enum([
  "seasonings_dry",
  "sauces_marinades",
  "produce",
  "proteins",
]);
export type PrepWeekPhaseKeyT = z.infer<typeof PrepWeekPhaseKey>;

// ── input ────────────────────────────────────────────────────────────

export const PrepWeekIngredientInputSchema = z.object({
  ingredientId: z.string().uuid(),
  ingredientName: z.string().min(1),
  quantity: z.number(),
  unit: z.string(),
  // e.g. "diced", "minced", "thinly sliced". Drives whether the AI
  // batches same-ingredient prep into a single step or splits by method.
  preparationNotes: z.string().optional(),
});

export const PrepWeekDishInputSchema = z.object({
  dishId: z.string().uuid(),
  dishName: z.string().min(1),
  ingredients: z.array(PrepWeekIngredientInputSchema),
});

export const PrepWeekMealInputSchema = z.object({
  mealId: z.string().uuid(),
  mealName: z.string().min(1),
  cuisine: z.string().optional(),
  // effectiveServings after override applied at the loader boundary.
  servings: z.number().int().min(1).max(20),
  dishes: z.array(PrepWeekDishInputSchema).min(1).max(8),
});

export const PrepWeekInputSchema = z.object({
  planId: z.string().uuid(),
  planName: z.string().min(1),
  // 14 = 7 days × 2 meals worst-case for the Prep the Week aggregation.
  meals: z.array(PrepWeekMealInputSchema).min(1).max(14),
});
export type PrepWeekInput = z.infer<typeof PrepWeekInputSchema>;

// ── result ───────────────────────────────────────────────────────────

export const PrepWeekStepSchema = z.object({
  number: z.number().int().min(1).max(50),
  // WS7-8a B3 (D-WS7-153) — STABLE per-step identity for checkbox persistence.
  // Code-owned, derived from (phase, ingredientId): `${phase}#${ingredientId}`
  // for a normal step, `seasonings_dry#blend` for the collapsed dry-blend step.
  // Survives a structureJson regenerate (same ingredient → same key regardless
  // of array position), unlike `number`. Persisted on the wire so mobile and
  // the PrepStepCompletion rollup share one identity. Longest value is
  // `sauces_marinades#<uuid>` ≈ 53 chars; 80 is a safe ceiling.
  stepKey: z.string().min(1).max(80),
  title: z.string().min(1).max(120),
  instructions: z.string().min(1).max(800),
  estimatedMinutes: z.number().int().min(1).max(60),
  // Destination labels per PRD §13.4.3 — every step states which meals
  // it contributes to so the UI can render "For Tuesday's tacos and
  // Friday's burrito bowls". Must reference real mealIds from the input;
  // route-level sanity check enforces this in Phase 2.
  contributesToMealIds: z.array(z.string().uuid()).min(1).max(20),
  // Optional. Use only when storage is non-trivial (e.g. airtight
  // container, 4 days max). Skip for self-evident cases.
  storageNote: z.string().max(200).optional(),
  // WS7-8a B2b (D-WS7-150) — narration-suggested skip. Set true when the
  // step's ingredients appear ONLY in a season-and-cook step (judged by the
  // AI from step prose), so the user does it while cooking, not at prep time.
  // Pure annotation: code-owned number / contributesToMealIds / quantities
  // are untouched. Mobile renders skipSuggested steps muted (Block 8b).
  skipSuggested: z.boolean().optional(),
});
export type PrepWeekStep = z.infer<typeof PrepWeekStepSchema>;

export const PrepWeekPhaseSchema = z.object({
  phase: PrepWeekPhaseKey,
  title: z.string().min(1).max(80),
  // Phases 1+2 (seasonings_dry, sauces_marinades) skippable; 3+4 always
  // present. A phase with zero steps is still emitted to keep the 4-phase
  // shape stable across plans.
  skippable: z.boolean(),
  steps: z.array(PrepWeekStepSchema).min(0).max(30),
});
export type PrepWeekPhase = z.infer<typeof PrepWeekPhaseSchema>;

// Phase order is fixed: seasonings_dry → sauces_marinades → produce →
// proteins. Enforced by the .superRefine below. The model is also told
// this in the prompt; the schema is the structural floor.
export const PrepWeekResultSchema = z
  .object({
    totalEstimatedMinutes: z.number().int().min(1).max(240),
    phases: z.array(PrepWeekPhaseSchema).length(4),
  })
  .superRefine((val, ctx) => {
    const expected: PrepWeekPhaseKeyT[] = [
      "seasonings_dry",
      "sauces_marinades",
      "produce",
      "proteins",
    ];
    for (let i = 0; i < 4; i++) {
      if (val.phases[i].phase !== expected[i]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["phases", i, "phase"],
          message: `phase at index ${i} must be "${expected[i]}", got "${val.phases[i].phase}"`,
        });
      }
    }
  });
export type PrepWeekResult = z.infer<typeof PrepWeekResultSchema>;

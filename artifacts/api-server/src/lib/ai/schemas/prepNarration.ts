// WS7-8a Block 2 — Prep the Week narration schemas.
//
// BLENDED architecture: the deterministic engine + code assembly own ALL
// numeric and attribution fields (quantities, per-meal contributesToMealIds,
// phase placement, grouping, step numbering). The AI is demoted to NARRATION:
// given a code-computed step plan, it returns prose only — title, instructions,
// optional storageNote, and a per-step time estimate.
//
// Crucially, this OUTPUT schema contains NO quantity and NO mealId field. The
// AI literally cannot return or alter a quantity or an attribution — "prose
// can't move the math" is true by construction, not by post-hoc validation.

import { z } from "zod";

import type { PrepPhaseKey } from "../../prepCombineEngine";

// ── narration input (code-built, passed to the prompt as JSON) ──────────────
// One component per summed line. A normal step has a single component; a
// collapsed spice-blend step (seasonings_dry) carries several.

export interface PrepNarrationComponent {
  ingredientName: string;
  // Code-owned, already summed + servings-scaled. The AI must echo this
  // number verbatim in prose and never recompute it.
  totalQuantity: number;
  unit: string;
  preparationNote?: string;
  // Meal NAMES this component contributes to (for "for Monday's tacos and
  // Thursday's bowls"-style prose). The authoritative id-level attribution is
  // kept in code, out of the AI's reach.
  forMeals: string[];
}

export interface PrepNarrationStepInput {
  // Code-assigned id the AI must echo back so prose re-joins its step.
  stepId: string;
  phase: PrepPhaseKey;
  isBlend: boolean;
  components: PrepNarrationComponent[];
  // WS7-8a B2b (D-WS7-150) — raw instruction-step text from the dish(es) this
  // step's ingredients are cooked in. The AI reads this to judge combine-vs-
  // season: if the ingredients appear only in a season-and-cook step, it sets
  // skipSuggested. Empty when no step text was available (then never demote).
  relevantSteps: string[];
}

export interface PrepNarrationInput {
  planName: string;
  steps: PrepNarrationStepInput[];
}

// ── narration output (forced tool_use) ──────────────────────────────────────

export const PrepNarrationStepResultSchema = z.object({
  // Echo of the code-assigned id — the join key back to the planned step.
  stepId: z.string().min(1),
  title: z.string().min(1).max(120),
  instructions: z.string().min(1).max(800),
  storageNote: z.string().min(1).max(200).optional(),
  // The one number the AI owns: a prep-time judgment (not a quantity, not an
  // attribution). Code sums these into totalEstimatedMinutes.
  estimatedMinutes: z.number().int().min(1).max(60),
  // WS7-8a B2b (D-WS7-150) — the AI's combine-vs-season judgment. true =
  // demote this step (its ingredients are only seasoned-and-cooked, not
  // prepped ahead). Annotation only; code-owned numbers/attribution stand.
  skipSuggested: z.boolean().optional(),
});
export type PrepNarrationStepResult = z.infer<typeof PrepNarrationStepResultSchema>;

export const PrepNarrationResultSchema = z.object({
  // Upper bound = 4 phases × 30 steps/phase (the PrepWeekResult ceiling).
  steps: z.array(PrepNarrationStepResultSchema).min(1).max(120),
});
export type PrepNarrationResult = z.infer<typeof PrepNarrationResultSchema>;

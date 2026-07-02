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

// WS7-8b FIX 1/2 — one per-dish measure within a component. Each carries a
// CODE-FORMATTED, kitchen-ready quantity string (fraction-rounded, unit
// appended — see formatMeasure in prepWeekAssembly.ts) so the narrator echoes
// it verbatim and never sees a raw decimal. Per-dish (not summed) so every
// number is directly usable and nothing has to be re-portioned. Sourced from
// the engine's line.contributions[]; code still owns the math.
export interface PrepMeasure {
  // Finished display string, e.g. "1 tbsp", "½ tsp", "2 each". Echo verbatim.
  amount: string;
  // The dish this specific measure is for ("the taco mix", "the chili").
  forDish: string;
  preparationNote?: string;
}

export interface PrepNarrationComponent {
  ingredientName: string;
  // Code-owned, already summed + servings-scaled. RETAINED for reference/
  // back-compat only — the narrator measures from `measures[]` per-dish, NOT
  // from this rolled-up total (WS7-8b FIX 1). Never recomputed by the AI.
  totalQuantity: number;
  unit: string;
  preparationNote?: string;
  // Meal NAMES this component contributes to (retained for reference). The
  // authoritative id-level attribution is kept in code, out of the AI's reach.
  forMeals: string[];
  // WS7-8b FIX 1/2 — the per-dish measures the narrator actually writes. One
  // entry per contributing dish, each already fraction-formatted. This is what
  // replaces "echo the summed totalQuantity" in the narration prompt.
  measures: PrepMeasure[];
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

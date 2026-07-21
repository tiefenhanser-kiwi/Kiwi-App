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

import type { DishRoleT, PrepPhaseKey } from "../../prepCombineEngine";

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
  // WS7-8b #4 — INPUT ONLY (structural KEEP-vs-DEMOTE signal for the narrator;
  // no matching output field, so prose still can't move the math). The role of
  // forDish's dish: sauce/topping/base = a mix/component dish (a lone measure
  // combining INTO it → KEEP); main/side = a cooked dish (a lone cooking fat
  // poured into a pan → DEMOTE). Judged alongside the dish steps
  // (relevantDishes → dishSteps).
  dishRole: DishRoleT;
  preparationNote?: string;
}

export interface PrepNarrationComponent {
  ingredientName: string;
  preparationNote?: string;
  // WS7-8b FIX 1/2 — the per-dish measures the narrator actually writes. One
  // entry per contributing dish, each already fraction-formatted. This is the
  // ONLY amount source the narrator sees.
  //
  // D-WS9-049 A1.1 — the old rolled-up `totalQuantity`/`unit` and the meal-name
  // `forMeals` array were dropped from this shape: the prompt marked all three
  // "reference only; IGNORE" (they only fed narration input tokens, never prose)
  // and the authoritative id-level attribution stays in code (contributesToMealIds
  // on the planned step), out of the AI's reach.
  measures: PrepMeasure[];
}

export interface PrepNarrationStepInput {
  // Code-assigned id the AI must echo back so prose re-joins its step.
  stepId: string;
  phase: PrepPhaseKey;
  isBlend: boolean;
  components: PrepNarrationComponent[];
  // WS7-8a B2b (D-WS7-150) / D-WS9-049 A1.2 — the NAMES of the dish(es) this
  // step's ingredients are cooked in (a subset of the step's `forDish` values).
  // The raw instruction-step text itself is NOT inlined per step anymore — the
  // AI looks each name up in the input-level `dishSteps` map (each dish's prose
  // is sent ONCE and shared across every step that touches it). The union of
  // those looked-up steps is this step's "relevant steps": the AI reads it to
  // judge combine-vs-season and set skipSuggested. Only dishes that actually
  // have step text are listed, so an empty array still means "no step text →
  // never demote", exactly as before.
  relevantDishes: string[];
  // WS7-8b #5 — INPUT ONLY (code-owned; no matching output field, so prose
  // still can't move the math). Present ONLY on a grouped sauces_marinades
  // dish-step whose dish also has dry spices that survived into the
  // seasonings_dry blend step; the value is that dish's name. When present, the
  // narrator MUST tell the user to combine the sauce's wet parts with "the
  // <name> spices from your seasoning blend." Absent → no linkage wording.
  blendSpiceDish?: string;
}

export interface PrepNarrationInput {
  planName: string;
  // D-WS9-049 A1.2 — dish name → that dish's raw instruction-step text, in
  // stepIndex order. Sent ONCE per dish and referenced by each step's
  // `relevantDishes`, instead of re-inlining a dish's full step prose on every
  // prep step that touches it. Only dishes with step text (and referenced by
  // some step) appear. Empty map when no step text was supplied.
  dishSteps: Record<string, string[]>;
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

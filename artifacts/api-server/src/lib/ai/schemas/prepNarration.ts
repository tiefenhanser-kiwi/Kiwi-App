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
  /**
   * ⚠️ D-WS9-301 rule 14 — RETIRED, and deliberately left here as a tombstone.
   * It carried "(from 2 limes)" / "(from 1 garlic head)" onto every derived
   * measure. Hans on the device pass: the parenthetical goes, the count lives in
   * the grocery list. Nothing sets it; the narrator is told not to invent it.
   * fromSource?: string;
   */
  /**
   * D-WS9-301 rule 10 — WHERE THIS PORTION GOES, by container name.
   *
   * "Finely dice 2 white onions — 1 into the enchilada container, ¾ into the
   * Mexican rice container, ¼ into the chili fixings container." The amount
   * alone was never enough: a cook reading "¾ onion" on a shared step has no
   * way to know which of four dishes it belongs to, and the recipe is not on
   * the screen.
   *
   * Rule 11's priority decides the value: the dish's own moment container when
   * it has other members, else the shared container this step fills.
   */
  destination?: string;
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
  /**
   * WS9 D-WS9-296 — THE BOWL. Present on a component step: every measure in it
   * goes into this one named vessel, and the narrator uses the string VERBATIM.
   * Absent on a plain per-ingredient portion.
   *
   * This replaces `blendSpiceDish`, which pointed from one container at
   * another. There is one container now.
   */
  bowlName?: string;
  /**
   * D-WS9-296 ruling 1 — a raw protein JOINS a bowl on cook day rather than
   * sitting in it. The sentence is written by the ENGINE and echoed verbatim:
   * it states a fact about the schedule and prose must not move it.
   */
  cookDaySentence?: string;
  /**
   * D-WS9-301 rule 12 — the knife-work verb(s) the recipe names for this whole
   * protein, e.g. ["pound"] or ["trim"]. The narrator OPENS the step with it:
   * "Pound 4 chicken breasts to even thickness", never a bare ingredient line.
   * Absent when the recipe names none, and then today's wording stands.
   */
  knifeVerbs?: string[];
  /**
   * H4 / D-WS9-301 rule 11(c) — what the cook ALREADY put in this container, in
   * earlier phases. A container is worked in up to two steps now and its produce
   * is cut in the produce phase, so by the time the liquids go in the bowl is
   * not empty — and a step that does not say so reads as if the cook is starting
   * a new bowl. Opening clause, verbatim shape:
   *
   *   "Lemon-Herb Chicken marinade bowl (garlic and rosemary already in it): add
   *    3 tbsp olive oil, zest and juice 1 lemon, whisk."
   *
   * Absent on the FIRST step that touches a container, and on a plain portion.
   */
  containerHolds?: string[];
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
  /**
   * WS9 BUG-204 — 🔴 THE AI OWNS NO NUMBERS AT ALL NOW, INCLUDING THIS ONE.
   *
   * It used to be "the one number the AI owns", and across the 14-plan corpus it
   * ran about three times long: mean 6.6 min per step, 3 min to halve one
   * poblano, 4 min to dice one onion. That was survivable while it only coloured
   * individual cards. D-WS9-301 ruling 4 puts the SUM in the header, and Hans's
   * condition for showing a total was trust in both directions — "40 minutes is
   * no more than 50 minutes or so in reality".
   *
   * A duration is a fact about an action and a quantity, so `prepStepMinutes.ts`
   * computes it. OPTIONAL rather than removed: a v12 narration already in flight
   * still parses, and anything that arrives here is IGNORED — the assembly never
   * reads it.
   */
  estimatedMinutes: z.number().int().min(1).max(60).optional(),
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

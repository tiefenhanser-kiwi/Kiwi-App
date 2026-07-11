import { z } from "zod";
import { WizardPlanCandidatesResultSchema } from "./wizard";

// PRD §6.8 — Tell Kiwi (directed input) request shape.
// Mirrors TellKiwiInput in artifacts/kiwi/lib/types.ts:503.
export const DirectedInputSchema = z.object({
  description: z.string().min(5).max(500),
  householdSize: z.number().int().min(1).max(30),
  // Cookbook Phase B Block 4 (D-WS7-190) — wantsLeftovers Switch removed from
  // Tell Kiwi; optional-with-default so an omitting body still validates.
  wantsLeftovers: z.boolean().optional().default(false),
  // Cookbook Phase B Block 4 (Ruling 3) — Tell Kiwi's "Adjust saved prefs for
  // this plan" disclosure now carries cuisines + weeklyPacing per-run. The
  // wizard.directed.generate body already has a "# Cuisine guidance" section
  // that leans on the user's preferred cuisines "if given" and a discovery
  // clause gated on "the user gave a cuisine steer" — supplying `cuisines`
  // here ACTIVATES that guidance for the directed path (previously it always
  // fell to the no-steer varied-palette default). weeklyPacing is referenced
  // only loosely in the directed body, so it is available but weakly weighted.
  cuisines: z.array(z.string()).default([]),
  weeklyPacing: z
    .enum(["mostly_easy", "mixed", "one_fancy_night", "minimal_effort"])
    .optional(),
  eatingStyles: z.array(z.string()).default([]),
  allergiesAndAvoidances: z.array(z.string()).default([]),
  dietaryNotes: z.string().max(500).optional(),
  // Cookbook Phase B Block 4 (D-WS7-035) — per-run overrides. Optional, NO
  // default (see WizardInputSchema note): omitted means "use stored". The
  // route resolves these into `preferencesContext`.
  discoveryMealsPerWeek: z.number().int().min(0).max(2).optional(),
  saucePreference: z.enum(["store_bought", "balanced", "homemade"]).optional(),
  maxCookTimeMinutes: z.number().int().positive().max(600).nullable().optional(),
  maxCookTimeCoverage: z.enum(["all", "most"]).optional(),
});
export type DirectedInput = z.infer<typeof DirectedInputSchema>;

// PRD §6.8 — output of step 1 (parse_intent).
// Five scenarios per PRD §6.5; populated fields differ by scenario.
export const ParsedIntentSchema = z.object({
  scenario: z.enum([
    "vague",
    "fully_specified",
    "partial",
    "unclear",
    "overflow",
  ]),
  // Meals the user named explicitly (e.g. "tacos and pasta").
  explicitMeals: z.array(z.string()).default([]),
  // Soft descriptors the user supplied (e.g. "comfort", "low-carb").
  intentDescriptors: z.array(z.string()).default([]),
  // Number of meals the parser inferred the user wants (1-7).
  mealCount: z.number().int().min(0).max(7).optional(),
  // Populated for `unclear` and `overflow` scenarios per PRD §6.5
  // Scenario E/F. Client surfaces this as a clarification modal.
  needsClarification: z
    .object({
      reason: z.string().max(280),
      options: z.array(z.string()).max(6).optional(),
    })
    .optional(),
});
export type ParsedIntent = z.infer<typeof ParsedIntentSchema>;

// PRD §6.8 — output of step 2 (generate). Reuses the wizard candidates
// shape; Tell Kiwi may return 1-3 candidates depending on scenario
// (vague/partial → 3; fully_specified → 1; overflow → 1 with
// needsClarification; unclear → empty + needsClarification).
export const DirectedGenerateResultSchema = WizardPlanCandidatesResultSchema;
export type DirectedGenerateResult = z.infer<
  typeof DirectedGenerateResultSchema
>;

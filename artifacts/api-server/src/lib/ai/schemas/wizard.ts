import { z } from "zod";

import { StepPhaseTypeSchema } from "./mealBuilder";

// BUG #3 (D-WS7-165) — wizard step contract. Pre-fix, wizard steps were bare
// strings, so the materializer had no phaseType / estimatedMinutes to persist
// and every wizard step fell to the DB column defaults (phaseType='cook',
// estimatedMinutes=1) — breaking the Cook Mode prep filter and per-step
// durations. The contract is now an object carrying both, aligned with the
// already-ratified builder/import step shape (mealBuilder.ts AssistedStep /
// ParsedSubDishStep). phaseType reuses StepPhaseTypeSchema (its 6 values match
// the Prisma StepPhase enum); estimatedMinutes mirrors the builder's bounds.
export const WizardStepSchema = z.object({
  text: z.string().min(1).max(400),
  phaseType: StepPhaseTypeSchema,
  estimatedMinutes: z.number().int().positive().max(600),
});
export type WizardStep = z.infer<typeof WizardStepSchema>;

// PRD §5.7 — Set Preferences wizard input shape.
// Mirrors WizardPreferencesInput in artifacts/kiwi/lib/types.ts:521.
export const WizardInputSchema = z.object({
  planDurationDays: z.number().int().min(1).max(7),
  householdSize: z.number().int().min(1).max(30),
  // Cookbook Phase B Block 4 (D-WS7-190) — the wantsLeftovers Switch was
  // removed from both wizard screens; the stored field is @default(false) and
  // inert. Optional-with-default so a body that omits it still validates and
  // the prompt still sees a concrete boolean.
  wantsLeftovers: z.boolean().optional().default(false),
  cuisines: z.array(z.string()).default([]),
  eatingStyles: z.array(z.string()).default([]),
  allergiesAndAvoidances: z.array(z.string()).default([]),
  difficulty: z.enum(["easy", "medium", "fancy"]),
  weeklyPacing: z.enum([
    "mostly_easy",
    "mixed",
    "one_fancy_night",
    "minimal_effort",
  ]),
  dietaryNotes: z.string().max(500).optional(),
  additionalNotes: z.string().max(500).optional(),
  // Cookbook Phase B Block 4 (D-WS7-035) — per-run overrides of the four
  // generation-shaping prefs. OPTIONAL WITH NO DEFAULT on purpose: an omitted
  // field means "no per-run override, use stored" and MUST stay `undefined` so
  // resolvePreferences() falls back to the stored value. A default here would
  // make every request look like an override and silently clobber stored prefs.
  // The route resolves these against stored UserPreferences into
  // `preferencesContext`; they are NOT passed to the prompt at top level.
  discoveryMealsPerWeek: z.number().int().min(0).max(2).optional(),
  saucePreference: z.enum(["store_bought", "balanced", "homemade"]).optional(),
  maxCookTimeMinutes: z.number().int().positive().max(600).nullable().optional(),
  maxCookTimeCoverage: z.enum(["all", "most"]).optional(),
  // Server-injected hidden context (PRD §5.7). Sourced from UserPreferences
  // by the wizard route — never accepted from the client.
  hiddenContext: z
    .object({
      // WS7-2 Block A: field names (equipment / recurringItems) preserved per
      // the locked AI-schema decision; values widened to match DB enum changes
      // (SpiceTolerance gained very_hot; BudgetLevel renamed budget -> economy).
      // Prompt text update for the value rename is deferred to D-WS7-023.
      equipment: z.array(z.string()).optional(),
      spiceTolerance: z.enum(["mild", "medium", "hot", "very_hot"]).optional(),
      budgetLevel: z.enum(["economy", "mid_range", "premium"]).optional(),
      pickyAvoidances: z.array(z.string()).optional(),
      recurringItems: z.array(z.string()).optional(),
      pantryStaples: z.array(z.string()).optional(),
      recentMealIds: z.array(z.string()).optional(),
    })
    .optional(),
});
export type WizardInput = z.infer<typeof WizardInputSchema>;

// PRD §5.7 — single plan candidate.
// Mirrors WizardPlanCandidate in artifacts/kiwi/lib/types.ts:476.
export const WizardPlanCandidateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(120),
  imageUrl: z.string().url().optional(),
  badge: z.enum(["featured", "top_rated"]).optional(),
  tags: z.array(z.string()).max(5),
  whyBullets: z.array(z.string()).min(1).max(3),
  mealTitles: z.array(z.string()).min(1).max(7),
  dailyMacros: z.object({
    calories: z.number().nonnegative(),
    proteinG: z.number().nonnegative(),
    carbsG: z.number().nonnegative(),
    fatG: z.number().nonnegative(),
  }),
});
export type WizardPlanCandidate = z.infer<typeof WizardPlanCandidateSchema>;

// PRD §5.5 + §5.8 — wrapper with empty/restrictive-constraint flag.
export const WizardPlanCandidatesResultSchema = z.object({
  candidates: z.array(WizardPlanCandidateSchema).max(3),
  cannotGenerateMore: z.boolean().optional(),
  reason: z.string().max(280).optional(),
});
export type WizardPlanCandidatesResult = z.infer<
  typeof WizardPlanCandidatesResultSchema
>;

// ── WS7-5a — wizard candidate expand (Branch B "View plan") ──────────────
// Step 2 of the two-step wizard commit model (PRD §5.6 redline). One
// candidate -> full per-meal recipe detail. Server posts /api/wizard/expand
// with the chosen candidate; route runs wizard.candidate.expand prompt +
// per-dish estimateDishMacros loop, writes a hidden draft MealPlanInstance,
// returns the expanded detail + draft id for the resume path.

// PRD §5.6 (redline) — request body to POST /api/wizard/expand.
// The candidate is echoed back from the build-plans response. Server trusts
// the user-selected candidate shape (the user can only pick what they were
// shown) and does not re-validate against a "this was a real candidate I
// generated" registry — candidates are stateless. candidateContext carries
// the slice of the original WizardInput the prompt needs to honor the
// constraints chained into the expansion.
export const WizardExpandCandidateContextSchema = z.object({
  planDurationDays: z.number().int().min(1).max(7),
  householdSize: z.number().int().min(1).max(30),
  wantsLeftovers: z.boolean(),
  allergiesAndAvoidances: z.array(z.string()).default([]),
  eatingStyles: z.array(z.string()).default([]),
  difficulty: z.enum(["easy", "medium", "fancy"]),
  // Cookbook Phase B Block 2 (D-WS7-197) — server-authoritative generation
  // prefs re-injected at expand (where ingredients + estimatedTimeMinutes are
  // authored). These are NOT trusted from the client echo: the route validates
  // this schema off req.body, but wizardExpansion.ts OVERWRITES these three
  // fields from the user's stored UserPreferences before the AI call. Optional
  // here so a client body that omits them still parses; the server fills them.
  // Discovery is intentionally absent — it is a generate-only concern (R6).
  saucePreference: z.string().optional(),
  maxCookTimeMinutes: z.number().int().nullable().optional(),
  maxCookTimeCoverage: z.string().optional(),
});
export type WizardExpandCandidateContext = z.infer<
  typeof WizardExpandCandidateContextSchema
>;

export const WizardExpandRequestSchema = z.object({
  candidate: WizardPlanCandidateSchema,
  candidateContext: WizardExpandCandidateContextSchema,
});
export type WizardExpandRequest = z.infer<typeof WizardExpandRequestSchema>;

// PRD §5.6 (redline) — per-dish detail shape returned by the expand AI.
// Mirrors the Dish/DishIngredient/RecipeInstructionStep conventions, but
// stays as a JSON snapshot inside MealPlanInstance.optimizationNotes until
// "Save and use" (WS7-5b) materializes real rows.
export const WizardExpandDishIngredientSchema = z.object({
  name: z.string().min(1).max(120),
  quantity: z.number().positive(),
  unit: z.string().min(1).max(40),
  preparationNote: z.string().max(120).optional(),
  isOptional: z.boolean().optional(),
});
export type WizardExpandDishIngredient = z.infer<
  typeof WizardExpandDishIngredientSchema
>;

export const WizardExpandDishSchema = z.object({
  title: z.string().min(1).max(120),
  role: z.enum(["main", "side", "sauce", "topping", "base", "optional"]),
  positionIndex: z.number().int().nonnegative(),
  // WS7-5b-server-fix2 — relaxed from .min(3) to .min(1). Meal-substance is
  // already guarded by WizardExpandMealSchema.dishes.min(1) and
  // WizardExpandResultSchema.meals.min(1).max(7); the per-dish floor was
  // bombing legitimately simple sides (warmed pita, a baked potato, a steamed
  // vegetable). The cascade flows to WizardExpandEnrichedDishSchema via the
  // .extend() below and therefore to WizardExpandedPlanSchema (the
  // materializer-validated read-side shape) — both directions of the wire stay
  // in sync from this single edit.
  ingredients: z.array(WizardExpandDishIngredientSchema).min(1),
  // BUG #3 (D-WS7-165) — widened string → object so phaseType / estimatedMinutes
  // survive to the materializer. Cascades via .extend() to
  // WizardExpandEnrichedDishSchema → WizardExpandedPlanSchema (the read-side
  // shape validated in wizardFinalize.ts + wizardActivation.ts).
  steps: z.array(WizardStepSchema).min(1).max(20),
});
export type WizardExpandDish = z.infer<typeof WizardExpandDishSchema>;

export const WizardExpandMealSchema = z.object({
  title: z.string().min(1).max(120),
  cuisineType: z.string().min(1).max(60),
  estimatedTimeMinutes: z.number().int().positive(),
  difficulty: z.enum(["easy", "medium", "fancy"]),
  servings: z.number().int().min(1).max(30),
  dishes: z.array(WizardExpandDishSchema).min(1),
});
export type WizardExpandMeal = z.infer<typeof WizardExpandMealSchema>;

// AI output shape (what wizard.candidate.expand returns directly).
export const WizardExpandResultSchema = z.object({
  meals: z.array(WizardExpandMealSchema).min(1).max(7),
});
export type WizardExpandResult = z.infer<typeof WizardExpandResultSchema>;

// Per-dish per-serving macros, attached AFTER the dishMacros estimator pass.
export const WizardExpandDishMacrosSchema = z.object({
  caloriesPerServing: z.number().nonnegative(),
  proteinGPerServing: z.number().nonnegative(),
  carbsGPerServing: z.number().nonnegative(),
  fatGPerServing: z.number().nonnegative(),
  // null when the dishMacros estimator failed for this dish (caller persists
  // the draft regardless; user sees a soft caveat and the macro tile renders
  // from whatever did succeed). Failures are non-blocking by design.
  failed: z.boolean().optional(),
});
export type WizardExpandDishMacros = z.infer<
  typeof WizardExpandDishMacrosSchema
>;

// Enriched per-dish shape carrying the AI ingredients/steps + the macro pass
// result, persisted into MealPlanInstance.optimizationNotes for the draft.
export const WizardExpandEnrichedDishSchema = WizardExpandDishSchema.extend({
  macros: WizardExpandDishMacrosSchema.nullable(),
});
export type WizardExpandEnrichedDish = z.infer<
  typeof WizardExpandEnrichedDishSchema
>;

export const WizardExpandEnrichedMealSchema = WizardExpandMealSchema.extend({
  dishes: z.array(WizardExpandEnrichedDishSchema).min(1),
});
export type WizardExpandEnrichedMeal = z.infer<
  typeof WizardExpandEnrichedMealSchema
>;

// Full post-finalize / materializer-side server shape — only valid AFTER
// the WS7-5c finalize-steps merge populates per-dish steps. The materializer
// (wizardActivation.ts) validates against this schema; activate/save callers
// merge finalize output into a details-stage draft to produce this shape.
export const WizardExpandedPlanSchema = z.object({
  // Mirror selected candidate identity / display fields so the resume read
  // surface can render the draft card without re-stitching.
  candidateId: z.string().min(1),
  title: z.string().min(1).max(120),
  tags: z.array(z.string()).max(5),
  whyBullets: z.array(z.string()).min(1).max(3),
  meals: z.array(WizardExpandEnrichedMealSchema).min(1).max(7),
});
export type WizardExpandedPlan = z.infer<typeof WizardExpandedPlanSchema>;

// ── WS7-5c Block A — details-stage shape (no steps) ──────────────────────
// The three-stage wizard splits the old heavy expand call into a lighter
// View-Details call (call #2; this shape) + a finalize-at-save call (call
// #3; merges steps into WizardExpandedPlanSchema). Latency win: only the
// plan the user actually saves pays the steps-generation cost.
//
// Details-stage carries ingredients + per-dish macros. NO steps. Used by:
//   - POST /wizard/expand AI-output validation (wizard.candidate.expand)
//   - GET /wizard/drafts/:id read parse
//   - Draft persisted shape in optimizationNotes (call #2 → save/activate)

export const WizardExpandDishDetailsSchema = z.object({
  title: z.string().min(1).max(120),
  role: z.enum(["main", "side", "sauce", "topping", "base", "optional"]),
  positionIndex: z.number().int().nonnegative(),
  ingredients: z.array(WizardExpandDishIngredientSchema).min(1),
  // steps intentionally absent — call #3 populates them at save/activate.
});
export type WizardExpandDishDetails = z.infer<
  typeof WizardExpandDishDetailsSchema
>;

export const WizardExpandMealDetailsSchema = z.object({
  title: z.string().min(1).max(120),
  cuisineType: z.string().min(1).max(60),
  estimatedTimeMinutes: z.number().int().positive(),
  difficulty: z.enum(["easy", "medium", "fancy"]),
  servings: z.number().int().min(1).max(30),
  dishes: z.array(WizardExpandDishDetailsSchema).min(1),
});
export type WizardExpandMealDetails = z.infer<
  typeof WizardExpandMealDetailsSchema
>;

// AI output shape for call #2 (wizard.candidate.expand) — details-stage.
export const WizardExpandResultDetailsSchema = z.object({
  meals: z.array(WizardExpandMealDetailsSchema).min(1).max(7),
});
export type WizardExpandResultDetails = z.infer<
  typeof WizardExpandResultDetailsSchema
>;

export const WizardExpandEnrichedDishDetailsSchema =
  WizardExpandDishDetailsSchema.extend({
    macros: WizardExpandDishMacrosSchema.nullable(),
  });
export type WizardExpandEnrichedDishDetails = z.infer<
  typeof WizardExpandEnrichedDishDetailsSchema
>;

export const WizardExpandEnrichedMealDetailsSchema =
  WizardExpandMealDetailsSchema.extend({
    dishes: z.array(WizardExpandEnrichedDishDetailsSchema).min(1),
  });
export type WizardExpandEnrichedMealDetails = z.infer<
  typeof WizardExpandEnrichedMealDetailsSchema
>;

// Full details-stage plan — call #2 response + persisted draft shape.
// After call #3 merges per-dish steps in, the resulting payload validates
// against WizardExpandedPlanSchema (the materializer's read-side schema).
export const WizardExpandedPlanDetailsSchema = z.object({
  candidateId: z.string().min(1),
  title: z.string().min(1).max(120),
  tags: z.array(z.string()).max(5),
  whyBullets: z.array(z.string()).min(1).max(3),
  meals: z.array(WizardExpandEnrichedMealDetailsSchema).min(1).max(7),
});
export type WizardExpandedPlanDetails = z.infer<
  typeof WizardExpandedPlanDetailsSchema
>;

// ── WS7-5c Block A — finalize-steps AI output (call #3) ──────────────────
// wizard.candidate.finalize_steps returns per-dish step arrays keyed by
// (mealIndex, dishIndex) so the server can merge them positionally into
// the details-stage draft. Sonnet, tool mode. Steps-only output — much
// smaller than the old 16k full-expand.
export const WizardFinalizeStepsDishSchema = z.object({
  mealIndex: z.number().int().nonnegative(),
  dishIndex: z.number().int().nonnegative(),
  // BUG #3 (D-WS7-165) — widened string → object. The finalize_steps AI now
  // emits per-step phaseType + estimatedMinutes (prompt body inverted to
  // require them); these merge positionally into the details plan and persist.
  steps: z.array(WizardStepSchema).min(1).max(20),
});
export type WizardFinalizeStepsDish = z.infer<
  typeof WizardFinalizeStepsDishSchema
>;

export const WizardFinalizeStepsResultSchema = z.object({
  dishSteps: z.array(WizardFinalizeStepsDishSchema).min(1),
});
export type WizardFinalizeStepsResult = z.infer<
  typeof WizardFinalizeStepsResultSchema
>;

// Mobile client for POST /api/wizard/build-plans.
// WS6 6a-3 — replaces lib/stubs.ts:getWizardPlanCandidates with a real call.
// WS7-1 — migrated to apiClient + Zod validation.
// WS7-5b-mobile Block A — adds expand / drafts/:id/save / drafts/:id/activate
// for the two-step "View Plan Details" → Plan Details screen flow.

import { z } from "zod";

import { apiClient } from "./client";
import type { WizardPlanCandidate, WizardPreferencesInput } from "../types";

// ── Zod schemas ──────────────────────────────────────────────────────────
// Transcribed from artifacts/api-server/src/lib/ai/schemas/wizard.ts —
// kept mobile-side rather than imported so the mobile package stays
// independent of the api-server build. `.passthrough()` for forward-compat.

const WizardPlanCandidateSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    imageUrl: z.string().optional(),
    badge: z.enum(["featured", "top_rated"]).optional(),
    tags: z.array(z.string()),
    whyBullets: z.array(z.string()),
    mealTitles: z.array(z.string()),
    dailyMacros: z.object({
      calories: z.number(),
      proteinG: z.number(),
      carbsG: z.number(),
      fatG: z.number(),
    }),
  })
  .passthrough();

const BuildWizardPlansResponseSchema = z.object({
  candidates: z.array(WizardPlanCandidateSchema),
  cannotGenerateMore: z.boolean().optional(),
  reason: z.string().optional(),
  metadata: z
    .object({
      promptVersion: z.number().nullable(),
      latencyMs: z.number(),
    })
    .optional(),
});

export interface BuildWizardPlansResult {
  candidates: WizardPlanCandidate[];
  cannotGenerateMore?: boolean;
  reason?: string;
  metadata?: {
    promptVersion: number | null;
    latencyMs: number;
  };
}

export async function buildWizardPlans(
  input: WizardPreferencesInput,
): Promise<BuildWizardPlansResult> {
  const body = await apiClient("/wizard/build-plans", {
    method: "POST",
    body: input,
    schema: BuildWizardPlansResponseSchema,
  });
  return body as BuildWizardPlansResult;
}

// ── WS7-5b-mobile Block A — expand / save / activate ─────────────────────
// Transcribed from artifacts/api-server/src/lib/ai/schemas/wizard.ts
// (WizardExpand* schemas) + wizard.ts route response shapes. Same forward-
// compat approach (.passthrough on nested shapes) as the candidate schema
// above so a server-side field addition does not break mobile validation.

const WizardExpandDishIngredientSchema = z
  .object({
    name: z.string(),
    quantity: z.number(),
    unit: z.string(),
    preparationNote: z.string().optional(),
    isOptional: z.boolean().optional(),
  })
  .passthrough();

const WizardExpandDishMacrosSchema = z
  .object({
    caloriesPerServing: z.number(),
    proteinGPerServing: z.number(),
    carbsGPerServing: z.number(),
    fatGPerServing: z.number(),
    failed: z.boolean().optional(),
  })
  .passthrough();

const WizardExpandEnrichedDishSchema = z
  .object({
    title: z.string(),
    role: z.enum(["main", "side", "sauce", "topping", "base", "optional"]),
    positionIndex: z.number(),
    ingredients: z.array(WizardExpandDishIngredientSchema),
    steps: z.array(z.string()),
    macros: WizardExpandDishMacrosSchema.nullable(),
  })
  .passthrough();

const WizardExpandEnrichedMealSchema = z
  .object({
    title: z.string(),
    cuisineType: z.string(),
    estimatedTimeMinutes: z.number(),
    difficulty: z.enum(["easy", "medium", "fancy"]),
    servings: z.number(),
    dishes: z.array(WizardExpandEnrichedDishSchema),
  })
  .passthrough();

export const WizardExpandedPlanSchema = z
  .object({
    candidateId: z.string(),
    title: z.string(),
    tags: z.array(z.string()),
    whyBullets: z.array(z.string()),
    meals: z.array(WizardExpandEnrichedMealSchema),
  })
  .passthrough();
export type WizardExpandedPlan = z.infer<typeof WizardExpandedPlanSchema>;
export type WizardExpandEnrichedMeal = z.infer<
  typeof WizardExpandEnrichedMealSchema
>;
export type WizardExpandEnrichedDish = z.infer<
  typeof WizardExpandEnrichedDishSchema
>;
export type WizardExpandDishIngredient = z.infer<
  typeof WizardExpandDishIngredientSchema
>;
export type WizardExpandDishMacros = z.infer<
  typeof WizardExpandDishMacrosSchema
>;

const WizardExpandResponseSchema = z.object({
  draft: z.object({
    id: z.string(),
    createdAt: z.string(),
  }),
  expanded: WizardExpandedPlanSchema,
});
export type WizardExpandResponse = z.infer<typeof WizardExpandResponseSchema>;

// Shape sent to POST /wizard/expand. Mirrors WizardExpandRequestSchema on
// the server. candidateContext narrows the original WizardInput to the
// fields the expand prompt needs.
export interface WizardExpandCandidateContext {
  planDurationDays: number;
  householdSize: number;
  wantsLeftovers: boolean;
  allergiesAndAvoidances: string[];
  eatingStyles: string[];
  difficulty: "easy" | "medium" | "fancy";
}

export interface WizardExpandRequest {
  candidate: WizardPlanCandidate;
  candidateContext: WizardExpandCandidateContext;
}

/**
 * POST /api/wizard/expand — Step 2 of the two-step wizard model.
 *
 * Takes the user-picked candidate (from build-plans / build-from-text) plus
 * the slice of the original input the prompt needs to honor the constraints.
 * Server runs the wizard.candidate.expand AI prompt + per-dish macro pass
 * (~3-15s typical), persists a hidden draft MealPlanInstance
 * (isWizardDraft=true), and returns the expanded plan + draft id.
 *
 * Accepts an optional AbortSignal so the Results screen can cancel the
 * call when the user taps "Back to results" mid-flight.
 *
 * Propagates apiClient typed errors: `UnauthenticatedError` (401),
 * `UpgradeRequiredError` (402 — entitlement), `ApiError` (502 ai_failed,
 * 500 persist_failed), `ApiSchemaError` on a response-shape mismatch.
 */
export async function expandWizardCandidate(
  request: WizardExpandRequest,
  opts: { signal?: AbortSignal } = {},
): Promise<WizardExpandResponse> {
  return apiClient("/wizard/expand", {
    method: "POST",
    body: request,
    schema: WizardExpandResponseSchema,
    signal: opts.signal,
  });
}

// Both /save and /activate return the same { instance: { id, revisionId } }
// envelope — mirrors POST /plans/use-template so post-mutation navigation
// reuses the same Plan Review entry point at /plan/[id].
const WizardDraftMutationResponseSchema = z.object({
  instance: z.object({ id: z.string(), revisionId: z.number() }),
});
export type WizardDraftMutationResponse = z.infer<
  typeof WizardDraftMutationResponseSchema
>;

/**
 * POST /api/wizard/drafts/:id/save — "Save for Later" CTA.
 *
 * Promotes the hidden draft into a real undated, inactive plan in My Plans.
 * Returns { instance: { id, revisionId } } at 201. After success the draft
 * id is dead — a second /save OR /activate on the same draft id returns 404
 * (shared `!isWizardDraft` guard server-side). Callers must track the
 * returned `instance.id` and route subsequent "use this week" actions through
 * `PATCH /plans/:instance.id` instead of the draft endpoints.
 *
 * Propagates apiClient typed errors: `UnauthenticatedError` (401),
 * `ApiError` (404 not found / not owned / already-saved/activated,
 * 422 malformed draft, 500 tx), `ApiSchemaError` on a response-shape mismatch.
 */
export async function saveWizardDraft(
  draftId: string,
): Promise<WizardDraftMutationResponse> {
  return apiClient(
    `/wizard/drafts/${encodeURIComponent(draftId)}/save`,
    {
      method: "POST",
      schema: WizardDraftMutationResponseSchema,
    },
  );
}

/**
 * POST /api/wizard/drafts/:id/activate — "Save and Use" CTA (pre-save).
 *
 * Materializes the hidden draft, demotes any prior active plan, flips the
 * draft to active for the current Sun-Sat week (auto-dated server-side via
 * WS7-5b-mobile-PRE), and bumps revisionId to 2. Returns 201
 * { instance: { id, revisionId } } — same envelope as POST /plans/use-template
 * so post-activation navigation reuses /plan/[id].
 *
 * Note: this endpoint can only be called BEFORE /save has fired against the
 * same draft id. Post-save, callers must use `patchPlan(instance.id,
 * { isActiveThisWeek: true })` against the new plan id instead — calling
 * /activate on a saved draft returns 404.
 *
 * Propagates apiClient typed errors: `UnauthenticatedError` (401),
 * `ApiError` (404 not found / not owned / already-saved/activated,
 * 422 malformed draft, 500 tx), `ApiSchemaError` on a response-shape mismatch.
 */
export async function activateWizardDraft(
  draftId: string,
): Promise<WizardDraftMutationResponse> {
  return apiClient(
    `/wizard/drafts/${encodeURIComponent(draftId)}/activate`,
    {
      method: "POST",
      schema: WizardDraftMutationResponseSchema,
    },
  );
}

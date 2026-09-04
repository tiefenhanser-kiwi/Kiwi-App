// Mobile client for POST /api/wizard/build-plans.
// WS6 6a-3 — replaces lib/stubs.ts:getWizardPlanCandidates with a real call.
// WS7-1 — migrated to apiClient + Zod validation.
// WS7-5b-mobile Block A — adds expand / drafts/:id/save / drafts/:id/activate
// for the two-step "View Plan Details" → Plan Details screen flow.
// WS7-5b-mobile Block B — adds listWizardDrafts / getWizardDraft for the
// wizard-entry resume interstitial. The detail endpoint returns the same
// envelope as POST /wizard/expand, so resume reuses Block A's Plan Details
// screen + params (draftId + JSON.stringified expanded plan).

import { z } from "zod";

import { apiClient } from "./client";
import type { WizardPlanCandidate, WizardPreferencesInput } from "../types";

// ── Zod schemas ──────────────────────────────────────────────────────────
// Transcribed from artifacts/api-server/src/lib/ai/schemas/wizard.ts —
// kept mobile-side rather than imported so the mobile package stays
// independent of the api-server build. `.passthrough()` for forward-compat.

export const WizardPlanCandidateSchema = z
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
  // BUG-053 (Part F) — session re-roll exclusion, merged into the POST body
  // alongside the wizard input (server strips it from WizardInputSchema and
  // reads it separately). Optional + backward-compatible.
  exclude?: { excludePlanTitles: string[]; excludeMealTitles: string[] },
): Promise<BuildWizardPlansResult> {
  const body = await apiClient("/wizard/build-plans", {
    method: "POST",
    body: exclude ? { ...input, ...exclude } : input,
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

// WS7-5c Block B (mobile) — `steps` is now OPTIONAL. Block A split the
// server-side expansion into details-stage (no steps) + finalize-steps
// (called at save/activate). The wizard-plan-details screen is a draft-
// validation view, not a cookbook — steps belong on the post-save meal-
// detail / Cook Mode path. The server returns no `steps` field for new
// drafts and strips it from legacy steps-bearing drafts on the GET path,
// so mobile sees one consistent stepless shape; leaving the schema
// permissive lets us still parse any older cached payloads in flight.
const WizardExpandEnrichedDishSchema = z
  .object({
    title: z.string(),
    role: z.enum(["main", "side", "sauce", "topping", "base", "optional"]),
    positionIndex: z.number(),
    ingredients: z.array(WizardExpandDishIngredientSchema),
    steps: z.array(z.string()).optional(),
    macros: WizardExpandDishMacrosSchema.nullable(),
  })
  .passthrough();

const WizardExpandEnrichedMealSchema = z
  .object({
    title: z.string(),
    // WS9 BUG-163 — the one-line headnote (server: WizardExpandMealDetailsSchema
    // .description, ≤200 chars, persisted to Meal.description). The server has
    // emitted this end to end for a while; mobile simply never declared it, so
    // the pre-save draft-review screen could not show a sub-text the SAVED meal
    // shows moments later. Optional, matching the server: the wizard
    // candidate.expand path does not author a headnote, and BUG-153's row
    // renders nothing rather than a placeholder when it is absent.
    description: z.string().optional(),
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
  // WS9 BUG-201 — OPTIONAL. Omitted = "this flow never loaded the user's
  // preferences, resolve from stored"; present (including `[]`) = "this is the
  // user's actual choice, honour it exactly". The discriminator is whether the
  // screen loaded, never whether the value is empty. See buildCandidateContext
  // in app/wizard-results.tsx.
  allergiesAndAvoidances?: string[];
  eatingStyles?: string[];
  difficulty: "easy" | "medium" | "fancy";
  // Cookbook Phase B Block 4 (D-WS7-035) — per-run sauce + cook-time overrides
  // re-sent at expand so the server resolver (wizardExpansion.ts) can honor a
  // per-run cook-cap/sauce set in the wizard instead of reverting to stored.
  // Optional: omitted when the flow carries no per-run override (server falls
  // back to stored). Discovery is generate-only, so it is not carried here.
  saucePreference?: "store_bought" | "balanced" | "homemade";
  maxCookTimeMinutes?: number | null;
  maxCookTimeCoverage?: "all" | "most";
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
  // WS9 3d Part 3b-4 (D-WS9-011a) — present on /activate: the plan this
  // activation displaced as this week's plan, or null. Absent on /save (which
  // never activates) → undefined. The client shows the demotion toast off it.
  demoted: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
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
 * Accepts an optional AbortSignal so the Plan Details screen can impose a
 * client-side timeout longer than the server's tx budget (D-WS7-080 fix —
 * platform fetch defaults can punch mid-AI-fan-out and abort while the
 * server is still committing the 201).
 *
 * Propagates apiClient typed errors: `UnauthenticatedError` (401),
 * `ApiError` (404 not found / not owned / already-saved/activated,
 * 422 malformed draft, 500 tx), `ApiSchemaError` on a response-shape mismatch.
 */
export async function activateWizardDraft(
  draftId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<WizardDraftMutationResponse> {
  return apiClient(
    `/wizard/drafts/${encodeURIComponent(draftId)}/activate`,
    {
      method: "POST",
      schema: WizardDraftMutationResponseSchema,
      signal: opts.signal,
    },
  );
}

// ── WS7-5b-mobile Block B — list / detail (resume interstitial) ──────────
// Server is authoritative for sort order (createdAt desc per wizard.ts:649)
// and stale-draft sweep (TTL via WIZARD_DRAFT_TTL_DAYS). The detail endpoint
// shares its response shape with POST /wizard/expand on purpose so resume
// can reuse Block A's WizardPlanDetailsScreen + its (draftId, expanded)
// param contract without a second render path.

const WizardDraftSummarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    createdAt: z.string(),
    mealTitles: z.array(z.string()),
  })
  .passthrough();
export type WizardDraftSummary = z.infer<typeof WizardDraftSummarySchema>;

const ListWizardDraftsResponseSchema = z.object({
  drafts: z.array(WizardDraftSummarySchema),
  ttlDays: z.number(),
});
export type ListWizardDraftsResponse = z.infer<
  typeof ListWizardDraftsResponseSchema
>;

/**
 * GET /api/wizard/drafts — list resume-able wizard drafts for the entry
 * interstitial. Server returns the drafts already sorted createdAt desc and
 * lazily sweeps drafts past TTL as a side-effect of this call. Empty list
 * is the no-interstitial case (most users).
 *
 * Propagates apiClient typed errors: `UnauthenticatedError` (401),
 * `ApiError` (500), `ApiSchemaError` on a response-shape mismatch.
 */
export async function listWizardDrafts(): Promise<ListWizardDraftsResponse> {
  return apiClient("/wizard/drafts", {
    schema: ListWizardDraftsResponseSchema,
  });
}

// BUG-023 — server-side dismissal. Declining a resume draft ("Get new
// results") must archive the SERVER row, not just hide it client-side via
// AsyncStorage — otherwise the draft resurfaces on another device or after a
// cache clear. Archives the owned wizard draft (isArchived:true); the resume
// list filters isArchived:false so it never offers it again. Idempotent: a
// stale/already-consumed id returns { dismissed: false } at 200, never a 404.
const DismissWizardDraftResponseSchema = z.object({ dismissed: z.boolean() });
export type DismissWizardDraftResponse = z.infer<
  typeof DismissWizardDraftResponseSchema
>;

/**
 * POST /api/wizard/drafts/:id/dismiss — decline a resume draft (BUG-023).
 *
 * Propagates apiClient typed errors: `UnauthenticatedError` (401),
 * `ApiError` (500), `ApiSchemaError` on a response-shape mismatch.
 */
export async function dismissWizardDraft(
  draftId: string,
): Promise<DismissWizardDraftResponse> {
  return apiClient(`/wizard/drafts/${encodeURIComponent(draftId)}/dismiss`, {
    method: "POST",
    schema: DismissWizardDraftResponseSchema,
  });
}

// ── Block 4b-3 (D-WS9-072) — "See Previous Options" last-batch ───────────
// The user's single last-generated plan-options batch (pre-expand candidate
// cards). The generate surfaces read this to decide whether to show the link,
// and to rehydrate wizard-results without a fresh AI call. `input` is the
// request slice needed to rebuild candidateContext at a later expand (null for
// surprise — context re-derives from stored prefs). Snapshot by design.

const WizardLastBatchSchema = z.object({
  source: z.enum(["wizard", "tellkiwi", "surprise"]),
  candidates: z.array(WizardPlanCandidateSchema),
  // Loosely typed on purpose — it round-trips verbatim into the wizard-results
  // rehydrate params as the WizardPreferencesInput / TellKiwiInput slice. Null
  // for surprise.
  input: z.unknown().nullable(),
  createdAt: z.string(),
});
export type WizardLastBatch = z.infer<typeof WizardLastBatchSchema>;

const GetWizardLastBatchResponseSchema = z.object({
  batch: WizardLastBatchSchema.nullable(),
});
export type GetWizardLastBatchResponse = z.infer<
  typeof GetWizardLastBatchResponseSchema
>;

/**
 * GET /api/wizard/last-batch — the "See Previous Options" batch, or
 * { batch: null } for a user who has never generated. Never 404s.
 *
 * Propagates apiClient typed errors: `UnauthenticatedError` (401),
 * `ApiError` (500), `ApiSchemaError` on a response-shape mismatch.
 */
export async function getWizardLastBatch(): Promise<GetWizardLastBatchResponse> {
  return apiClient("/wizard/last-batch", {
    schema: GetWizardLastBatchResponseSchema,
  });
}

/**
 * GET /api/wizard/drafts/:id — resume detail fetch. Returns the same
 * envelope as POST /wizard/expand so resume navigates to the Block A
 * Plan Details screen with the same (draftId, expanded JSON) params.
 *
 * 404 here means the draft is gone (swept past TTL, saved/activated since
 * the list snapshot, or never owned). 422 means optimizationNotes failed
 * schema parse — surface as an error and offer "Get new results" instead.
 *
 * Propagates apiClient typed errors: `UnauthenticatedError` (401),
 * `ApiError` (404 not found / not owned / not a draft, 422 malformed,
 * 500 read failed), `ApiSchemaError` on a response-shape mismatch.
 */
export async function getWizardDraft(
  draftId: string,
): Promise<WizardExpandResponse> {
  return apiClient(`/wizard/drafts/${encodeURIComponent(draftId)}`, {
    schema: WizardExpandResponseSchema,
  });
}

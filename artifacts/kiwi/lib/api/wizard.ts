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

import { todayLocalDate } from "../dates";
import { apiClient } from "./client";
import { MealCardSchema } from "./mealCard";
import type { WizardPlanCandidate, WizardPreferencesInput } from "../types";
import type { WizardShelfRequest } from "../wizard/perRunPayload";

// ── Zod schemas ──────────────────────────────────────────────────────────
// Transcribed from artifacts/api-server/src/lib/ai/schemas/wizard.ts —
// kept mobile-side rather than imported so the mobile package stays
// independent of the api-server build. `.passthrough()` for forward-compat.

// D-WS9-191 Block 1 (server) — the per-meal rows the chooser card shows, in
// `mealTitles` order. OPTIONAL on the wire: a legacy batch (a pre-Block-1
// last-batch row) has none and the card renders title-only rows. `.passthrough()`
// on the row too — the server may add fields.
export const WizardPlanCandidateMealSchema = z
  .object({
    title: z.string(),
    description: z.string().nullable(),
    storeMealId: z.string().optional(),
    estimatedTimeMinutes: z.number().optional(),
  })
  .passthrough();

export const WizardPlanCandidateSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    imageUrl: z.string().optional(),
    badge: z.enum(["featured", "top_rated"]).optional(),
    tags: z.array(z.string()),
    whyBullets: z.array(z.string()),
    mealTitles: z.array(z.string()),
    storeSlots: z
      .array(z.object({ slotIndex: z.number(), storeMealId: z.string() }).passthrough())
      .optional(),
    meals: z.array(WizardPlanCandidateMealSchema).optional(),
    dailyMacros: z.object({
      calories: z.number(),
      proteinG: z.number(),
      carbsG: z.number(),
      fatG: z.number(),
    }),
  })
  .passthrough();

// ── D-WS9-191 Block 2 — the generation body's session extras ───────────────
// Merged into the POST body beside the wizard input (the server reads them
// separately; WizardInputSchema is a plain z.object, so an unread key is
// stripped, never a 400). BUG-053 Part F's exclusion pair, plus the "Get
// another plan option" pair: `another.dismissedPlanTitles` (the contract's
// field) and `candidateCount: 1` (the Block 1 shape's request field) — the
// screen sends both on an "another" call and neither on the first batch.
export interface WizardGenerateExtras {
  excludePlanTitles: string[];
  excludeMealTitles: string[];
  another?: { dismissedPlanTitles: string[] };
  candidateCount?: number;
}

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
  // reads it separately). Optional + backward-compatible. D-WS9-191 — the
  // "another" pair rides the same slot.
  exclude?: WizardGenerateExtras,
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
    // WS9 BUG-245 (D-WS9-235) — hands-on minutes if the expand payload carries
    // them; absent/null → the draft row renders its total only.
    activeTimeMinutes: z.number().nullable().optional(),
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
      // WS9 Redesign Arc Block 2a (§1) — the device's local calendar date, so
      // the server dates the activated plan to the USER's week. The route
      // parses no body today and ignores the key until the server lane reads it.
      body: { localDate: todayLocalDate() },
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

// ── WS9 Redesign Arc Block 2a (D-WS9-237) — POST /wizard/shelf ──────────────
// The Pick screen's feed: ~15 catalog + playlist meals that fit the wizard's
// per-run input, with REAL meal ids. Transcribed from the route
// (artifacts/api-server/src/routes/wizard.ts) — the card is the shared
// MealCard plus the per-card flags; times are the server's DERIVED columns
// (D-WS9-235). Paging is by exclusion: the client re-sends every id already
// shown as `excludeMealIds` and the server returns the next slice.

export const ShelfMealSchema = MealCardSchema.extend({
  /** A catalog meal the user has never been served (the discovery dial's unit). */
  isNewToYou: z.boolean(),
  /** In the user's playlist (a fork of it, or a playlist meal itself). */
  isPlaylist: z.boolean(),
  /** Text mode — a meal the user NAMED, matched and pinned to the front. */
  isPinned: z.boolean(),
  matchesCuisine: z.boolean().nullable(),
  source: z.string(),
});
export type ShelfMeal = z.infer<typeof ShelfMealSchema>;

const WizardShelfResponseSchema = z.object({
  meals: z.array(ShelfMealSchema),
  /** Every catalog meal that fits the filters — the "{N} fit your preferences" N. */
  totalEligible: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  /** Text mode — named meals Kiwi could not find. [] in prefs mode. */
  unmatchedNames: z.array(z.string()),
  /** Text mode — whether the parse ran (false = parse failed, shelf unpinned). */
  textParsed: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type WizardShelfResponse = z.infer<typeof WizardShelfResponseSchema>;

/**
 * POST /api/wizard/shelf — "Meals to choose from". DB-only unless `text` is
 * sent (then the parse_intent call runs for its named meals). Fast.
 *
 * Propagates apiClient typed errors: `UnauthenticatedError` (401),
 * `UpgradeRequiredError` (402 — entitlement), `ApiError` (400 body, 500),
 * `ApiSchemaError` on a response-shape mismatch.
 */
export async function buildWizardShelf(
  body: WizardShelfRequest,
): Promise<WizardShelfResponse> {
  return apiClient("/wizard/shelf", {
    method: "POST",
    body,
    schema: WizardShelfResponseSchema,
  });
}

// ── D-WS9-191 Block 2 — GET /wizard/limits + POST /wizard/candidates/dismiss ─

// `maxRefreshesPerSession` = the server's `wizard.max_refreshes_per_session`
// (default 4). Since D-WS9-191 it means PRESSES of "Get another plan option"
// per plan-options screen session; the initial batch is not a press. The
// client counts presses (lib/wizard/planOptions.ts pressesLeft). `.passthrough()`
// — the route also returns candidateCount, unused here.
const WizardLimitsResponseSchema = z
  .object({
    maxRefreshesPerSession: z.number(),
  })
  .passthrough();
export type WizardLimitsResponse = z.infer<typeof WizardLimitsResponseSchema>;

/**
 * GET /api/wizard/limits — the per-session cap. A failure is not fatal to the
 * screen (it falls back to the server's known default); propagates apiClient
 * typed errors so the caller can decide.
 */
export async function getWizardLimits(): Promise<WizardLimitsResponse> {
  return apiClient("/wizard/limits", { schema: WizardLimitsResponseSchema });
}

/** POST /wizard/candidates/dismiss body — see lib/wizard/planOptions.ts dismissRequestFor. */
export interface DismissWizardCandidateRequest {
  title: string;
  mealTitles: string[];
  storeMealIds?: string[];
  source: "wizard" | "tellkiwi";
}

/**
 * POST /api/wizard/candidates/dismiss — "Not For Me". Logs a
 * `plan_candidate_dismissed` activity row a future wizard can read; nothing
 * acts on it now (Hans: no preference learning at this stage). 204, no body.
 * Fire-and-forget at the call site: a failure never blocks the dismissal.
 */
export async function dismissWizardCandidate(
  body: DismissWizardCandidateRequest,
): Promise<void> {
  await apiClient("/wizard/candidates/dismiss", {
    method: "POST",
    body,
    parseAs: "none",
  });
}

// ── Block 4b-3 (D-WS9-072) — "See Previous Options" last-batch ───────────
// The user's single last-generated plan-options batch (pre-expand candidate
// cards). The generate surfaces read this to decide whether to show the link,
// and to rehydrate wizard-results without a fresh AI call. `input` is the
// request slice needed to rebuild candidateContext at a later expand. Snapshot
// by design.
//
// WS9 Redesign Arc Block 2a Part B — "surprise" is REMOVED from the WRITE side
// with the Surprise Me entry. Block 2b (ruled, 2a CANDIDATE-1) — the READ union
// mirrors the server's (wizardLastBatch.ts WizardBatchSourceOnRead): a row a
// user generated through Surprise Me before Block 2 still parses, and
// shouldShowPreviousOptions renders NOTHING for it (there is no screen left to
// rehydrate it into). The next generation overwrites the row.

//
// WS9 Redesign Arc Block 2c Part E — a SHELF batch ("Meals to choose from").
// The server ([WS9-arc-PS-A]) stores the ORDERED refs last shown on the Pick
// screen and, on read, re-resolves them to CURRENT cards: `batch.shelf` is a
// WizardShelfResponse the Pick screen can mount as-is (a deleted / archived
// meal drops out; nothing left → { batch: null }). A shelf row carries no
// plan candidates (`candidates` optional on read; consumers coalesce);
// `input` is the WizardShelfRequest slice "Get more options" re-posts.
// `metadata` is null on this read where the live shelf omits it.
const LastBatchShelfSchema = WizardShelfResponseSchema.extend({
  metadata: z.record(z.unknown()).nullable().optional(),
});
const WizardLastBatchSchema = z.object({
  source: z.enum(["wizard", "tellkiwi", "surprise", "shelf"]),
  candidates: z.array(WizardPlanCandidateSchema).optional(),
  shelf: LastBatchShelfSchema.nullable().optional(),
  // Loosely typed on purpose — it round-trips verbatim into the wizard-results
  // rehydrate params as the WizardPreferencesInput / TellKiwiInput slice (or,
  // for a shelf batch, the Pick screen's WizardShelfRequest).
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

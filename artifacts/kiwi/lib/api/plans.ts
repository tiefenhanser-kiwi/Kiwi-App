// Mobile client for the WS7-3 A2 composite plan reads — GET /plans (the Plan
// Discovery list) and GET /plans/:id (the Plan Review detail).
// WS7-3 Block C1 — API-client + hook foundation; no screens migrate here.
//
// Schemas are transcribed from the real server routes
// (artifacts/api-server/src/routes/plans.ts + src/lib/planQueries.ts), NOT the
// PRD — the implementation wins where the two differ (see C1 Phase 1 §7).

import { z } from "zod";

import { apiClient } from "./client";
import { MealDetailSchema } from "./meals";

// ── Filter keys ────────────────────────────────────────────────────────────
// The four Plan Discovery facets — mirrors PLAN_FILTER_KEYS in
// src/lib/planQueries.ts. Date-based filters (this_week, upcoming, …) are NOT
// accepted by GET /plans today (WS7-3 commissioning ruling — C1 Phase 1 §1.5).
export const PLAN_FILTER_KEYS = [
  "my_plans",
  "featured",
  "top_rated",
  "hosting_events",
] as const;
export type PlanFilterKey = (typeof PLAN_FILTER_KEYS)[number];

/**
 * Narrows a server-supplied string[] (e.g. user.lastPlanDiscoveryFilters /
 * user.lastPlansFilters) to the typed PlanFilterKey union, dropping unknown
 * values silently. Relocated from lib/stubs.ts in WS7-3 C2 — it outlives the
 * stub file because the Home + Plans-tab filter persistence reads through it.
 */
export function asPlanDiscoveryFilters(
  arr: string[] | undefined | null,
): PlanFilterKey[] {
  if (!arr) return [];
  return arr.filter((k): k is PlanFilterKey =>
    (PLAN_FILTER_KEYS as readonly string[]).includes(k),
  );
}

// ── Schemas ────────────────────────────────────────────────────────────────

// One row of the Plan Discovery list. `source` distinguishes the user's saved
// plans (`instance`) from public catalog templates (`template`); template rows
// always carry null status/dates.
export const PlanListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  image: z.string().nullable(),
  tags: z.array(z.string()),
  source: z.enum(["instance", "template"]),
  status: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  isActiveThisWeek: z.boolean(),
});
export type PlanListItem = z.infer<typeof PlanListItemSchema>;

// Compact plan summary — the pinned "This Week" callout (GET /plans
// `activeThisWeek`) and the GET /home `activePlan` field share this shape.
export const PlanSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  revisionId: z.number(),
});
export type PlanSummary = z.infer<typeof PlanSummarySchema>;

// GET /plans response — the cursor-paginated discovery union plus the user's
// current This-Week plan.
const PlanListResponseSchema = z.object({
  plans: z.array(PlanListItemSchema),
  activeThisWeek: PlanSummarySchema.nullable(),
  nextCursor: z.string().nullable(),
});
export type PlanListResponse = z.infer<typeof PlanListResponseSchema>;

// One item of a Plan Review payload — a plan slot plus its fully-composed
// Meal. `meal` is null when the meal row is missing/archived server-side.
// WS7-4-D c5: exported so the item mutation response schemas can reuse it.
export const PlanDetailItemSchema = z.object({
  id: z.string(),
  mealId: z.string(),
  positionIndex: z.number(),
  assignedDayOfWeek: z.string().nullable(),
  assignedDate: z.string().nullable(),
  servingsOverride: z.number().nullable(),
  isBreakfast: z.boolean(),
  isLunch: z.boolean(),
  isDinner: z.boolean(),
  notes: z.string().nullable(),
  meal: MealDetailSchema.nullable(),
});
export type PlanDetailItem = z.infer<typeof PlanDetailItemSchema>;

// WS7-6 Fix-Block 2 (D, closes D-WS7-060) — fields are nullable so the
// server can signal "no meals assigned" (empty state) with `null` rather
// than misleading zeros. Plan Review renders "—" for null.
const MacroDailyAverageSchema = z.object({
  caloriesPerDay: z.number().nullable(),
  proteinGPerDay: z.number().nullable(),
  carbsGPerDay: z.number().nullable(),
  fatGPerDay: z.number().nullable(),
});
export type MacroDailyAverage = z.infer<typeof MacroDailyAverageSchema>;

// WS7-4-A c6 — Optimization panel note shape per PRD §8.3.4. Mirrors the
// OptimizationNote interface in lib/types.ts (server-canonical).
const OptimizationNoteSchema = z.object({
  type: z.enum(["prep", "cost"]),
  text: z.string(),
});

// GET /plans/:id payload — the `plan` envelope's contents: instance meta +
// every item with its Meal expansion + a fresh macro rollup.
export const PlanDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  revisionId: z.number(),
  isActiveThisWeek: z.boolean(),
  userId: z.string(),
  sourceType: z.string(),
  // WS7-4-A c6 — new MealPlanInstance fields from PRD §8.3.3 / §8.3.4 / §8.3.7.
  prepStatus: z.enum(["not_prepped", "partial", "prepped"]),
  optimizationNotes: z.array(OptimizationNoteSchema),
  breakfastOverrides: z.string(),
  lunchOverrides: z.string(),
  items: z.array(PlanDetailItemSchema),
  macroDailyAverage: MacroDailyAverageSchema,
});
export type PlanDetail = z.infer<typeof PlanDetailSchema>;

const PlanDetailEnvelopeSchema = z.object({ plan: PlanDetailSchema });

// WS7-4-B c5 — Template detail schema for the Use Plan preview overlay.
// Mirrors the GET /plans/templates/:id server projection. Item shape is a
// subset of PlanDetailItem (no assignedDate / servingsOverride / notes —
// those are per-Instance concerns; templates carry only slot identity).
const TemplateDetailItemSchema = z.object({
  id: z.string(),
  mealId: z.string(),
  positionIndex: z.number(),
  assignedDayOfWeek: z.string().nullable(),
  isBreakfast: z.boolean(),
  isLunch: z.boolean(),
  isDinner: z.boolean(),
  meal: MealDetailSchema.nullable(),
});
export type TemplateDetailItem = z.infer<typeof TemplateDetailItemSchema>;

export const TemplateDetailSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  image: z.string().nullable(),
  tags: z.array(z.string()),
  sourceType: z.string(),
  defaultDaysCount: z.number(),
  optimizationNotes: z.array(OptimizationNoteSchema),
  items: z.array(TemplateDetailItemSchema),
});
export type TemplateDetail = z.infer<typeof TemplateDetailSchema>;

const TemplateDetailEnvelopeSchema = z.object({ template: TemplateDetailSchema });

const UseTemplateResponseSchema = z.object({
  instance: z.object({ id: z.string(), revisionId: z.number() }),
});

// WS7-5b-mobile Block C — POST /plans response envelope. Mirrors the server
// 201 shape at src/routes/plans.ts:509-511 (the WS7-4-C c2 create endpoint).
const CreatePlanResponseSchema = z.object({
  instance: z.object({ id: z.string(), revisionId: z.number() }),
});

export interface PostPlanBody {
  name?: string;
  startDate?: string | null;
  endDate?: string | null;
  isActiveThisWeek?: boolean;
}

// WS7-4-C c5/c6 — PATCH /plans/:id response envelope. macrosStale is
// returned when the server checked planNeedsMacroEstimation as part of
// the mutation; absent in no-op responses.
const PatchPlanResponseSchema = z.object({
  instance: z.object({ id: z.string(), revisionId: z.number() }),
  macrosStale: z.boolean().optional(),
});
export type PatchPlanResponse = z.infer<typeof PatchPlanResponseSchema>;

// Body shape accepted by PATCH /plans/:id. All fields optional; the
// server enforces non-empty via Zod refine. Mirrors the server-side
// PatchPlanBody in src/routes/plans.ts (WS7-4-C c4).
export interface PatchPlanBody {
  name?: string;
  startDate?: string | null;
  endDate?: string | null;
  status?: "draft" | "this_week" | "next_week" | "upcoming" | "past";
  isActiveThisWeek?: boolean;
  breakfastOverrides?: string | null;
  lunchOverrides?: string | null;
  prepStatus?: "not_prepped" | "partial" | "prepped";
  optimizationNotes?: unknown;
}

// ── Getters ────────────────────────────────────────────────────────────────

/**
 * GET /plans — the Plan Discovery list. `filter` is a multi-select subset of
 * PLAN_FILTER_KEYS; omitted/empty defers to the server default (`my_plans`).
 * Returns the cursor-paginated union plus the current This-Week plan summary.
 * Propagates the apiClient typed errors: `UnauthenticatedError` (401),
 * `ApiSchemaError` on a response-shape mismatch.
 */
export async function getPlans(
  filter?: readonly PlanFilterKey[],
  // WS7-7-A B6 — `cursor` is the opaque `nextCursor` from a prior page (the
  // server paginates GET /plans via paginateById). Additive: existing callers
  // that omit it get page 1, unchanged.
  opts: { cursor?: string } = {},
): Promise<PlanListResponse> {
  const params = new URLSearchParams();
  if (filter && filter.length > 0) params.set("filter", filter.join(","));
  if (opts.cursor) params.set("cursor", opts.cursor);
  const qs = params.toString();
  return apiClient(`/plans${qs ? `?${qs}` : ""}`, {
    schema: PlanListResponseSchema,
  });
}

/**
 * GET /plans/:id — the composite Plan Review payload. Propagates the apiClient
 * typed errors: `ApiError` (404 for a missing or non-owned plan),
 * `UnauthenticatedError` (401), `ApiSchemaError` on a response-shape mismatch.
 */
export async function getPlan(id: string): Promise<PlanDetail> {
  const body = await apiClient(`/plans/${encodeURIComponent(id)}`, {
    schema: PlanDetailEnvelopeSchema,
  });
  return body.plan;
}

/**
 * WS7-4-B c5 — GET /plans/templates/:id — public Template detail for the
 * Use Plan preview overlay. Propagates the apiClient typed errors: `ApiError`
 * (404 for a missing or non-readable template; the server collapses
 * non-public-non-owner into 404 to avoid existence leak),
 * `UnauthenticatedError` (401), `ApiSchemaError` on a response-shape mismatch.
 */
export async function getTemplate(templateId: string): Promise<TemplateDetail> {
  const body = await apiClient(
    `/plans/templates/${encodeURIComponent(templateId)}`,
    { schema: TemplateDetailEnvelopeSchema },
  );
  return body.template;
}

/**
 * WS7-4-B c5 — POST /plans/use-template/:templateId — copy a Template into a
 * new MealPlanInstance owned by the current user. Returns `{ instanceId }`
 * for navigation. Propagates the apiClient typed errors: `ApiError` (404 for
 * missing/non-readable template, 429 when the per-user mutation limit is
 * exhausted, 500 on transactional failure), `UnauthenticatedError` (401),
 * `ApiSchemaError` on a response-shape mismatch.
 */
export async function useTemplate(
  templateId: string,
): Promise<{ instanceId: string }> {
  const body = await apiClient(
    `/plans/use-template/${encodeURIComponent(templateId)}`,
    { method: "POST", schema: UseTemplateResponseSchema },
  );
  return { instanceId: body.instance.id };
}

/**
 * WS7-4-C c5/c6 — PATCH /plans/:id — edit any subset of plan-level fields
 * (name, dates, status, isActiveThisWeek, breakfast/lunch overrides,
 * prepStatus, optimizationNotes). Single helper covers both updatePlanName
 * (body = { name }) and updatePlanDateRange (body = { startDate?, endDate? })
 * since they hit the same endpoint with different body subsets. Propagates
 * the apiClient typed errors: `ApiError` (404 missing/non-owned, 400
 * validation, 429 rate limit, 500 tx), `UnauthenticatedError` (401),
 * `ApiSchemaError` on a response-shape mismatch.
 */
export async function patchPlan(
  planId: string,
  body: PatchPlanBody,
): Promise<PatchPlanResponse> {
  return apiClient(`/plans/${encodeURIComponent(planId)}`, {
    method: "PATCH",
    body,
    schema: PatchPlanResponseSchema,
  });
}

/**
 * WS7-5b-mobile Block C — POST /plans — create a new empty MealPlanInstance
 * for the requester (resolves D-WS7-059). All body fields are optional; an
 * empty body `{}` is valid and produces an undated, inactive draft. Used by
 * the AddMealToPlanSheet "Create new plan" flow, which pairs this with
 * `postPlanItem` to seed the new plan with one meal. Propagates apiClient
 * typed errors: `ApiError` (400 validation, 429 rate limit, 500 tx),
 * `UnauthenticatedError` (401), `ApiSchemaError` on response-shape mismatch.
 */
export async function createPlan(
  body: PostPlanBody = {},
): Promise<{ instanceId: string; revisionId: number }> {
  const response = await apiClient(`/plans`, {
    method: "POST",
    body,
    schema: CreatePlanResponseSchema,
  });
  return {
    instanceId: response.instance.id,
    revisionId: response.instance.revisionId,
  };
}

// ── WS7-4-D c5 — Plan Item mutation helpers ────────────────────────────────
// Server endpoints (POST/PATCH/DELETE /plans/:id/items[/:itemId] +
// /promote-override) all return the same rich Q-P1-5 (a) envelope. Mobile
// mutators discard the parsed response and trigger React Query invalidation
// per Q-P0-8, but the helpers parse the full envelope so smoke + future
// skip-refetch callers get assertion surface.

const PlanItemMutationResponseSchema = z.object({
  item: PlanDetailItemSchema,
  planId: z.string(),
  revisionId: z.number(),
  macrosStale: z.boolean(),
});
export type PlanItemMutationResponse = z.infer<
  typeof PlanItemMutationResponseSchema
>;

const PlanItemDeleteResponseSchema = z.object({
  planId: z.string(),
  revisionId: z.number(),
  macrosStale: z.boolean(),
});
export type PlanItemDeleteResponse = z.infer<
  typeof PlanItemDeleteResponseSchema
>;

const PromoteItemOverrideResponseSchema = PlanItemMutationResponseSchema.extend({
  newMealId: z.string(),
});
export type PromoteItemOverrideResponse = z.infer<
  typeof PromoteItemOverrideResponseSchema
>;

export interface PostPlanItemBody {
  mealId: string;
  slot?: "breakfast" | "lunch" | "dinner";
  assignedDayOfWeek?: string | null;
  servingsOverride?: number | null;
}

export interface PatchPlanItemBody {
  mealId?: string;
  slot?: "breakfast" | "lunch" | "dinner";
  assignedDayOfWeek?: string | null;
  servingsOverride?: number | null;
  ingredientOverrides?: unknown;
  recipeOverrideJson?: unknown;
  notes?: string | null;
}

/**
 * POST /plans/:id/items — add a meal to a plan. Per Q-P0-5, body uses
 * slot=breakfast|lunch|dinner (server maps to 3 booleans; defaults to
 * "dinner" when omitted). Propagates apiClient typed errors.
 */
export async function postPlanItem(
  planId: string,
  body: PostPlanItemBody,
): Promise<PlanItemMutationResponse> {
  return apiClient(`/plans/${encodeURIComponent(planId)}/items`, {
    method: "POST",
    body,
    schema: PlanItemMutationResponseSchema,
  });
}

/**
 * PATCH /plans/:id/items/:itemId — multi-field item edit. Per Q-P1-4 v1,
 * when `mealId` is included no other field may accompany it (server returns
 * 400). Propagates apiClient typed errors.
 */
export async function patchPlanItem(
  planId: string,
  itemId: string,
  body: PatchPlanItemBody,
): Promise<PlanItemMutationResponse> {
  return apiClient(
    `/plans/${encodeURIComponent(planId)}/items/${encodeURIComponent(itemId)}`,
    {
      method: "PATCH",
      body,
      schema: PlanItemMutationResponseSchema,
    },
  );
}

/**
 * DELETE /plans/:id/items/:itemId — hard-delete an item (Q-P0-2).
 * Propagates apiClient typed errors.
 */
export async function deletePlanItem(
  planId: string,
  itemId: string,
): Promise<PlanItemDeleteResponse> {
  return apiClient(
    `/plans/${encodeURIComponent(planId)}/items/${encodeURIComponent(itemId)}`,
    {
      method: "DELETE",
      schema: PlanItemDeleteResponseSchema,
    },
  );
}

/**
 * POST /plans/:id/items/:itemId/promote-override — materialize the item's
 * recipeOverrideJson into a new private Meal and rebind. Per Q-P1-2, a
 * server 422 `{ error: "unresolved_ingredient", ingredientName }` surfaces
 * as ApiError with the structured body.
 */
export async function promoteItemOverride(
  planId: string,
  itemId: string,
): Promise<PromoteItemOverrideResponse> {
  return apiClient(
    `/plans/${encodeURIComponent(planId)}/items/${encodeURIComponent(itemId)}/promote-override`,
    {
      method: "POST",
      schema: PromoteItemOverrideResponseSchema,
    },
  );
}

// ── WS7-4-E c1 — Recalc macros (hybrid pull per Ruling 11) ─────────────────
// Mobile mutators fire this after a mutation response carries
// macrosStale: true (a dish in the plan needs AI estimation). The server
// runs estimateDishMacros per uncached dish, persists fresh canonical
// per-serving macros back to Dish rows, then returns the recomputed plan
// aggregates. The mobile UI only consumes `dailyAverages` for PRD §8.3.5;
// the rest of the payload is parsed loosely (server-canonical) so a future
// caller can read perDay / perMeal / caveats without a schema bump.

const RecalcMacrosResponseSchema = z.object({
  dailyAverages: MacroDailyAverageSchema,
  hasEstimatedMacros: z.boolean().optional(),
  estimationCaveats: z.array(z.string()).optional(),
});
export type RecalcMacrosResponse = z.infer<typeof RecalcMacrosResponseSchema>;

/**
 * POST /plans/:id/recalc-macros — server runs Haiku per uncached dish,
 * persists canonical macros back to Dish rows, and returns the recomputed
 * plan-level rollups. Auth-gated + rate-limited (server: recalcLimiter
 * 12/min). Propagates apiClient typed errors: `ApiError` (404 missing/
 * non-owned, 429 rate limit, 500 estimation failure), `UnauthenticatedError`
 * (401), `ApiSchemaError` on a response-shape mismatch.
 */
export async function recalcPlanMacros(
  planId: string,
): Promise<RecalcMacrosResponse> {
  return apiClient(
    `/plans/${encodeURIComponent(planId)}/recalc-macros`,
    {
      method: "POST",
      schema: RecalcMacrosResponseSchema,
    },
  );
}

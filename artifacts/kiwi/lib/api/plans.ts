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
const PlanDetailItemSchema = z.object({
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

const MacroDailyAverageSchema = z.object({
  caloriesPerDay: z.number(),
  proteinGPerDay: z.number(),
  carbsGPerDay: z.number(),
  fatGPerDay: z.number(),
});
export type MacroDailyAverage = z.infer<typeof MacroDailyAverageSchema>;

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
  items: z.array(PlanDetailItemSchema),
  macroDailyAverage: MacroDailyAverageSchema,
});
export type PlanDetail = z.infer<typeof PlanDetailSchema>;

const PlanDetailEnvelopeSchema = z.object({ plan: PlanDetailSchema });

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
): Promise<PlanListResponse> {
  const query =
    filter && filter.length > 0
      ? `?filter=${encodeURIComponent(filter.join(","))}`
      : "";
  return apiClient(`/plans${query}`, { schema: PlanListResponseSchema });
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

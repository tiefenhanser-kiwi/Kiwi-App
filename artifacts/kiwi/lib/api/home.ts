// Mobile client for the WS7-3 A2 composite Home-tab read — GET /home.
// WS7-3 Block C1 — API-client + hook foundation; no screens migrate here.
//
// GET /home is a flat composite (NOT enveloped under a `home:` key): today's
// meal, the active plan summary, and the badged plan-discovery cards. Schema
// transcribed from the real server route (artifacts/api-server/src/routes/
// home.ts) — the implementation wins over PRD §4.6 (see C1 Phase 1 §7).

import { z } from "zod";

import { apiClient } from "./client";
import { MealListItemSchema } from "./meals";
import { PLAN_FILTER_KEYS, PlanListItemSchema, PlanSummarySchema } from "./plans";

// Today's assigned meal — a plan-slot reference plus the list-shaped Meal.
const TodaysMealSchema = z.object({
  mealPlanItemId: z.string(),
  dayOffset: z.number(),
  planId: z.string(),
  planName: z.string(),
  meal: MealListItemSchema,
});
export type TodaysMeal = z.infer<typeof TodaysMealSchema>;

// One badged discovery card — a filter key plus up to five plans.
const PlanDiscoveryCardSchema = z.object({
  badge: z.enum(PLAN_FILTER_KEYS),
  plans: z.array(PlanListItemSchema),
});
export type PlanDiscoveryCard = z.infer<typeof PlanDiscoveryCardSchema>;

// The active-plan summary as /home returns it: PlanSummary plus the R4
// grocery-list pointer (WS9 3a). `groceryListId` is the plan's non-archived
// list id, or null when none exists — drives the Home "Grocery List" smart
// route (has-list → open · no-list → generate). Home-only: the shared
// PlanSummarySchema is untouched (other /plans callers don't carry it).
const HomeActivePlanSchema = PlanSummarySchema.extend({
  groceryListId: z.string().nullable(),
});
export type HomeActivePlan = z.infer<typeof HomeActivePlanSchema>;

// GET /home — the full Home-tab payload. `todaysMeal` / `activePlan` are null
// when the user has no active plan or nothing assigned to today.
export const HomePayloadSchema = z.object({
  todaysMeal: TodaysMealSchema.nullable(),
  activePlan: HomeActivePlanSchema.nullable(),
  planDiscoveryCards: z.array(PlanDiscoveryCardSchema),
  // D-WS9-026 — ISO timestamp of the user's first committed plan, or null
  // (first-run). null → show the Home teaching arc; non-null → collapsed
  // forever. A timestamp, not a boolean, so the value doubles as the
  // time-to-first-plan activation metric server-side.
  firstPlanCreatedAt: z.string().nullable(),
});
export type HomePayload = z.infer<typeof HomePayloadSchema>;

/**
 * GET /home — the composite Home-tab payload. Propagates the apiClient typed
 * errors: `UnauthenticatedError` (401), `ApiSchemaError` on a response-shape
 * mismatch.
 */
export async function getHomePayload(): Promise<HomePayload> {
  return apiClient("/home", { schema: HomePayloadSchema });
}

// ── WS9-2 2c (D-WS9-154) — the Tried & True rail ────────────────────────────
//
// Transcribed field-for-field from the server builder (RailPlanItem +
// railRowToItem in api-server/src/lib/planQueries.ts). Replaces the retired
// three-query merge over GET /plans.
//
// ⚠️ `image` is NON-OPTIONAL and nullable, matching the server, which always
// emits the key. This is load-bearing: the rail is the only surface in the app
// where photographs actually render, and if a server-side projection ever drops
// imageUrl the field arrives absent and THIS schema fails loudly rather than
// blanking the cards silently. Do not soften it to .optional().
const RailPlanItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string().nullable(),
  tags: z.array(z.string()),
  // The badge pill derives from these two client-side — the label is copy.
  isFeatured: z.boolean(),
  isHostingFeatured: z.boolean(),
});
export type RailPlanItem = z.infer<typeof RailPlanItemSchema>;

const HomeRailResponseSchema = z.object({
  plans: z.array(RailPlanItemSchema),
});
export type HomeRailResponse = z.infer<typeof HomeRailResponseSchema>;

/**
 * GET /home/rail — the ordered Tried & True rail (public catalog templates with
 * a non-null railPosition). Propagates the apiClient typed errors:
 * `UnauthenticatedError` (401), `ApiSchemaError` on a response-shape mismatch.
 */
export async function getHomeRail(): Promise<RailPlanItem[]> {
  const body = await apiClient("/home/rail", {
    schema: HomeRailResponseSchema,
  });
  return body.plans;
}

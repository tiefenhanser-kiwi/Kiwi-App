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

// GET /home — the full Home-tab payload. `todaysMeal` / `activePlan` are null
// when the user has no active plan or nothing assigned to today.
export const HomePayloadSchema = z.object({
  todaysMeal: TodaysMealSchema.nullable(),
  activePlan: PlanSummarySchema.nullable(),
  planDiscoveryCards: z.array(PlanDiscoveryCardSchema),
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

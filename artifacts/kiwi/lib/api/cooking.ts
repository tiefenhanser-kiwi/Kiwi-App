// Mobile client for the WS7-8a B3 prep-step completion endpoints (D-WS7-153) —
// the checkbox-persistence layer behind the WS7-8b Prep & Cook screens.
//   PUT    /api/plans/:planId/prep-week/completions — check a step (idempotent upsert)
//   DELETE /api/plans/:planId/prep-week/completions — uncheck a step (idempotent delete)
//   GET    /api/plans/:planId/prep-week/completions — resume: checked rows +
//          per-meal prepped map + the status rollups.
//
// WS7-8b Block 1 — data plumbing only; no screens here. The schemas mirror the
// server response builders verbatim (artifacts/api-server/src/routes/cooking.ts
// :434-568); the implementation wins where it differs from any PRD.
//
// These are FREE endpoints (no entitlement gate — only AI prep generation is
// premium). Auth is the apiClient default (Bearer token); plan ownership is
// enforced server-side as a 404 (never leak a plan's existence), surfacing as
// ApiError(status=404). All helpers use throw mode — callers catch — matching
// the lib/api/plans.ts mutation helpers.

import { z } from "zod";

import { apiClient } from "./client";

// ── Shared vocabulary ──────────────────────────────────────────────────────

// The plan-level prep rollup enum — identical to PlanDetailSchema.prepStatus
// (server `PrepStatus`). Defined locally so cooking.ts has no import cycle with
// plans.ts; the literal set is asserted equal to the plan-detail enum in tests.
const PrepStatusSchema = z.enum(["not_prepped", "partial", "prepped"]);
export type PrepStatusValue = z.infer<typeof PrepStatusSchema>;

// `stepKey` is an opaque stable identity minted server-side
// (`<phaseKey>#<ingredientId>` or `<phaseKey>#blend` — prepWeekAssembly.ts).
// The mobile client treats it as opaque: the write path validates only
// min(1)/max(80) server-side, with no allowlist, so we mirror a plain string.
const StepKeySchema = z.string().min(1).max(80);

// ── Schemas (verbatim mirrors of the server response builders) ──────────────

// PUT / DELETE both return the same tiny ack: the echoed stepKey + the new
// checked state (PUT → true, DELETE → false). cooking.ts:534 / :567.
const CompletionMutationResponseSchema = z.object({
  stepKey: z.string(),
  checked: z.boolean(),
});
export type CompletionMutationResponse = z.infer<
  typeof CompletionMutationResponseSchema
>;

// One persisted checked row in the GET (resume) response. cooking.ts:482-485.
const PrepCompletionRowSchema = z.object({
  stepKey: z.string(),
  checkedAt: z.string(), // ISO-8601 (r.checkedAt.toISOString()).
});
export type PrepCompletionRow = z.infer<typeof PrepCompletionRowSchema>;

// GET /plans/:planId/prep-week/completions — cooking.ts:481-494. All three
// status fields are mirrored, NOT collapsed (WS7-8b B1 ruling):
//   - derivedPrepStatus  — the raw auto-rollup over the full meal universe.
//   - prepStatus         — the EFFECTIVE status (manual pin when isManual, else
//                          derived). What the user should see.
//   - prepStatusIsManual — which of the two is in play.
// `perMeal` maps every plan mealId → prepped? (a zero-step meal is vacuously
// true). The screen decides which status drives the UI.
const PrepWeekCompletionsResponseSchema = z.object({
  completions: z.array(PrepCompletionRowSchema),
  perMeal: z.record(z.string(), z.boolean()),
  derivedPrepStatus: PrepStatusSchema,
  prepStatus: PrepStatusSchema,
  prepStatusIsManual: z.boolean(),
});
export type PrepWeekCompletions = z.infer<
  typeof PrepWeekCompletionsResponseSchema
>;

// ── Client functions ────────────────────────────────────────────────────────

function completionsPath(planId: string): string {
  return `/plans/${encodeURIComponent(planId)}/prep-week/completions`;
}

/**
 * PUT …/prep-week/completions — check a prep step (idempotent upsert; a
 * re-check keeps the original checkedAt). Body is `{ stepKey }`. Returns the
 * `{ stepKey, checked: true }` ack. Propagates apiClient typed errors:
 * `ApiError` (404 missing/non-owned plan, 400 invalid stepKey, 429 rate limit),
 * `UnauthenticatedError` (401), `ApiSchemaError` on a response-shape mismatch.
 */
export async function checkPrepStep(
  planId: string,
  stepKey: string,
): Promise<CompletionMutationResponse> {
  return apiClient(completionsPath(planId), {
    method: "PUT",
    body: { stepKey },
    schema: CompletionMutationResponseSchema,
  });
}

/**
 * DELETE …/prep-week/completions — uncheck a prep step (idempotent delete;
 * unchecking a missing/orphan row is a harmless no-op). The server reads the
 * stepKey from the REQUEST BODY (`{ stepKey }`), not a path/query param — the
 * apiClient wrapper transmits a DELETE body (client.ts:138-158 builds it for
 * any method). Returns the `{ stepKey, checked: false }` ack. Propagates the
 * same typed errors as {@link checkPrepStep}.
 */
export async function uncheckPrepStep(
  planId: string,
  stepKey: string,
): Promise<CompletionMutationResponse> {
  return apiClient(completionsPath(planId), {
    method: "DELETE",
    body: { stepKey },
    schema: CompletionMutationResponseSchema,
  });
}

/**
 * GET …/prep-week/completions — resume state for the Week Prep screen: every
 * checked row, the per-meal prepped map, and the status rollups (raw derived +
 * effective + manual flag). Propagates apiClient typed errors: `ApiError` (404
 * missing/non-owned, 429 rate limit), `UnauthenticatedError` (401),
 * `ApiSchemaError` on a response-shape mismatch.
 */
export async function getPrepWeekCompletions(
  planId: string,
): Promise<PrepWeekCompletions> {
  return apiClient(completionsPath(planId), {
    schema: PrepWeekCompletionsResponseSchema,
  });
}

// Re-export for callers/tests that want to validate the stepKey bound before a
// write (the server caps it at 80 chars).
export { StepKeySchema };

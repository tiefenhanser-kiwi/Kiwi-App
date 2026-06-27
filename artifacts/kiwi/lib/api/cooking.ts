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
// WS7-8b Block 3 (Build Block 2B) — adds the Cooking Sequencer client
// `getCookingSequence(mealId)` (POST /meals/:mealId/cooking-sequence). The
// Sequencer is FREE read-only infrastructure (PRD §13.5.5): it reorders +
// annotates existing step data and generates nothing — no write path, nothing
// stored client-side. The response Zod mirror is verbatim against the server's
// route envelope (cooking.ts:128-133) + SequencedStepSchema (ai/schemas/
// sequencer.ts:72-91); §27 two-direction validation.
//
// These are FREE endpoints (no entitlement gate — only AI prep generation is
// premium). Auth is the apiClient default (Bearer token); plan ownership is
// enforced server-side as a 404 (never leak a plan's existence), surfacing as
// ApiError(status=404). All helpers use throw mode — callers catch — matching
// the lib/api/plans.ts mutation helpers.

import { z } from "zod";

import { apiClient } from "./client";
import { UpgradeRequiredError } from "./errors";

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

// ── Cooking Sequencer (POST /meals/:mealId/cooking-sequence) ────────────────
// WS7-8b Block 3 (Build Block 2B). Verbatim Zod mirror of the server wire —
// the route returns `{ sequence, totalEstimatedMinutes, dishCount, usedAI }`
// (cooking.ts:128-133), NOT the bare SequencedStepsResultSchema. Each entry is
// an ORDERING + ANNOTATION over steps the client already holds: it references
// the source step by (dishId, originalStepIndex) and carries NO step text /
// phase / minutes — those are joined back on the held meal detail. `reason` is
// the optional, server-composed parallel cue ("While the chicken rests, start
// the sauce"). Constraints (int / nonnegative / max 140) match sequencer.ts so
// a malformed payload is rejected in both directions (§27).

const SequencedStepSchema = z.object({
  dishId: z.string().min(1),
  originalStepIndex: z.number().int().min(0),
  sequenceIndex: z.number().int().min(0),
  startsAtMinutes: z.number().int().nonnegative(),
  // Optional inline cue shown in Cook Mode; server-composed, never client-side.
  reason: z.string().max(140).optional(),
  // Optional hard dependencies the ordering already enforces — mirrored for
  // completeness; the mobile flow consumes the linear order, not these edges.
  dependsOn: z
    .array(
      z.object({
        dishId: z.string().min(1),
        originalStepIndex: z.number().int().min(0),
      }),
    )
    .optional(),
});
export type SequencedStep = z.infer<typeof SequencedStepSchema>;

const CookingSequenceResponseSchema = z.object({
  sequence: z.array(SequencedStepSchema),
  totalEstimatedMinutes: z.number().int().positive(),
  // = meal.dishLinks.length server-side; always >= 2 on the AI path we call.
  dishCount: z.number().int().nonnegative(),
  // true on the multi-dish AI path, false on the single-dish branch (which the
  // client never reaches — it degrades to naive ordering without calling).
  usedAI: z.boolean(),
});
export type CookingSequence = z.infer<typeof CookingSequenceResponseSchema>;

/**
 * POST …/meals/:mealId/cooking-sequence — the Cooking Sequencer (PRD §13.5.4).
 * mealId travels in the PATH; there is NO request body (the server loads all
 * step data itself). Returns the intermixed execution order for a multi-dish
 * meal plus per-step parallel cues.
 *
 * Callers MUST only invoke this for genuine multi-dish meals (degrade to naive
 * ordering otherwise, §7.13) and SHOULD treat any failure as non-fatal —
 * falling back to naive ordering (§13.5.5: the Sequencer only improves order,
 * the meal always cooks). Propagates apiClient typed errors: `ApiError` (404
 * missing/non-owned, 400 empty meal, 502 AI failure, 429 rate limit),
 * `UnauthenticatedError` (401), `ApiSchemaError` on a response-shape mismatch.
 */
export async function getCookingSequence(
  mealId: string,
): Promise<CookingSequence> {
  return apiClient(`/meals/${encodeURIComponent(mealId)}/cooking-sequence`, {
    method: "POST",
    schema: CookingSequenceResponseSchema,
  });
}

// ── Prep the Week GENERATE (POST /plans/:planId/prep-week) ───────────────────
// WS7-8b Block 4 (Block 1). The GENERATE call: hands the plan to the blended
// engine + narration AI and returns the assembled 4-phase PrepWeekResult inside
// a cache envelope. This is a FAITHFUL §27 two-direction mirror of the server
// wire — the result-shape mirror replicates the server schema's constraints
// (phase count + fixed order, per-field min/max) so a malformed payload is
// rejected on the mobile side too (artifacts/api-server/src/lib/ai/schemas/
// prepWeek.ts:61-127), and the envelope mirror covers BOTH server branches:
//   - cache HIT  (cooking.ts:217-223): no `metadata`.
//   - cache MISS (cooking.ts:394-403): `metadata: { latencyMs }`.
// `metadata` (and its `latencyMs`) are therefore OPTIONAL so both parse.

// Canonical 4-phase enum, fixed order — mirrors prepWeek.ts PrepWeekPhaseKey.
const PrepWeekPhaseKeySchema = z.enum([
  "seasonings_dry",
  "sauces_marinades",
  "produce",
  "proteins",
]);
export type PrepWeekPhaseKey = z.infer<typeof PrepWeekPhaseKeySchema>;

// One combined prep step. Constraints match the server step schema exactly so
// the mobile parse accepts precisely what the server emits and nothing looser.
const PrepWeekStepSchema = z.object({
  number: z.number().int().min(1).max(50),
  // Opaque stable identity, `${phase}#${ingredientId}` (or `…#blend`); the
  // completion write-back (Block 3) keys on this. Server caps it at 80.
  stepKey: z.string().min(1).max(80),
  title: z.string().min(1).max(120),
  instructions: z.string().min(1).max(800),
  estimatedMinutes: z.number().int().min(1).max(60),
  // Destination meal ids — drives the "where each goes" rows. Real plan mealIds
  // (uuid); carries NO names/days (those need a plan-detail lookup, Block 2/3).
  contributesToMealIds: z.array(z.string().uuid()).min(1).max(20),
  storageNote: z.string().max(200).optional(),
  skipSuggested: z.boolean().optional(),
});
export type PrepWeekStep = z.infer<typeof PrepWeekStepSchema>;

const PrepWeekPhaseSchema = z.object({
  phase: PrepWeekPhaseKeySchema,
  title: z.string().min(1).max(80),
  skippable: z.boolean(),
  // A phase may be emitted with zero steps to keep the 4-phase shape stable.
  steps: z.array(PrepWeekStepSchema).min(0).max(30),
});
export type PrepWeekPhase = z.infer<typeof PrepWeekPhaseSchema>;

// Exactly 4 phases in the fixed food-safety order (proteins last). The
// superRefine mirrors the server's — so a reordered/short payload is rejected
// in BOTH directions (§27), not silently accepted.
const PrepWeekResultSchema = z
  .object({
    totalEstimatedMinutes: z.number().int().min(1).max(240),
    phases: z.array(PrepWeekPhaseSchema).length(4),
  })
  .superRefine((val, ctx) => {
    const expected: PrepWeekPhaseKey[] = [
      "seasonings_dry",
      "sauces_marinades",
      "produce",
      "proteins",
    ];
    for (let i = 0; i < 4; i++) {
      // Guard the index access: a short/over-long payload already fails the
      // .length(4) check above, but the refine still runs — so a missing phase
      // must register an issue (reject cleanly), NOT throw a TypeError. This is
      // a deliberate hardening over the server's literal refine, which never
      // sees a non-4 payload (it only validates its own assembled result).
      if (val.phases[i]?.phase !== expected[i]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["phases", i, "phase"],
          message: `phase at index ${i} must be "${expected[i]}", got "${val.phases[i]?.phase}"`,
        });
      }
    }
  });
export type PrepWeekResult = z.infer<typeof PrepWeekResultSchema>;

// The cache envelope around the result. `metadata` is optional (miss-only); its
// `latencyMs` is the only field the server sends there.
const PrepWeekEnvelopeSchema = z.object({
  cacheHit: z.boolean(),
  result: PrepWeekResultSchema,
  planRevisionId: z.number(),
  generatedAt: z.string(), // ISO-8601
  promptVersion: z.number(),
  metadata: z.object({ latencyMs: z.number() }).optional(),
});
export type PrepWeekEnvelope = z.infer<typeof PrepWeekEnvelopeSchema>;

/**
 * The result of a GENERATE attempt. A 402 (entitlement gate) is NOT a throw —
 * it surfaces as a typed, recoverable `upgrade_required` outcome so the screen
 * can show an upgrade affordance instead of crashing. The gate is inert in
 * trial today (can() stub → allowed:true), so the happy path is `ok`; this is
 * forward-compat for the Stripe phase. All OTHER failures (404 missing/non-
 * owned, 502 AI/assembly, 401, schema mismatch) still throw like every other
 * helper here — the caller catches those as hard errors.
 */
export type PrepWeekOutcome =
  | { kind: "ok"; envelope: PrepWeekEnvelope }
  | { kind: "upgrade_required"; message: string };

/**
 * POST …/plans/:planId/prep-week — generate (or cache-hit) the Prep the Week
 * structure. Returns a {@link PrepWeekOutcome}: `ok` with the parsed envelope,
 * or `upgrade_required` on a 402 (non-fatal). Propagates apiClient typed errors
 * for every other status: `ApiError` (404 missing/non-owned, 400 empty plan,
 * 502 AI/assembly failure, 429 rate limit), `UnauthenticatedError` (401),
 * `ApiSchemaError` on a response-shape mismatch.
 */
export async function getPrepWeek(planId: string): Promise<PrepWeekOutcome> {
  try {
    const envelope = await apiClient(
      `/plans/${encodeURIComponent(planId)}/prep-week`,
      { method: "POST", schema: PrepWeekEnvelopeSchema },
    );
    return { kind: "ok", envelope };
  } catch (err) {
    if (err instanceof UpgradeRequiredError) {
      return {
        kind: "upgrade_required",
        message: err.userFacingMessage ?? "Prep the Week is a Premium feature",
      };
    }
    throw err;
  }
}

// Re-export the result-shape schema for callers/tests that want to validate a
// PrepWeekResult independently of the envelope.
export { PrepWeekResultSchema, PrepWeekEnvelopeSchema };

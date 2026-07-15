// Mobile client for POST /api/wizard/build-from-text.
// WS6 6a-4 — replaces the WS5 Tell Kiwi stub with the real two-step pipeline.
// WS7-1 — migrated to apiClient + Zod validation.
//
// Response shape mirrors what the server returns: a parsedIntent (the step-1
// classification), 0-3 candidates depending on scenario, and an optional
// needsClarification block for unclear/overflow.

import { z } from "zod";

import { apiClient } from "./client";
import type { TellKiwiInput, WizardPlanCandidate } from "../types";

// ── Zod schemas ──────────────────────────────────────────────────────────

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

const NeedsClarificationSchema = z.object({
  reason: z.string(),
  options: z.array(z.string()).optional(),
});

const TellKiwiScenarioSchema = z.enum([
  "vague",
  "fully_specified",
  "partial",
  "unclear",
  "overflow",
]);

const ParsedIntentSchema = z
  .object({
    scenario: TellKiwiScenarioSchema,
    explicitMeals: z.array(z.string()),
    intentDescriptors: z.array(z.string()),
    mealCount: z.number().optional(),
    needsClarification: NeedsClarificationSchema.optional(),
  })
  .passthrough();

const BuildFromTextResponseSchema = z.object({
  candidates: z.array(WizardPlanCandidateSchema),
  parsedIntent: ParsedIntentSchema,
  needsClarification: NeedsClarificationSchema.optional(),
  cannotGenerateMore: z.boolean().optional(),
  reason: z.string().optional(),
  metadata: z
    .object({
      promptVersion: z.number().nullable(),
      latencyMs: z.number(),
      flow: z.string(),
    })
    .optional(),
});

export type TellKiwiScenario = z.infer<typeof TellKiwiScenarioSchema>;

export interface ParsedIntent {
  scenario: TellKiwiScenario;
  explicitMeals: string[];
  intentDescriptors: string[];
  mealCount?: number;
  needsClarification?: {
    reason: string;
    options?: string[];
  };
}

export interface BuildFromTextResult {
  candidates: WizardPlanCandidate[];
  parsedIntent: ParsedIntent;
  needsClarification?: { reason: string; options?: string[] };
  cannotGenerateMore?: boolean;
  reason?: string;
  metadata?: {
    promptVersion: number | null;
    latencyMs: number;
    flow: string;
  };
}

export interface BuildFromTextInput extends TellKiwiInput {
  // Optional override; defaults to 5 server-side. Mobile usually omits.
  planDurationDays?: number;
}

export async function buildFromText(
  input: BuildFromTextInput,
): Promise<BuildFromTextResult> {
  const body = await apiClient("/wizard/build-from-text", {
    method: "POST",
    body: input,
    schema: BuildFromTextResponseSchema,
  });
  return body as BuildFromTextResult;
}

/**
 * POST /api/wizard/surprise-me — WS9 3c §7.6 Surprise-me path.
 *
 * Zero-input generation: the server reads the user's stored preferences and
 * generates popular crowd-pleaser candidates from model knowledge, ALWAYS
 * within hard constraints (allergies/dietary). Returns the same
 * BuildFromTextResult shape (candidates + a synthetic `vague` parsedIntent) so
 * the wizard-results screen renders it through the existing Tell Kiwi branch
 * and R5's "Use this plan" applies unchanged.
 */
export async function buildSurprise(): Promise<BuildFromTextResult> {
  const body = await apiClient("/wizard/surprise-me", {
    method: "POST",
    schema: BuildFromTextResponseSchema,
  });
  return body as BuildFromTextResult;
}

// Mobile client for POST /api/wizard/build-from-text.
// WS9 Redesign Arc Block 2a Part B — buildSurprise (POST /wizard/surprise-me)
// DELETED with the Surprise Me entry; the server lane removes the route.
// WS6 6a-4 — replaces the WS5 Tell Kiwi stub with the real two-step pipeline.
// WS7-1 — migrated to apiClient + Zod validation.
//
// Response shape mirrors what the server returns: a parsedIntent (the step-1
// classification), 0-3 candidates depending on scenario, and an optional
// needsClarification block for unclear/overflow.

import { z } from "zod";

import { apiClient } from "./client";
import type { TellKiwiInput, WizardPlanCandidate } from "../types";
import type { WizardGenerateExtras } from "./wizard";

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
    // D-WS9-191 Block 1 — the per-meal rows (title + description | null, the
    // store id and minutes on store-bound slots), in mealTitles order. Optional:
    // a legacy batch has none. Mirrors lib/api/wizard.ts's schema — duplicated
    // here on purpose (this file keeps its own transcription).
    storeSlots: z
      .array(z.object({ slotIndex: z.number(), storeMealId: z.string() }).passthrough())
      .optional(),
    meals: z
      .array(
        z
          .object({
            title: z.string(),
            description: z.string().nullable(),
            storeMealId: z.string().optional(),
            estimatedTimeMinutes: z.number().optional(),
          })
          .passthrough(),
      )
      .optional(),
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
  /**
   * FIX-2 (Part D) — the household THIS plan was built for: the parsed "for
   * two" when the text named one, else the stepper's. Absent from a pre-FIX-2
   * server. Sizes this plan only; the profile household is never changed.
   */
  householdSize: z.number().int().min(1).max(30).optional(),
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
  /** FIX-2 (Part D) — only when the text named a number of people. */
  householdSize?: number;
  /** FIX-2 (Part D) — "nothing too spicy". */
  avoidSpicy?: boolean;
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
  /** FIX-2 (Part D) — see BuildFromTextResponseSchema. */
  householdSize?: number;
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
  // D-WS9-191 Block 2 — "Get another plan option" in Tell Kiwi mode: the SAME
  // stored body plus the session exclusion + `another` / `candidateCount: 1`
  // (lib/api/wizard.ts WizardGenerateExtras). Omitted on the first build.
  extras?: WizardGenerateExtras,
): Promise<BuildFromTextResult> {
  const body = await apiClient("/wizard/build-from-text", {
    method: "POST",
    body: extras ? { ...input, ...extras } : input,
    schema: BuildFromTextResponseSchema,
  });
  return body as BuildFromTextResult;
}

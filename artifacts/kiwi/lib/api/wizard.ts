// Mobile client for POST /api/wizard/build-plans.
// WS6 6a-3 — replaces lib/stubs.ts:getWizardPlanCandidates with a real call.
// WS7-1 — migrated to apiClient + Zod validation.

import { z } from "zod";

import { apiClient } from "./client";
import type { WizardPlanCandidate, WizardPreferencesInput } from "../types";

// ── Zod schemas ──────────────────────────────────────────────────────────
// Transcribed from artifacts/api-server/src/lib/ai/schemas/wizard.ts —
// kept mobile-side rather than imported so the mobile package stays
// independent of the api-server build. `.passthrough()` for forward-compat.

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
): Promise<BuildWizardPlansResult> {
  const body = await apiClient("/wizard/build-plans", {
    method: "POST",
    body: input,
    schema: BuildWizardPlansResponseSchema,
  });
  return body as BuildWizardPlansResult;
}

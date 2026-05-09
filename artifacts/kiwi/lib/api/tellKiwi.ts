// Mobile client for POST /api/wizard/build-from-text.
// WS6 6a-4 — replaces the WS5 Tell Kiwi stub with the real two-step pipeline.
//
// Response shape mirrors what the server returns: a parsedIntent (the step-1
// classification), 0-3 candidates depending on scenario, and an optional
// needsClarification block for unclear/overflow.

import { readToken } from "../auth";
import type { TellKiwiInput, WizardPlanCandidate } from "../types";

const apiBase =
  process.env.EXPO_PUBLIC_API_BASE_URL ||
  (process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
    : "http://localhost:3000/api");

export type TellKiwiScenario =
  | "vague"
  | "fully_specified"
  | "partial"
  | "unclear"
  | "overflow";

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
  const token = await readToken();
  if (!token) {
    throw new Error("Not authenticated");
  }
  const res = await fetch(`${apiBase}/wizard/build-from-text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === "string") detail = body.error;
    } catch {
      // body wasn't JSON; keep the HTTP-status detail
    }
    throw new Error(detail);
  }
  return (await res.json()) as BuildFromTextResult;
}

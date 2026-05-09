// Mobile client for POST /api/wizard/build-plans.
// WS6 6a-3 — replaces lib/stubs.ts:getWizardPlanCandidates with a real call.

import { readToken } from "../auth";
import type { WizardPlanCandidate, WizardPreferencesInput } from "../types";

const apiBase =
  process.env.EXPO_PUBLIC_API_BASE_URL ||
  (process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
    : "http://localhost:3000/api");

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
  const token = await readToken();
  if (!token) {
    throw new Error("Not authenticated");
  }
  const res = await fetch(`${apiBase}/wizard/build-plans`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    // Server returns a Kiwi-styled message in `error` for 502 (AI failure)
    // and 402 (entitlement). Surface that to the React Query mutation.
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === "string") detail = body.error;
    } catch {
      // body wasn't JSON; keep the HTTP-status detail
    }
    throw new Error(detail);
  }
  return (await res.json()) as BuildWizardPlansResult;
}

// Plan-Gen Arc Block 4b-3 (D-WS9-072) — "See Previous Options" decision + param
// helpers, pinned here as pure functions so the link's show/hide rule and its
// wizard-results rehydrate navigation are testable without rendering the screen.

import type { WizardLastBatch } from "../api/wizard";

/**
 * Whether the "See Previous Options" link should render. Hidden when the user
 * has no batch (most new users) or a degenerate empty batch — the link is an
 * assist, never a blocker.
 */
export function shouldShowPreviousOptions(
  batch: WizardLastBatch | null | undefined,
): boolean {
  return !!batch && batch.candidates.length > 0;
}

/**
 * Build the wizard-results route params that re-show a stored batch WITHOUT a
 * generate call (`rehydrate:"1"` + the candidates JSON). Params branch on
 * `source` so the "Use this plan" expand can rebuild candidateContext:
 *   - wizard   → replay the WizardPreferencesInput slice as `input`
 *   - tellkiwi → replay the TellKiwiInput slice as `tellKiwiInput`
 *   - surprise → no input; wizard-results re-derives context from stored prefs
 *
 * Candidates are serialized VERBATIM, so a rehydrated candidate carries the same
 * title + mealTitles as when generated — which is exactly what makes its
 * server-side content hash match, so re-expanding it reuses the existing draft
 * (a DB read, not an AI call).
 */
export function buildRehydrateParams(
  batch: WizardLastBatch,
): Record<string, string> {
  const base = {
    rehydrate: "1",
    rehydratedCandidates: JSON.stringify(batch.candidates),
  };
  if (batch.source === "tellkiwi") {
    return {
      ...base,
      source: "tellkiwi",
      ...(batch.input ? { tellKiwiInput: JSON.stringify(batch.input) } : {}),
    };
  }
  if (batch.source === "surprise") {
    return { ...base, source: "surprise" };
  }
  return {
    ...base,
    ...(batch.input ? { input: JSON.stringify(batch.input) } : {}),
  };
}

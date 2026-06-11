// WS7-6 G1 — Mode A "Ask Kiwi" submit orchestrator.
//
// Pulled out of the screen so the parse → adapt → navigate / error-route logic
// is unit-testable WITHOUT mocking expo-router or the apiClient (the harness's
// no-module-mocking constraint — Block 4's container/view split is the
// precedent). The screen injects the real `parseMeal` + navigation closures;
// tests inject fakes.
//
// Error routing mirrors how Import-from-Text handles its equivalents, mapped to
// parse-meal's typed errors (lib/api/client.ts):
//   - 402 UpgradeRequiredError → route to the upgrade modal (the UI stays
//     ungated pre-submit; the server's 402 is the gate, PRD §1.2 trial-mode).
//   - 502 ApiError (ai_failed) → friendly retryable message; the caller keeps
//     the typed text intact (we never signal "clear input").
//   - transport / unknown → same retryable treatment.

import type { ParseMealInput, ParseMealResult } from "@/lib/api/builder";
import { ApiError, UpgradeRequiredError } from "@/lib/api/errors";

import { parsedMealToDraft } from "./parsedMealToDraft";

export const ASK_KIWI_AI_FAILED_MESSAGE =
  "Kiwi couldn't turn that into a meal. Tweak your description and try again.";

export interface AskKiwiSubmitDeps {
  /** Real impl: parseMeal from lib/api/builder. */
  parseMeal: (
    input: ParseMealInput,
    opts?: { signal?: AbortSignal },
  ) => Promise<ParseMealResult>;
  /** Real impl: router.push("/meal-builder", { draftSource, draftJson, … }). */
  navigateToDraft: (draftJson: string) => void;
  /** Real impl: router.push("/upgrade"). */
  routeToUpgrade: () => void;
}

export type AskKiwiSubmitOutcome =
  | { status: "success" }
  | { status: "upgrade" }
  | { status: "error"; message: string };

/**
 * Run a Mode A free-text parse and route the result. Never throws — every
 * failure path resolves to a typed outcome the screen renders. On any error
 * the screen leaves the user's typed text untouched (parse failures are
 * retryable in place).
 */
export async function runAskKiwiSubmit(
  args: { freeText: string; servings: number },
  deps: AskKiwiSubmitDeps,
): Promise<AskKiwiSubmitOutcome> {
  try {
    const { meal } = await deps.parseMeal({
      freeText: args.freeText,
      servings: args.servings,
    });
    const draft = parsedMealToDraft(meal);
    deps.navigateToDraft(JSON.stringify(draft));
    return { status: "success" };
  } catch (err) {
    // UpgradeRequiredError extends ApiError — check it FIRST.
    if (err instanceof UpgradeRequiredError) {
      deps.routeToUpgrade();
      return { status: "upgrade" };
    }
    if (err instanceof ApiError) {
      // 502 ai_failed (and any other non-2xx) → friendly retryable. The
      // server's parse-meal failure body carries no user-facing copy, so we
      // use our own message rather than echo a raw "Request failed (502)".
      return { status: "error", message: ASK_KIWI_AI_FAILED_MESSAGE };
    }
    // ApiNetworkError / anything unexpected — retryable, same treatment.
    return { status: "error", message: ASK_KIWI_AI_FAILED_MESSAGE };
  }
}

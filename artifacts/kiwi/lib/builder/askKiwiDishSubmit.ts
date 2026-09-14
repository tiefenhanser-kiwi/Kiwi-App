// WS7-6 G2 — Dish Mode A "Ask Kiwi" submit orchestrator.
//
// The dish twin of askKiwiSubmit.ts. Pulled out of the screen so the
// parse → adapt → navigate / error-route logic is unit-testable WITHOUT
// mocking expo-router or the apiClient. The screen injects the real
// `parseDish` + navigation closures; tests inject fakes.
//
// Error routing mirrors askKiwiSubmit, mapped to parse-dish's typed errors:
//   - 402 UpgradeRequiredError → route to the upgrade modal.
//   - 429/503 ApiError with a spend-guard `reason` (D-WS9-241 D) → the
//     server's copy VERBATIM; keyed on reason, not status.
//   - 502 ApiError (ai_failed) → friendly retryable message; input kept.
//   - transport / unknown → same retryable treatment.

import type { ParseDishInput, ParseDishResult } from "@/lib/api/builder";
import {
  ApiError,
  UpgradeRequiredError,
  spendGuardRefusal,
} from "@/lib/api/errors";

import { parsedDishToDraft } from "./parsedDishToDraft";

export const ASK_KIWI_DISH_AI_FAILED_MESSAGE =
  "Kiwi couldn't turn that into a dish. Tweak your description and try again.";

export interface AskKiwiDishSubmitDeps {
  /** Real impl: parseDish from lib/api/builder. */
  parseDish: (
    input: ParseDishInput,
    opts?: { signal?: AbortSignal },
  ) => Promise<ParseDishResult>;
  /** Real impl: router.push("/dish-builder", { draftJson, … }). */
  navigateToDraft: (draftJson: string) => void;
  /** Real impl: router.push("/upgrade"). */
  routeToUpgrade: () => void;
}

export type AskKiwiDishSubmitOutcome =
  | { status: "success" }
  | { status: "upgrade" }
  | { status: "error"; message: string };

/**
 * Run a Dish Mode A free-text parse and route the result. Never throws — every
 * failure path resolves to a typed outcome the screen renders. On any error
 * the screen leaves the user's typed text untouched (parse failures are
 * retryable in place).
 */
export async function runAskKiwiDishSubmit(
  args: { freeText: string; servings: number },
  deps: AskKiwiDishSubmitDeps,
): Promise<AskKiwiDishSubmitOutcome> {
  try {
    const { dish } = await deps.parseDish({
      freeText: args.freeText,
      servings: args.servings,
    });
    const draft = parsedDishToDraft(dish);
    deps.navigateToDraft(JSON.stringify(draft));
    return { status: "success" };
  } catch (err) {
    // UpgradeRequiredError extends ApiError — check it FIRST.
    if (err instanceof UpgradeRequiredError) {
      deps.routeToUpgrade();
      return { status: "upgrade" };
    }
    if (err instanceof ApiError) {
      // A spend-guard refusal says WHAT happened — render it, don't replace it.
      const refusal = spendGuardRefusal(err.body);
      if (refusal) return { status: "error", message: refusal.message };
      return { status: "error", message: ASK_KIWI_DISH_AI_FAILED_MESSAGE };
    }
    return { status: "error", message: ASK_KIWI_DISH_AI_FAILED_MESSAGE };
  }
}

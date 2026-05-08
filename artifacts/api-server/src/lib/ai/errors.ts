// WS6 AI orchestrator — failure-reason → user-facing copy mapping.
// Per PRD §1.11: never surface technical errors to the user.
// Per kiwi_ws6_plan.md §3 6a-1.

export type AICallFailureReason =
  | "no_api_key"
  | "sdk_error"
  | "validation_failed"
  | "parse_failed"
  | "rate_limited";

const KIWI_DISTRACTED = "Kiwi got distracted. Try again?";
const RATE_LIMITED =
  "Take a moment to consider these plans before generating new ones.";

export function userFacingMessage(reason: AICallFailureReason): string {
  switch (reason) {
    case "rate_limited":
      return RATE_LIMITED;
    case "no_api_key":
    case "sdk_error":
    case "validation_failed":
    case "parse_failed":
      return KIWI_DISTRACTED;
  }
}

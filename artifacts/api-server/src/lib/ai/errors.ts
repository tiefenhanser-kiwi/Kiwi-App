// WS6 AI orchestrator — failure-reason → user-facing copy mapping.
// Per PRD §1.11: never surface technical errors to the user.
// Per kiwi_ws6_plan.md §3 6a-1.
//
// D-WS9-240 — three spend-guard refusal reasons (lib/spendGuard.ts) and the
// HTTP status mapping routes apply at their `status(502)` sites.

import {
  AI_DISABLED_RETRY_AFTER_SECONDS,
  secondsUntilNextUtcDay,
} from "../spendGuard";

export type AICallFailureReason =
  | "no_api_key"
  | "sdk_error"
  | "validation_failed"
  | "parse_failed"
  | "rate_limited"
  // D-WS9-240 — spend guard. None of these reached Anthropic and none wrote
  // an LLMCallLog row.
  | "ai_disabled"
  | "spend_cap_global"
  | "spend_cap_user";

const KIWI_DISTRACTED = "Kiwi got distracted. Try again?";
const RATE_LIMITED =
  "Take a moment to consider these plans before generating new ones.";
// D-WS9-240 copy. Deliberately NOT D-WS9-229's rate-limit sentence ("Kiwi
// seems to be missing the mark…") — that one is about generation quality.
export const SPEND_CAP_USER_COPY =
  "You've reached today's planning limit — Kiwi will be ready to plan again tomorrow.";
export const AI_UNAVAILABLE_COPY =
  "Kiwi is taking a short break. Please try again in a little while.";

export function userFacingMessage(reason: AICallFailureReason): string {
  switch (reason) {
    case "rate_limited":
      return RATE_LIMITED;
    case "spend_cap_user":
      return SPEND_CAP_USER_COPY;
    case "spend_cap_global":
    case "ai_disabled":
      return AI_UNAVAILABLE_COPY;
    case "no_api_key":
    case "sdk_error":
    case "validation_failed":
    case "parse_failed":
      return KIWI_DISTRACTED;
  }
}

// ── HTTP mapping (D-WS9-240) ─────────────────────────────────────────
//
// Routes that surface an AICallFailure answered 502 for every reason. A spend
// refusal is not an upstream failure: the per-user cap is the caller's own
// quota (429) and the global ceiling / kill switch is "come back later" (503).
// Both carry Retry-After. Everything else keeps 502.
//
// errorHandler is NOT the place for this — it honours only thrown 4xx and
// drops the body copy (Phase 0 §2.2); every AI route branches on
// `result.success` itself, so the mapping is applied at those sites.

export interface AIFailureHttp {
  status: 502 | 429 | 503;
  retryAfterSeconds?: number;
}

export type SpendGuardFailureReason = Extract<
  AICallFailureReason,
  "ai_disabled" | "spend_cap_global" | "spend_cap_user"
>;

const SPEND_GUARD_REASONS: ReadonlySet<string> = new Set<SpendGuardFailureReason>([
  "ai_disabled",
  "spend_cap_global",
  "spend_cap_user",
]);

// The fan-out helpers (wizardExpansion / wizardFinalize) wrap a per-meal
// failure's reason into a composite `meal_failed:…` string. They must let a
// spend-guard reason through unwrapped so the route can map its status.
export function isSpendGuardReason(
  reason: string,
): reason is SpendGuardFailureReason {
  return SPEND_GUARD_REASONS.has(reason);
}

// `reason` is typed `string`, not AICallFailureReason: the expansion/finalize
// helpers hand routes composite strings, and anything unrecognised is 502.
export function aiFailureStatus(
  reason: string,
  now: Date = new Date(),
): AIFailureHttp {
  switch (reason) {
    case "spend_cap_user":
      return { status: 429, retryAfterSeconds: secondsUntilNextUtcDay(now) };
    case "spend_cap_global":
      return { status: 503, retryAfterSeconds: secondsUntilNextUtcDay(now) };
    case "ai_disabled":
      return { status: 503, retryAfterSeconds: AI_DISABLED_RETRY_AFTER_SECONDS };
    default:
      return { status: 502 };
  }
}

// Structural over express.Response so this module stays framework-free.
interface StatusCapable {
  status(code: number): this;
  setHeader(name: string, value: string): unknown;
}

// `return withAIFailureStatus(res, result.reason).json({...})` — drop-in for
// `return res.status(502).json({...})`.
export function withAIFailureStatus<R extends StatusCapable>(
  res: R,
  reason: string,
  now: Date = new Date(),
): R {
  const http = aiFailureStatus(reason, now);
  if (http.retryAfterSeconds != null) {
    res.setHeader("Retry-After", String(http.retryAfterSeconds));
  }
  return res.status(http.status);
}

// Sonnet 5.5 side-by-side (measure-only lane) — the per-call model override and
// the request shape a model needs. Shared by both Anthropic doors (runAICall +
// streamPlanCandidates).
//
// AI_MODEL_OVERRIDE_SONNET (dev-only): when set, a call whose resolved model is
// MODEL_SONNET runs on the override instead, and LLMCallLog.model records the
// override (the doors log the model this returns). Read at CALL time, not at
// import, so a probe can flip it between runs. Unset → the configured model,
// unchanged.
//
// ⚠️ A model-string swap alone fails EVERY Kiwi call on claude-sonnet-5-5
// (measured, scripts/_scratch/sonnet55/p0-out.txt, SDK 0.90.0):
//   - `temperature` → 400 "`temperature` is deprecated for this model."
//   - tool_choice {type:"tool"} → 400 "type "tool" and "any" are not supported".
// So a model in NO_SAMPLING_NO_FORCED_TOOL gets: no temperature, tool_choice
// auto plus a one-line instruction naming the tool, and a thinking mode. Every
// other model keeps today's shape byte for byte.

import { MODEL_SONNET } from "./promptRegistry";

const NO_SAMPLING_NO_FORCED_TOOL: ReadonlySet<string> = new Set(["claude-sonnet-5-5"]);

export function resolveCallModel(configured: string): string {
  const override = process.env.AI_MODEL_OVERRIDE_SONNET?.trim();
  return override && configured === MODEL_SONNET ? override : configured;
}

export interface ModelRequestShape {
  // false → omit `temperature` from the request entirely.
  sendsTemperature: boolean;
  // false → tool_choice {type:"auto"} + toolInstruction appended to the user
  // message (auto does not guarantee a call; a missing tool_use block is an
  // extraction failure, which runAICall already retries).
  forcesToolChoice: boolean;
  // Spread into the request when present. `between_tools` is how thinking is
  // turned OFF on claude-sonnet-5-5 (`disabled` is a 400 there).
  thinking?: { type: "between_tools" };
}

export const LEGACY_SHAPE: ModelRequestShape = {
  sendsTemperature: true,
  forcesToolChoice: true,
};

// 🔴 Part J.0 (D1) — THINKING OFF IS THE CODED DEFAULT for claude-sonnet-5-5.
// Omitting `thinking` on that model runs ADAPTIVE thinking, and the compare lane
// measured what that does to Kiwi's calls (scripts/_scratch/sonnet55/p5-out.md):
// 0/3 set_preferences and 0/1 directed.generate passed (every one max_tokens),
// prep.narrate_steps output 2.1× and cost 1.5× the thinking-off arm. So a DB row
// flipped to claude-sonnet-5-5 must never, by itself, produce adaptive thinking.
// AI_SONNET55_THINKING=adaptive is the only way back to the model default; any
// other value (unset included) sends between_tools.
export function requestShapeForModel(model: string): ModelRequestShape {
  if (!NO_SAMPLING_NO_FORCED_TOOL.has(model)) return LEGACY_SHAPE;
  const adaptive = process.env.AI_SONNET55_THINKING?.trim() === "adaptive";
  return {
    sendsTemperature: false,
    forcesToolChoice: false,
    ...(adaptive ? {} : { thinking: { type: "between_tools" as const } }),
  };
}

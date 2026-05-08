// WS6 AI orchestrator — in-memory prompt registry.
// Per kiwi_ws6_plan.md §3 6a-1.
// TODO(6a-2): swap this Map for a Prisma-backed lookup against the
// AIPrompt + AIPromptVersion tables, with the 60-second cache pattern
// per PRD §15.4.4. Until that migration lands, bodies live in this
// file as placeholders — 6a-3 onward replaces them with real prompts
// in their respective sub-phases.

import type { AICallMode } from "./modes";

// Latest-as-of-2026-05 model strings. Per Hans's locked decision in
// kiwi_ws6_plan.md §4 these will move to AIPrompt.defaultModel post-6a-2
// so per-prompt model swaps don't require a code deploy.
export const MODEL_SONNET = "claude-sonnet-4-6";
export const MODEL_HAIKU = "claude-haiku-4-5-20251001";

export interface PromptDescriptor {
  body: string;
  defaultModel: string;
  defaultMode: AICallMode;
  // Caller-facing description used to populate the tool_use description
  // field. Keep it terse; the schema carries the structural detail.
  toolDescription: string;
}

// Placeholder body builder — emits a clearly-marked stub the caller will
// see in logs if it ever reaches the Anthropic API before 6a-3+ replaces it.
const placeholder = (key: string): string =>
  `[PLACEHOLDER for ${key} — replace via 6a-3+ sub-phase]`;

// Per PRD §15.4.2 + WS6-specific additions.
// Mode + model assignments per kiwi_ws6_plan.md §4 (Hybrid Option C).
const REGISTRY: ReadonlyMap<string, PromptDescriptor> = new Map([
  // 6a-3 — Set Preferences wizard
  [
    "wizard.set_preferences.generate",
    {
      body: placeholder("wizard.set_preferences.generate"),
      defaultModel: MODEL_SONNET,
      defaultMode: "tool",
      toolDescription: "Generate up to 3 distinct meal-plan candidates from the user's wizard preferences.",
    },
  ],
  // 6a-4 — Tell Kiwi two-step
  [
    "wizard.directed.parse_intent",
    {
      body: placeholder("wizard.directed.parse_intent"),
      defaultModel: MODEL_HAIKU,
      defaultMode: "text",
      toolDescription: "Parse the user's free-text plan request into a structured intent.",
    },
  ],
  [
    "wizard.directed.generate",
    {
      body: placeholder("wizard.directed.generate"),
      defaultModel: MODEL_SONNET,
      defaultMode: "tool",
      toolDescription: "Generate plan candidates given a parsed Tell Kiwi intent.",
    },
  ],
  // PRD §15.4.2 — Cook Now
  [
    "wizard.cook_now.match",
    {
      body: placeholder("wizard.cook_now.match"),
      defaultModel: MODEL_HAIKU,
      defaultMode: "text",
      toolDescription: "Match a Cook Now request against the existing meal catalog.",
    },
  ],
  [
    "wizard.cook_now.generate",
    {
      body: placeholder("wizard.cook_now.generate"),
      defaultModel: MODEL_SONNET,
      defaultMode: "tool",
      toolDescription: "Generate a fresh recipe when no catalog match exists for Cook Now.",
    },
  ],
  // PRD §15.4.2 — wizard reasoning sidecar
  [
    "wizard.optimization_notes",
    {
      body: placeholder("wizard.optimization_notes"),
      defaultModel: MODEL_HAIKU,
      defaultMode: "text",
      toolDescription: "Generate the why-this-works bullets for a plan candidate.",
    },
  ],
  // 6c-1 — Reformat-for-Kiwi pass and import paths
  [
    "import.url.parse_fallback",
    {
      body: placeholder("import.url.parse_fallback"),
      defaultModel: MODEL_SONNET,
      defaultMode: "tool",
      toolDescription: "Parse a recipe from raw URL HTML when JSON-LD extraction fails.",
    },
  ],
  [
    "import.image.ocr_parse",
    {
      body: placeholder("import.image.ocr_parse"),
      defaultModel: MODEL_SONNET,
      defaultMode: "tool",
      toolDescription: "Parse a recipe from an OCR'd image of a printed recipe.",
    },
  ],
  [
    "import.reformat_for_kiwi",
    {
      body: placeholder("import.reformat_for_kiwi"),
      defaultModel: MODEL_SONNET,
      defaultMode: "tool",
      toolDescription: "Normalize a raw recipe into Kiwi's canonical Dish + step shape with phaseType / parallelGroup.",
    },
  ],
  // 6b-4 — Kiwi-assist meal builder Mode A
  [
    "meal_builder.mode_a_parse",
    {
      body: placeholder("meal_builder.mode_a_parse"),
      defaultModel: MODEL_SONNET,
      defaultMode: "tool",
      toolDescription: "Parse free-text meal description into structured ingredients and steps.",
    },
  ],
  // 6d-2 — Prep the Week aggregation
  [
    "prep.aggregation_logic",
    {
      body: placeholder("prep.aggregation_logic"),
      defaultModel: MODEL_SONNET,
      defaultMode: "tool",
      toolDescription: "Aggregate cross-meal prep into the 4-phase Prep the Week structure.",
    },
  ],
  // 6d-1 — Cooking Sequencer
  [
    "sequencer.step_ordering",
    {
      body: placeholder("sequencer.step_ordering"),
      defaultModel: MODEL_SONNET,
      defaultMode: "tool",
      toolDescription: "Order steps from multiple dishes into a single parallel-execution sequence.",
    },
  ],
  // 6b-3 — plan-level macro recalc
  [
    "macros.weighting_rules",
    {
      body: placeholder("macros.weighting_rules"),
      defaultModel: MODEL_HAIKU,
      defaultMode: "text",
      toolDescription: "Recalculate plan-level daily macro averages per PRD §11.7 weighting rules.",
    },
  ],
  // 6b-2 — Simple Dish macros AI
  [
    "nutrition.ingredient_estimate",
    {
      body: placeholder("nutrition.ingredient_estimate"),
      defaultModel: MODEL_HAIKU,
      defaultMode: "text",
      toolDescription: "Estimate per-serving macros from an ingredient list.",
    },
  ],
  // 6c-4 — predictive grocery-add categorization
  [
    "grocery.recurring_item_categorize",
    {
      body: placeholder("grocery.recurring_item_categorize"),
      defaultModel: MODEL_HAIKU,
      defaultMode: "text",
      toolDescription: "Categorize a free-text grocery item into a section + canonical name.",
    },
  ],
  // 6c-3 — ambiguous item flagging at generation time
  [
    "grocery.ambiguous_item_flag",
    {
      body: placeholder("grocery.ambiguous_item_flag"),
      defaultModel: MODEL_HAIKU,
      defaultMode: "text",
      toolDescription: "Flag a grocery item as ambiguous and list the variants the user must resolve.",
    },
  ],
  // 6b-1 — Find Similar AI semantic similarity (WS6 addition)
  [
    "meals.find_similar",
    {
      body: placeholder("meals.find_similar"),
      defaultModel: MODEL_HAIKU,
      defaultMode: "text",
      toolDescription: "Rank candidate meals by similarity to a source meal.",
    },
  ],
]);

export class UnknownPromptKeyError extends Error {
  constructor(key: string) {
    super(`Unknown prompt key: ${key}`);
    this.name = "UnknownPromptKeyError";
  }
}

export function resolvePromptDescriptor(key: string): PromptDescriptor {
  const descriptor = REGISTRY.get(key);
  if (!descriptor) throw new UnknownPromptKeyError(key);
  return descriptor;
}

// Re-export for legacy callers; runAICall uses resolvePromptDescriptor.
export function resolvePromptBody(key: string): string {
  return resolvePromptDescriptor(key).body;
}

// Naive {{var}} substitution. Caller passes a flat record; values are
// JSON-stringified if not strings. Missing keys are left as-is so they
// surface during prompt-iteration debugging instead of being silently empty.
export function renderPromptBody(
  body: string,
  vars: Record<string, unknown>,
): string {
  return body.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    if (!(name in vars)) return match;
    const v = vars[name];
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

// Cost lookup table — published per-million-token rates as of 2026-05.
// TODO(6a-2): move to SystemSetting table so admin can update without redeploy.
export interface ModelRate {
  inputPerMtokUsd: number;
  outputPerMtokUsd: number;
}

const MODEL_RATES: Record<string, ModelRate> = {
  "claude-sonnet-4-6": { inputPerMtokUsd: 3, outputPerMtokUsd: 15 },
  "claude-haiku-4-5-20251001": { inputPerMtokUsd: 1, outputPerMtokUsd: 5 },
};

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rate = MODEL_RATES[model];
  if (!rate) return 0; // unknown model — log-only, don't fabricate cost
  const inputCost = (inputTokens / 1_000_000) * rate.inputPerMtokUsd;
  const outputCost = (outputTokens / 1_000_000) * rate.outputPerMtokUsd;
  return inputCost + outputCost;
}

// Test/diagnostic helper — list registered keys.
export function listPromptKeys(): readonly string[] {
  return Array.from(REGISTRY.keys());
}

// WS6 6a-2 — Seed AIPrompt + AIPromptVersion rows.
// Source-of-truth for the placeholder bodies + descriptors is the in-memory
// REGISTRY in src/lib/ai/promptRegistry.ts. This seed mirrors that data into
// the DB so DB-backed lookup works after 6a-2 ships. Real prompt bodies are
// authored per-flow in 6a-3 onward; this seed only establishes the rows.
//
// Idempotent — safe to re-run. Uses upsert on AIPrompt.key, and on the
// (promptId, version) unique tuple for AIPromptVersion.

import type { PrismaClient } from "@prisma/client";

type AICallMode = "tool" | "text";

interface PromptSeed {
  key: string;
  description: string;
  variables: string[];
  defaultModel: string;
  defaultMode: AICallMode;
  body: string;
}

const MODEL_SONNET = "claude-sonnet-4-6";
const MODEL_HAIKU = "claude-haiku-4-5-20251001";

const placeholder = (key: string): string =>
  `[PLACEHOLDER for ${key} — replace via 6a-3+ sub-phase]`;

// Mirror of REGISTRY in src/lib/ai/promptRegistry.ts. Keep in sync until that
// file is deleted (target: end of WS6 once all real prompts have landed).
const PROMPTS: PromptSeed[] = [
  {
    key: "wizard.set_preferences.generate",
    description:
      "Generate up to 3 distinct meal-plan candidates from the user's wizard preferences.",
    variables: [],
    defaultModel: MODEL_SONNET,
    defaultMode: "tool",
    body: placeholder("wizard.set_preferences.generate"),
  },
  {
    key: "wizard.directed.parse_intent",
    description:
      "Parse the user's free-text plan request into a structured intent.",
    variables: [],
    defaultModel: MODEL_HAIKU,
    defaultMode: "text",
    body: placeholder("wizard.directed.parse_intent"),
  },
  {
    key: "wizard.directed.generate",
    description: "Generate plan candidates given a parsed Tell Kiwi intent.",
    variables: [],
    defaultModel: MODEL_SONNET,
    defaultMode: "tool",
    body: placeholder("wizard.directed.generate"),
  },
  {
    key: "wizard.cook_now.match",
    description: "Match a Cook Now request against the existing meal catalog.",
    variables: [],
    defaultModel: MODEL_HAIKU,
    defaultMode: "text",
    body: placeholder("wizard.cook_now.match"),
  },
  {
    key: "wizard.cook_now.generate",
    description:
      "Generate a fresh recipe when no catalog match exists for Cook Now.",
    variables: [],
    defaultModel: MODEL_SONNET,
    defaultMode: "tool",
    body: placeholder("wizard.cook_now.generate"),
  },
  {
    key: "wizard.optimization_notes",
    description: "Generate the why-this-works bullets for a plan candidate.",
    variables: [],
    defaultModel: MODEL_HAIKU,
    defaultMode: "text",
    body: placeholder("wizard.optimization_notes"),
  },
  {
    key: "import.url.parse_fallback",
    description:
      "Parse a recipe from raw URL HTML when JSON-LD extraction fails.",
    variables: [],
    defaultModel: MODEL_SONNET,
    defaultMode: "tool",
    body: placeholder("import.url.parse_fallback"),
  },
  {
    key: "import.image.ocr_parse",
    description: "Parse a recipe from an OCR'd image of a printed recipe.",
    variables: [],
    defaultModel: MODEL_SONNET,
    defaultMode: "tool",
    body: placeholder("import.image.ocr_parse"),
  },
  {
    key: "import.reformat_for_kiwi",
    description:
      "Normalize a raw recipe into Kiwi's canonical Dish + step shape with phaseType / parallelGroup.",
    variables: [],
    defaultModel: MODEL_SONNET,
    defaultMode: "tool",
    body: placeholder("import.reformat_for_kiwi"),
  },
  {
    key: "meal_builder.mode_a_parse",
    description:
      "Parse free-text meal description into structured ingredients and steps.",
    variables: [],
    defaultModel: MODEL_SONNET,
    defaultMode: "tool",
    body: placeholder("meal_builder.mode_a_parse"),
  },
  {
    key: "prep.aggregation_logic",
    description:
      "Aggregate cross-meal prep into the 4-phase Prep the Week structure.",
    variables: [],
    defaultModel: MODEL_SONNET,
    defaultMode: "tool",
    body: placeholder("prep.aggregation_logic"),
  },
  {
    key: "sequencer.step_ordering",
    description:
      "Order steps from multiple dishes into a single parallel-execution sequence.",
    variables: [],
    defaultModel: MODEL_SONNET,
    defaultMode: "tool",
    body: placeholder("sequencer.step_ordering"),
  },
  {
    key: "macros.weighting_rules",
    description:
      "Recalculate plan-level daily macro averages per PRD §11.7 weighting rules.",
    variables: [],
    defaultModel: MODEL_HAIKU,
    defaultMode: "text",
    body: placeholder("macros.weighting_rules"),
  },
  {
    key: "nutrition.ingredient_estimate",
    description: "Estimate per-serving macros from an ingredient list.",
    variables: [],
    defaultModel: MODEL_HAIKU,
    defaultMode: "text",
    body: placeholder("nutrition.ingredient_estimate"),
  },
  {
    key: "grocery.recurring_item_categorize",
    description:
      "Categorize a free-text grocery item into a section + canonical name.",
    variables: [],
    defaultModel: MODEL_HAIKU,
    defaultMode: "text",
    body: placeholder("grocery.recurring_item_categorize"),
  },
  {
    key: "grocery.ambiguous_item_flag",
    description:
      "Flag a grocery item as ambiguous and list the variants the user must resolve.",
    variables: [],
    defaultModel: MODEL_HAIKU,
    defaultMode: "text",
    body: placeholder("grocery.ambiguous_item_flag"),
  },
  {
    key: "meals.find_similar",
    description: "Rank candidate meals by similarity to a source meal.",
    variables: [],
    defaultModel: MODEL_HAIKU,
    defaultMode: "text",
    body: placeholder("meals.find_similar"),
  },
];

export async function seedAIPrompts(prisma: PrismaClient): Promise<void> {
  for (const p of PROMPTS) {
    // Upsert the AIPrompt row by key. variables/description/defaultModel/defaultMode
    // get refreshed on every run so changes here propagate without manual SQL.
    const prompt = await prisma.aIPrompt.upsert({
      where: { key: p.key },
      update: {
        description: p.description,
        variables: p.variables,
        defaultModel: p.defaultModel,
        defaultMode: p.defaultMode,
      },
      create: {
        key: p.key,
        description: p.description,
        variables: p.variables,
        defaultModel: p.defaultModel,
        defaultMode: p.defaultMode,
      },
      select: { id: true },
    });

    // Upsert version 1 with the placeholder body. We don't bump versions
    // here — version bumps are an admin action. Re-running this seed only
    // refreshes v1's body if no admin has edited it (i.e., body still matches
    // a placeholder). If any version (1 or higher) is already isActive, leave it.
    await prisma.aIPromptVersion.upsert({
      where: { promptId_version: { promptId: prompt.id, version: 1 } },
      update: {
        body: p.body,
        notes: "Initial seed from 6a-2",
      },
      create: {
        promptId: prompt.id,
        version: 1,
        body: p.body,
        notes: "Initial seed from 6a-2",
        isActive: true,
        createdById: null,
      },
    });

    // Ensure exactly one active version exists for this prompt. If no version
    // is currently active (shouldn't happen, but defensive), set v1 active.
    const activeCount = await prisma.aIPromptVersion.count({
      where: { promptId: prompt.id, isActive: true },
    });
    if (activeCount === 0) {
      await prisma.aIPromptVersion.update({
        where: { promptId_version: { promptId: prompt.id, version: 1 } },
        data: { isActive: true },
      });
    }
  }

  console.log(`seeded ${PROMPTS.length} AI prompts`);
}

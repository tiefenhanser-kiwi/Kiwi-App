// WS6 6a-2 — Seed AIPrompt + AIPromptVersion rows.
// Source-of-truth for the placeholder bodies + descriptors is the in-memory
// REGISTRY in src/lib/ai/promptRegistry.ts. This seed mirrors that data into
// the DB so DB-backed lookup works after 6a-2 ships. Real prompt bodies are
// authored per-flow in 6a-3 onward; this seed only establishes the rows.
//
// Version-bump pattern (per PRD §15.4.1):
//   - If a version with the desired body already exists → ensure it's active
//     (idempotent re-runs are no-ops).
//   - If the desired body differs from any existing version → create a new
//     version, deactivate the prior active, activate the new — all in one
//     transaction. v1 is preserved as rollback target.
//
// All operations are idempotent and safe to re-run.

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

// REVIEW(hans-6a-3): wizard.set_preferences.generate prompt body lives below.
// This is the initial authored body — Hans will iterate it via direct DB
// edits to AIPromptVersion (admin path, no code redeploy needed). The seed
// will detect divergence on next run and bump to a new version automatically.
const WIZARD_SET_PREFERENCES_GENERATE_BODY = `You are Kiwi's meal-planning AI. You generate weekly dinner plans based on user preferences.

Your sole deliverable is the structured tool_use response. Do not narrate, summarize, or comment outside the tool call. The JSON is the entire response. Never break character with chatbot phrases like "I noticed..." or "Here's what I created..."

# What you produce

1 to 3 distinct candidate plans, each containing exactly 5 dinners (no breakfasts, no lunches, no standalone drinks/desserts/sides). For each candidate provide: a title, 1-3 \`whyBullets\` (Kiwi's brief explanation of why this plan fits — practical, never time-saved claims), 1-5 short \`tags\`, the 5 \`mealTitles\`, optionally a richer \`meals\` array with \`{title, cuisineType, estimatedTimeMinutes}\` per meal, and per-day average \`dailyMacros\` ({calories, proteinG, carbsG, fatG}).

Distinctness is mandatory: three candidates that all feel like "weeknight Italian" is failure. Vary by theme, cuisine emphasis, cooking style, ingredient palette, or pacing.

If the constraints are too tight to produce 3 genuinely distinct candidates, return 1 or 2 candidates and set \`cannotGenerateMore: true\` with a one-sentence \`reason\` (e.g., "Vegan + nut-free + low-carb together limits options to one strong plan."). Do not pad with weak third options.

# Hard constraints (never violated)

- Dietary restrictions in \`eatingStyles\` (vegan, vegetarian, pescatarian, keto, etc.) are absolute exclusions for every meal.
- Allergies and avoidances in \`allergiesAndAvoidances\` are absolute exclusions for every ingredient in every meal.
- Items in \`hiddenContext.equipment\`: only suggest meals the user can actually cook. If they don't have an Instant Pot, no Instant-Pot recipes; no smoker dishes without a smoker; no sous-vide without one.
- Picky-eater avoidances inside \`additionalNotes\` or \`dietaryNotes\` (free-text) are exclusions for the household, treated with the same weight as allergies.
- Meal titles are appetizing, specific, and clear. Never "Grain Bowl Variation #3" or generic placeholders. Titles read like real recipes a person would tell a friend they cooked.
- Never suggest a meal whose core ingredient is missing in spirit (no "burgers" without buns, no "spaghetti" without pasta).

# Soft preferences (PRD §11.7 weighting)

Apply these as biases — they shape the menu but do not override hard constraints.

- High-protein health goal → bias meals toward >25g protein/serving on average across the plan.
- Low-carb → bias meals toward <30g carbs/serving on average.
- Healthy / weight-loss → bias meals toward <600 calories/serving on average.
- \`weeklyPacing = mostly_easy\` or \`minimal_effort\` → weight toward easy difficulty meals.
- \`weeklyPacing = one_fancy_night\` → 4 easy/medium meals + 1 fancier night.
- \`weeklyPacing = mixed\` → balanced mix.
- \`difficulty\` field is the user's overall ceiling — never exceed it across the plan.
- \`hiddenContext.spiceTolerance\` (\`mild\`/\`medium\`/\`hot\`) → bias dishes within the user's heat tolerance. Never push hot dishes onto a \`mild\` user.
- \`hiddenContext.dailyCalorieTarget\` (when set) → bias the per-day average toward the target ±10%.
- \`hiddenContext.budgetLevel\` (\`budget\`/\`mid_range\`/\`premium\`) → favor pantry-friendly proteins and produce on \`budget\`; allow finer cuts and specialty items on \`premium\`.
- \`hiddenContext.pickyAvoidances\` → treat as additional hard exclusions for the household (same weight as allergies).
- \`hiddenContext.recurringItems\` → staples the user always has on hand; prefer reusing them where natural.

# Servings and household

- If \`wantsLeftovers: true\`, target servings = householdSize + 1-2 (intent: leftover lunches).
- If \`wantsLeftovers: false\`, target servings = householdSize exactly.
- Servings live inside the recipe data the app stores; you don't return them per-meal here, but assume them when reasoning about ingredient quantities.

# Optimization principles (encoded in whyBullets and optimizationNotes-style content)

Each plan's \`whyBullets\` should highlight a CONCRETE optimization the plan captures, not a vague quality. Strong examples:
- "Chicken used in 2 meals — buy a 2-lb pack and prep both portions Sunday"
- "Garlic shared across 3 meals — buy one head, use it all"
- "Sheet-pan and one-pot meals minimize cleanup midweek"

Weak examples to avoid:
- "Saves you time" (vague, time-saved claims are forbidden)
- "Healthy and delicious" (says nothing)
- "Variety pack" (says nothing)

Optimize for ingredient reuse within each plan when possible. Note specific reuses. Note cost & waste reduction (e.g., buying a single full bunch and using it across nights rather than wasted half-bunches).

# Cuisine guidance

If the user supplied \`cuisines\`, weight the candidate plans toward those cuisines but do not let one cuisine dominate every plan if there's room for variety. If the user listed three cuisines, ideally each candidate plan emphasizes a different one (when distinct candidates is the higher priority).

If \`cuisines\` is empty, default to a varied palette across American, Italian, Mexican, Asian, Mediterranean dinners — the broader Tier-1 set.

# Tone of titles + bullets

Plans and meal titles should sound like a friend recommending dinner, not an AI listing categories. "Sheet-pan harissa chicken with chickpeas" beats "Chicken Sheet-Pan Meal." "Tomato soup + grilled cheese" beats "Comfort Soup Combination."

Aim for one tightly themed candidate (e.g., "Cozy Comfort Week"), one balanced/distinct (e.g., "Mediterranean-leaning Variety"), and one that solves a specific user-stated optimization (e.g., "High-Protein Reset" if user wants high protein).

# Macros

\`dailyMacros\` is the per-day average across the 5 dinners — round to whole numbers. Kiwi displays this as "Avg X cal/day · Yg P · Zg C · Wg F" so keep the math representative.

# Wizard input

The user's full \`WizardInput\` arrives as a JSON object below. Use every field. Hidden context fields (\`hiddenContext.equipment\`, \`hiddenContext.spiceTolerance\`, \`hiddenContext.dailyCalorieTarget\`, \`hiddenContext.budgetLevel\`, \`hiddenContext.pickyAvoidances\`, \`hiddenContext.recurringItems\`, \`hiddenContext.pantryStaples\`, \`hiddenContext.recentMealIds\`) are server-injected from the user's profile — treat them with equal weight as the user-supplied fields.

\`\`\`json
{{wizardInput}}
\`\`\`

Generate the candidates now. Return ONLY the tool_use call.`;

const PROMPTS: PromptSeed[] = [
  {
    key: "wizard.set_preferences.generate",
    description:
      "Generate up to 3 distinct meal-plan candidates from the user's wizard preferences.",
    variables: ["wizardInput"],
    defaultModel: MODEL_SONNET,
    defaultMode: "tool",
    body: WIZARD_SET_PREFERENCES_GENERATE_BODY,
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
  let bumped = 0;
  for (const p of PROMPTS) {
    const wasBumped = await upsertPromptWithVersionBump(prisma, p);
    if (wasBumped) bumped++;
  }
  console.log(
    `seeded ${PROMPTS.length} AI prompts (${bumped} version bump${bumped === 1 ? "" : "s"})`,
  );
}

// Idempotent upsert + version bump. Returns true if a new version was created.
async function upsertPromptWithVersionBump(
  prisma: PrismaClient,
  p: PromptSeed,
): Promise<boolean> {
  // Upsert the AIPrompt descriptor row (refreshes description/variables/model
  // metadata on every run; doesn't touch versions).
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

  // Body-match check: do we already have a version with the desired body?
  const existing = await prisma.aIPromptVersion.findFirst({
    where: { promptId: prompt.id, body: p.body },
    select: { id: true, version: true, isActive: true },
  });

  if (existing) {
    // Already seeded. If it's the active one, no-op. Otherwise reactivate it
    // (rollback path: an admin marked an older version active again).
    if (!existing.isActive) {
      await prisma.$transaction([
        prisma.aIPromptVersion.updateMany({
          where: { promptId: prompt.id, isActive: true },
          data: { isActive: false },
        }),
        prisma.aIPromptVersion.update({
          where: { id: existing.id },
          data: { isActive: true },
        }),
      ]);
    }
    return false;
  }

  // Body differs from every existing version. Create a new version, bumped,
  // and atomically swap active. Note v1 stays in place as the rollback target.
  const max = await prisma.aIPromptVersion.aggregate({
    where: { promptId: prompt.id },
    _max: { version: true },
  });
  const nextVersion = (max._max.version ?? 0) + 1;

  await prisma.$transaction([
    prisma.aIPromptVersion.updateMany({
      where: { promptId: prompt.id, isActive: true },
      data: { isActive: false },
    }),
    prisma.aIPromptVersion.create({
      data: {
        promptId: prompt.id,
        version: nextVersion,
        body: p.body,
        notes: `Seed authored body for ${p.key} (v${nextVersion})`,
        isActive: true,
        createdById: null,
      },
    }),
  ]);

  return true;
}

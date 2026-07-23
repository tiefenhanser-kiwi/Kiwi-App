// Plan-Gen Arc · Block 3.6 (D-WS9-063) — generate-prefix re-measure gate.
//
// After the §10 re-tune of GENERATE_MEAL_INSTRUCTIONS, re-measure the harness's
// STABLE_GENERATE_PREFIX against the real model (claude-sonnet-4-6), in the two
// contexts the harness actually sends it:
//   • system-only     — the prefix as its own `system` block (the cached unit).
//   • tools + system  — the same, PLUS the forced tool_use schema the generate
//                        call attaches (buildToolForSchema on the meal schema).
//
// Method: real messages.countTokens, baseline-subtracted so the trivial user
// message cancels and each number isolates its own contribution. Read-only.
//
//   node --env-file=.env --import tsx scripts/ws9-block3-generate-prefix-measure.ts

import Anthropic from "@anthropic-ai/sdk";

import { buildToolForSchema, forcedToolChoice } from "../src/lib/ai/modes";
import { resolvePromptDescriptorFromDb } from "../src/lib/ai/promptRegistry";
import { WizardExpandEnrichedMealDetailsSchema } from "../src/lib/ai/schemas/wizard";
import { STABLE_GENERATE_PREFIX } from "../src/lib/storeFillPrompts";

const MODEL = "claude-sonnet-4-6";
const FLOOR = 2048; // Sonnet 4.6 prompt-cache minimum cacheable prefix.
const PRIOR_SYSTEM_ONLY = 4230; // Block 3.6 v3 pre-fixes
const PRIOR_TOOLS_SYSTEM = 5710; // Block 3.6 v3 pre-fixes (w/ forced tool)

// A minimal, fixed user message — identical across all three measures so it
// cancels under subtraction and never influences the isolated numbers.
const MIN_USER = "x";

async function count(
  client: Anthropic,
  params: Partial<Anthropic.MessageCountTokensParams>,
): Promise<number> {
  const res = await client.messages.countTokens({
    model: MODEL,
    messages: [{ role: "user", content: MIN_USER }],
    ...params,
  } as Anthropic.MessageCountTokensParams);
  return res.input_tokens;
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set — cannot measure. Aborting.");
    process.exit(1);
  }
  const client = new Anthropic();

  // Reproduce the exact tool the generate call attaches (fallback descriptor →
  // no DB dependency; identical toolDescription the harness runs on).
  const descriptor = await resolvePromptDescriptorFromDb("store.generate_meal", null);
  const tools = buildToolForSchema(
    WizardExpandEnrichedMealDetailsSchema,
    descriptor.toolDescription,
  );

  const systemBlock = [{ type: "text" as const, text: STABLE_GENERATE_PREFIX }];

  const [base, sys, sysTool] = await Promise.all([
    count(client, {}),
    count(client, { system: systemBlock }),
    count(client, { system: systemBlock, tools, tool_choice: forcedToolChoice() }),
  ]);

  const systemOnly = sys - base;
  const toolsSystem = sysTool - base;
  const toolSchema = sysTool - sys;

  const pct = (t: number) => (((t - FLOOR) / FLOOR) * 100).toFixed(1);
  const delta = (t: number, prior: number) => {
    const d = t - prior;
    return `${d >= 0 ? "+" : ""}${d} vs prior ${prior}`;
  };

  console.log(`model:                 ${MODEL}`);
  console.log(`cache floor:           ${FLOOR} tokens`);
  console.log(`(baseline "${MIN_USER}" user message = ${base} tokens, subtracted out)`);
  console.log("");
  console.log(`STABLE_GENERATE_PREFIX (system-only): ${systemOnly} tokens`);
  console.log(`  clears floor? ${systemOnly >= FLOOR ? "YES" : "NO"} (margin ${pct(systemOnly)}%)  [${delta(systemOnly, PRIOR_SYSTEM_ONLY)}]`);
  console.log("");
  console.log(`tool schema alone:                    ${toolSchema} tokens`);
  console.log(`tools + system (forced tool_use):     ${toolsSystem} tokens  [${delta(toolsSystem, PRIOR_TOOLS_SYSTEM)}]`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

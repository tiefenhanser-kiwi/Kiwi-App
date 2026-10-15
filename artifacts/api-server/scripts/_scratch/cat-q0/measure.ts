// CAT-Q0 — measure the rubric prefix and the per-meal payload with REAL
// count_tokens (free; no generation). Reads the catalog read-only.
//
//   node --env-file=.env --import tsx scripts/_scratch/cat-q0/measure.ts [--show <mealId>]
//
// prefix tokens = count(tools + system + "x") − count("x"), i.e. what the
// cache_control breakpoint on the system block covers (tools render first).
import Anthropic from "@anthropic-ai/sdk";
import { PrismaClient } from "@prisma/client";

import { assertScriptDatabase } from "../../../src/lib/scripts/requireDatabaseHost";
import { loadCatalog } from "./catalogDb";
import { mulberry32, shuffled } from "./rng";
import { REVIEW_MODEL, REVIEW_TOOL, RUBRIC, userMessage } from "./rubric";

const { host, mode } = assertScriptDatabase("cat-q0/measure");
console.log(`database: ${host} (${mode})`);
const client = new Anthropic();
const count = async (withPrefix: boolean, content: string) => (await client.messages.countTokens({
  model: REVIEW_MODEL,
  ...(withPrefix ? { system: [{ type: "text" as const, text: RUBRIC }], tools: [REVIEW_TOOL], tool_choice: { type: "auto" as const } } : {}),
  messages: [{ role: "user", content }],
})).input_tokens;

const bare = await count(false, "x");
const full = await count(true, "x");
console.log(`model ${REVIEW_MODEL}: rubric prefix (tools + system) = ${full - bare} tokens (count with prefix ${full}, bare "x" ${bare}); the cacheable minimum on this model is 512`);

const prisma = new PrismaClient();
const meals = await loadCatalog(prisma);
await prisma.$disconnect();
const show = process.argv.indexOf("--show");
if (show >= 0) {
  const m = meals.find((x) => x.id === process.argv[show + 1]) ?? meals[0];
  console.log(userMessage(m));
}
const sample = shuffled(meals, mulberry32(7)).slice(0, 25);
const sizes: number[] = [];
for (const m of sample) sizes.push((await count(false, userMessage(m))) - bare + 1);
sizes.sort((a, b) => a - b);
const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
console.log(`per-meal user message over 25 random meals (seed 7): mean ${mean.toFixed(0)} · median ${sizes[12]} · min ${sizes[0]} · max ${sizes[24]} tokens`);

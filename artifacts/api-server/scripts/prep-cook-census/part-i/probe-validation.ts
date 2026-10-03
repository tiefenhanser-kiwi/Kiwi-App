// [prepcook] Part I — probe: WHY prep.narrate_steps fails validation on a large
// plan. Read-only on the DB (LLMCallLog aside); one runAICall with a spy that keeps
// the raw tool output, then the schema's own issues are printed.
//
//   node --env-file=.env --import tsx scripts/prep-cook-census/part-i/probe-validation.ts <planId>
import Anthropic from "@anthropic-ai/sdk";
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPrepWeekInput } from "../../../src/lib/prepWeekAggregation";
import { buildPrepCombineInput } from "../../../src/lib/prepCombineAdapter";
import { combinePrep } from "../../../src/lib/prepCombineEngine";
import { buildStepPlan } from "../../../src/lib/prepWeekAssembly";
import { PrepNarrationResultSchema } from "../../../src/lib/ai/schemas/prepNarration";
import { runAICall } from "../../../src/lib/ai/runAICall";
import { TEST_USER_ID, FORBIDDEN_PLAN } from "./corpus";

const prisma = new PrismaClient();
if (!new URL(process.env.DATABASE_URL ?? "").hostname.includes("ep-broad-haze")) throw new Error("REFUSING: not the dev branch");
const planId = process.argv[2];
if (!planId || planId === FORBIDDEN_PLAN) throw new Error("REFUSING");

const raws: unknown[] = [];
let cost = 0;
const real = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const client = {
  messages: {
    create: async (params: Anthropic.MessageCreateParams) => {
      const res = (await real.messages.create(params)) as Anthropic.Message;
      cost += ((res.usage?.input_tokens ?? 0) * 3 + (res.usage?.output_tokens ?? 0) * 15) / 1e6;
      for (const b of res.content) if (b.type === "tool_use") raws.push(b.input);
      return res;
    },
  },
} as unknown as Pick<Anthropic, "messages">;

async function main() {
  const { input, cookDays, identity } = await loadPrepWeekInput({ planId, userId: TEST_USER_ID, prisma });
  const texts = new Map<string, string[]>();
  for (const m of input.meals) for (const d of m.dishes) texts.set(d.dishId, d.stepTexts);
  const plan = buildStepPlan(combinePrep(buildPrepCombineInput(input), identity?.foldedIdByIngredientId), input.planName, texts, cookDays.lagByMealId);
  const r = await runAICall("prep.narrate_steps", { prepNarrationInput: plan.narrationInput }, PrepNarrationResultSchema, { prisma, maxTokens: 16384, client });
  console.log(`success=${r.success} attempts=${raws.length} cost=$${cost.toFixed(4)} planned steps=${plan.narrationInput.steps.length}`);
  for (const [i, raw] of raws.entries()) {
    const p = PrepNarrationResultSchema.safeParse(raw);
    const issues = p.success ? [] : p.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`);
    const steps = ((raw as { steps?: { instructions?: string; title?: string }[] })?.steps ?? []);
    const longest = steps.map((s) => s.instructions?.length ?? 0).sort((a, b) => b - a).slice(0, 3);
    console.log(`attempt ${i + 1}: ${issues.length} issue(s); longest instructions ${longest.join(", ")} chars`);
    for (const x of issues.slice(0, 8)) console.log(`   ${x}`);
  }
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "out", `validation-${planId.slice(0, 8)}.json`), JSON.stringify(raws, null, 2));
}

main().finally(() => prisma.$disconnect());

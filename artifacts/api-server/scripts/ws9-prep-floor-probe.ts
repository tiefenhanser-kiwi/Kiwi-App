// WS9 §2 — READ-ONLY prompt-size probe for prep.narrate_steps.
//
// SELECT-ONLY on the DB. Makes NO model completion calls — only the Anthropic
// /messages/count_tokens endpoint, which is free and non-generative.
//
// Reconstructs the EXACT user message runAICall would send for a plan at
// full-week and at each subset size, and splits the input token count into the
// constant prompt body vs. the per-meal payload.
//
// Run (from repo root):
//   pnpm --filter @workspace/api-server exec tsx scripts/ws9-prep-floor-probe.ts <planIdPrefix>

import Anthropic from "@anthropic-ai/sdk";
import { PrismaClient } from "@prisma/client";
import { loadPrepWeekInput } from "../src/lib/prepWeekAggregation";
import { buildPrepCombineInput } from "../src/lib/prepCombineAdapter";
import { combinePrep } from "../src/lib/prepCombineEngine";
import { buildStepPlan } from "../src/lib/prepWeekAssembly";
import {
  resolvePromptDescriptorFromDb,
  renderPromptBody,
} from "../src/lib/ai/promptRegistry";
import { buildToolForSchema } from "../src/lib/ai/modes";
import { PrepNarrationResultSchema } from "../src/lib/ai/schemas/prepNarration";

if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* set some other way */
  }
}

const prisma = new PrismaClient();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const planPrefix = process.argv[2] ?? "3d2fdff3";

async function countTokens(userMessage: string, tools: unknown[]) {
  const r = await anthropic.messages.countTokens({
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: userMessage }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: tools as any,
  });
  return r.input_tokens;
}

async function main() {
  const plan = await prisma.mealPlanInstance.findFirst({
    where: { id: { startsWith: planPrefix } },
    include: { items: { include: { meal: { select: { id: true, title: true } } } } },
  });
  if (!plan) throw new Error(`no plan starting ${planPrefix}`);
  console.log(`plan ${plan.id}  "${plan.name}"  userId=${plan.userId}`);
  console.log(`revisionId=${plan.revisionId ?? "(none)"}`);
  for (const it of plan.items) {
    console.log(`  item meal=${it.meal?.id} "${it.meal?.title}" servings=${(it as Record<string, unknown>).servings ?? "-"}`);
  }

  const descriptor = await resolvePromptDescriptorFromDb(
    "prep.narrate_steps",
    prisma,
  );
  console.log(
    `\nprompt version ${descriptor.version}, model ${descriptor.defaultModel}, mode ${descriptor.defaultMode}`,
  );

  // The EXACT tool array runAICall builds for a tool-mode call.
  const tools = buildToolForSchema(
    PrepNarrationResultSchema,
    descriptor.toolDescription,
  );

  // ── constant floor: the body with the payload variable rendered as `{}` ──
  const emptyRendered = renderPromptBody(descriptor.body, {
    prepNarrationInput: {},
  });
  const floor = await countTokens(emptyRendered, tools);
  const toolsOnly = await countTokens("x", tools);
  console.log(
    `\nCONSTANT FLOOR: body+tools with an empty payload = ${floor} tok` +
      `   (tool schema alone ≈ ${toolsOnly} tok)`
  );

  const mealIdsAll = plan.items.map((i) => i.meal!.id);

  async function measure(label: string, mealIds: string[] | undefined) {
    const { input } = await loadPrepWeekInput({
      planId: plan!.id,
      userId: plan!.userId,
      prisma,
      mealIds,
    });
    const combineResult = combinePrep(buildPrepCombineInput(input));
    const stepTextByDishId = new Map<string, string[]>();
    for (const meal of input.meals)
      for (const dish of meal.dishes) stepTextByDishId.set(dish.dishId, dish.stepTexts);
    const stepPlan = buildStepPlan(combineResult, input.planName, stepTextByDishId);
    const rendered = renderPromptBody(descriptor.body, {
      prepNarrationInput: stepPlan.narrationInput,
    });
    const tok = await countTokens(rendered, tools);
    const payloadChars =
      JSON.stringify(stepPlan.narrationInput).length;
    console.log(
      `${label.padEnd(28)} meals=${input.meals.length} steps=${stepPlan.steps.length} ` +
        `payloadChars=${payloadChars} INPUT_TOK=${tok} (payload=${tok - floor})`
    );
    return { tok, meals: input.meals.length, steps: stepPlan.steps.length };
  }

  console.log("");
  await measure("full week (no mealIds)", undefined);
  await measure("explicit all 4", mealIdsAll);
  for (let i = 0; i < mealIdsAll.length; i++) {
    await measure(`subset: meal[${i}] only`, [mealIdsAll[i]]);
  }
  // every adjacent + non-adjacent 2-meal pair
  for (let i = 0; i < mealIdsAll.length; i++)
    for (let j = i + 1; j < mealIdsAll.length; j++)
      await measure(`subset: meals[${i},${j}]`, [mealIdsAll[i], mealIdsAll[j]]);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });

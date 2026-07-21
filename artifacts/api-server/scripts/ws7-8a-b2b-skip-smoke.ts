// WS7-8a Block 2b — step-based prep-worthiness (skip rule) live smoke.
//
// Seeds a SELF-CONTAINED fixture plan (its own throwaway user + fixture-
// namespaced ingredients — touches no real user's data), runs the full Block
// 2b pipeline (loader -> adapter -> combine engine -> narration -> assembly)
// with a REAL Anthropic narration call, and reports:
//   (a) what the engine flagged prep-worthy,
//   (b) what the narration demoted to skipSuggested,
//   (c) the step text the AI judged against for each step.
// Always cleans up (try/finally), even on failure.
//
// Run:  pnpm --filter @workspace/api-server exec tsx --env-file=.env \
//         scripts/ws7-8a-b2b-skip-smoke.ts
// Needs: a reachable dev DB + ANTHROPIC_API_KEY in .env. The script re-seeds
// the prep.narrate_steps prompt first so the live call uses the B2b body.

import { PrismaClient } from "@prisma/client";

import { seedAIPrompts } from "../prisma/seeds/aiPrompts";
import { loadPrepWeekInput } from "../src/lib/prepWeekAggregation";
import { buildPrepCombineInput } from "../src/lib/prepCombineAdapter";
import { combinePrep } from "../src/lib/prepCombineEngine";
import { buildStepPlan, assemblePrepWeekResult } from "../src/lib/prepWeekAssembly";
import {
  PrepNarrationResultSchema,
} from "../src/lib/ai/schemas/prepNarration";
import { runAICall } from "../src/lib/ai/runAICall";

const prisma = new PrismaClient();

// Fixed fixture UUIDs so a prior aborted run is cleaned on the next run.
const ID = {
  user: "7be8a000-0000-4000-8000-000000000001",
  plan: "7be8a000-0000-4000-8000-000000000002",
  mealA: "7be8a000-0000-4000-8000-00000000000a", // single-dish → meal-owned steps
  mealB: "7be8a000-0000-4000-8000-00000000000b", // multi-dish → dish-owned steps
  dishChicken: "7be8a000-0000-4000-8000-0000000000c1",
  dishMarinade: "7be8a000-0000-4000-8000-0000000000c2",
  dishVeg: "7be8a000-0000-4000-8000-0000000000c3",
  itemA: "7be8a000-0000-4000-8000-0000000000d1",
  itemB: "7be8a000-0000-4000-8000-0000000000d2",
  // ingredients (fixture-namespaced canonicalName; real displayName drives the engine)
  chicken: "7be8a000-0000-4000-8000-0000000000e1",
  salt: "7be8a000-0000-4000-8000-0000000000e2",
  pepper: "7be8a000-0000-4000-8000-0000000000e3",
  paprika: "7be8a000-0000-4000-8000-0000000000e4",
  soy: "7be8a000-0000-4000-8000-0000000000e5",
  brownSugar: "7be8a000-0000-4000-8000-0000000000e6",
  garlic: "7be8a000-0000-4000-8000-0000000000e7",
  ginger: "7be8a000-0000-4000-8000-0000000000e8",
  peppers: "7be8a000-0000-4000-8000-0000000000e9",
} as const;

const DISH_IDS = [ID.dishChicken, ID.dishMarinade, ID.dishVeg];
const MEAL_IDS = [ID.mealA, ID.mealB];
const INGREDIENT_IDS = [
  ID.chicken, ID.salt, ID.pepper, ID.paprika, ID.soy,
  ID.brownSugar, ID.garlic, ID.ginger, ID.peppers,
];

async function cleanup(): Promise<void> {
  await prisma.recipeInstructionStep.deleteMany({
    where: {
      OR: [
        { ownerType: "dish", ownerId: { in: DISH_IDS } },
        { ownerType: "meal", ownerId: { in: MEAL_IDS } },
      ],
    },
  });
  await prisma.dishIngredient.deleteMany({ where: { dishId: { in: DISH_IDS } } });
  await prisma.mealDishLink.deleteMany({ where: { mealId: { in: MEAL_IDS } } });
  await prisma.prepWeekStructure.deleteMany({ where: { planId: ID.plan } });
  await prisma.mealPlanItem.deleteMany({ where: { mealPlanInstanceId: ID.plan } });
  await prisma.mealPlanInstance.deleteMany({ where: { id: ID.plan } });
  await prisma.meal.deleteMany({ where: { id: { in: MEAL_IDS } } });
  await prisma.dish.deleteMany({ where: { id: { in: DISH_IDS } } });
  await prisma.ingredient.deleteMany({ where: { id: { in: INGREDIENT_IDS } } });
  await prisma.user.deleteMany({ where: { id: ID.user } });
}

async function seed(): Promise<void> {
  await prisma.user.create({
    data: {
      id: ID.user,
      email: `ws78b-smoke-${ID.user}@example.invalid`,
      firstName: "Smoke",
      lastName: "Fixture",
    },
  });

  // Fixture-namespaced canonicalName avoids colliding with real catalog rows;
  // displayName + category are what the engine actually reads.
  await prisma.ingredient.createMany({
    data: [
      { id: ID.chicken, canonicalName: "ws78b-chicken-breast", displayName: "chicken breast", category: "Protein", defaultUnit: "lb" },
      { id: ID.salt, canonicalName: "ws78b-salt", displayName: "salt", category: "Pantry", defaultUnit: "tsp" },
      { id: ID.pepper, canonicalName: "ws78b-black-pepper", displayName: "black pepper", category: "Pantry", defaultUnit: "tsp" },
      { id: ID.paprika, canonicalName: "ws78b-paprika", displayName: "paprika", category: "Pantry", defaultUnit: "tsp" },
      { id: ID.soy, canonicalName: "ws78b-soy-sauce", displayName: "soy sauce", category: "Pantry", defaultUnit: "cup" },
      { id: ID.brownSugar, canonicalName: "ws78b-brown-sugar", displayName: "brown sugar", category: "Pantry", defaultUnit: "tbsp" },
      { id: ID.garlic, canonicalName: "ws78b-garlic", displayName: "garlic", category: "Produce", defaultUnit: "clove" },
      { id: ID.ginger, canonicalName: "ws78b-ginger", displayName: "ginger", category: "Produce", defaultUnit: "inch" },
      { id: ID.peppers, canonicalName: "ws78b-bell-peppers", displayName: "bell peppers", category: "Produce", defaultUnit: "each" },
    ],
  });

  await prisma.dish.createMany({
    data: [
      { id: ID.dishChicken, title: "Grilled Chicken", servingsDefault: 4 },
      { id: ID.dishMarinade, title: "Teriyaki Marinade", servingsDefault: 4 },
      { id: ID.dishVeg, title: "Stir-Fried Vegetables", servingsDefault: 4 },
    ],
  });

  await prisma.dishIngredient.createMany({
    data: [
      // Grilled Chicken — season-and-cook (chicken + denylisted/lone seasonings)
      { dishId: ID.dishChicken, ingredientId: ID.chicken, quantity: 2, unit: "lb", positionIndex: 0 },
      { dishId: ID.dishChicken, ingredientId: ID.salt, quantity: 1, unit: "tsp", positionIndex: 1 },
      { dishId: ID.dishChicken, ingredientId: ID.pepper, quantity: 1, unit: "tsp", positionIndex: 2 },
      { dishId: ID.dishChicken, ingredientId: ID.paprika, quantity: 2, unit: "tsp", positionIndex: 3 },
      // Teriyaki Marinade — combine / make-ahead
      { dishId: ID.dishMarinade, ingredientId: ID.soy, quantity: 0.5, unit: "cup", positionIndex: 0 },
      { dishId: ID.dishMarinade, ingredientId: ID.brownSugar, quantity: 2, unit: "tbsp", positionIndex: 1 },
      { dishId: ID.dishMarinade, ingredientId: ID.garlic, quantity: 3, unit: "clove", preparationNote: "minced", positionIndex: 2 },
      { dishId: ID.dishMarinade, ingredientId: ID.ginger, quantity: 1, unit: "inch", preparationNote: "grated", positionIndex: 3 },
      // Stir-Fried Vegetables — real produce prep
      { dishId: ID.dishVeg, ingredientId: ID.peppers, quantity: 3, unit: "each", preparationNote: "sliced", positionIndex: 0 },
    ],
  });

  await prisma.meal.createMany({
    data: [
      { id: ID.mealA, userId: ID.user, title: "Grill Night", servingsDefault: 4 },
      { id: ID.mealB, userId: ID.user, title: "Teriyaki Stir-Fry", servingsDefault: 4 },
    ],
  });

  await prisma.mealDishLink.createMany({
    data: [
      { mealId: ID.mealA, dishId: ID.dishChicken, positionIndex: 0 },
      { mealId: ID.mealB, dishId: ID.dishMarinade, positionIndex: 0 },
      { mealId: ID.mealB, dishId: ID.dishVeg, positionIndex: 1 },
    ],
  });

  // Meal A: SINGLE dish → meal-owned steps (ownerType="meal"). Season-and-cook.
  // Meal B: MULTI dish → dish-owned steps (ownerType="dish"). Combine + prep.
  await prisma.recipeInstructionStep.createMany({
    data: [
      {
        ownerType: "meal", ownerId: ID.mealA, stepIndex: 0,
        stepTextRaw: "Season the chicken breast all over with salt, black pepper, and paprika.",
        stepTextTranslated: "Season the chicken breast all over with salt, black pepper, and paprika.",
      },
      {
        ownerType: "meal", ownerId: ID.mealA, stepIndex: 1,
        stepTextRaw: "Grill 6 minutes per side until the internal temperature reaches 165°F.",
        stepTextTranslated: "Grill 6 minutes per side until the internal temperature reaches 165°F.",
      },
      {
        ownerType: "dish", ownerId: ID.dishMarinade, stepIndex: 0,
        stepTextRaw: "In a bowl, whisk together the soy sauce, brown sugar, minced garlic, and grated ginger to make the marinade.",
        stepTextTranslated: "In a bowl, whisk together the soy sauce, brown sugar, minced garlic, and grated ginger to make the marinade.",
      },
      {
        ownerType: "dish", ownerId: ID.dishMarinade, stepIndex: 1,
        stepTextRaw: "Pour the marinade over the protein and let it rest at least 30 minutes before cooking.",
        stepTextTranslated: "Pour the marinade over the protein and let it rest at least 30 minutes before cooking.",
      },
      {
        ownerType: "dish", ownerId: ID.dishVeg, stepIndex: 0,
        stepTextRaw: "Slice the bell peppers into thin strips.",
        stepTextTranslated: "Slice the bell peppers into thin strips.",
      },
      {
        ownerType: "dish", ownerId: ID.dishVeg, stepIndex: 1,
        stepTextRaw: "Stir-fry the peppers over high heat for 4 minutes.",
        stepTextTranslated: "Stir-fry the peppers over high heat for 4 minutes.",
      },
    ],
  });

  await prisma.mealPlanInstance.create({
    data: { id: ID.plan, userId: ID.user, titleOverride: "WS7-8a B2b Smoke Plan", status: "draft" },
  });
  await prisma.mealPlanItem.createMany({
    data: [
      { id: ID.itemA, mealPlanInstanceId: ID.plan, mealId: ID.mealA, positionIndex: 0 },
      { id: ID.itemB, mealPlanInstanceId: ID.plan, mealId: ID.mealB, positionIndex: 1 },
    ],
  });
}

async function main(): Promise<void> {
  console.log("── WS7-8a B2b skip-rule smoke ──\n");

  // Ensure the live prompt is the B2b narration body.
  await seedAIPrompts(prisma);

  await cleanup(); // clear any prior aborted run
  await seed();

  try {
    // Full Block 2b pipeline.
    const { input } = await loadPrepWeekInput({
      planId: ID.plan,
      userId: ID.user,
      prisma,
    });
    const combineInput = buildPrepCombineInput(input);
    const combineResult = combinePrep(combineInput);

    const stepTextByDishId = new Map<string, string[]>();
    for (const meal of input.meals) {
      for (const dish of meal.dishes) stepTextByDishId.set(dish.dishId, dish.stepTexts);
    }
    const stepPlan = buildStepPlan(combineResult, input.planName, stepTextByDishId);

    // (a) What the engine flagged prep-worthy (include + uncertain).
    console.log("(a) ENGINE prep-worthy groups (per phase):");
    for (const phase of combineResult.phases) {
      for (const e of phase.entries) {
        console.log(
          `    [${phase.phase}] ${e.ingredientName} — ${e.prepWorthy}` +
            (e.isBlendComponent ? " (blend)" : ""),
        );
      }
    }
    const excludedNames = combineResult.excluded.map((e) => e.ingredientName);
    console.log(`    (excluded as noise/buy-and-use: ${excludedNames.join(", ") || "none"})\n`);

    // Live narration call.
    console.log("(  ) Calling prep.narrate_steps (live Sonnet)…\n");
    const ai = await runAICall(
      "prep.narrate_steps",
      { prepNarrationInput: stepPlan.narrationInput },
      PrepNarrationResultSchema,
      { prisma, userId: ID.user },
    );
    if (!ai.success) {
      console.log(`!! Narration FAILED: ${ai.reason} — ${ai.userFacingMessage}`);
      return;
    }

    const result = assemblePrepWeekResult(stepPlan, ai.data);

    // (c) Step text the AI judged against, per planned step. D-WS9-049 A1.2 —
    // prose now lives once in narrationInput.dishSteps; each step references the
    // dish names, so resolve the union here for display.
    console.log("(c) STEP TEXT judged per step (relevantDishes → dishSteps):");
    for (const s of stepPlan.steps) {
      const names = s.components.map((c) => c.ingredientName).join(", ");
      console.log(`    ${s.stepId} [${s.phase}] {${names}}`);
      const stepText = s.relevantDishes.flatMap(
        (d) => stepPlan.narrationInput.dishSteps[d] ?? [],
      );
      if (stepText.length === 0) console.log("        (no step text)");
      for (const t of stepText) console.log(`        • ${t}`);
    }
    console.log();

    // (b) What narration demoted to skipSuggested.
    console.log("(b) NARRATION result — demotions:");
    const demoted: string[] = [];
    const kept: string[] = [];
    for (const phase of result.phases) {
      for (const step of phase.steps) {
        const line = `${phase.phase}/#${step.number} "${step.title}"`;
        if (step.skipSuggested) demoted.push(line);
        else kept.push(line);
      }
    }
    console.log("    SKIP-SUGGESTED:");
    if (demoted.length === 0) console.log("        (none)");
    for (const d of demoted) console.log(`        ⤵ ${d}`);
    console.log("    KEPT as prep:");
    for (const k of kept) console.log(`        ✓ ${k}`);

    console.log(
      `\n    Expected (known-answer): chicken breast → SKIP (season-and-cook);` +
        ` garlic/ginger/soy sauce/bell peppers → KEEP (combine/real prep).`,
    );
    console.log(
      "    NOTE: live AI — run-to-run variance is possible; read the judgment above against the expectation.",
    );
    console.log(`\n    totalEstimatedMinutes (code-summed): ${result.totalEstimatedMinutes}`);
  } finally {
    await cleanup();
    await prisma.$disconnect();
    console.log("\n── cleanup done; fixture removed ──");
  }
}

main().catch(async (err) => {
  console.error("smoke crashed:", err);
  try {
    await cleanup();
  } catch {
    /* ignore */
  }
  await prisma.$disconnect();
  process.exit(1);
});

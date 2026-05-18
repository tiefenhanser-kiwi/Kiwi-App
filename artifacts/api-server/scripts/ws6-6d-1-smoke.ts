// WS6 6d-1 — Cooking Sequencer live smoke.
// Helper-direct (no HTTP). Imports the production runCookingSequence and
// runs it against real Anthropic + real Neon. Mirrors ws6-6c-7-smoke.ts.
// The api-server process does NOT need to be running.
//
// Surfaces under test:
//   - multi-dish meal → AI path (Sonnet tool_use), LLMCallLog row written
//   - single-dish meal → no-AI branch, NO LLMCallLog row
//
// Idempotency: teardown at script start deletes any prior fixture rows
// (meals, dishes, dishLinks, instruction steps). Re-run safe.
//
// Run:    pnpm --filter @workspace/api-server exec tsx scripts/ws6-6d-1-smoke.ts
// Prereq: prisma:seed (AIPrompts, includes sequencer.step_ordering body)
//         AND prisma:seed:dev (Hans's account). ANTHROPIC_API_KEY must be set.

import { PrismaClient } from "@prisma/client";

import {
  runCookingSequence,
  type CookingSequenceResult,
} from "../src/lib/cookingSequence";
import { runAICall } from "../src/lib/ai/runAICall";

const prisma = new PrismaClient();

const DEV_USER_EMAIL = "hans.tiefenthaler+8@gmail.com";

// Fixture IDs — stable across runs so teardown is keyed by ID.
const MULTI_MEAL_ID = "smoke-6d1-multi-meal";
const MULTI_DISH_SALMON = "smoke-6d1-multi-dish-salmon";
const MULTI_DISH_RICE = "smoke-6d1-multi-dish-rice";
const MULTI_DISH_BROCCOLI = "smoke-6d1-multi-dish-broccoli";

const SINGLE_MEAL_ID = "smoke-6d1-single-meal";
const SINGLE_DISH_ID = "smoke-6d1-single-dish-soup";

const ALL_FIXTURE_MEAL_IDS = [MULTI_MEAL_ID, SINGLE_MEAL_ID];
const ALL_FIXTURE_DISH_IDS = [
  MULTI_DISH_SALMON,
  MULTI_DISH_RICE,
  MULTI_DISH_BROCCOLI,
  SINGLE_DISH_ID,
];

const COST_CEILING_USD = 0.2;

interface SurfaceReport {
  label: string;
  status: "PASS" | "FAIL";
  wallMs: number;
  costUsd: number;
  notes: string[];
}

// ── teardown / setup ──────────────────────────────────────────────────

async function teardown(): Promise<void> {
  // Steps are polymorphic (no FK), so wipe by ownerType+ownerId set.
  await prisma.recipeInstructionStep.deleteMany({
    where: {
      ownerType: "dish",
      ownerId: { in: ALL_FIXTURE_DISH_IDS },
    },
  });
  // MealDishLink has onDelete: Cascade on mealId → deleting the Meal sweeps
  // its links, but the Dish rows do not cascade. Delete links first to be
  // safe, then dishes.
  await prisma.mealDishLink.deleteMany({
    where: { mealId: { in: ALL_FIXTURE_MEAL_IDS } },
  });
  await prisma.meal.deleteMany({
    where: { id: { in: ALL_FIXTURE_MEAL_IDS } },
  });
  await prisma.dish.deleteMany({
    where: { id: { in: ALL_FIXTURE_DISH_IDS } },
  });
  console.log("[teardown] fixtures cleared");
}

async function createMultiDishFixture(userId: string): Promise<void> {
  // Three dishes with intentionally different parallelism profiles so
  // the sequencer has real choices to make.
  //
  // Salmon: 20 min (sear + rest — rest is a passive window for prep).
  // Rice pilaf: 25 min (mostly passive simmer once boiling).
  // Broccoli: 8 min (late-start, quick cook).
  //
  // Well-sequenced, all three should land within ~2 minutes of each other.

  // 1. Three dishes.
  await prisma.dish.createMany({
    data: [
      {
        id: MULTI_DISH_SALMON,
        userId,
        title: "Pan-seared Salmon",
        estimatedTimeMinutes: 20,
        servingsDefault: 4,
      },
      {
        id: MULTI_DISH_RICE,
        userId,
        title: "Rice Pilaf",
        estimatedTimeMinutes: 25,
        servingsDefault: 4,
      },
      {
        id: MULTI_DISH_BROCCOLI,
        userId,
        title: "Steamed Broccoli",
        estimatedTimeMinutes: 8,
        servingsDefault: 4,
      },
    ],
  });

  // 2. Multi-dish meal.
  await prisma.meal.create({
    data: {
      id: MULTI_MEAL_ID,
      userId,
      title: "Pan-seared salmon with rice pilaf and steamed broccoli",
      estimatedTimeMinutes: 25,
      servingsDefault: 4,
      dishLinks: {
        create: [
          { dishId: MULTI_DISH_SALMON, positionIndex: 0, roleLabel: "main" },
          { dishId: MULTI_DISH_RICE, positionIndex: 1, roleLabel: "side" },
          { dishId: MULTI_DISH_BROCCOLI, positionIndex: 2, roleLabel: "side" },
        ],
      },
    },
  });

  // 3. Steps. ownerType+ownerId polymorphism; no JOIN.
  //
  // Salmon (5 steps, 20 min total)
  await prisma.recipeInstructionStep.createMany({
    data: [
      {
        ownerType: "dish",
        ownerId: MULTI_DISH_SALMON,
        stepIndex: 0,
        stepTextRaw: "Pat the salmon fillets dry and season both sides with salt and pepper.",
        stepTextTranslated: "Pat the salmon fillets dry and season both sides with salt and pepper.",
        estimatedMinutes: 2,
        phaseType: "prep",
        parallelGroup: null,
      },
      {
        ownerType: "dish",
        ownerId: MULTI_DISH_SALMON,
        stepIndex: 1,
        stepTextRaw: "Heat 2 tbsp olive oil in a large skillet over medium-high heat until shimmering.",
        stepTextTranslated: "Heat 2 tbsp olive oil in a large skillet over medium-high heat until shimmering.",
        estimatedMinutes: 3,
        phaseType: "preheat",
        parallelGroup: null,
      },
      {
        ownerType: "dish",
        ownerId: MULTI_DISH_SALMON,
        stepIndex: 2,
        stepTextRaw: "Sear the salmon skin-side down for 6 minutes, then flip and cook 3 more minutes.",
        stepTextTranslated: "Sear the salmon skin-side down for 6 minutes, then flip and cook 3 more minutes.",
        estimatedMinutes: 9,
        phaseType: "cook",
        parallelGroup: null,
        isTimingSensitive: true,
      },
      {
        ownerType: "dish",
        ownerId: MULTI_DISH_SALMON,
        stepIndex: 3,
        stepTextRaw: "Transfer the salmon to a plate and let it rest, tented with foil.",
        stepTextTranslated: "Transfer the salmon to a plate and let it rest, tented with foil.",
        estimatedMinutes: 5,
        phaseType: "rest",
        parallelGroup: null,
      },
      {
        ownerType: "dish",
        ownerId: MULTI_DISH_SALMON,
        stepIndex: 4,
        stepTextRaw: "Plate the salmon and finish with a squeeze of lemon.",
        stepTextTranslated: "Plate the salmon and finish with a squeeze of lemon.",
        estimatedMinutes: 1,
        phaseType: "assemble",
        parallelGroup: null,
      },
    ],
  });

  // Rice pilaf (5 steps, 25 min total — mostly passive)
  await prisma.recipeInstructionStep.createMany({
    data: [
      {
        ownerType: "dish",
        ownerId: MULTI_DISH_RICE,
        stepIndex: 0,
        stepTextRaw: "Melt 1 tbsp butter in a medium saucepan over medium heat.",
        stepTextTranslated: "Melt 1 tbsp butter in a medium saucepan over medium heat.",
        estimatedMinutes: 2,
        phaseType: "preheat",
        parallelGroup: null,
      },
      {
        ownerType: "dish",
        ownerId: MULTI_DISH_RICE,
        stepIndex: 1,
        stepTextRaw: "Add 1 cup long-grain rice and toast for 2 minutes, stirring frequently.",
        stepTextTranslated: "Add 1 cup long-grain rice and toast for 2 minutes, stirring frequently.",
        estimatedMinutes: 2,
        phaseType: "cook",
        parallelGroup: null,
      },
      {
        ownerType: "dish",
        ownerId: MULTI_DISH_RICE,
        stepIndex: 2,
        stepTextRaw: "Pour in 2 cups chicken broth and bring to a boil.",
        stepTextTranslated: "Pour in 2 cups chicken broth and bring to a boil.",
        estimatedMinutes: 3,
        phaseType: "cook",
        parallelGroup: null,
      },
      {
        ownerType: "dish",
        ownerId: MULTI_DISH_RICE,
        stepIndex: 3,
        stepTextRaw: "Cover, reduce heat to low, and simmer until liquid is absorbed.",
        stepTextTranslated: "Cover, reduce heat to low, and simmer until liquid is absorbed.",
        estimatedMinutes: 16,
        phaseType: "cook",
        parallelGroup: "passive-simmer",
      },
      {
        ownerType: "dish",
        ownerId: MULTI_DISH_RICE,
        stepIndex: 4,
        stepTextRaw: "Fluff the rice with a fork and let stand 2 minutes before serving.",
        stepTextTranslated: "Fluff the rice with a fork and let stand 2 minutes before serving.",
        estimatedMinutes: 2,
        phaseType: "rest",
        parallelGroup: null,
      },
    ],
  });

  // Broccoli (3 steps, 8 min total — late-start)
  await prisma.recipeInstructionStep.createMany({
    data: [
      {
        ownerType: "dish",
        ownerId: MULTI_DISH_BROCCOLI,
        stepIndex: 0,
        stepTextRaw: "Cut 1 large head of broccoli into florets.",
        stepTextTranslated: "Cut 1 large head of broccoli into florets.",
        estimatedMinutes: 3,
        phaseType: "prep",
        parallelGroup: null,
      },
      {
        ownerType: "dish",
        ownerId: MULTI_DISH_BROCCOLI,
        stepIndex: 1,
        stepTextRaw: "Bring 1 inch of salted water to a boil in a covered pot with a steamer basket.",
        stepTextTranslated: "Bring 1 inch of salted water to a boil in a covered pot with a steamer basket.",
        estimatedMinutes: 3,
        phaseType: "preheat",
        parallelGroup: null,
      },
      {
        ownerType: "dish",
        ownerId: MULTI_DISH_BROCCOLI,
        stepIndex: 2,
        stepTextRaw: "Steam the broccoli until bright green and crisp-tender, 4 minutes.",
        stepTextTranslated: "Steam the broccoli until bright green and crisp-tender, 4 minutes.",
        estimatedMinutes: 4,
        phaseType: "cook",
        parallelGroup: null,
        isTimingSensitive: true,
      },
    ],
  });

  console.log("[setup] multi-dish fixture created (3 dishes, 13 steps total)");
}

async function createSingleDishFixture(userId: string): Promise<void> {
  await prisma.dish.create({
    data: {
      id: SINGLE_DISH_ID,
      userId,
      title: "Quick Tomato Soup",
      estimatedTimeMinutes: 15,
      servingsDefault: 4,
    },
  });

  await prisma.meal.create({
    data: {
      id: SINGLE_MEAL_ID,
      userId,
      title: "Quick Tomato Soup",
      estimatedTimeMinutes: 15,
      servingsDefault: 4,
      dishLinks: {
        create: [
          { dishId: SINGLE_DISH_ID, positionIndex: 0, roleLabel: "main" },
        ],
      },
    },
  });

  await prisma.recipeInstructionStep.createMany({
    data: [
      {
        ownerType: "dish",
        ownerId: SINGLE_DISH_ID,
        stepIndex: 0,
        stepTextRaw: "Sauté 1 chopped onion in 2 tbsp olive oil over medium heat until soft.",
        stepTextTranslated: "Sauté 1 chopped onion in 2 tbsp olive oil over medium heat until soft.",
        estimatedMinutes: 5,
        phaseType: "cook",
        parallelGroup: null,
      },
      {
        ownerType: "dish",
        ownerId: SINGLE_DISH_ID,
        stepIndex: 1,
        stepTextRaw: "Add 1 can crushed tomatoes and 1 cup broth; bring to a simmer.",
        stepTextTranslated: "Add 1 can crushed tomatoes and 1 cup broth; bring to a simmer.",
        estimatedMinutes: 3,
        phaseType: "cook",
        parallelGroup: null,
      },
      {
        ownerType: "dish",
        ownerId: SINGLE_DISH_ID,
        stepIndex: 2,
        stepTextRaw: "Simmer 6 minutes, then blend until smooth and season with salt and pepper.",
        stepTextTranslated: "Simmer 6 minutes, then blend until smooth and season with salt and pepper.",
        estimatedMinutes: 7,
        phaseType: "cook",
        parallelGroup: null,
      },
    ],
  });

  console.log("[setup] single-dish fixture created (1 dish, 3 steps)");
}

// ── helpers ───────────────────────────────────────────────────────────

async function getDevUserId(): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { email: DEV_USER_EMAIL },
    select: { id: true },
  });
  if (!user) {
    throw new Error(
      `dev user ${DEV_USER_EMAIL} not found — run pnpm --filter @workspace/api-server prisma:seed:dev`,
    );
  }
  return user.id;
}

async function readSequencerLog(
  userId: string,
  since: Date,
): Promise<{ count: number; costUsd: number; latencyMs: number; retryCount: number }> {
  const rows = await prisma.lLMCallLog.findMany({
    where: {
      userId,
      promptKey: "sequencer.step_ordering",
      createdAt: { gte: since },
    },
    select: {
      costEstimateUsd: true,
      latencyMs: true,
      retryCount: true,
    },
  });
  const costUsd = rows.reduce((s, r) => s + Number(r.costEstimateUsd ?? 0), 0);
  const latencyMs = rows.reduce((s, r) => s + (r.latencyMs ?? 0), 0);
  const retryCount = rows.reduce((s, r) => s + (r.retryCount ?? 0), 0);
  return { count: rows.length, costUsd, latencyMs, retryCount };
}

function sumInputEstimatedMinutes(result: CookingSequenceResult, rawSum: number): string {
  // totalEstimatedMinutes from the AI vs naive sum of step estimatedMinutes.
  // With good parallel weaving, AI total should be substantially lower.
  const aiTotal = result.totalEstimatedMinutes;
  const savedPct = rawSum > 0 ? Math.round(((rawSum - aiTotal) / rawSum) * 100) : 0;
  return `aiTotal=${aiTotal}min raw_sum=${rawSum}min savings=${savedPct}%`;
}

// ── surfaces ──────────────────────────────────────────────────────────

async function surface_multiDish(userId: string): Promise<SurfaceReport> {
  console.log("\n══ [multi-dish] AI sequencer path ══");
  const wallStart = Date.now();
  const since = new Date();
  const notes: string[] = [];

  let result: CookingSequenceResult;
  try {
    result = await runCookingSequence({
      mealId: MULTI_MEAL_ID,
      userId,
      deps: { prisma, runAICall },
    });
  } catch (err) {
    notes.push(`runCookingSequence threw: ${(err as Error).message}`);
    return {
      label: "multi-dish AI sequencer",
      status: "FAIL",
      wallMs: Date.now() - wallStart,
      costUsd: 0,
      notes,
    };
  }

  const wallMs = Date.now() - wallStart;
  const log = await readSequencerLog(userId, since);

  notes.push(`usedAI=${result.usedAI}`);
  notes.push(`dishCount=${result.dishCount}`);
  notes.push(`steps=${result.sequence.length}`);
  notes.push(`llmCallLogRows=${log.count}`);
  notes.push(`ai_latencyMs=${log.latencyMs}`);
  notes.push(`retries=${log.retryCount}`);

  // 13 steps total (5 salmon + 5 rice + 3 broccoli).
  const expectedSteps = 13;
  // Naive sum: 2+3+9+5+1 + 2+2+3+16+2 + 3+3+4 = 55 minutes raw.
  const rawSum = 2 + 3 + 9 + 5 + 1 + 2 + 2 + 3 + 16 + 2 + 3 + 3 + 4;
  notes.push(sumInputEstimatedMinutes(result, rawSum));

  // Sanity checks.
  const checks: string[] = [];
  if (!result.usedAI) checks.push("usedAI was false on multi-dish");
  if (result.dishCount !== 3) checks.push(`dishCount expected 3, got ${result.dishCount}`);
  if (result.sequence.length !== expectedSteps) {
    checks.push(`steps expected ${expectedSteps}, got ${result.sequence.length}`);
  }
  if (log.count !== 1) {
    checks.push(`LLMCallLog expected 1 row, got ${log.count}`);
  }
  // sequenceIndex contiguous 0..n-1
  const sortedByIdx = [...result.sequence].sort((a, b) => a.sequenceIndex - b.sequenceIndex);
  for (let i = 0; i < sortedByIdx.length; i++) {
    if (sortedByIdx[i].sequenceIndex !== i) {
      checks.push(`sequenceIndex gap at position ${i}: got ${sortedByIdx[i].sequenceIndex}`);
      break;
    }
  }
  // Each original step appears exactly once.
  const seen = new Set<string>();
  for (const s of result.sequence) {
    const key = `${s.dishId}:${s.originalStepIndex}`;
    if (seen.has(key)) {
      checks.push(`duplicate step in output: ${key}`);
      break;
    }
    seen.add(key);
  }
  // Within-dish ordering preserved (originalStepIndex is monotonic per dishId
  // in sequenceIndex order — a step from a dish never precedes an earlier
  // step from the same dish).
  const perDishLast = new Map<string, number>();
  for (const s of sortedByIdx) {
    const last = perDishLast.get(s.dishId);
    if (last !== undefined && s.originalStepIndex < last) {
      checks.push(
        `intra-dish order inverted: dish ${s.dishId} step ${s.originalStepIndex} after ${last}`,
      );
      break;
    }
    perDishLast.set(s.dishId, s.originalStepIndex);
  }

  // Surface 2-3 representative reason annotations verbatim.
  const withReason = result.sequence.filter((s) => typeof s.reason === "string" && s.reason);
  notes.push(`reasonsAnnotated=${withReason.length}/${result.sequence.length}`);
  for (const s of withReason.slice(0, 3)) {
    notes.push(`reason@seq${s.sequenceIndex}: "${s.reason}"`);
  }

  const pass = checks.length === 0;
  if (!pass) {
    for (const c of checks) notes.push(`CHECK FAILED: ${c}`);
  }

  return {
    label: "multi-dish AI sequencer",
    status: pass ? "PASS" : "FAIL",
    wallMs,
    costUsd: log.costUsd,
    notes,
  };
}

async function surface_singleDish(userId: string): Promise<SurfaceReport> {
  console.log("\n══ [single-dish] no-AI branch ══");
  const wallStart = Date.now();
  const since = new Date();
  const notes: string[] = [];

  let result: CookingSequenceResult;
  try {
    result = await runCookingSequence({
      mealId: SINGLE_MEAL_ID,
      userId,
      deps: { prisma, runAICall },
    });
  } catch (err) {
    notes.push(`runCookingSequence threw: ${(err as Error).message}`);
    return {
      label: "single-dish no-AI",
      status: "FAIL",
      wallMs: Date.now() - wallStart,
      costUsd: 0,
      notes,
    };
  }

  const wallMs = Date.now() - wallStart;
  const log = await readSequencerLog(userId, since);

  notes.push(`usedAI=${result.usedAI}`);
  notes.push(`dishCount=${result.dishCount}`);
  notes.push(`steps=${result.sequence.length}`);
  notes.push(`llmCallLogRowsSinceStart=${log.count}`);
  notes.push(`totalEstimatedMinutes=${result.totalEstimatedMinutes}`);

  const checks: string[] = [];
  if (result.usedAI) checks.push("usedAI was true on single-dish (must be false)");
  if (result.dishCount !== 1) checks.push(`dishCount expected 1, got ${result.dishCount}`);
  if (result.sequence.length !== 3) {
    checks.push(`steps expected 3, got ${result.sequence.length}`);
  }
  if (log.count !== 0) {
    checks.push(`LLMCallLog expected 0 rows (no AI), got ${log.count}`);
  }
  // 5 + 3 + 7 = 15 expected
  if (result.totalEstimatedMinutes !== 15) {
    checks.push(`totalEstimatedMinutes expected 15, got ${result.totalEstimatedMinutes}`);
  }
  // No `reason` or `dependsOn` on single-dish branch.
  for (const s of result.sequence) {
    if (s.reason !== undefined) {
      checks.push(`single-dish step ${s.sequenceIndex} has reason (should be omitted)`);
      break;
    }
  }
  // sequenceIndex == originalStepIndex on single-dish branch.
  for (const s of result.sequence) {
    if (s.sequenceIndex !== s.originalStepIndex) {
      checks.push(
        `single-dish sequenceIndex ${s.sequenceIndex} != originalStepIndex ${s.originalStepIndex}`,
      );
      break;
    }
  }
  // Cumulative startsAtMinutes.
  const expectedStarts = [0, 5, 8];
  for (let i = 0; i < expectedStarts.length; i++) {
    if (result.sequence[i].startsAtMinutes !== expectedStarts[i]) {
      checks.push(
        `single-dish startsAtMinutes[${i}] expected ${expectedStarts[i]}, got ${result.sequence[i].startsAtMinutes}`,
      );
      break;
    }
  }

  const pass = checks.length === 0;
  if (!pass) {
    for (const c of checks) notes.push(`CHECK FAILED: ${c}`);
  }

  return {
    label: "single-dish no-AI",
    status: pass ? "PASS" : "FAIL",
    wallMs,
    costUsd: 0,
    notes,
  };
}

// ── main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set in env — aborting smoke");
    process.exit(2);
  }

  console.log("══════════════════════════════════════════════════════════");
  console.log("WS6 6d-1 — Cooking Sequencer live smoke");
  console.log("══════════════════════════════════════════════════════════");

  const runStartIso = new Date().toISOString();
  const userId = await getDevUserId();
  console.log(`dev user: ${userId} (${DEV_USER_EMAIL})`);

  await teardown();
  await createMultiDishFixture(userId);
  await createSingleDishFixture(userId);

  const wallStart = Date.now();
  const rMulti = await surface_multiDish(userId);
  const rSingle = await surface_singleDish(userId);
  const totalWallMs = Date.now() - wallStart;

  const reports = [rMulti, rSingle];
  const passCount = reports.filter((r) => r.status === "PASS").length;
  const failCount = reports.filter((r) => r.status === "FAIL").length;
  const totalCost = reports.reduce((s, r) => s + r.costUsd, 0);

  // ── report ─────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("=== WS6 6d-1 Smoke ===");
  console.log(`Run date:        ${runStartIso}`);
  console.log(
    `Total:           2 surfaces, ${passCount} PASS, ${failCount} FAIL`,
  );
  console.log(`Wall latency:    ${totalWallMs}ms total`);
  console.log(`Cost:            $${totalCost.toFixed(4)} (sequencer.step_ordering only)`);

  console.log("\nPer-surface:");
  for (const r of reports) {
    const wallStr = `${r.wallMs}ms`.padStart(7);
    const costStr = `$${r.costUsd.toFixed(4)}`.padStart(8);
    const label = `[${r.label}]`.padEnd(30);
    console.log(`  ${label} ${r.status.padEnd(6)} ${wallStr}   ${costStr}`);
    for (const n of r.notes) console.log(`    - ${n}`);
  }

  if (totalCost > COST_CEILING_USD) {
    console.log(
      `\n[COST WARNING] $${totalCost.toFixed(4)} exceeds ceiling $${COST_CEILING_USD}`,
    );
  }

  await teardown();
  await prisma.$disconnect();

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n[FATAL] smoke crashed:", err);
  prisma.$disconnect().finally(() => process.exit(2));
});

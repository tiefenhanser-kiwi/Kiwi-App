// Plan-Gen Arc · Block 3 (D-WS9-041 / D-WS9-044) — store-fill harness core tests.
// Pure logic + a fake-tx materialize assertion (dish-owned steps) + a list-driven
// dry-run orchestration test with a fake runAICall (no network, no DB).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { PrismaClient } from "@prisma/client";
import type { WizardExpandEnrichedMealDetails } from "../ai/schemas/wizard";
import type { runAICall as productionRunAICall } from "../ai/runAICall";
import { materializeMeal } from "../mealMaterialize";
import {
  STORE_FILL_TARGET,
  buildMaterializePayload,
  dedupKey,
  deriveAllergens,
  isCarbIngredient,
  isProteinIngredient,
  isVegIngredient,
  mealComplete,
  mergeSteps,
  runStoreFill,
  validateBug040Meal,
  type GenProfile,
} from "../storeFill";

// ── factories ────────────────────────────────────────────────────────────────

const PROFILE: GenProfile = { key: "test", servings: 4, difficulty: "easy" };

function macros() {
  return {
    caloriesPerServing: 500,
    proteinGPerServing: 30,
    carbsGPerServing: 40,
    fatGPerServing: 20,
  };
}

/** A valid, complete two-dish dinner (main + base). Overrides let tests break it. */
function makeMeal(
  over: Partial<WizardExpandEnrichedMealDetails> = {},
): WizardExpandEnrichedMealDetails {
  return {
    title: "Seared Chicken with Rice",
    cuisineType: "American",
    estimatedTimeMinutes: 35,
    difficulty: "easy",
    servings: 4,
    dishes: [
      {
        title: "Seared Chicken",
        role: "main",
        positionIndex: 0,
        ingredients: [
          { name: "chicken breast", quantity: 1, unit: "pound" },
          { name: "olive oil", quantity: 2, unit: "tablespoon" },
        ],
        macros: macros(),
      },
      {
        title: "Steamed Rice",
        role: "base",
        positionIndex: 1,
        ingredients: [{ name: "white rice", quantity: 1, unit: "cup" }],
        macros: macros(),
      },
    ],
    ...over,
  };
}

function singleDish(
  title: string,
  ingredients: { name: string; quantity: number; unit: string }[],
): WizardExpandEnrichedMealDetails {
  return makeMeal({
    dishes: [{ title, role: "main", positionIndex: 0, ingredients, macros: macros() }],
  });
}

function finalizeFor(meal: WizardExpandEnrichedMealDetails) {
  return {
    dishSteps: meal.dishes.map((_d, di) => ({
      mealIndex: 0,
      dishIndex: di,
      steps: [
        { text: "Prep the components.", phaseType: "prep" as const, estimatedMinutes: 5, isTimingSensitive: false },
        { text: "Cook until done.", phaseType: "cook" as const, estimatedMinutes: 12, isTimingSensitive: true },
      ],
    })),
  };
}

// ── ingredient classification ────────────────────────────────────────────────

describe("ingredient classification", () => {
  it("isProteinIngredient matches proteins, not plain veg", () => {
    assert.equal(isProteinIngredient("boneless chicken thighs"), true);
    assert.equal(isProteinIngredient("extra-firm tofu"), true);
    assert.equal(isProteinIngredient("carrot"), false);
  });

  it("isCarbIngredient matches starches; excludes cornstarch/corned beef", () => {
    assert.equal(isCarbIngredient("white rice"), true);
    assert.equal(isCarbIngredient("russet potatoes"), true);
    assert.equal(isCarbIngredient("cornstarch"), false);
    assert.equal(isCarbIngredient("corned beef"), false);
    assert.equal(isCarbIngredient("olive oil"), false);
  });

  it("isVegIngredient matches vegetables; excludes aromatics/citrus/peppercorn", () => {
    assert.equal(isVegIngredient("broccoli florets"), true);
    assert.equal(isVegIngredient("bell pepper"), true);
    assert.equal(isVegIngredient("garlic"), false);
    assert.equal(isVegIngredient("yellow onion"), false);
    assert.equal(isVegIngredient("lemon"), false);
    assert.equal(isVegIngredient("black peppercorns"), false);
  });
});

// ── compositional completeness (D-WS9-044) ───────────────────────────────────

describe("mealComplete", () => {
  it("passes a multi-dish meal with a main + protein", () => {
    assert.deepEqual(mealComplete(makeMeal()), { ok: true });
  });

  it("fails when there is no main dish (the Greek-salad failure)", () => {
    const salad = makeMeal({
      dishes: [
        {
          title: "Big Green Salad",
          role: "side",
          positionIndex: 0,
          ingredients: [{ name: "romaine lettuce", quantity: 1, unit: "head" }],
          macros: { ...macros(), proteinGPerServing: 3 },
        },
      ],
    });
    assert.equal(mealComplete(salad).reason, "no_main_dish");
  });

  it("REJECTS a lone protein single dish (no carb, no vegetable)", () => {
    const loneSalmon = singleDish("Grilled Salmon", [
      { name: "salmon fillet", quantity: 1, unit: "pound" },
      { name: "lemon", quantity: 1, unit: "each" },
      { name: "fresh dill", quantity: 1, unit: "tablespoon" },
    ]);
    assert.equal(mealComplete(loneSalmon).reason, "incomplete_single_dish");
  });

  it("REJECTS a bare protein with only aromatics", () => {
    const bareChicken = singleDish("Grilled Chicken Breast", [
      { name: "chicken breast", quantity: 1, unit: "pound" },
      { name: "garlic", quantity: 2, unit: "clove" },
      { name: "yellow onion", quantity: 1, unit: "each" },
      { name: "olive oil", quantity: 2, unit: "tablespoon" },
    ]);
    assert.equal(mealComplete(bareChicken).reason, "incomplete_single_dish");
  });

  it("PASSES a single-dish stir-fry (protein + vegetable)", () => {
    const stirFry = singleDish("Chicken and Broccoli Stir-Fry", [
      { name: "chicken thigh", quantity: 1, unit: "pound" },
      { name: "broccoli florets", quantity: 2, unit: "cup" },
      { name: "soy sauce", quantity: 3, unit: "tablespoon" },
    ]);
    assert.deepEqual(mealComplete(stirFry), { ok: true });
  });

  it("PASSES a single-dish one-pot pasta (protein + carb)", () => {
    const onePot = singleDish("One-Pot Chicken Pasta", [
      { name: "chicken breast", quantity: 1, unit: "pound" },
      { name: "penne pasta", quantity: 12, unit: "ounce" },
      { name: "marinara sauce", quantity: 2, unit: "cup" },
    ]);
    assert.deepEqual(mealComplete(onePot), { ok: true });
  });

  it("PASSES a single-dish chicken soup (protein + carb + veg)", () => {
    const soup = singleDish("Chicken Noodle Soup", [
      { name: "chicken breast", quantity: 1, unit: "pound" },
      { name: "egg noodles", quantity: 8, unit: "ounce" },
      { name: "carrot", quantity: 2, unit: "each" },
      { name: "celery", quantity: 2, unit: "stalk" },
    ]);
    assert.deepEqual(mealComplete(soup), { ok: true });
  });
});

// ── allergens ────────────────────────────────────────────────────────────────

describe("deriveAllergens", () => {
  it("stamps dairy + fish + wheat, sorted+unique", () => {
    const meal = singleDish("Baked Salmon Alfredo", [
      { name: "salmon fillet", quantity: 1, unit: "pound" },
      { name: "heavy cream", quantity: 1, unit: "cup" },
      { name: "fettuccine pasta", quantity: 8, unit: "ounce" },
      { name: "parmesan cheese", quantity: 0.5, unit: "cup" },
    ]);
    assert.deepEqual(deriveAllergens(meal), ["dairy", "fish", "wheat"]);
  });

  it("returns [] when no allergen keywords appear", () => {
    const meal = singleDish("Grilled Chicken and Peppers", [
      { name: "chicken breast", quantity: 1, unit: "pound" },
      { name: "bell pepper", quantity: 2, unit: "each" },
    ]);
    assert.deepEqual(deriveAllergens(meal), []);
  });
});

// ── BUG-040 gate ─────────────────────────────────────────────────────────────

describe("validateBug040Meal", () => {
  it("passes non-empty units", () => {
    assert.deepEqual(validateBug040Meal(makeMeal()), { ok: true });
  });

  it("rejects an empty unit (never coerced)", () => {
    const bad = singleDish("Chicken", [{ name: "chicken", quantity: 3, unit: "" }]);
    const r = validateBug040Meal(bad);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /ingredients\.0\.unit/);
  });
});

// ── merge steps ──────────────────────────────────────────────────────────────

describe("mergeSteps", () => {
  it("merges one entry per dish", () => {
    const meal = makeMeal();
    const r = mergeSteps(meal, finalizeFor(meal));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.stepsPerDish.length, 2);
  });

  it("fails on a missing dish", () => {
    const meal = makeMeal();
    const r = mergeSteps(meal, { dishSteps: [finalizeFor(meal).dishSteps[0]] });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /missing_dish_steps:1/);
  });
});

// ── dedup key ────────────────────────────────────────────────────────────────

describe("dedupKey", () => {
  it("normalizes case, whitespace, trailing punctuation", () => {
    assert.equal(dedupKey("  Big  Greek Salad!  "), "big greek salad");
  });
});

// ── payload assembly ─────────────────────────────────────────────────────────

describe("buildMaterializePayload", () => {
  it("builds kind:new dishes, maps steps, stamps allergens, tags=cuisine+difficulty", () => {
    const meal = makeMeal();
    const merged = mergeSteps(meal, finalizeFor(meal));
    assert.equal(merged.ok, true);
    if (!merged.ok) return;
    const payload = buildMaterializePayload(meal, merged.stepsPerDish, ["dairy"], "seared-chicken");

    assert.equal(payload.mealType, "dinner");
    assert.equal(payload.sourceType, undefined); // target carries batch_generated
    assert.deepEqual(payload.allergens, ["dairy"]);
    assert.equal(payload.dishFamilyKey, "seared-chicken");
    assert.deepEqual(payload.tags, ["american", "easy"]);
    const d0 = payload.dishes[0];
    assert.equal(d0.kind, "new");
    if (d0.kind !== "new") return;
    assert.equal(d0.role, "main");
    assert.equal(d0.steps.length, 2);
    assert.equal(d0.steps[0].phaseType, "prep");
  });
});

// ── materializeMeal via the store target persists DISH-OWNED steps ──────────

describe("materializeMeal via STORE_FILL_TARGET", () => {
  it("writes steps as ownerType:'dish' and mints a batch_generated pool meal", async () => {
    const meal = makeMeal();
    const merged = mergeSteps(meal, finalizeFor(meal));
    assert.equal(merged.ok, true);
    if (!merged.ok) return;
    const payload = buildMaterializePayload(meal, merged.stepsPerDish, ["dairy"], "seared-chicken");

    const map = new Map<string, string>();
    for (const d of payload.dishes) {
      if (d.kind !== "new") continue;
      for (const ing of d.ingredients) map.set(ing.name.toLowerCase().trim(), `ing-${map.size}`);
    }

    const createdSteps: Array<Record<string, unknown>> = [];
    const createdMeals: Array<Record<string, unknown>> = [];
    let dishSeq = 0;
    const fakeTx = {
      meal: {
        create: async ({ data }: { data: Record<string, unknown> }) => { createdMeals.push(data); return { id: "meal-1" }; },
        update: async () => ({}),
      },
      dish: { create: async () => ({ id: `dish-${dishSeq++}` }) },
      mealDishLink: { create: async () => ({}), findMany: async () => [] },
      dishIngredient: { create: async () => ({}) },
      recipeInstructionStep: {
        create: async ({ data }: { data: Record<string, unknown> }) => { createdSteps.push(data); return {}; },
      },
    };

    const res = await materializeMeal(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeTx as any,
      "",
      payload,
      map,
      STORE_FILL_TARGET,
    );
    assert.equal(res.mealId, "meal-1");
    assert.equal(createdSteps.length, 4);
    for (const s of createdSteps) assert.equal(s.ownerType, "dish");

    const m = createdMeals[0];
    assert.equal(m.userId, null);
    assert.equal(m.isPublic, true);
    assert.equal(m.sourceType, "batch_generated");
    assert.deepEqual(m.allergens, ["dairy"]);
    assert.equal(m.dishFamilyKey, "seared-chicken");
    assert.equal(m.mealType, "dinner");
  });
});

// ── list-driven orchestration (dry-run, fake AI + fake prisma) ──────────────

interface FakeMeta { input?: number; output?: number; cacheRead?: number; cacheCreation?: number }

function okResult(data: unknown, meta: FakeMeta = {}) {
  return {
    success: true as const,
    data,
    metadata: {
      promptKey: "x", promptVersion: null, model: "claude-sonnet-4-6", mode: "tool" as const,
      latencyMs: 1, inputTokens: meta.input ?? 10, outputTokens: meta.output ?? 5,
      cacheReadInputTokens: meta.cacheRead ?? 0, cacheCreationInputTokens: meta.cacheCreation ?? 0,
      costEstimateUsd: 0, retryCount: 0,
    },
  };
}

function makeFakeRunAICall(genQueue: unknown[], finQueue: unknown[]): typeof productionRunAICall {
  const fn = async (promptKey: string) => {
    if (promptKey === "store.generate_meal") {
      const next = genQueue.shift();
      if (next === undefined) throw new Error("gen queue exhausted");
      return next;
    }
    if (promptKey === "store.finalize_steps") {
      const next = finQueue.shift();
      if (next === undefined) throw new Error("fin queue exhausted");
      return next;
    }
    throw new Error(`unexpected promptKey ${promptKey}`);
  };
  return fn as unknown as typeof productionRunAICall;
}

function fakePrisma(existingKeys: string[] = []): PrismaClient {
  return {
    meal: { findMany: async () => existingKeys.map((dishFamilyKey) => ({ dishFamilyKey })) },
  } as unknown as PrismaClient;
}

const DISH = (rank: number, dish: string, key = dish.toLowerCase().replace(/[^a-z0-9]+/g, "-")) =>
  ({ rank, dish, key, category: "Test" });

describe("runStoreFill — list-driven dry-run", () => {
  it("generates against the target dish, no DB writes, accumulates tokens", async () => {
    const meal = makeMeal();
    const runAICall = makeFakeRunAICall(
      [okResult(meal, { input: 100, cacheRead: 3000 })],
      [okResult(finalizeFor(meal), { input: 50, cacheRead: 3200 })],
    );
    const result = await runStoreFill(
      { prisma: fakePrisma(), runAICall },
      { apply: false, limit: 1, dishes: [DISH(1, "Baked Chicken Breast")], profiles: [PROFILE] },
    );

    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].targetDish, "Baked Chicken Breast");
    assert.equal(result.records[0].written, false);
    assert.equal(result.tokens.aiCalls, 2);
    assert.equal(result.tokens.cacheRead, 6200);
  });

  it("takes the FIRST N dishes by rank", async () => {
    const meal = makeMeal();
    const runAICall = makeFakeRunAICall(
      [okResult(makeMeal({ title: "M1" }))],
      [okResult(finalizeFor(meal))],
    );
    const result = await runStoreFill(
      { prisma: fakePrisma(), runAICall },
      { apply: false, limit: 1, dishes: [DISH(2, "Second"), DISH(1, "First")], profiles: [PROFILE] },
    );
    assert.equal(result.records[0].targetDish, "First"); // rank 1 first
  });

  it("regenerates on an incomplete single-dish meal, logs the rejection", async () => {
    const loneSalmon = singleDish("Grilled Salmon", [
      { name: "salmon fillet", quantity: 1, unit: "pound" },
      { name: "lemon", quantity: 1, unit: "each" },
    ]);
    const good = makeMeal();
    const runAICall = makeFakeRunAICall(
      [okResult(loneSalmon), okResult(good)],
      [okResult(finalizeFor(good))],
    );
    const result = await runStoreFill(
      { prisma: fakePrisma(), runAICall },
      { apply: false, limit: 1, dishes: [DISH(1, "Grilled Salmon")], profiles: [PROFILE], retries: 2 },
    );

    assert.equal(result.records.length, 1);
    assert.equal(result.completenessRejections.length, 1);
    assert.equal(result.completenessRejections[0].reason, "incomplete_single_dish");
  });

  it("skips a BUG-040-invalid meal (empty unit), never coerces", async () => {
    const bad = singleDish("Bad Units", [
      { name: "chicken", quantity: 3, unit: "" },
      { name: "rice", quantity: 1, unit: "cup" },
    ]);
    const runAICall = makeFakeRunAICall([okResult(bad)], []);
    const result = await runStoreFill(
      { prisma: fakePrisma(), runAICall },
      { apply: false, limit: 1, dishes: [DISH(1, "X", "x")], profiles: [PROFILE] },
    );
    assert.equal(result.records.length, 0);
    assert.equal(result.skips[0].stage, "bug040");
  });

  it("dedups on the TARGET-DISH KEY, seeded from existing batch_generated (re-run safe, no generate)", async () => {
    // "x" already written → dedup BEFORE generating (gen queue empty proves it).
    const runAICall = makeFakeRunAICall([], []);
    const result = await runStoreFill(
      { prisma: fakePrisma(["x"]), runAICall },
      { apply: false, limit: 1, dishes: [DISH(1, "X", "x")], profiles: [PROFILE] },
    );
    assert.equal(result.records.length, 0);
    assert.equal(result.tokens.aiCalls, 0); // never generated
    assert.equal(result.skips[0].stage, "dedup");
    assert.equal(result.skips[0].reason, "already_written");
  });
});

// ── Part 2 runaway controls ─────────────────────────────────────────────────

describe("runStoreFill — runaway controls", () => {
  const bigRate = { inputPerMtokUsd: 3, outputPerMtokUsd: 15 };

  it("--max-calls halts the run cleanly", async () => {
    const meal = makeMeal();
    // Enough responses for several meals, but cap calls at 2 (one meal's worth).
    const gen = Array.from({ length: 5 }, () => okResult(meal));
    const fin = Array.from({ length: 5 }, () => okResult(finalizeFor(meal)));
    const result = await runStoreFill(
      { prisma: fakePrisma(), runAICall: makeFakeRunAICall(gen, fin) },
      { apply: false, limit: 5, dishes: [DISH(1,"A","a"),DISH(2,"B","b"),DISH(3,"C","c"),DISH(4,"D","d"),DISH(5,"E","e")], profiles: [PROFILE], maxCalls: 2 },
    );
    assert.equal(result.stoppedBy, "max_calls");
    assert.equal(result.records.length, 1); // only the first meal completed
  });

  it("--max-cost halts the run cleanly", async () => {
    const meal = makeMeal();
    const gen = Array.from({ length: 5 }, () => okResult(meal, { input: 1_000_000 }));
    const fin = Array.from({ length: 5 }, () => okResult(finalizeFor(meal), { input: 1_000_000 }));
    const result = await runStoreFill(
      { prisma: fakePrisma(), runAICall: makeFakeRunAICall(gen, fin) },
      { apply: false, limit: 5, dishes: [DISH(1,"A","a"),DISH(2,"B","b"),DISH(3,"C","c"),DISH(4,"D","d"),DISH(5,"E","e")], profiles: [PROFILE], maxCostUsd: 5, rate: bigRate },
    );
    assert.equal(result.stoppedBy, "max_cost");
    assert.ok(result.records.length < 5);
  });

  it("aborts after N consecutive meal failures", async () => {
    const lone = singleDish("Grilled Salmon", [
      { name: "salmon fillet", quantity: 1, unit: "pound" },
      { name: "lemon", quantity: 1, unit: "each" },
    ]);
    // Every generate returns an incomplete meal → each meal fails; retries:0.
    const gen = Array.from({ length: 6 }, () => okResult(lone));
    const result = await runStoreFill(
      { prisma: fakePrisma(), runAICall: makeFakeRunAICall(gen, []) },
      { apply: false, limit: 6, dishes: [DISH(1,"A","a"),DISH(2,"B","b"),DISH(3,"C","c"),DISH(4,"D","d"),DISH(5,"E","e"),DISH(6,"F","f")], profiles: [PROFILE], retries: 0, maxConsecutiveFailures: 3 },
    );
    assert.equal(result.stoppedBy, "consecutive_failures");
    assert.equal(result.records.length, 0);
    assert.equal(result.attempted, 3); // stopped before the 4th
  });
});

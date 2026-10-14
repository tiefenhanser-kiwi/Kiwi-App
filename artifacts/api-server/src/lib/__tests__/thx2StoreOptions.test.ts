// THX-2G (D-WS9-311) — the script-only store-fill options. Two guarantees:
//   1. The default generate and finalize prefixes are BYTE-IDENTICAL to what
//      they were before THX-2G (sha256 pinned), so the catalog's warm cache and
//      every existing caller are untouched (D-WS9-311 call 1, §7).
//   2. Every new option, absent, is exactly today's behaviour — on the wire
//      (runAICall's prefix / max_tokens / user body), in the payload, and in
//      the materialize write.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import type { PrismaClient } from "@prisma/client";

import type { WizardExpandEnrichedMealDetails } from "../ai/schemas/wizard";
import type { runAICall as productionRunAICall } from "../ai/runAICall";
import { materializeMeal } from "../mealMaterialize";
import {
  STORE_FILL_TARGET,
  buildMaterializePayload,
  buildTags,
  finalizeInput,
  generateInput,
  mealComplete,
  mergeSteps,
  runStoreFill,
  singleDishComplete,
  storeFillTarget,
  type GenProfile,
} from "../storeFill";
import {
  DEFAULT_DISH_RANGE_SENTENCE,
  STABLE_FINALIZE_PREFIX,
  STABLE_GENERATE_PREFIX,
  dishRangeSentence,
  generatePrefixFor,
} from "../storeFillPrompts";

// Measured on `next` at 504b666, before any THX-2G edit.
const GENERATE_PREFIX_SHA256 = "e9c24ef31703f97adbd7b111069dc88db3fd78a8adce8d93fb72f395eba6025b";
const FINALIZE_PREFIX_SHA256 = "823334672b8f984c837e1a2180748d6fe8bf6272cbb0f43337371dc3501e83bd";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const PROFILE: GenProfile = { key: "test", servings: 4, difficulty: "easy" };
const macros = () => ({ caloriesPerServing: 500, proteinGPerServing: 30, carbsGPerServing: 40, fatGPerServing: 20 });

function makeMeal(over: Partial<WizardExpandEnrichedMealDetails> = {}): WizardExpandEnrichedMealDetails {
  return {
    title: "Seared Chicken with Rice",
    cuisineType: "American",
    estimatedTimeMinutes: 35,
    difficulty: "easy",
    servings: 4,
    dishes: [
      { title: "Seared Chicken", role: "main", positionIndex: 0, ingredients: [{ name: "chicken breast", quantity: 1, unit: "pound" }], macros: macros() },
      { title: "Steamed Rice", role: "base", positionIndex: 1, ingredients: [{ name: "white rice", quantity: 1, unit: "cup" }], macros: macros() },
    ],
    ...over,
  };
}

/** A lone side: what an alternate looks like, and what mealComplete rejects. */
function loneSide(): WizardExpandEnrichedMealDetails {
  return makeMeal({
    title: "Cranberry-Apple Chutney",
    dishes: [{ title: "Cranberry-Apple Chutney", role: "sauce", positionIndex: 0, ingredients: [{ name: "fresh cranberries", quantity: 12, unit: "ounce" }], macros: macros() }],
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

function ok(data: unknown) {
  return {
    success: true as const,
    data,
    metadata: { promptKey: "x", promptVersion: null, model: "claude-sonnet-4-6", mode: "tool" as const, latencyMs: 1, inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costEstimateUsd: 0, retryCount: 0 },
  };
}

interface Recorded { key: string; vars: Record<string, unknown>; opts: Record<string, unknown> }
function recordingRunAICall(gens: unknown[], fins: unknown[], log: Recorded[]): typeof productionRunAICall {
  return (async (key: string, vars: Record<string, unknown>, _schema: unknown, opts: Record<string, unknown>) => {
    log.push({ key, vars, opts });
    const q = key === "store.generate_meal" ? gens : fins;
    const next = q.shift();
    if (next === undefined) throw new Error(`${key} queue exhausted`);
    return next;
  }) as unknown as typeof productionRunAICall;
}
const fakePrisma = () => ({ meal: { findMany: async () => [] } }) as unknown as PrismaClient;
const DISH = { rank: 1, dish: "Seared Chicken with Rice", key: "seared-chicken", category: "Test", parentDish: "x", band: "top25" as const, siblingCount: 1 };

// ── 1. the prefixes ──────────────────────────────────────────────────────────

describe("THX-2G — the default store prefixes are byte-identical (sha256)", () => {
  it("STABLE_GENERATE_PREFIX hashes to the pre-THX-2G value", () => {
    assert.equal(sha256(STABLE_GENERATE_PREFIX), GENERATE_PREFIX_SHA256);
  });
  it("STABLE_FINALIZE_PREFIX hashes to the pre-THX-2G value", () => {
    assert.equal(sha256(STABLE_FINALIZE_PREFIX), FINALIZE_PREFIX_SHA256);
  });
  it("generatePrefixFor with no option returns the default prefix itself", () => {
    assert.equal(generatePrefixFor(), STABLE_GENERATE_PREFIX);
    assert.equal(generatePrefixFor({}), STABLE_GENERATE_PREFIX);
    assert.equal(generatePrefixFor({ maxDishes: undefined }), STABLE_GENERATE_PREFIX);
  });
});

describe("THX-2G — generatePrefixFor({ maxDishes }) swaps exactly one sentence", () => {
  it("the default dish-range sentence is in the prefix exactly once", () => {
    const first = STABLE_GENERATE_PREFIX.indexOf(DEFAULT_DISH_RANGE_SENTENCE);
    assert.ok(first >= 0);
    assert.equal(STABLE_GENERATE_PREFIX.indexOf(DEFAULT_DISH_RANGE_SENTENCE, first + 1), -1);
  });
  it("the variant differs from the default only in that sentence", () => {
    const v = generatePrefixFor({ maxDishes: 8 });
    const at = STABLE_GENERATE_PREFIX.indexOf(DEFAULT_DISH_RANGE_SENTENCE);
    assert.equal(v.slice(0, at), STABLE_GENERATE_PREFIX.slice(0, at));
    assert.equal(v.slice(at, at + dishRangeSentence(8).length), dishRangeSentence(8));
    assert.equal(v.slice(at + dishRangeSentence(8).length), STABLE_GENERATE_PREFIX.slice(at + DEFAULT_DISH_RANGE_SENTENCE.length));
    assert.ok(!v.includes(DEFAULT_DISH_RANGE_SENTENCE));
    assert.equal(generatePrefixFor({ maxDishes: 8 }), v, "the variant is stable (cacheable) across calls");
  });
  it("refuses a dish range outside 1–12", () => {
    for (const bad of [0, 13, 2.5, -1]) assert.throws(() => generatePrefixFor({ maxDishes: bad }));
  });
});

// ── 2. each option, absent, is today's behaviour ─────────────────────────────

describe("THX-2G — generateInput / finalizeInput briefs", () => {
  it("no brief, an empty brief and a blank brief are all today's input", () => {
    const base = generateInput("Turkey", PROFILE, ["Turkey", "Gravy"], "pie crust");
    assert.equal(generateInput("Turkey", PROFILE, ["Turkey", "Gravy"], "pie crust", undefined), base);
    assert.equal(generateInput("Turkey", PROFILE, ["Turkey", "Gravy"], "pie crust", ""), base);
    assert.equal(generateInput("Turkey", PROFILE, ["Turkey", "Gravy"], "pie crust", "  "), base);
    const meal = makeMeal();
    assert.equal(finalizeInput(meal), JSON.stringify({ meals: [meal] }));
    assert.equal(finalizeInput(meal, undefined), finalizeInput(meal));
    assert.equal(finalizeInput(meal, " "), finalizeInput(meal));
  });
  it("a brief sits under the JSON and the shortcut line stays LAST", () => {
    const out = generateInput("Turkey", PROFILE, ["Turkey"], "pie crust", "For ten.");
    const json = JSON.stringify({ targetDish: "Turkey", servings: 4, difficulty: "easy", dishes: ["Turkey"] });
    assert.ok(out.startsWith(`${json}\n\nBrief: For ten.\n\nStore-bought shortcut the cook uses for this dinner: pie crust.`));
    assert.equal(generateInput("Turkey", PROFILE, undefined, undefined, "For ten."), `${JSON.stringify({ targetDish: "Turkey", servings: 4, difficulty: "easy" })}\n\nBrief: For ten.`);
    assert.equal(finalizeInput(makeMeal(), "Monday."), `${JSON.stringify({ meals: [makeMeal()] })}\n\nBrief: Monday.`);
  });
});

describe("THX-2G — tags, payload extras, target, completeness", () => {
  it("buildTags with no extras is [cuisine, difficulty]; extras append, deduplicated", () => {
    assert.deepEqual(buildTags(makeMeal()), ["american", "easy"]);
    assert.deepEqual(buildTags(makeMeal(), []), ["american", "easy"]);
    assert.deepEqual(buildTags(makeMeal(), ["thanksgiving", "easy"]), ["american", "easy", "thanksgiving"]);
  });
  it("buildMaterializePayload with no extras writes no dish tags and today's meal tags", () => {
    const meal = makeMeal();
    const merged = mergeSteps(meal, finalizeFor(meal));
    assert.ok(merged.ok);
    if (!merged.ok) return;
    const plain = buildMaterializePayload(meal, merged.stepsPerDish, [], "k", merged.registryPerDish);
    assert.deepEqual(plain, buildMaterializePayload(meal, merged.stepsPerDish, [], "k", merged.registryPerDish, {}));
    assert.deepEqual(plain.tags, ["american", "easy"]);
    for (const d of plain.dishes) assert.ok(!("tags" in d), "no tags key on a dish");
    const themed = buildMaterializePayload(meal, merged.stepsPerDish, [], "k", merged.registryPerDish, { tags: ["thanksgiving"], dishTags: ["thanksgiving", "course-sides"] });
    assert.deepEqual(themed.tags, ["american", "easy", "thanksgiving"]);
    for (const d of themed.dishes) assert.deepEqual(d.kind === "new" ? d.tags : null, ["thanksgiving", "course-sides"]);
  });
  it("storeFillTarget: absent/true is STORE_FILL_TARGET itself; false is non-public, same owner and provenance", () => {
    assert.equal(storeFillTarget(), STORE_FILL_TARGET);
    assert.equal(storeFillTarget(true), STORE_FILL_TARGET);
    assert.deepEqual(storeFillTarget(false), { userId: null, isPublic: false, sourceType: "batch_generated" });
    assert.equal(STORE_FILL_TARGET.isPublic, true, "the constant is not mutated");
  });
  it("singleDishComplete passes a lone side mealComplete rejects, and rejects a padded dinner", () => {
    assert.equal(mealComplete(loneSide()).ok, false);
    assert.deepEqual(singleDishComplete(loneSide()), { ok: true });
    assert.deepEqual(singleDishComplete(makeMeal()), { ok: false, reason: "not_single_dish" });
  });
});

describe("THX-2G — runStoreFill on the wire", () => {
  it("with no new option: default prefixes, no maxTokens key, today's inputs", async () => {
    const meal = makeMeal();
    const log: Recorded[] = [];
    await runStoreFill({ prisma: fakePrisma(), runAICall: recordingRunAICall([ok(meal)], [ok(finalizeFor(meal))], log) }, { apply: false, limit: 1, dishes: [DISH], profiles: [PROFILE] });
    const [gen, fin] = log;
    assert.equal(gen.opts.cachedSystemPrefix, STABLE_GENERATE_PREFIX);
    assert.equal(fin.opts.cachedSystemPrefix, STABLE_FINALIZE_PREFIX);
    assert.ok(!("maxTokens" in gen.opts) && !("maxTokens" in fin.opts));
    assert.equal(gen.vars.generateInput, generateInput(DISH.dish, PROFILE));
    assert.equal(fin.vars.finalizeInput, finalizeInput(meal));
  });
  it("with the THX-2G options: the variant prefix, the cap on both calls, both briefs", async () => {
    const meal = makeMeal();
    const log: Recorded[] = [];
    await runStoreFill(
      { prisma: fakePrisma(), runAICall: recordingRunAICall([ok(meal)], [ok(finalizeFor(meal))], log) },
      { apply: false, limit: 1, dishes: [DISH], profiles: [PROFILE], maxDishes: 8, maxOutputTokens: 16000, brief: "For ten.", finalizeBrief: "Monday." },
    );
    const [gen, fin] = log;
    assert.equal(gen.opts.cachedSystemPrefix, generatePrefixFor({ maxDishes: 8 }));
    assert.equal(fin.opts.cachedSystemPrefix, STABLE_FINALIZE_PREFIX);
    assert.equal(gen.opts.maxTokens, 16000);
    assert.equal(fin.opts.maxTokens, 16000);
    assert.equal(gen.vars.generateInput, generateInput(DISH.dish, PROFILE, undefined, undefined, "For ten."));
    assert.equal(fin.vars.finalizeInput, finalizeInput(meal, "Monday."));
  });
  it("completeness: the default still rejects a lone side; single_dish accepts it", async () => {
    const dflt = await runStoreFill(
      { prisma: fakePrisma(), runAICall: recordingRunAICall([ok(loneSide()), ok(loneSide()), ok(loneSide())], [], []) },
      { apply: false, limit: 1, dishes: [DISH], profiles: [PROFILE] },
    );
    assert.equal(dflt.records.length, 0);
    assert.equal(dflt.completenessRejections.length, 3);
    const side = loneSide();
    const single = await runStoreFill(
      { prisma: fakePrisma(), runAICall: recordingRunAICall([ok(side)], [ok(finalizeFor(side))], []) },
      { apply: false, limit: 1, dishes: [DISH], profiles: [PROFILE], completeness: "single_dish" },
    );
    assert.equal(single.records.length, 1);
    assert.equal(single.completenessRejections.length, 0);
  });
});

describe("THX-2G — transactionTimeoutMs on the per-meal write", () => {
  async function txArgs(transactionTimeoutMs?: number): Promise<unknown[]> {
    const meal = makeMeal();
    const seen: unknown[][] = [];
    // Every model read answers empty and every upsert mints an id, so
    // resolveIngredients runs through; the write itself is stubbed at $transaction.
    const model = { findMany: async () => [], findFirst: async () => null, findUnique: async () => null, upsert: async () => ({ id: "ing-1" }) };
    const prisma = new Proxy(
      { $transaction: async (...args: unknown[]) => { seen.push(args); return { mealId: "m1", dishIds: [], linksCreated: 0 }; } },
      { get: (target, prop) => (prop in target ? target[prop as keyof typeof target] : typeof prop === "string" && !prop.startsWith("$") ? model : undefined) },
    ) as unknown as PrismaClient;
    const r = await runStoreFill(
      { prisma, runAICall: recordingRunAICall([ok(meal)], [ok(finalizeFor(meal))], []) },
      { apply: true, limit: 1, dishes: [DISH], profiles: [PROFILE], ...(transactionTimeoutMs !== undefined ? { transactionTimeoutMs } : {}) },
    ).catch((e: unknown) => e);
    if (seen.length === 0) throw r instanceof Error ? r : new Error("no $transaction call");
    return seen[0];
  }
  it("absent → $transaction(fn) with no options argument, as today", async () => {
    const args = await txArgs();
    assert.equal(args.length, 1);
  });
  it("set → $transaction(fn, { timeout })", async () => {
    const args = await txArgs(60_000);
    assert.deepEqual(args[1], { timeout: 60_000 });
  });
});

describe("THX-2G — materializeMeal: dish tags and the non-public target", () => {
  function fakeTx(createdMeals: Array<Record<string, unknown>>, createdDishes: Array<Record<string, unknown>>) {
    let seq = 0;
    return {
      meal: {
        create: async ({ data }: { data: Record<string, unknown> }) => { createdMeals.push(data); return { id: "meal-1" }; },
        update: async () => ({}),
        findUnique: async (args: { select?: Record<string, unknown> }) =>
          args.select && "dishLinks" in args.select ? { dishLinks: [] } : { allergens: [], allergenSources: null, allergensStampedAt: null },
      },
      dish: { create: async ({ data }: { data: Record<string, unknown> }) => { createdDishes.push(data); return { id: `dish-${seq++}` }; } },
      mealDishLink: { create: async () => ({}), findMany: async () => [] },
      dishIngredient: { create: async () => ({}) },
      recipeInstructionStep: { findMany: async () => [], create: async () => ({}) },
    };
  }
  async function write(extras: Parameters<typeof buildMaterializePayload>[5], isPublic?: boolean) {
    const meal = makeMeal();
    const merged = mergeSteps(meal, finalizeFor(meal));
    if (!merged.ok) throw new Error("merge");
    const payload = buildMaterializePayload(meal, merged.stepsPerDish, [], "k", merged.registryPerDish, extras);
    const map = new Map<string, string>([["chicken breast", "i1"], ["white rice", "i2"]]);
    const meals: Array<Record<string, unknown>> = [];
    const dishes: Array<Record<string, unknown>> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await materializeMeal(fakeTx(meals, dishes) as any, "", payload, map, storeFillTarget(isPublic));
    return { meal: meals[0], dishes };
  }
  it("no dish tags → no `tags` key on the Dish create (the column default, as before)", async () => {
    const { meal, dishes } = await write(undefined);
    assert.equal(meal.isPublic, true);
    for (const d of dishes) assert.ok(!("tags" in d));
  });
  it("dish tags and isPublic:false reach the write", async () => {
    const { meal, dishes } = await write({ tags: ["thanksgiving"], dishTags: ["thanksgiving", "course-sides"] }, false);
    assert.equal(meal.isPublic, false);
    assert.equal(meal.userId, null);
    assert.equal(meal.sourceType, "batch_generated");
    assert.deepEqual(meal.tags, ["american", "easy", "thanksgiving"]);
    for (const d of dishes) assert.deepEqual(d.tags, ["thanksgiving", "course-sides"]);
  });
});

// WS9 BUG-274 — macros at save.
//
// POST /me/meals never estimated macros: the builder / parse / import adapters
// send none, recomputeAndPersistMealMacros only SUMS, and the grounded
// estimator was reached only from plan recalc + wizard expansion. The pre-pass
// in materializeMeal estimates each zero-macro `kind:"new"` dish (in parallel,
// before any row is written), stamps macros + macroGroundedPct on the create,
// emits dish_macros_estimated, and FAILS SOFT.
//
// The estimator is stubbed at the opts seam — no AI call, no DB.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { materializeMeal, type MaterializeMealPayload } from "../mealMaterialize";
import type { EstimateDishMacrosResult } from "../dishMacros";

function makeFakeTx() {
  const dishCreates: Array<Record<string, unknown>> = [];
  const activity: Array<Record<string, unknown>> = [];
  let dishSeq = 0;
  const tx = {
    meal: {
      create: async () => ({ id: "meal-1" }),
      update: async () => ({}),
      findUnique: async (args: { select?: Record<string, unknown> }) =>
        args.select && "dishLinks" in args.select
          ? { dishLinks: [] }
          : { allergens: [], allergenSources: null, allergensStampedAt: null },
    },
    dish: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        dishCreates.push(data);
        return { id: `dish-${dishSeq++}` };
      },
      update: async () => ({}),
    },
    ingredient: {
      findMany: async () => [
        {
          id: "ing-chicken",
          canonicalName: "chicken breast",
          nutritionRefPerUnit: {
            source: "usda",
            matched: true,
            basis: "per100g",
            per100g: { calories: 165, protein: 31, carbs: 0, fat: 3.6 },
          },
          conversionRef: null,
        },
      ],
    },
    userActivity: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        activity.push(data);
        return {};
      },
    },
    mealDishLink: { create: async () => ({}), findMany: async () => [] },
    dishIngredient: { create: async () => ({}) },
    recipeInstructionStep: { create: async () => ({}), findMany: async () => [] },
  };
  return { tx, dishCreates, activity };
}

function threeDishPayload(): MaterializeMealPayload {
  return {
    title: "Grilled chicken with rice pilaf and green beans",
    sourceType: "directed",
    servingsDefault: 4,
    dishes: [
      {
        kind: "new",
        title: "Grilled Chicken Breast",
        role: "main",
        positionIndex: 0,
        ingredients: [{ name: "chicken breast", quantity: 4, unit: "pieces" }],
        steps: [{ text: "Grill.", estimatedMinutes: 12, phaseType: "cook" }],
        // absent macros -> estimate
      },
      {
        kind: "new",
        title: "Rice Pilaf",
        role: "side",
        positionIndex: 1,
        ingredients: [{ name: "rice", quantity: 1.5, unit: "cups" }],
        steps: [{ text: "Simmer.", estimatedMinutes: 18, phaseType: "cook" }],
        // explicit all-zero macros -> estimate (same predicate as plan recalc)
        macros: {
          caloriesPerServing: 0,
          proteinGPerServing: 0,
          carbsGPerServing: 0,
          fatGPerServing: 0,
        },
      },
      {
        kind: "new",
        title: "Steamed Green Beans",
        role: "side",
        positionIndex: 2,
        ingredients: [{ name: "green beans", quantity: 1, unit: "lb" }],
        steps: [{ text: "Steam.", estimatedMinutes: 6, phaseType: "cook" }],
        // user-authored non-zero macros -> LEFT ALONE
        macros: {
          caloriesPerServing: 44,
          proteinGPerServing: 2,
          carbsGPerServing: 10,
          fatGPerServing: 0,
        },
      },
    ],
  };
}

const INGREDIENT_MAP = new Map([
  ["chicken breast", "ing-chicken"],
  ["rice", "ing-rice"],
  ["green beans", "ing-beans"],
]);

function successFor(calories: number): EstimateDishMacrosResult {
  return {
    status: "success",
    perServing: {
      calories,
      proteinG: calories / 10,
      carbsG: calories / 5,
      fatG: calories / 20,
    },
    sanityFlags: [],
    grounding: { status: "partial", ratio: 0.5, matched: 1, total: 2 } as never,
  };
}

describe("BUG-274 — materializeMeal estimates zero-macro dishes at save", () => {
  it("zero/absent dishes are estimated (in parallel, grounded); non-zero dishes are left alone", async () => {
    const { tx, dishCreates, activity } = makeFakeTx();
    const calls: Array<{ dishTitle: string; ingredients: unknown[] }> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    await materializeMeal(
      tx as never,
      "user-1",
      threeDishPayload(),
      INGREDIENT_MAP,
      undefined,
      {
        estimateMacros: true,
        estimateDishMacrosImpl: async (o) => {
          calls.push({ dishTitle: o.dishTitle, ingredients: o.ingredients });
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          assert.equal(
            o.skipConversionWriteback,
            true,
            "no ingredient write-back inside the tx",
          );
          assert.equal(o.servings, 4);
          return successFor(o.dishTitle === "Rice Pilaf" ? 210 : 280);
        },
      },
    );

    assert.deepEqual(
      calls.map((c) => c.dishTitle).sort(),
      ["Grilled Chicken Breast", "Rice Pilaf"],
      "exactly the two zero-macro dishes are estimated",
    );
    assert.equal(maxInFlight, 2, "the two estimates run concurrently");
    // Grounding: the chicken ingredient carried the USDA ref + identity.
    const chicken = calls.find((c) => c.dishTitle === "Grilled Chicken Breast")!;
    assert.deepEqual(chicken.ingredients[0], {
      name: "chicken breast",
      quantity: 4,
      unit: "pieces",
      isOptional: false,
      nutritionRefPer100g: { calories: 165, protein: 31, carbs: 0, fat: 3.6 },
      ingredientId: "ing-chicken",
      canonicalName: "chicken breast",
      conversionRef: null,
    });

    assert.equal(dishCreates.length, 3);
    assert.equal(dishCreates[0].caloriesPerServing, 280);
    assert.equal(dishCreates[0].proteinGPerServing, 28);
    assert.equal(dishCreates[0].macroGroundedPct, 50, "grounding stamped like plan recalc");
    assert.equal(dishCreates[1].caloriesPerServing, 210);
    assert.equal(dishCreates[1].macroGroundedPct, 50);
    // The user-authored dish is byte-identical to the pre-fix write.
    assert.equal(dishCreates[2].caloriesPerServing, 44);
    assert.equal(dishCreates[2].proteinGPerServing, 2);
    assert.ok(!("macroGroundedPct" in dishCreates[2]));

    assert.deepEqual(
      activity.map((a) => [a.eventType, a.entityId, a.userId]),
      [
        ["dish_macros_estimated", "dish-0", "user-1"],
        ["dish_macros_estimated", "dish-1", "user-1"],
      ],
      "one dish_macros_estimated per estimated dish, none for the authored one",
    );
  });

  it("an estimator THROW or a failed result still saves the meal, that dish at zero", async () => {
    const { tx, dishCreates, activity } = makeFakeTx();
    const res = await materializeMeal(
      tx as never,
      "user-1",
      threeDishPayload(),
      INGREDIENT_MAP,
      undefined,
      {
        estimateMacros: true,
        estimateDishMacrosImpl: async (o) => {
          if (o.dishTitle === "Grilled Chicken Breast") throw new Error("boom");
          return { status: "failed", error: "spend guard" };
        },
      },
    );
    assert.equal(res.mealId, "meal-1");
    assert.equal(res.dishIds.length, 3, "the save completed");
    assert.equal(dishCreates.length, 3);
    // Both zero dishes stay at zero (absent -> column default; explicit -> 0).
    assert.ok(!("caloriesPerServing" in dishCreates[0]));
    assert.equal(dishCreates[1].caloriesPerServing, 0);
    assert.equal(dishCreates[2].caloriesPerServing, 44);
    assert.equal(activity.length, 0, "no dish_macros_estimated for a failed estimate");
  });

  it("a slow estimator is cut at the deadline and the save proceeds at zero", async () => {
    const { tx, dishCreates } = makeFakeTx();
    const started = Date.now();
    await materializeMeal(
      tx as never,
      "user-1",
      threeDishPayload(),
      INGREDIENT_MAP,
      undefined,
      {
        estimateMacros: true,
        estimateDeadlineMs: 20,
        estimateDishMacrosImpl: () =>
          new Promise((r) => setTimeout(() => r(successFor(999)), 500)),
      },
    );
    assert.ok(Date.now() - started < 400, "did not wait for the slow estimate");
    assert.ok(!("caloriesPerServing" in dishCreates[0]));
    assert.equal(dishCreates[1].caloriesPerServing, 0);
  });

  it("OFF by default, and off on the store-pool (target) path even when asked", async () => {
    let calls = 0;
    const impl = async () => {
      calls++;
      return successFor(100);
    };
    const a = makeFakeTx();
    await materializeMeal(
      a.tx as never,
      "user-1",
      threeDishPayload(),
      INGREDIENT_MAP,
      undefined,
      { estimateDishMacrosImpl: impl },
    );
    assert.equal(calls, 0, "no estimateMacros flag -> no call");
    assert.ok(!("caloriesPerServing" in a.dishCreates[0]));

    const b = makeFakeTx();
    await materializeMeal(
      b.tx as never,
      "",
      threeDishPayload(),
      INGREDIENT_MAP,
      { userId: null, isPublic: true, sourceType: "batch_generated" },
      { estimateMacros: true, estimateDishMacrosImpl: impl },
    );
    assert.equal(calls, 0, "store-fill target -> never estimates");
  });

  it("a tx without the grounding / activity surfaces still saves (ungrounded, warned)", async () => {
    const { tx, dishCreates } = makeFakeTx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (tx as any).ingredient;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (tx as any).userActivity;
    let seen: unknown[] = [];
    // Capture the CHICKEN call specifically (the two estimates race).
    await materializeMeal(
      tx as never,
      "user-1",
      threeDishPayload(),
      INGREDIENT_MAP,
      undefined,
      {
        estimateMacros: true,
        estimateDishMacrosImpl: async (o) => {
          if (o.dishTitle === "Grilled Chicken Breast") seen = o.ingredients;
          return successFor(300);
        },
      },
    );
    assert.equal(dishCreates[0].caloriesPerServing, 300);
    assert.deepEqual(seen[0], {
      name: "chicken breast",
      quantity: 4,
      unit: "pieces",
      isOptional: false,
    });
  });
});

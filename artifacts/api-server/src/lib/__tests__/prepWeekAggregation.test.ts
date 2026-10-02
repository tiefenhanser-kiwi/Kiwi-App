// WS6 6d-2 — loadPrepWeekInput loader unit tests.
// Mocked Prisma (ad-hoc stub keyed by planId). No DB.
// Mirrors the cookingSequence.test.ts / planMacros.test.ts harness style.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

import { prepCompositionFingerprint } from "../prepWeekFingerprint";
import { buildPrepCombineInput } from "../prepCombineAdapter";
import { combinePrep } from "../prepCombineEngine";
import { buildStepPlan } from "../prepWeekAssembly";
import { applyStorageOverlay, type StorageContext } from "../prepStorage";

import {
  loadPrepWeekInput,
  PrepWeekEmptyPlanError,
  PrepWeekNotFoundError,
  PrepWeekUnknownMealError,
} from "../prepWeekAggregation";

const USER_ID = "user-prep-week-test";
const OTHER_USER_ID = "user-prep-week-other";

interface IngredientFixture {
  id: string;
  displayName: string;
  canonicalName?: string;
  category?: string;
}

interface DishIngredientFixture {
  quantity: number;
  unit: string;
  preparationNote: string | null;
  ingredient: IngredientFixture;
  positionIndex: number;
}

interface DishFixture {
  id: string;
  title: string;
  servingsDefault: number;
  // WS7-8 BUG-003 — immutable authored anchor; null = legacy/seed row.
  authoredServingsDefault: number | null;
  dishIngredients: DishIngredientFixture[];
}

interface DishLinkFixture {
  dishId: string;
  positionIndex: number;
  dish: DishFixture;
}

interface MealFixture {
  id: string;
  title: string;
  cuisineType: string | null;
  servingsDefault: number;
  dishLinks: DishLinkFixture[];
}

interface ItemFixture {
  id: string;
  mealId: string;
  positionIndex: number;
  servingsOverride: number | null;
  meal: MealFixture;
  // D-WS9-298 — the cook day. Optional so every pre-existing fixture stays as it
  // is (undated, which is 4 of the 13 census plans).
  assignedDate?: Date | null;
  assignedDayOfWeek?: string | null;
}

interface PlanFixture {
  id: string;
  userId: string;
  revisionId: number;
  titleOverride: string | null;
  items: ItemFixture[];
  // D-WS9-298 — the prep-day baseline the lag is measured from.
  startDate?: Date | null;
}

interface StepFixture {
  ownerType: "dish" | "meal";
  ownerId: string;
  stepIndex: number;
  stepTextRaw: string;
}

/** D-WS9-297 ruling 8 — one `component` edge: `from` yields `to`. */
interface RelationFixture {
  toIngredientId: string;
  fromCanonicalName: string;
  yieldQuantity: number;
  yieldUnit: string;
}

function makePrismaStub(
  plans: PlanFixture[],
  steps: StepFixture[] = [],
  // D-WS9-297 ruling 8 — `component` edges, for the sourceYield lookup. Default
  // empty: every pre-existing test asserts a payload with sourceYield null, which
  // is the shape for an ingredient with no component parent (nearly all of them).
  relations: RelationFixture[] = [],
): PrismaClient {
  return {
    mealPlanInstance: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const p = plans.find((pp) => pp.id === where.id);
        return p ?? null;
      },
    },
    recipeInstructionStep: {
      findMany: async ({
        where,
      }: {
        where: { ownerType: string; ownerId: { in: string[] } };
      }) =>
        steps
          .filter(
            (s) =>
              s.ownerType === where.ownerType &&
              where.ownerId.in.includes(s.ownerId),
          )
          .sort((a, b) => a.stepIndex - b.stepIndex)
          .map((s) => ({ ownerId: s.ownerId, stepTextRaw: s.stepTextRaw })),
    },
    ingredientRelation: {
      findMany: async ({
        where,
      }: {
        where: { toIngredientId: { in: string[] } };
      }) =>
        relations
          .filter((r) => where.toIngredientId.in.includes(r.toIngredientId))
          .map((r) => ({
            toIngredientId: r.toIngredientId,
            yieldQuantity: r.yieldQuantity,
            yieldUnit: r.yieldUnit,
            from: { canonicalName: r.fromCanonicalName },
          })),
    },
  } as unknown as PrismaClient;
}

const PLAN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEAL_A = "11111111-1111-4111-8111-111111111111";
const MEAL_B = "22222222-2222-4222-8222-222222222222";
const DISH_A1 = "33333333-3333-4333-8333-333333333333";
const DISH_B1 = "44444444-4444-4444-8444-444444444444";
const ING_ONION = "55555555-5555-4555-8555-555555555555";
const ING_GARLIC = "66666666-6666-4666-8666-666666666666";

function plan(opts?: Partial<PlanFixture>): PlanFixture {
  return {
    id: PLAN_ID,
    userId: USER_ID,
    revisionId: 1,
    titleOverride: "Test Week",
    items: [
      {
        id: "item-a",
        mealId: MEAL_A,
        positionIndex: 0,
        servingsOverride: null,
        meal: {
          id: MEAL_A,
          title: "Tacos",
          cuisineType: "Mexican",
          servingsDefault: 4,
          dishLinks: [
            {
              dishId: DISH_A1,
              positionIndex: 0,
              dish: {
                id: DISH_A1,
                title: "Beef tacos",
                servingsDefault: 4,
                // Legacy/seed row — no anchor; loader carries null through.
                authoredServingsDefault: null,
                dishIngredients: [
                  {
                    quantity: 2,
                    unit: "medium",
                    preparationNote: "diced",
                    positionIndex: 0,
                    ingredient: {
                      id: ING_ONION,
                      displayName: "yellow onion",
                      category: "Produce",
                    },
                  },
                  {
                    quantity: 3,
                    unit: "cloves",
                    preparationNote: "minced",
                    positionIndex: 1,
                    ingredient: {
                      id: ING_GARLIC,
                      displayName: "garlic",
                      category: "Produce",
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      {
        id: "item-b",
        mealId: MEAL_B,
        positionIndex: 1,
        servingsOverride: 6,
        meal: {
          id: MEAL_B,
          title: "Stir Fry",
          cuisineType: null,
          servingsDefault: 4,
          dishLinks: [
            {
              dishId: DISH_B1,
              positionIndex: 0,
              dish: {
                id: DISH_B1,
                title: "Chicken stir fry",
                servingsDefault: 4,
                // Fresh row — anchor set at create (== servingsDefault).
                authoredServingsDefault: 4,
                dishIngredients: [
                  {
                    quantity: 1,
                    unit: "medium",
                    preparationNote: "diced",
                    positionIndex: 0,
                    ingredient: {
                      id: ING_ONION,
                      displayName: "yellow onion",
                      category: "Produce",
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
    ...opts,
  };
}

describe("loadPrepWeekInput — access checks", () => {
  it("throws NotFoundError when the plan does not exist", async () => {
    const prisma = makePrismaStub([]);
    await assert.rejects(
      loadPrepWeekInput({ planId: "missing", userId: USER_ID, prisma }),
      (err) => err instanceof PrepWeekNotFoundError,
    );
  });

  it("throws NotFoundError when the plan belongs to a different user (no leak)", async () => {
    const prisma = makePrismaStub([plan({ userId: OTHER_USER_ID })]);
    await assert.rejects(
      loadPrepWeekInput({ planId: PLAN_ID, userId: USER_ID, prisma }),
      (err) => err instanceof PrepWeekNotFoundError,
    );
  });
});

describe("loadPrepWeekInput — empty-plan paths", () => {
  it("throws EmptyPlanError when items is empty", async () => {
    const prisma = makePrismaStub([plan({ items: [] })]);
    await assert.rejects(
      loadPrepWeekInput({ planId: PLAN_ID, userId: USER_ID, prisma }),
      (err) => err instanceof PrepWeekEmptyPlanError,
    );
  });

  it("throws EmptyPlanError when every meal has no dishes/ingredients", async () => {
    const p = plan();
    // Strip every dish's ingredients — loader filters such dishes, then the
    // whole meal, then the whole plan, surfacing EmptyPlanError.
    for (const it of p.items) {
      for (const link of it.meal.dishLinks) {
        link.dish.dishIngredients = [];
      }
    }
    const prisma = makePrismaStub([p]);
    await assert.rejects(
      loadPrepWeekInput({ planId: PLAN_ID, userId: USER_ID, prisma }),
      (err) => err instanceof PrepWeekEmptyPlanError,
    );
  });
});

describe("loadPrepWeekInput — payload shape", () => {
  it("returns input + planRevisionId on the happy path", async () => {
    const prisma = makePrismaStub([plan({ revisionId: 7 })]);
    const { input, planRevisionId } = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma,
    });
    assert.equal(planRevisionId, 7);
    assert.equal(input.planId, PLAN_ID);
    assert.equal(input.meals.length, 2);
  });

  it("carries servingsOverride through un-applied (scaling is the adapter's job)", async () => {
    const prisma = makePrismaStub([plan()]);
    const { input } = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma,
    });
    const stirFry = input.meals.find((m) => m.mealId === MEAL_B);
    assert.ok(stirFry);
    // item-b sets servingsOverride: 6 — carried verbatim, not pre-applied.
    assert.equal(stirFry.servingsOverride, 6);
    // Dish base servings = dish.servingsDefault (the adapter's scaling base).
    assert.equal(stirFry.dishes[0].baseServings, 4);
    // WS7-8 BUG-003 — anchor carried through verbatim (fresh row → 4).
    assert.equal(stirFry.dishes[0].authoredBaseServings, 4);
    // Quantity stays RAW (1), NOT scaled to 1.5 — the loader never scales.
    const onion = stirFry.dishes[0].ingredients.find(
      (i) => i.ingredientId === ING_ONION,
    );
    assert.ok(onion);
    assert.equal(onion.quantity, 1);
  });

  it("carries servingsOverride=null when the plan-item has no override", async () => {
    const prisma = makePrismaStub([plan()]);
    const { input } = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma,
    });
    const tacos = input.meals.find((m) => m.mealId === MEAL_A);
    assert.ok(tacos);
    // item-a leaves servingsOverride null — carried as null (adapter falls
    // back to the dish base when scaling).
    assert.equal(tacos.servingsOverride, null);
    assert.equal(tacos.dishes[0].baseServings, 4);
    // WS7-8 BUG-003 — legacy row's null anchor carried through verbatim.
    assert.equal(tacos.dishes[0].authoredBaseServings, null);
  });

  it("carries Ingredient.category onto each ingredient", async () => {
    const prisma = makePrismaStub([plan()]);
    const { input } = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma,
    });
    const tacos = input.meals.find((m) => m.mealId === MEAL_A);
    assert.ok(tacos);
    const onion = tacos.dishes[0].ingredients.find(
      (i) => i.ingredientId === ING_ONION,
    );
    assert.ok(onion);
    assert.equal(onion.category, "Produce");
  });

  it("carries preparationNote (singular) — value when present, null when absent", async () => {
    const prisma = makePrismaStub([plan()]);
    const { input } = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma,
    });
    const tacos = input.meals.find((m) => m.mealId === MEAL_A);
    assert.ok(tacos);
    const onion = tacos.dishes[0].ingredients.find(
      (i) => i.ingredientId === ING_ONION,
    );
    assert.ok(onion);
    assert.equal(onion.preparationNote, "diced");

    // Force a null prepNote and re-run.
    const p2 = plan();
    p2.items[0].meal.dishLinks[0].dish.dishIngredients[0].preparationNote = null;
    const prisma2 = makePrismaStub([p2]);
    const { input: input2 } = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma: prisma2,
    });
    const tacos2 = input2.meals.find((m) => m.mealId === MEAL_A);
    assert.ok(tacos2);
    const onion2 = tacos2.dishes[0].ingredients.find(
      (i) => i.ingredientId === ING_ONION,
    );
    assert.ok(onion2);
    // Present as null (not omitted) on no-prep ingredients.
    assert.equal(onion2.preparationNote, null);
  });

  it("threads cuisineType into the meal payload when present", async () => {
    const prisma = makePrismaStub([plan()]);
    const { input } = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma,
    });
    const tacos = input.meals.find((m) => m.mealId === MEAL_A);
    const stirFry = input.meals.find((m) => m.mealId === MEAL_B);
    assert.ok(tacos && stirFry);
    assert.equal(tacos.cuisine, "Mexican");
    // cuisine is now always present as a field; null when the meal has none.
    assert.equal(stirFry.cuisine, null);
  });
});

describe("loadPrepWeekInput — step text (WS7-8a B2b)", () => {
  it("folds BOTH dish-owned and meal-owned steps into a dish's stepTexts", async () => {
    const steps: StepFixture[] = [
      // dish-owned (multi-dish path)
      { ownerType: "dish", ownerId: DISH_A1, stepIndex: 1, stepTextRaw: "Dice the onion." },
      { ownerType: "dish", ownerId: DISH_A1, stepIndex: 0, stepTextRaw: "Mince the garlic." },
      // meal-owned (single-dish path) on the SAME meal
      { ownerType: "meal", ownerId: MEAL_A, stepIndex: 0, stepTextRaw: "Season the beef and brown it." },
      // dish-owned on the other meal's dish
      { ownerType: "dish", ownerId: DISH_B1, stepIndex: 0, stepTextRaw: "Stir-fry everything." },
    ];
    const prisma = makePrismaStub([plan()], steps);
    const { input } = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma,
    });
    const tacos = input.meals.find((m) => m.mealId === MEAL_A);
    assert.ok(tacos);
    // dish-owned steps (stepIndex order) THEN the meal-owned step.
    assert.deepEqual(tacos.dishes[0].stepTexts, [
      "Mince the garlic.",
      "Dice the onion.",
      "Season the beef and brown it.",
    ]);

    const stirFry = input.meals.find((m) => m.mealId === MEAL_B);
    assert.ok(stirFry);
    // MEAL_B has no meal-owned steps → only its dish-owned step.
    assert.deepEqual(stirFry.dishes[0].stepTexts, ["Stir-fry everything."]);
  });

  it("leaves stepTexts empty when no steps exist", async () => {
    const prisma = makePrismaStub([plan()], []);
    const { input } = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma,
    });
    for (const meal of input.meals) {
      for (const dish of meal.dishes) {
        assert.deepEqual(dish.stepTexts, []);
      }
    }
  });
});

// ── WS9 Prep Selected Meals — the `mealIds` subset filter ───────────────────
// The filter lives in the loader (not the route) so ONE code path feeds the
// engine, the step plan, the narration input and the assembled result. These
// tests pin the two things that path must guarantee: only the named meals get
// through, and an id that isn't in the plan is REJECTED rather than dropped.

describe("loadPrepWeekInput — mealIds subset (WS9)", () => {
  it("passes only the named meals to the aggregation input", async () => {
    const prisma = makePrismaStub([plan()]);
    const { input } = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma,
      mealIds: [MEAL_B],
    });
    // Read the LIVE result, not a restated literal: the ids actually present.
    assert.deepEqual(
      input.meals.map((m) => m.mealId),
      [MEAL_B],
    );
    // And the excluded meal's ingredients are genuinely absent — MEAL_A is the
    // only source of garlic in this fixture, so its absence proves the filter
    // reached the ingredient level, not just the meal list.
    const allIngredientIds = input.meals.flatMap((m) =>
      m.dishes.flatMap((d) => d.ingredients.map((i) => i.ingredientId)),
    );
    assert.equal(allIngredientIds.includes(ING_GARLIC), false);
    assert.equal(allIngredientIds.includes(ING_ONION), true);
  });

  it("selecting every meal reproduces the full-week input exactly", async () => {
    const prisma = makePrismaStub([plan()]);
    const full = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma,
    });
    const explicit = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma,
      mealIds: [MEAL_A, MEAL_B],
    });
    assert.deepEqual(explicit.input, full.input);
    assert.equal(explicit.planRevisionId, full.planRevisionId);
  });

  it("omitting mealIds is byte-identical to today's full-week behaviour", async () => {
    const prisma = makePrismaStub([plan()]);
    const { input } = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma,
      mealIds: undefined,
    });
    assert.deepEqual(
      input.meals.map((m) => m.mealId),
      [MEAL_A, MEAL_B],
    );
  });

  it("rejects an id that is not in the plan — and NAMES it", async () => {
    const prisma = makePrismaStub([plan()]);
    const foreign = "99999999-9999-4999-8999-999999999999";
    await assert.rejects(
      loadPrepWeekInput({
        planId: PLAN_ID,
        userId: USER_ID,
        prisma,
        mealIds: [MEAL_A, foreign],
      }),
      (err) => {
        assert.ok(err instanceof PrepWeekUnknownMealError);
        // Live read of the error's payload — the WHICH, not just the THAT.
        assert.deepEqual(err.unknownMealIds, [foreign]);
        return true;
      },
    );
  });

  it("a foreign id is never silently dropped down to the known ones", async () => {
    const prisma = makePrismaStub([plan()]);
    // If the loader narrowed instead of rejecting, this would resolve to a
    // one-meal input. It must throw instead.
    await assert.rejects(
      loadPrepWeekInput({
        planId: PLAN_ID,
        userId: USER_ID,
        prisma,
        mealIds: ["99999999-9999-4999-8999-999999999999"],
      }),
      (err) => err instanceof PrepWeekUnknownMealError,
    );
  });

  it("membership is checked against the plan, not against a non-owner's view", async () => {
    // Ownership still wins: a non-owner gets 404-shaped NotFound, never a
    // 400 that would confirm which meals the plan contains.
    const prisma = makePrismaStub([plan({ userId: OTHER_USER_ID })]);
    await assert.rejects(
      loadPrepWeekInput({
        planId: PLAN_ID,
        userId: USER_ID,
        prisma,
        mealIds: ["99999999-9999-4999-8999-999999999999"],
      }),
      (err) => err instanceof PrepWeekNotFoundError,
    );
  });
});

// ── WS9 BUG-338 / D-WS9-298 — THE CACHE MUST NOT SEE A DATE ──────────────────
//
// 🔴 THIS IS THE REVERSAL OF A B1 DECISION, AND THE TEST THAT KEEPS IT REVERSED.
// B1 put assignedDate/assignedDayOfWeek on `PrepLoadedMeal`.
// `prepCompositionFingerprint` hashes the WHOLE of `PrepLoadedPlan` — deliberately,
// with a long argument in its own header for why a field allowlist is the worse
// hazard — so every day reassignment became a cache MISS and cost ~73 s and
// ~$0.125 to regenerate a byte-identical payload. Hans moves days ad hoc all week.
//
// The dates now ride on `cookDays`, BESIDE the hashed input. Both halves are
// asserted below, because either alone would be satisfiable by a broken
// implementation: the fingerprint must not move, AND the dates must still arrive.

describe("loadPrepWeekInput — cook days ride beside the hashed input (D-WS9-298)", () => {
  const dated = (iso: string, day: string) =>
    plan({
      startDate: new Date("2026-10-04T00:00:00.000Z"),
      items: plan().items.map((it, i) =>
        i === 0 ? { ...it, assignedDate: new Date(iso), assignedDayOfWeek: day } : it,
      ),
    });

  it("a day reassignment does not move the composition fingerprint", async () => {
    const sunday = dated("2026-10-05T00:00:00.000Z", "Sunday");
    const friday = dated("2026-10-09T00:00:00.000Z", "Friday");
    const a = await loadPrepWeekInput({ planId: PLAN_ID, userId: USER_ID, prisma: makePrismaStub([sunday]) });
    const b = await loadPrepWeekInput({ planId: PLAN_ID, userId: USER_ID, prisma: makePrismaStub([friday]) });
    assert.equal(
      prepCompositionFingerprint(a.input),
      prepCompositionFingerprint(b.input),
      "moving a meal from Sunday to Friday changed the fingerprint — the cache will miss",
    );
  });

  it("…and the days DO arrive, on cookDays", async () => {
    // The other half. A fingerprint that never moves is also what you get by
    // dropping the days entirely, which would make D-WS9-298 unbuildable.
    //
    // 🔴 H3 item 14 — THE LAG IS DERIVED FROM THE NAME NOW. The plan starts on
    // Sunday 2026-10-04, so "Sunday" is 0 days out and "Friday" is 5.
    //
    // This test used to assert 1 and 5 off `assignedDate`, and its own fixture
    // carried the very defect the item-14 probe found on Hans's plan: it paired
    // the label "Sunday" with 2026-10-05, which is a MONDAY. The old assertion
    // was reading the date and calling it the day.
    const sunday = dated("2026-10-05T00:00:00.000Z", "Sunday");
    const friday = dated("2026-10-09T00:00:00.000Z", "Friday");
    const a = await loadPrepWeekInput({ planId: PLAN_ID, userId: USER_ID, prisma: makePrismaStub([sunday]) });
    const b = await loadPrepWeekInput({ planId: PLAN_ID, userId: USER_ID, prisma: makePrismaStub([friday]) });
    assert.equal(a.cookDays.prepDay, "2026-10-04");
    assert.equal(a.cookDays.lagByMealId.get(MEAL_A), 0);
    assert.equal(b.cookDays.lagByMealId.get(MEAL_A), 5);
    assert.equal(a.cookDays.dayNameByMealId.get(MEAL_A), "Sunday");
    assert.equal(b.cookDays.dayNameByMealId.get(MEAL_A), "Friday");
  });

  it("🔴 H3 item 14 — THE DAY NAME MOVES THE LAG AND `assignedDate` DOES NOT", async () => {
    // The defect, in one assertion pair. Hans moved a meal four times on Plan
    // Review; `PATCH /plans/:id/items/:itemId` writes `assignedDayOfWeek` and
    // nothing else (plans.ts:2443-2444), and the prep lane was reading
    // `assignedDate`, which is written once at plan creation and never again.
    const withDate = (day: string, iso: string | null) =>
      plan({
        startDate: new Date("2026-10-04T00:00:00.000Z"), // a Sunday
        items: plan().items.map((it, i) =>
          i === 0
            ? { ...it, assignedDayOfWeek: day, assignedDate: iso ? new Date(iso) : null }
            : it,
        ),
      });

    // Same stale date on both; only the NAME differs. The lag must follow.
    const asWed = await loadPrepWeekInput({
      planId: PLAN_ID, userId: USER_ID,
      prisma: makePrismaStub([withDate("Wednesday", "2026-10-05T00:00:00.000Z")]),
    });
    const asSat = await loadPrepWeekInput({
      planId: PLAN_ID, userId: USER_ID,
      prisma: makePrismaStub([withDate("Saturday", "2026-10-05T00:00:00.000Z")]),
    });
    assert.equal(asWed.cookDays.lagByMealId.get(MEAL_A), 3, "Wednesday is 3 days after Sunday");
    assert.equal(asSat.cookDays.lagByMealId.get(MEAL_A), 6, "Saturday is 6 days after Sunday");

    // …and the same name with WILDLY different dates gives the same lag, which
    // is the statement that `assignedDate` is no longer read at all.
    const dateA = await loadPrepWeekInput({
      planId: PLAN_ID, userId: USER_ID,
      prisma: makePrismaStub([withDate("Friday", "2026-10-09T00:00:00.000Z")]),
    });
    const dateB = await loadPrepWeekInput({
      planId: PLAN_ID, userId: USER_ID,
      prisma: makePrismaStub([withDate("Friday", "2027-03-02T00:00:00.000Z")]),
    });
    const noDate = await loadPrepWeekInput({
      planId: PLAN_ID, userId: USER_ID,
      prisma: makePrismaStub([withDate("Friday", null)]),
    });
    assert.equal(dateA.cookDays.lagByMealId.get(MEAL_A), 5);
    assert.equal(dateB.cookDays.lagByMealId.get(MEAL_A), 5, "a date five months out moved the lag");
    assert.equal(noDate.cookDays.lagByMealId.get(MEAL_A), 5, "a NULL date lost the lag");
  });

  it("a weekday earlier in the week than the start WRAPS FORWARD", async () => {
    // "Monday" on a Wednesday-start plan is next Monday, not five days ago.
    // Hans's own plan is this shape: start Wednesday 2026-09-30, chili "Monday".
    const p = plan({
      startDate: new Date("2026-09-30T00:00:00.000Z"), // a Wednesday
      items: plan().items.map((it, i) => (i === 0 ? { ...it, assignedDayOfWeek: "Monday" } : it)),
    });
    // `now` pinned to the start: this test's subject is the WRAP, and H5.0 made
    // the lag depend on today as well. Without the pin it asserts two things at
    // once and goes red on the calendar rather than on a defect.
    const r = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma: makePrismaStub([p]),
      now: new Date("2026-09-30T09:00:00.000Z"),
    });
    assert.equal(r.cookDays.lagByMealId.get(MEAL_A), 5);
  });

  it("the loaded input carries NO date-shaped field at all", async () => {
    // Structural, not behavioural: the guarantee is that nothing date-shaped can
    // reach the hash, not merely that today's two fields do not.
    const r = await loadPrepWeekInput({
      planId: PLAN_ID,
      userId: USER_ID,
      prisma: makePrismaStub([dated("2026-10-09T00:00:00.000Z", "Friday")]),
    });
    const json = JSON.stringify(r.input);
    for (const needle of ["assignedDate", "assignedDayOfWeek", "prepDay", "startDate", "2026-10"]) {
      assert.ok(!json.includes(needle), `"${needle}" reached the hashed input`);
    }
  });

  // ── H5.0 — THE PREP SESSION CANNOT HAPPEN IN THE PAST ───────────────────
  //
  // The block from Hans's October 2 device pass: the Proteins phase rendered no
  // steps although he was cooking the chicken the next day. The lag was the
  // weekday offset from `startDate`, so once the week had begun every lag was
  // inflated by the days that had passed — against a 2-day food-safety window.
  describe("the lag is measured from the prep session, not from startDate", () => {
    /** Hans's own plan: a Wednesday start, the chicken on Saturday. */
    const hansPlan = () =>
      plan({
        startDate: new Date("2026-09-30T00:00:00.000Z"), // Wednesday
        items: plan().items.map((it, i) =>
          i === 0 ? { ...it, assignedDayOfWeek: "Saturday", assignedDate: null } : it,
        ),
      });
    const at = (nowIso: string) =>
      loadPrepWeekInput({
        planId: PLAN_ID,
        userId: USER_ID,
        prisma: makePrismaStub([hansPlan()]),
        now: new Date(nowIso),
      });

    it("🔴 opened two days into the week, SATURDAY is one day out — not three", async () => {
      // The measured defect, exactly: on Friday Oct 2 the cook is prepping for
      // tomorrow, and the shipped code called it three days out and told them to
      // leave the chicken for cook day.
      const r = await at("2026-10-02T18:00:00.000Z");
      assert.equal(r.cookDays.prepDay, "2026-10-02", "the prep day stayed in the past");
      assert.equal(r.cookDays.lagByMealId.get(MEAL_A), 1);
    });

    it("…and opened BEFORE the week starts, the plan's start is still the anchor", async () => {
      const r = await at("2026-09-28T18:00:00.000Z");
      assert.equal(r.cookDays.prepDay, "2026-09-30");
      assert.equal(r.cookDays.lagByMealId.get(MEAL_A), 3, "Saturday is 3 days after Wednesday");
    });

    it("…and on the start day itself, the two anchors agree", async () => {
      const r = await at("2026-09-30T23:59:00.000Z");
      assert.equal(r.cookDays.prepDay, "2026-09-30");
      assert.equal(r.cookDays.lagByMealId.get(MEAL_A), 3);
    });

    it("🔴 a cook day already gone clamps to 0, never to a negative", async () => {
      // A negative lag would read as "keep" by accident — judgeProteinStep's
      // first arm is `<= 2` — rather than on purpose.
      const r = await at("2026-10-05T12:00:00.000Z"); // Monday, past Saturday
      assert.equal(r.cookDays.lagByMealId.get(MEAL_A), 0);
    });

    it("the anchor does NOT reach the hashed input — a new day is not a cache miss", async () => {
      const a = await at("2026-10-02T06:00:00.000Z");
      const b = await at("2026-10-04T06:00:00.000Z");
      assert.notEqual(
        a.cookDays.lagByMealId.get(MEAL_A),
        b.cookDays.lagByMealId.get(MEAL_A),
        "the two days must differ, or this test proves nothing",
      );
      assert.equal(
        prepCompositionFingerprint(a.input),
        prepCompositionFingerprint(b.input),
        "the clock reached the fingerprint — every day would cost ~73 s and ~$0.125",
      );
    });
  });

  // ── H5.0 — THE WHOLE SERVER CHAIN, on the shape that was broken ──────────
  //
  // The loader's lag is only half the defect: what Hans saw was an EMPTY PHASE,
  // which is applyStorageOverlay's `skipSuggested`. So run the chain the route
  // runs — loader → buildStepPlan → overlay — and assert on the phase.
  describe("the Proteins phase is not empty when the cook is cooking tomorrow", () => {
    const PROT_PLAN = "22222222-2222-4222-8222-222222222222";
    const PROT_MEAL = "33333333-3333-4333-8333-333333333333";

    /** One meal, one dish, one whole protein with knife work the recipe names. */
    const proteinPlan = (day: string): PlanFixture => ({
      id: PROT_PLAN,
      userId: USER_ID,
      revisionId: 1,
      titleOverride: "Protein Week",
      startDate: new Date("2026-09-30T00:00:00.000Z"), // a Wednesday
      items: [
        {
          id: "item-p",
          mealId: PROT_MEAL,
          positionIndex: 0,
          servingsOverride: null,
          assignedDayOfWeek: day,
          assignedDate: null,
          meal: {
            id: PROT_MEAL,
            title: "Lemon-Herb Baked Chicken Breast",
            cuisineType: null,
            servingsDefault: 4,
            dishLinks: [
              {
                dishId: "44444444-4444-4444-8444-444444444444",
                positionIndex: 0,
                dish: {
                  id: "44444444-4444-4444-8444-444444444444",
                  title: "Lemon-Herb Baked Chicken Breast",
                  servingsDefault: 4,
                  authoredServingsDefault: 4,
                  dishIngredients: [
                    {
                      quantity: 2,
                      unit: "lb",
                      preparationNote: "pounded to an even thickness",
                      positionIndex: 0,
                      ingredient: {
                        id: "55555555-5555-4555-8555-555555555555",
                        displayName: "boneless skinless chicken breasts",
                        category: "Protein",
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    });

    /** routes/cooking.ts's own context builder, keyed by stepKey. */
    const contextFor = (
      sp: ReturnType<typeof buildStepPlan>,
      lags: Map<string, number>,
      dayNames: Map<string, string>,
      names: Map<string, string>,
    ): Map<string, StorageContext> => {
      const m = new Map<string, StorageContext>();
      for (const st of sp.steps) {
        const ingredientNames = st.components.map((c) => c.ingredientName);
        const notes = st.components.flatMap((c) => [
          c.preparationNote ?? "",
          ...c.measures.map((x) => x.preparationNote ?? ""),
        ]);
        const latest = st.contributesToMealIds
          .map((id) => ({ id, lag: lags.get(id) ?? -1 }))
          .sort((x, y) => y.lag - x.lag)[0];
        const dayName = latest ? dayNames.get(latest.id) : undefined;
        const mealName = latest ? names.get(latest.id) : undefined;
        m.set(st.stepKey, {
          daysUntilCook: st.daysUntilCook,
          ...(dayName ? { dayName } : {}),
          ...(mealName ? { mealName } : {}),
          phase: st.phase,
          text: [...ingredientNames, ...notes].join(" "),
          bowlName: st.bowlName,
          ingredientNames,
        } as StorageContext);
      }
      return m;
    };

    async function run(day: string, nowIso: string) {
      const loaded = await loadPrepWeekInput({
        planId: PROT_PLAN,
        userId: USER_ID,
        prisma: makePrismaStub([proteinPlan(day)]),
        now: new Date(nowIso),
      });
      const lags = loaded.cookDays.lagByMealId;
      const dayNames = loaded.cookDays.dayNameByMealId;
      const names = new Map(loaded.input.meals.map((m) => [m.mealId, m.mealName]));
      const texts = new Map<string, string[]>();
      for (const m of loaded.input.meals) for (const d of m.dishes) texts.set(d.dishId, d.stepTexts);
      const sp = buildStepPlan(
        combinePrep(buildPrepCombineInput(loaded.input)),
        loaded.input.planName,
        texts,
        lags,
      );
      // An assembled-shaped result, with the ENGINE's keys — an overlay given an
      // unknown key drops the note instead of rewriting it, and the test would
      // pass vacuously.
      const result = {
        totalEstimatedMinutes: 20,
        phases: ["seasonings_dry", "produce", "sauces_marinades", "proteins"].map((phase) => ({
          phase,
          title: phase,
          skippable: false,
          steps: sp.steps
            .filter((x) => x.phase === phase && !x.demoted)
            .map((x, i) => ({
              number: i + 1,
              stepKey: x.stepKey,
              title: "Pound the chicken breasts",
              instructions: "Pound them to an even thickness.",
              estimatedMinutes: x.estimatedMinutes,
              contributesToMealIds: x.contributesToMealIds,
            })),
        })),
      };
      const overlaid = applyStorageOverlay(
        result as never,
        contextFor(sp, lags, dayNames, names),
      );
      const proteins = overlaid.phases.find((p) => p.phase === "proteins")!;
      return {
        lag: lags.get(PROT_MEAL),
        prepDay: loaded.cookDays.prepDay,
        steps: proteins.steps,
        shown: proteins.steps.filter((x) => !x.skipSuggested),
        held: (proteins as { heldForCookDay?: string[] }).heldForCookDay ?? [],
      };
    }

    it("🔴 Saturday, opened on the Friday: the phase RENDERS the step", async () => {
      // The device defect, end to end. Before H5.0 this read lag 3 and the phase
      // came back with nothing on it.
      const r = await run("Saturday", "2026-10-02T18:00:00.000Z");
      assert.equal(r.prepDay, "2026-10-02");
      assert.equal(r.lag, 1);
      assert.equal(r.steps.length, 1, "the fixture must produce one protein step");
      assert.equal(r.shown.length, 1, "🔴 THE PROTEINS PHASE IS EMPTY ON SCREEN");
      assert.match(r.shown[0].storageNote!, /cook within 2 days/);
      assert.deepEqual(r.held, [], "nothing should be held when it is cooked tomorrow");
    });

    it("…and a day 5+ out moves it into heldForCookDay instead", async () => {
      // Monday on a Wednesday-start plan, read before the week begins: 5 days.
      const r = await run("Monday", "2026-09-28T18:00:00.000Z");
      assert.equal(r.lag, 5);
      assert.equal(r.shown.length, 0, "5 days out must not be prepped ahead");
      assert.equal(r.steps[0].skipSuggested, true);
      assert.equal(r.held.length, 1, "a demoted protein must be SHOWN as held, not dropped");
      assert.match(r.held[0], /Monday, 5 days out/);
      assert.match(r.held[0], /that morning/);
    });

    it("…and the same Monday meal, read on the Sunday, comes BACK into the phase", async () => {
      // The move that matters to the cook is the calendar's, not theirs. Same
      // plan, same day name, one day later: 5 → 1, and the step returns.
      const r = await run("Monday", "2026-10-04T18:00:00.000Z");
      assert.equal(r.lag, 1);
      assert.equal(r.shown.length, 1, "the step did not come back when the week caught up");
      assert.deepEqual(r.held, []);
    });
  });

  it("an undated plan yields a null prepDay and no lags, never a fabricated zero", async () => {
    const r = await loadPrepWeekInput({ planId: PLAN_ID, userId: USER_ID, prisma: makePrismaStub([plan()]) });
    assert.equal(r.cookDays.prepDay, null);
    assert.equal(r.cookDays.lagByMealId.size, 0);
    assert.equal(r.cookDays.dayNameByMealId.size, 0);
  });

  it("🔴 with no startDate there is NO baseline and NO lags — not a guess", async () => {
    // This used to fall back to the earliest `assignedDate` as the baseline.
    // H3 item 14 removes that: a weekday NAME means nothing without a week to
    // place it in, and the fallback could only ever be driven by the same
    // write-once column the whole defect came from. No startDate, no lags — and
    // D-WS9-298's unknown-day sentence covers the user ("prep this the day
    // before you cook, or leave it for cook day").
    const p = plan({
      startDate: null,
      items: plan().items.map((it, i) =>
        i === 0 ? { ...it, assignedDate: new Date("2026-10-09T00:00:00.000Z"), assignedDayOfWeek: "Friday" } : it,
      ),
    });
    const r = await loadPrepWeekInput({ planId: PLAN_ID, userId: USER_ID, prisma: makePrismaStub([p]) });
    assert.equal(r.cookDays.prepDay, null);
    assert.equal(r.cookDays.lagByMealId.size, 0);
    // The day NAME still arrives — it is what the "Saturday" copy renders from.
    assert.equal(r.cookDays.dayNameByMealId.get(MEAL_A), "Friday");
  });
});

// SERVER-9 C (BUG-582) — a tick made in a subset or one-meal session counts only for
// the meals in that session. QA-NIGHT's R5: ticking "Mince the garlic" in a one-meal
// prep made Cook Mode of the OTHER meals sharing that garlic say "the minced garlic
// you prepped", because the session served the week's key.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { derivePrepCompletion } from "../prepCompletion";
import {
  SCOPED_KEY_MAX,
  parseScopedKey,
  planMealOrder,
  scopePrefix,
  scopedKey,
  splitTicks,
  ticksForMeal,
  withSessionKeys,
} from "../prepScope";
import { buildCoreWeek } from "../prepWeekBuild";
import { weeknightCookWordingFor } from "../feastCookWording";
import { loadPrepStepSet } from "../prepStepSet";
import { deriveAmountRefs } from "../stepAmountRefs";
import { load, uuid, type Meal } from "./fixtures/prep3Week";

const A = uuid(1);
const B = uuid(2);
const C = uuid(3);
const GARLIC = uuid(50);
const OIL = uuid(51);

// Three meals, each mincing garlic: the week's ONE garlic step covers all three.
const meal = (id: string, n: number, name: string, day: string, lag: number): Meal => ({
  id,
  name,
  day,
  lag,
  dishes: [{
    id: uuid(100 + n),
    name,
    ings: [
      { id: GARLIC, name: "garlic cloves", category: "Produce", quantity: 3, unit: "clove", note: "minced" },
      { id: OIL, name: "olive oil", category: "Pantry", quantity: 1, unit: "tbsp" },
    ],
    steps: [{ i: 0, phase: "cook", text: "Heat 1 tablespoon olive oil in a skillet, add 3 minced garlic cloves and sauté for 1 minute.", ids: [GARLIC, OIL] }],
  }],
});
const MEALS = [meal(A, 1, "Garlic Shrimp", "Monday", 1), meal(B, 2, "Garlic Pasta", "Tuesday", 2), meal(C, 3, "Garlic Greens", "Wednesday", 3)];
const LOAD = load(MEALS);
const PLAN_MEALS = [A, B, C];
const week = buildCoreWeek(LOAD);
const garlicKey = week.stepPlan.steps.find((s) => s.stepKey.includes(GARLIC))!.stepKey;

describe("SERVER-9 C — the scope rides in the key", () => {
  it("the fixture's garlic step is one week step covering all three meals", () => {
    assert.ok(garlicKey, "a garlic step");
    const st = week.stepPlan.steps.find((s) => s.stepKey === garlicKey)!;
    assert.deepEqual([...new Set(st.components.flatMap((c) => c.measures.map((m) => m.mealId)))].sort(), [A, B, C].sort());
  });

  it("a one-meal and a two-meal session decode back to their meals; the base is the week's key", () => {
    for (const scope of [[A], [B, C], [C, A]]) {
      const k = scopedKey(scopePrefix(PLAN_MEALS, scope, PLAN_MEALS)!, garlicKey)!;
      const p = parseScopedKey(k, PLAN_MEALS)!;
      assert.equal(p.base, garlicKey);
      assert.deepEqual([...p.mealIds!].sort(), [...scope].sort());
    }
  });

  it("the plan's meal order, not the request's, decides the mask (the same session, the same key)", () => {
    assert.equal(scopePrefix(PLAN_MEALS, [B, A], PLAN_MEALS), scopePrefix([C, B, A], [A, B], PLAN_MEALS));
    assert.deepEqual(planMealOrder([C, A, A, B]), [A, B, C].sort());
  });

  it("every eligible meal is the week: no prefix, the week's keys", () => {
    assert.equal(scopePrefix(PLAN_MEALS, [A, B, C], PLAN_MEALS), null);
    assert.equal(scopePrefix(PLAN_MEALS, [A, B], [A, B]), null, "a feast left out of eligible");
    assert.equal(scopePrefix(PLAN_MEALS, ["not-in-plan"], PLAN_MEALS), null);
  });

  it("a plan whose meals changed decodes a stale key to no meal at all (the check)", () => {
    const k = scopedKey(scopePrefix(PLAN_MEALS, [B], PLAN_MEALS)!, garlicKey)!;
    // B's bit now names another meal: the check refuses it rather than counting it for that meal.
    const swapped = [A, uuid(9), C];
    assert.equal(parseScopedKey(k, swapped)!.mealIds, null);
    assert.deepEqual(ticksForMeal([k], uuid(9), swapped), []);
  });

  it("an unscoped key is not parsed; feast keys pass as unscoped", () => {
    assert.equal(parseScopedKey(garlicKey, PLAN_MEALS), null);
    const s = splitTicks([garlicKey, "feast#produce#x", "week-labels"], PLAN_MEALS);
    assert.deepEqual(s.unscoped, [garlicKey, "feast#produce#x", "week-labels"]);
  });

  it("fits the apps' 80 characters: the longest engine key (71) in a 20-meal plan", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => uuid(200 + i));
    const longest = `cnt#sauc#${"x".repeat(62)}`;
    assert.equal(longest.length, 71);
    const k = scopedKey(scopePrefix(twenty, [twenty[19]!, twenty[0]!], twenty)!, longest);
    assert.ok(k && k.length <= SCOPED_KEY_MAX, `${k?.length}`);
    assert.equal(parseScopedKey(k!, twenty)!.base, longest);
    // Too long is refused, never served (the caller falls back to the week's key and logs).
    assert.equal(scopedKey("~vvvvvvv.00~", longest), null);
  });

  it("ticksForMeal: the week's ticks count for everyone, a session's only for its meals", () => {
    const one = scopedKey(scopePrefix(PLAN_MEALS, [A], PLAN_MEALS)!, garlicKey)!;
    const ticks = [one, "produce#other"];
    assert.deepEqual(ticksForMeal(ticks, A, PLAN_MEALS).sort(), [garlicKey, "produce#other"].sort());
    assert.deepEqual(ticksForMeal(ticks, B, PLAN_MEALS), ["produce#other"]);
    assert.deepEqual(ticksForMeal(ticks, C, PLAN_MEALS), ["produce#other"]);
  });
});

describe("SERVER-9 C — the session's served keys", () => {
  const result = { phases: [{ steps: [{ stepKey: garlicKey }, { stepKey: "produce#onion" }, { stepKey: "week-labels" }] }] };
  const session = (scope: string[], ticks: string[] = []) => withSessionKeys(result, { planMeals: PLAN_MEALS, scope, eligible: PLAN_MEALS, ticks }).result.phases[0]!.steps.map((s) => s.stepKey);

  it("a one-meal session's steps go out scoped to that meal", () => {
    for (const k of session([A])) assert.deepEqual([...parseScopedKey(k, PLAN_MEALS)!.mealIds!], [A]);
  });

  it("a step the week already ticked keeps the week's key, so the session shows it ticked", () => {
    const keys = session([A], [garlicKey]);
    assert.equal(keys[0], garlicKey);
    assert.ok(parseScopedKey(keys[1]!, PLAN_MEALS));
  });

  it("a step a wider session ticked keeps that session's key; a narrower one's does not", () => {
    const ab = scopedKey(scopePrefix(PLAN_MEALS, [A, B], PLAN_MEALS)!, garlicKey)!;
    assert.equal(session([A], [ab])[0], ab, "{A,B} ticked covers the one-meal A session");
    const a = scopedKey(scopePrefix(PLAN_MEALS, [A], PLAN_MEALS)!, garlicKey)!;
    assert.notEqual(session([A, B], [a])[0], a, "{A} ticked does not cover {A,B}");
  });

  it("every meal selected is the week: keys unchanged", () => {
    assert.deepEqual(session([A, B, C]), [garlicKey, "produce#onion", "week-labels"]);
  });
});

describe("SERVER-9 C — Cook Mode's words (R5): only the session's meal reads the prepped garlic", () => {
  const dishesOf = (m: Meal) =>
    m.dishes.map((d) => ({
      dishId: d.id,
      title: d.name,
      steps: d.steps.map((s) => ({ stepIndex: s.i, text: s.text, amountRefs: deriveAmountRefs(s.text, d.ings.map((x) => ({ ingredientId: x.id, name: x.name, quantity: x.quantity, unit: x.unit }))).amountRefs })),
    }));
  const prismaWith = (ticks: string[]) => ({
    prepStepCompletion: { findMany: async () => ticks.map((stepKey) => ({ stepKey })) },
    prepWeekStructure: { findUnique: async () => null },
    dishIngredient: {
      findMany: async () => MEALS.flatMap((m) => m.dishes.flatMap((d) => d.ings.map((x) => ({ dishId: d.id, ingredientId: x.id, ingredient: { canonicalName: x.name } })))),
    },
  });
  const read = async (ticks: string[], m: Meal) => {
    const out = await weeknightCookWordingFor(
      prismaWith(ticks) as never,
      { planId: LOAD.input.planId, userId: "u", mealId: m.id, mealTags: [], dishes: dishesOf(m) },
      { loadPrepWeekInput: (async () => LOAD) as never },
    );
    return out.get(m.dishes[0]!.id)?.get(0)?.text ?? null;
  };

  it("the week's tick words every meal (the week's garlic was minced for all three)", async () => {
    for (const m of MEALS) assert.match((await read([garlicKey], m)) ?? "", /garlic you prepped/i, m.name);
  });

  it("a one-meal session's tick words that meal only; the other two keep their own words (BUG-582)", async () => {
    const one = scopedKey(scopePrefix(PLAN_MEALS, [A], PLAN_MEALS)!, garlicKey)!;
    assert.match((await read([one], MEALS[0]!)) ?? "", /garlic you prepped/i);
    assert.equal(await read([one], MEALS[1]!), null, "Garlic Pasta unchanged");
    assert.equal(await read([one], MEALS[2]!), null, "Garlic Greens unchanged");
  });

  it("a two-meal session's tick words its two meals, not the third", async () => {
    const two = scopedKey(scopePrefix(PLAN_MEALS, [A, C], PLAN_MEALS)!, garlicKey)!;
    assert.match((await read([two], MEALS[0]!)) ?? "", /garlic you prepped/i);
    assert.equal(await read([two], MEALS[1]!), null);
    assert.match((await read([two], MEALS[2]!)) ?? "", /garlic you prepped/i);
  });

  it("without a meal id only the week's ticks count", async () => {
    const one = scopedKey(scopePrefix(PLAN_MEALS, [A], PLAN_MEALS)!, garlicKey)!;
    const out = await weeknightCookWordingFor(prismaWith([one]) as never, { planId: "p", userId: "u", mealTags: [], dishes: dishesOf(MEALS[0]!) }, { loadPrepWeekInput: (async () => LOAD) as never });
    assert.equal(out.size, 0);
  });
});

describe("SERVER-9 C — the isPrepped rollup", () => {
  const rollup = async (ticks: string[]) => {
    const steps = await loadPrepStepSet({
      planId: LOAD.input.planId,
      userId: "u",
      prisma: { prepWeekStructure: { findUnique: async () => null } } as never,
      loadPrepWeekInput: (async () => LOAD) as never,
      ticks,
    });
    return derivePrepCompletion(PLAN_MEALS, steps, new Set(ticks));
  };
  const all = (scope: string[] | null) =>
    week.stepPlan.steps.filter((s) => !s.demoted).map((s) => (scope ? scopedKey(scopePrefix(PLAN_MEALS, scope, PLAN_MEALS)!, s.stepKey)! : s.stepKey));

  it("every step ticked in a one-meal session: that meal fully prepped, the others not (they read partly before)", async () => {
    const r = await rollup(all([A]));
    assert.equal(r.perMealState[A], "fully");
    assert.equal(r.perMealState[B], "not");
    assert.equal(r.perMealState[C], "not");
    assert.equal(r.derivedPrepStatus, "partial");
  });

  it("the week's ticks still prep every meal", async () => {
    const r = await rollup(all(null));
    for (const id of PLAN_MEALS) assert.equal(r.perMealState[id], "fully");
    assert.equal(r.derivedPrepStatus, "prepped");
  });

  it("derivePrepCompletion reads doneFor per meal", () => {
    const r = derivePrepCompletion([A, B], [{ stepKey: "k", contributesToMealIds: [A, B], doneFor: [B] }], new Set());
    assert.deepEqual(r.perMeal, { [A]: false, [B]: true });
  });
});

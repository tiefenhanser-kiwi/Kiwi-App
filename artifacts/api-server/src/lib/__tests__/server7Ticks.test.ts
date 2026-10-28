// SERVER-7 B (BUG-556/557) — a tick is a tick of the step the cook saw. The ticks are keys
// of the plan's CACHED Prep the Week; an engine change re-keys steps, so they are resolved
// by what each old step held (its portions: a food of a dish in a phase), never dropped.
// And (QA-6) one container has one id, whatever was ticked.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { cachedStepsOf, claimOf, resolveTicks } from "../prepTickCarry";
import type { PlannedStep } from "../prepWeekAssembly";
import { buildPrepWeekPlan } from "../prepWeekBuild";
import { feastDishFacts, weeknightDoneSteps } from "../feastCookWording";
import { load, uuid, type Meal } from "./fixtures/prep3Week";

const D1 = "d1d1d1d1-0000-4000-8000-000000000001";
const D2 = "d2d2d2d2-0000-4000-8000-000000000002";
const M1 = "m1m1m1m1-0000-4000-8000-000000000001".replace(/m/g, "a");
const M2 = "m2m2m2m2-0000-4000-8000-000000000002".replace(/m/g, "b");
const F = (n: number) => `f${String(n).padStart(7, "0")}-0000-4000-8000-00000000000f`;

/** A step of today's build: its key, phase and portions (food, dish, meal). */
function st(stepKey: string, phase: string, parts: [food: string, dishId: string, mealId?: string][], extra: Partial<PlannedStep> = {}): PlannedStep {
  return {
    stepId: stepKey, stepKey, phase, number: 1, ingredientId: null, contributesToMealIds: [], isBlend: false, estimatedMinutes: 2, relevantDishes: [],
    components: parts.map(([food, dishId, mealId]) => ({ ingredientName: food, measures: [{ amount: "1", forDish: "x", dishRole: "main", dishId, ingredientId: food, ...(mealId ? { mealId } : {}) }] })),
    ...extra,
  } as unknown as PlannedStep;
}
const cache = (keys: Record<string, string[]>) => new Map(Object.entries(keys).map(([k, meals]) => [k, { contributesToMealIds: meals }]));

describe("SERVER-7 B — the old keys say what they held", () => {
  it("reads every shape the engines wrote", () => {
    assert.deepEqual(claimOf(`seasonings_dry#dish#${D1}`), { key: `seasonings_dry#dish#${D1}`, phase: "seasonings_dry", dishId: D1 });
    assert.deepEqual(claimOf(`cnt#sauc#${D1}|c:marinade@r:0|A`), { key: `cnt#sauc#${D1}|c:marinade@r:0|A`, phase: "sauces_marinades", dishId: D1 });
    assert.deepEqual(claimOf(`produce#${F(1)}`), { key: `produce#${F(1)}`, phase: "produce", food: F(1) });
    assert.equal(claimOf("seasonings_dry#blend")?.phase, "seasonings_dry");
    assert.deepEqual([...claimOf("seasonings_dry#blend", { contributesToMealIds: [M1] })!.mealIds!], [M1]);
    for (const k of ["week-labels", "produce#wash-all", "produce#not-a-uuid", "feast#produce#x", "cnt#zzzz#x|y"]) assert.equal(claimOf(k), null, k);
  });

  it("the cached week's steps by key (the feast session's blob is not the week)", () => {
    const json = { phases: [{ steps: [{ stepKey: "a", contributesToMealIds: [M1] }] }], feastSession: { result: { phases: [{ steps: [{ stepKey: "f" }] }] } } };
    assert.deepEqual([...cachedStepsOf(json).keys()], ["a"]);
    assert.equal(cachedStepsOf(null).size, 0);
  });
});

describe("SERVER-7 B — resolveTicks", () => {
  // Today: the skewers' marinade is one container (its spices and its oil, in the wet phase),
  // the tacos' spices another, a merged lemon step (wedges + juice), the chicken.
  const today = [
    st(`cnt#sauc#${D1}|c:marinade@r:0|A`, "sauces_marinades", [[F(1), D1, M1], [F(2), D1, M1], [F(3), D1, M1]]),
    st(`cnt#seas#${D2}|c:seasoning@r:0|A`, "seasonings_dry", [[F(4), D2, M2], [F(5), D2, M2]]),
    st(`produce#${F(6)}`, "produce", [[F(6), D1, M1], [F(7), D1, M1]]),
    st(`proteins#${F(8)}`, "proteins", [[F(8), D1, M1]]),
    st(`seasonings_dry#left#${D1}`, "seasonings_dry", [[F(9), D1, M1]], { demoted: { reason: "single-item" } } as never),
  ];

  it("an exact key is itself; the label step's key is live though the build never has it", () => {
    const r = resolveTicks([`proteins#${F(8)}`, "week-labels"], today);
    assert.deepEqual([...r.done].sort(), ["proteins#" + F(8), "week-labels"].sort());
    assert.deepEqual(r.unmapped, []);
  });

  it("the dish's old dry blend and wet step, both ticked, carry today's one marinade (spices moved to the wet phase)", () => {
    const old = cache({ [`seasonings_dry#dish#${D1}`]: [M1], [`sauces_marinades#dish#${D1}`]: [M1] });
    const r = resolveTicks([`seasonings_dry#dish#${D1}`, `sauces_marinades#dish#${D1}`], today, { cached: old });
    assert.ok(r.done.has(`cnt#sauc#${D1}|c:marinade@r:0|A`));
    assert.deepEqual(r.carried.get(`cnt#sauc#${D1}|c:marinade@r:0|A`), [`sauces_marinades#dish#${D1}`]);
    assert.deepEqual(r.unmapped, [`seasonings_dry#dish#${D1}`], "its own dry portions are a demoted line today: kept, reported");
  });

  it("the wet step unticked on the old screen decides the marinade: not carried", () => {
    const old = cache({ [`seasonings_dry#dish#${D1}`]: [M1], [`sauces_marinades#dish#${D1}`]: [M1] });
    const r = resolveTicks([`seasonings_dry#dish#${D1}`], today, { cached: old });
    assert.ok(!r.done.has(`cnt#sauc#${D1}|c:marinade@r:0|A`));
  });

  it("the week's one blend carries every dry container of its meals", () => {
    const r = resolveTicks(["seasonings_dry#blend"], today, { cached: cache({ "seasonings_dry#blend": [M2] }) });
    assert.ok(r.done.has(`cnt#seas#${D2}|c:seasoning@r:0|A`));
    // M1's marinade is wet: not the blend's.
    assert.ok(!r.done.has(`cnt#sauc#${D1}|c:marinade@r:0|A`));
  });

  it("a food's old step, under an older group id, carries the food's step today (the fold)", () => {
    const r = resolveTicks([`produce#${F(66)}`, `produce#${F(7)}`], today, { cached: cache({ [`produce#${F(66)}`]: [M1], [`produce#${F(7)}`]: [M1] }), fold: (id) => (id === F(66) ? F(6) : id) });
    assert.ok(r.done.has(`produce#${F(6)}`));
    assert.deepEqual(r.unmapped, []);
  });

  it("a merged step whose other half was left unticked on the old screen is not carried", () => {
    const r = resolveTicks([`produce#${F(66)}`], today, { cached: cache({ [`produce#${F(66)}`]: [M1], [`produce#${F(7)}`]: [M1] }), fold: (id) => (id === F(66) ? F(6) : id) });
    assert.ok(!r.done.has(`produce#${F(6)}`));
    assert.deepEqual(r.unmapped, [`produce#${F(66)}`]);
  });

  it("a portion the old screen never showed does not decide; with no cache, every portion must be ticked", () => {
    // The old screen had only the lemon (F6); today's step also holds the juice (F7).
    const withCache = resolveTicks([`produce#${F(66)}`], today, { cached: cache({ [`produce#${F(66)}`]: [M1] }), fold: (id) => (id === F(66) ? F(6) : id) });
    assert.ok(withCache.done.has(`produce#${F(6)}`));
    const noCache = resolveTicks([`produce#${F(66)}`], today, { fold: (id) => (id === F(66) ? F(6) : id) });
    assert.ok(!noCache.done.has(`produce#${F(6)}`));
  });

  it("a claim keeps to the cached step's meals", () => {
    const r = resolveTicks(["seasonings_dry#blend"], today, { cached: cache({ "seasonings_dry#blend": [M1] }) });
    assert.ok(!r.done.has(`cnt#seas#${D2}|c:seasoning@r:0|A`));
  });

  it("a demoted step is never carried; `carryable` narrows further (Cook Mode: tickable today)", () => {
    const old = cache({ [`seasonings_dry#dish#${D1}`]: [M1], [`sauces_marinades#dish#${D1}`]: [M1] });
    const ticks = [`seasonings_dry#dish#${D1}`, `sauces_marinades#dish#${D1}`];
    assert.ok(!resolveTicks(ticks, today, { cached: old }).done.has(`seasonings_dry#left#${D1}`));
    assert.equal(resolveTicks(ticks, today, { cached: old, carryable: () => false }).carried.size, 0);
  });

  it("a tick whose meal left the plan carries nothing and is reported", () => {
    const r = resolveTicks([`seasonings_dry#dish#${uuid(999)}`, "produce#orphan-removed-ingredient"], today);
    assert.deepEqual(r.unmapped.sort(), [`seasonings_dry#dish#${uuid(999)}`, "produce#orphan-removed-ingredient"].sort());
    assert.equal(r.carried.size, 0);
  });
});

// prep3Marinade's lemon-pepper chicken: a produce step juices the lemon into the marinade.
const lemonPepper: Meal = {
  id: uuid(1), name: "Grilled Lemon Pepper Chicken", day: "Monday", lag: 1,
  dishes: [{
    id: uuid(11), name: "Grilled Lemon Pepper Chicken Breasts",
    ings: [
      { id: uuid(101), name: "boneless skinless chicken breasts", category: "Protein", quantity: 2, unit: "lb", note: "pounded to even 3/4-inch thickness" },
      { id: uuid(102), name: "lemon", category: "Produce", quantity: 2, unit: "each", note: "1 zested and juiced, 1 sliced into wedges for serving" },
      { id: uuid(103), name: "olive oil", category: "Pantry", quantity: 3, unit: "tbsp" },
      { id: uuid(104), name: "coarsely cracked black pepper", category: "Pantry", quantity: 1.5, unit: "tsp" },
      { id: uuid(105), name: "garlic powder", category: "Pantry", quantity: 1, unit: "tsp" },
      { id: uuid(107), name: "kosher salt", category: "Pantry", quantity: 1, unit: "tsp" },
    ],
    steps: [
      { i: 1, phase: "prep", text: "Zest and juice 1 lemon, then whisk together the zest, juice, 3 tablespoons olive oil, 1½ teaspoons cracked black pepper, 1 teaspoon garlic powder and 1 teaspoon kosher salt into a marinade.", ids: [uuid(102), uuid(103), uuid(104), uuid(105), uuid(107)], key: "seasoning" },
      { i: 3, phase: "rest", text: "Coat the chicken breasts evenly in the marinade and let sit at room temperature for 10 minutes." },
    ],
  }],
};

describe("SERVER-7 B (QA-6) — one container, one id, whatever was ticked", () => {
  const b = buildPrepWeekPlan(load([lemonPepper]));
  const produce = b.stepPlan.steps.filter((s) => !s.demoted && s.phase === "produce" && s.components.some((c) => c.measures.some((m) => m.destination)));

  it("a cut into the marinade carries the marinade's own id, ticked alone or with the marinade", () => {
    assert.ok(produce.length > 0, "the lemon goes into the marinade");
    const all = feastDishFacts(b, { weeknight: true }).get(uuid(11))!;
    const mixId = all.mixes[0].containerId;
    assert.ok(mixId && !/ bowl$/.test(mixId), `the container's id, not its name: ${mixId}`);
    const cutsOnly = feastDishFacts(b, { weeknight: true, onlySteps: new Set(produce.map((s) => s.stepKey)) }).get(uuid(11))!;
    assert.equal(cutsOnly.mixes.length, 0, "the marinade's own steps are not ticked");
    const into = cutsOnly.cuts.filter((c) => c.kind === "mix");
    assert.ok(into.length > 0);
    for (const c of into) assert.equal(c.containerId, mixId);
    for (const c of all.cuts.filter((x) => x.kind === "mix")) assert.equal(c.containerId, mixId);
  });
});

describe("SERVER-7 B — Cook Mode reads the ticks of the cached screen (weeknightDoneSteps)", () => {
  const b = buildPrepWeekPlan(load([lemonPepper]));
  const mixSteps = b.stepPlan.steps.filter((s) => !s.demoted && s.bowlName && (s.phase === "seasonings_dry" || s.phase === "sauces_marinades"));
  // The screen an older engine showed: the dish's dry blend and its wet step, by dish.
  const old = { phases: [
    { phase: "seasonings_dry", steps: [{ stepKey: `seasonings_dry#dish#${uuid(11)}`, contributesToMealIds: [uuid(1)] }] },
    { phase: "sauces_marinades", steps: [{ stepKey: `sauces_marinades#dish#${uuid(11)}`, contributesToMealIds: [uuid(1)] }] },
  ] };
  const ticks = [`seasonings_dry#dish#${uuid(11)}`, `sauces_marinades#dish#${uuid(11)}`];

  it("the old keys tick today's marinade steps, and Cook Mode names the marinade", () => {
    assert.ok(mixSteps.length > 0);
    const done = weeknightDoneSteps(b, ticks, old, (id) => id);
    for (const s of mixSteps) assert.ok(done.has(s.stepKey), `${s.stepKey} not done: ${[...done].join(", ")}`);
    const facts = feastDishFacts(b, { weeknight: true, onlySteps: done }).get(uuid(11))!;
    assert.equal(facts.mixes.length, 1);
  });

  it("an old key of a dish not in the plan ticks nothing", () => {
    assert.equal(weeknightDoneSteps(b, [`seasonings_dry#dish#${uuid(999)}`], old, (id) => id).size, 0);
  });
});

// WS7-8b Block 3 — Cook Mode engine tests.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyPrepFilter,
  flattenDishSteps,
  flattenMealSteps,
  formatClock,
  highlightQuantities,
  isTimerDone,
  misePlaceItems,
  remainingMinutes,
  resolveCookRender,
  resolvePrepGate,
  sequenceMealSteps,
  timerRemainingMs,
  type CookStep,
} from "../cookSession";
import type { SequencedStep } from "@/lib/api/cooking";
import type { MealDetail, MealStep } from "@/lib/api/meals";
import type { DishDetail } from "@/lib/api/dishes";

// ── Fixtures ────────────────────────────────────────────────────────────────

function step(overrides: Partial<MealStep> = {}): MealStep {
  return {
    stepIndex: 0,
    text: "Do the thing",
    estimatedMinutes: 5,
    phaseType: "cook",
    parallelGroup: null,
    requiresPreheat: false,
    requiresRest: false,
    requiresMarination: false,
    isTimingSensitive: false,
    ...overrides,
  };
}

function mealDetail(overrides: Partial<MealDetail> = {}): MealDetail {
  return {
    id: "m1",
    title: "Test Meal",
    cuisine: "",
    minutes: 30,
    servings: 4,
    calories: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
    tags: [],
    image: null,
    description: null,
    difficulty: "medium",
    mealType: "dinner",
    sourceType: "user",
    isPublic: false,
    userId: "u1",
    dishes: [],
    steps: [],
    notes: null,
    ...overrides,
  };
}

function dishDetail(steps: MealStep[]): DishDetail {
  return {
    id: "d1",
    title: "Test Dish",
    description: null,
    image: null,
    difficulty: "easy",
    minutes: 10,
    servings: 2,
    calories: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
    tags: [],
    sourceType: "user",
    userId: "u1",
    ingredients: [],
    steps,
  };
}

// ── flatten ─────────────────────────────────────────────────────────────────

test("flattenMealSteps: meal-owned steps win and carry no dish label", () => {
  const meal = mealDetail({
    steps: [
      step({ text: "Prep onions", phaseType: "prep" }),
      step({ text: "Sear", phaseType: "cook" }),
    ],
    dishes: [], // ignored when meal-owned steps exist
  });
  const out = flattenMealSteps(meal);
  assert.equal(out.length, 2);
  assert.equal(out[0].text, "Prep onions");
  assert.equal(out[0].isPrep, true);
  assert.equal(out[1].isPrep, false);
  assert.equal(out[0].dishTitle, undefined);
});

test("flattenMealSteps: multi-dish meal flattens by dish then index, tagging dishTitle", () => {
  const meal = mealDetail({
    steps: [],
    dishes: [
      {
        dishId: "dA",
        title: "Sauce",
        roleLabel: "component",
        positionIndex: 0,
        minutes: 10,
        difficulty: "easy",
        servings: 4,
        ingredients: [],
        steps: [step({ text: "Simmer sauce" })],
      },
      {
        dishId: "dB",
        title: "Pasta",
        roleLabel: "main",
        positionIndex: 1,
        minutes: 12,
        difficulty: "easy",
        servings: 4,
        ingredients: [],
        steps: [step({ text: "Boil pasta" })],
      },
    ],
  });
  const out = flattenMealSteps(meal);
  assert.deepEqual(
    out.map((s) => [s.text, s.dishTitle]),
    [
      ["Simmer sauce", "Sauce"],
      ["Boil pasta", "Pasta"],
    ],
  );
});

test("flattenMealSteps: single-dish meal does NOT tag a dish label", () => {
  const meal = mealDetail({
    steps: [],
    dishes: [
      {
        dishId: "dA",
        title: "Solo",
        roleLabel: "main",
        positionIndex: 0,
        minutes: 10,
        difficulty: "easy",
        servings: 2,
        ingredients: [],
        steps: [step({ text: "Cook it" })],
      },
    ],
  });
  assert.equal(flattenMealSteps(meal)[0].dishTitle, undefined);
});

test("flattenDishSteps: flat order, no labels", () => {
  const out = flattenDishSteps(
    dishDetail([step({ text: "Chop", phaseType: "prep" }), step({ text: "Fry" })]),
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].isPrep, true);
  assert.equal(out[0].dishTitle, undefined);
});

// ── prep gate ───────────────────────────────────────────────────────────────

test("resolvePrepGate: no plan context → unknown; plan context → prepped/not_prepped by isPrepped", () => {
  assert.equal(resolvePrepGate(false, false), "unknown");
  assert.equal(resolvePrepGate(false, true), "unknown");
  assert.equal(resolvePrepGate(true, true), "prepped");
  assert.equal(resolvePrepGate(true, false), "not_prepped");
});

// ── resolveCookRender (polish #1 — gate shows while step data loads) ──────────

const baseRender = {
  recipeError: false,
  planResolving: false,
  recipeLoading: false,
  sequenceLoading: false,
  needsGatePrompt: false,
};

test("resolveCookRender: error wins over everything (even if other flags are set)", () => {
  assert.equal(
    resolveCookRender({
      ...baseRender,
      recipeError: true,
      planResolving: true,
      needsGatePrompt: true,
    }),
    "error",
  );
});

test("resolveCookRender: blocks on the cheap plan fetch before the gate (no State-3 flash)", () => {
  // A plan-context launch still resolving isPrepped: even though the gate would
  // read 'unknown' (planItem not yet found), we must NOT show the State-3 prompt
  // — we wait on the plan so a State-1/2 launch never flashes the question.
  assert.equal(
    resolveCookRender({ ...baseRender, planResolving: true, needsGatePrompt: true }),
    "plan-loading",
  );
});

test("resolveCookRender: shows the gate WHILE the recipe/sequence load behind it", () => {
  // The slow recipe/sequence fetch no longer blocks the State-3 gate prompt.
  assert.equal(
    resolveCookRender({
      ...baseRender,
      recipeLoading: true,
      sequenceLoading: true,
      needsGatePrompt: true,
    }),
    "gate",
  );
});

test("resolveCookRender: after the gate is answered, falls through to the spinner if step data is still in flight", () => {
  // needsGatePrompt flips false once answered; remaining recipe/sequence load
  // is then surfaced as the spinner.
  assert.equal(
    resolveCookRender({ ...baseRender, recipeLoading: true, needsGatePrompt: false }),
    "recipe-loading",
  );
  assert.equal(
    resolveCookRender({ ...baseRender, sequenceLoading: true, needsGatePrompt: false }),
    "recipe-loading",
  );
});

test("resolveCookRender: everything resolved → the full session", () => {
  assert.equal(resolveCookRender(baseRender), "session");
});

// ── filter / recap / remaining ──────────────────────────────────────────────

const MIXED: CookStep[] = [
  { key: "0", text: "Mince garlic", phaseType: "prep", estimatedMinutes: 3, isPrep: true, isTimingSensitive: false },
  { key: "1", text: "Dice onion", phaseType: "prep", estimatedMinutes: 4, isPrep: true, isTimingSensitive: false },
  { key: "2", text: "Sear", phaseType: "cook", estimatedMinutes: 8, isPrep: false, isTimingSensitive: false },
  { key: "3", text: "Rest", phaseType: "rest", estimatedMinutes: 5, isPrep: false, isTimingSensitive: true },
];

test("applyPrepFilter: skipPrep drops prep steps; otherwise keeps all", () => {
  assert.equal(applyPrepFilter(MIXED, false).length, 4);
  const cooked = applyPrepFilter(MIXED, true);
  assert.deepEqual(cooked.map((s) => s.text), ["Sear", "Rest"]);
  assert.ok(cooked.every((s) => !s.isPrep));
});

test("misePlaceItems: lists this meal's own prep-phase step texts (recap source)", () => {
  assert.deepEqual(misePlaceItems(MIXED), ["Mince garlic", "Dice onion"]);
});

test("remainingMinutes: sums estimatedMinutes from the index to the end", () => {
  assert.equal(remainingMinutes(MIXED, 0), 20);
  assert.equal(remainingMinutes(MIXED, 2), 13);
  assert.equal(remainingMinutes(MIXED, 4), 0);
});

test("flatten carries isTimingSensitive through from the step shape", () => {
  const meal = mealDetail({
    steps: [step({ phaseType: "cook", isTimingSensitive: true })],
  });
  assert.equal(flattenMealSteps(meal)[0].isTimingSensitive, true);
  const dish = flattenDishSteps(
    dishDetail([step({ isTimingSensitive: false })]),
  );
  assert.equal(dish[0].isTimingSensitive, false);
});

// ── timer helpers ────────────────────────────────────────────────────────────

test("timerRemainingMs: clamps at 0 and counts down from endsAt", () => {
  const timer = { endsAt: 10_000, durationMs: 5_000 };
  assert.equal(timerRemainingMs(timer, 5_000), 5_000);
  assert.equal(timerRemainingMs(timer, 9_000), 1_000);
  assert.equal(timerRemainingMs(timer, 10_000), 0);
  assert.equal(timerRemainingMs(timer, 12_000), 0); // never negative
});

test("isTimerDone: true once now reaches/passes endsAt", () => {
  const timer = { endsAt: 10_000, durationMs: 5_000 };
  assert.equal(isTimerDone(timer, 9_999), false);
  assert.equal(isTimerDone(timer, 10_000), true);
  assert.equal(isTimerDone(timer, 11_000), true);
});

test("formatClock: M:SS, rounds up so a fresh 5:00 reads 5:00 not 4:59", () => {
  assert.equal(formatClock(5 * 60 * 1000), "5:00");
  assert.equal(formatClock(5 * 60 * 1000 - 1), "5:00"); // ceil to the second
  assert.equal(formatClock(63 * 1000), "1:03");
  assert.equal(formatClock(9 * 1000), "0:09");
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(-500), "0:00"); // clamp
  assert.equal(formatClock(72 * 60 * 1000), "72:00"); // minutes uncapped
});

// ── quantity highlighter ────────────────────────────────────────────────────

function reconstruct(text: string): string {
  return highlightQuantities(text)
    .map((seg) => seg.text)
    .join("");
}

test("highlightQuantities: GUARANTEE — segments always rejoin to the original string", () => {
  const samples = [
    "Mince 3 cloves garlic",
    "Add 2 cups diced tomatoes and 1 tbsp olive oil",
    "Simmer for 4 minutes, then rest 1/2 hour",
    "Preheat to 400 and bake 1.5 hours",
    "Stir gently until combined", // no quantities
    "",
    "½ tsp salt to taste",
    "Reduce by 2-3 tablespoons",
  ];
  for (const sample of samples) {
    assert.equal(reconstruct(sample), sample, `lossy on: ${JSON.stringify(sample)}`);
  }
});

test("highlightQuantities: marks number+unit spans as quantity, plain text otherwise", () => {
  const segs = highlightQuantities("Add 2 cups diced tomatoes");
  const quantities = segs.filter((s) => s.isQuantity).map((s) => s.text);
  assert.ok(quantities.includes("2 cups"), `got: ${JSON.stringify(quantities)}`);
  // the descriptive remainder is plain (qualifier text never stripped — 8a)
  const plain = segs.filter((s) => !s.isQuantity).map((s) => s.text).join("");
  assert.ok(plain.includes("diced tomatoes"));
});

test("highlightQuantities: no match → a single plain segment, never throws", () => {
  const segs = highlightQuantities("Stir gently until combined");
  assert.equal(segs.length, 1);
  assert.equal(segs[0].isQuantity, false);
  assert.equal(segs[0].text, "Stir gently until combined");
});

// ── sequenceMealSteps (Build Block 2B — Sequencer ordering + cues) ────────────

function seq(overrides: Partial<SequencedStep> = {}): SequencedStep {
  return {
    dishId: "dA",
    originalStepIndex: 0,
    sequenceIndex: 0,
    startsAtMinutes: 0,
    ...overrides,
  };
}

// A two-dish meal. dish dA carries NON-contiguous stepIndex values (5 then 2)
// so the join can be proven to key on stepIndex, not array position.
function twoDishMeal(): MealDetail {
  return mealDetail({
    steps: [],
    dishes: [
      {
        dishId: "dA",
        title: "Chicken",
        roleLabel: "main",
        positionIndex: 0,
        minutes: 20,
        difficulty: "medium",
        servings: 2,
        ingredients: [],
        steps: [
          step({ stepIndex: 5, text: "Sear chicken" }),
          step({ stepIndex: 2, text: "Rest chicken", phaseType: "rest" }),
        ],
      },
      {
        dishId: "dB",
        title: "Salad",
        roleLabel: "side",
        positionIndex: 1,
        minutes: 8,
        difficulty: "easy",
        servings: 2,
        ingredients: [],
        steps: [step({ stepIndex: 0, text: "Chop salad", phaseType: "prep" })],
      },
    ],
  });
}

test("sequenceMealSteps: intermixes dishes in sequence order and attaches the cue", () => {
  const meal = twoDishMeal();
  // Sear (dA#5) → Chop salad (dB#0, cued) → Rest (dA#2).
  const out = sequenceMealSteps(meal, [
    seq({ dishId: "dA", originalStepIndex: 5, sequenceIndex: 0 }),
    seq({
      dishId: "dB",
      originalStepIndex: 0,
      sequenceIndex: 1,
      reason: "While the chicken sears, chop the salad.",
    }),
    seq({ dishId: "dA", originalStepIndex: 2, sequenceIndex: 2 }),
  ]);
  assert.deepEqual(
    out.map((s) => [s.text, s.dishTitle, s.cue]),
    [
      ["Sear chicken", "Chicken", undefined],
      ["Chop salad", "Salad", "While the chicken sears, chop the salad."],
      ["Rest chicken", "Chicken", undefined],
    ],
  );
});

test("sequenceMealSteps: joins on stepIndex, NOT array position", () => {
  const meal = twoDishMeal();
  // dA#2 is the SECOND element of dA.steps but stepIndex 2 — must resolve to
  // "Rest chicken", proving the join keys on stepIndex.
  const out = sequenceMealSteps(meal, [
    seq({ dishId: "dA", originalStepIndex: 2, sequenceIndex: 0 }),
  ]);
  assert.equal(out[0].text, "Rest chicken");
});

test("sequenceMealSteps: sorts defensively by sequenceIndex (unordered input)", () => {
  const meal = twoDishMeal();
  const out = sequenceMealSteps(meal, [
    seq({ dishId: "dA", originalStepIndex: 2, sequenceIndex: 2 }),
    seq({ dishId: "dA", originalStepIndex: 5, sequenceIndex: 0 }),
    seq({ dishId: "dB", originalStepIndex: 0, sequenceIndex: 1 }),
  ]);
  assert.deepEqual(out.map((s) => s.text), [
    "Sear chicken",
    "Chop salad",
    "Rest chicken",
  ]);
});

test("sequenceMealSteps: omitted steps are appended in naive order (never dropped)", () => {
  const meal = twoDishMeal();
  // Sequence references ONLY dA#5 — the other two steps must still appear,
  // appended in naive (dish, then stepIndex) order: dA#2 then dB#0.
  const out = sequenceMealSteps(meal, [
    seq({ dishId: "dA", originalStepIndex: 5, sequenceIndex: 0 }),
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((s) => s.text), [
    "Sear chicken",
    "Rest chicken",
    "Chop salad",
  ]);
});

test("sequenceMealSteps: unmappable entries are skipped, real steps preserved", () => {
  const meal = twoDishMeal();
  const out = sequenceMealSteps(meal, [
    seq({ dishId: "ghost", originalStepIndex: 9, sequenceIndex: 0 }), // unknown
    seq({ dishId: "dA", originalStepIndex: 5, sequenceIndex: 1 }),
  ]);
  // The unknown entry contributes nothing; all three real steps still present.
  assert.equal(out.length, 3);
  assert.equal(out[0].text, "Sear chicken");
  assert.ok(out.some((s) => s.text === "Rest chicken"));
  assert.ok(out.some((s) => s.text === "Chop salad"));
});

test("sequenceMealSteps: a duplicate reference is emitted once (then naive-appended remainder)", () => {
  const meal = twoDishMeal();
  const out = sequenceMealSteps(meal, [
    seq({ dishId: "dA", originalStepIndex: 5, sequenceIndex: 0 }),
    seq({ dishId: "dA", originalStepIndex: 5, sequenceIndex: 1 }), // dup
  ]);
  assert.equal(out.filter((s) => s.text === "Sear chicken").length, 1);
  assert.equal(out.length, 3); // dup collapsed, other two appended
});

test("sequenceMealSteps: empty sequence → full naive order, no cues", () => {
  const meal = twoDishMeal();
  const out = sequenceMealSteps(meal, []);
  assert.deepEqual(out.map((s) => s.text), [
    "Sear chicken",
    "Rest chicken",
    "Chop salad",
  ]);
  assert.ok(out.every((s) => s.cue === undefined));
});

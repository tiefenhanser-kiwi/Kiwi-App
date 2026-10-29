// WS7-8b Block 3 — Cook Mode engine tests.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  doneInPrepStepKeys,
  firstLiveIndex,
  prepChips,
  withPrepChips,
  flattenDishSteps,
  flattenMealSteps,
  formatClock,
  highlightQuantities,
  isTimerDone,
  buildCookSessionParams,
  lastLiveIndex,
  nextLiveIndex,
  prepRecap,
  preppedReadPlanItemId,
  prevLiveIndex,
  remainingMinutes,
  resolveAmountMultiplier,
  resolveCookRender,
  resolvePrepGate,
  sequenceMealSteps,
  shouldLoadPrepForCook,
  skipToCookingY,
  timerRemainingMs,
  type CookStep,
} from "../cookSession";
import type { PrepWeekResult, SequencedStep } from "@/lib/api/cooking";
import { MealStepSchema, type MealDetail, type MealStep } from "@/lib/api/meals";
import type { DishDetail } from "@/lib/api/dishes";

// ── WS7-8b BUG-006 — resolveAmountMultiplier ─────────────────────────────────

test("resolveAmountMultiplier: override scales (effective 6 / authored 4 = 1.5)", () => {
  assert.equal(resolveAmountMultiplier(6, 4), 1.5);
});

test("resolveAmountMultiplier: no override is a no-op (effective === authored → 1)", () => {
  assert.equal(resolveAmountMultiplier(4, 4), 1);
  assert.equal(resolveAmountMultiplier(10, 10), 1);
});

test("resolveAmountMultiplier: 0/missing authored denominator guards to 1 (no NaN/Infinity)", () => {
  assert.equal(resolveAmountMultiplier(6, 0), 1);
  assert.equal(resolveAmountMultiplier(6, Number.NaN), 1);
  assert.equal(resolveAmountMultiplier(6, undefined as unknown as number), 1);
  // a bad numerator also falls back rather than emitting 0/NaN
  assert.equal(resolveAmountMultiplier(Number.NaN, 4), 1);
  assert.equal(resolveAmountMultiplier(0, 4), 1);
});

// ── WS7-8b BUG-006 follow-up — buildCookSessionParams ────────────────────────

test("buildCookSessionParams: includes planId + planItemId when both present (plan launch)", () => {
  assert.deepEqual(
    buildCookSessionParams({ mealId: "m1", planId: "p1", planItemId: "pi1" }),
    { mealId: "m1", planId: "p1", planItemId: "pi1" },
  );
});

test("buildCookSessionParams: omits plan context in the Library (no fabrication)", () => {
  assert.deepEqual(buildCookSessionParams({ mealId: "m1" }), { mealId: "m1" });
});

test("buildCookSessionParams: omits plan context when only one of the pair is present", () => {
  // partial context is unusable — never half-pass it
  assert.deepEqual(buildCookSessionParams({ mealId: "m1", planId: "p1" }), { mealId: "m1" });
  assert.deepEqual(
    buildCookSessionParams({ mealId: "m1", planItemId: "pi1" }),
    { mealId: "m1" },
  );
});

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
  assert.equal(out[0].phaseType, "prep");
  assert.equal(out[1].phaseType, "cook");
  assert.equal(out[0].dishTitle, undefined);
  // K-R7 — a meal-owned step has no dish identity, so no prep step can cover it.
  assert.equal(out[0].dishId, undefined);
  assert.equal(out[0].stepIndex, undefined);
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
  assert.equal(out[0].phaseType, "prep");
  assert.equal(out[0].dishTitle, undefined);
  // A dishId launch carries no meal, so its steps carry no cover identity.
  assert.equal(out[0].dishId, undefined);
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

// ── remaining ───────────────────────────────────────────────────────────────

const MIXED: CookStep[] = [
  { key: "0", text: "Mince garlic", phaseType: "prep", estimatedMinutes: 3, isTimingSensitive: false },
  { key: "1", text: "Dice onion", phaseType: "prep", estimatedMinutes: 4, isTimingSensitive: false },
  { key: "2", text: "Sear", phaseType: "cook", estimatedMinutes: 8, isTimingSensitive: false },
  { key: "3", text: "Rest", phaseType: "rest", estimatedMinutes: 5, isTimingSensitive: true },
];

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
    startOffsetMinutes: 0,
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

// WEB-4d (R4) — the THX-3d dumps: Make-Ahead's step 24 and Vegetarian's 37–38
// were preheats the server merged, re-added after serve by the append.
test("sequenceMealSteps: a step the server merged is not appended; other omissions still are", () => {
  const meal = twoDishMeal();
  const out = sequenceMealSteps(
    meal,
    [seq({ dishId: "dA", originalStepIndex: 5, sequenceIndex: 0 })],
    [{ dishId: "dA", originalStepIndex: 2 }],
  );
  assert.deepEqual(out.map((s) => s.text), ["Sear chicken", "Chop salad"]);
  // Absent field → today's behaviour, every omitted step appended.
  assert.equal(
    sequenceMealSteps(meal, [seq({ dishId: "dA", originalStepIndex: 5, sequenceIndex: 0 })]).length,
    3,
  );
  // A merged id the sequence names anyway is still emitted where it sits.
  const named = sequenceMealSteps(
    meal,
    [
      seq({ dishId: "dA", originalStepIndex: 2, sequenceIndex: 0 }),
      seq({ dishId: "dA", originalStepIndex: 5, sequenceIndex: 1 }),
    ],
    [{ dishId: "dA", originalStepIndex: 2 }],
  );
  assert.deepEqual(named.map((s) => s.text), ["Rest chicken", "Sear chicken", "Chop salad"]);
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

// ── K-R7 — the prepped Cook Mode view ────────────────────────────────────────
// The recap comes from the plan's PREP steps, a cook step collapses to "done in
// prep" only when every prep step covering it is complete, and no cook step is
// ever removed from the flow.

const MEAL = "11111111-1111-4111-8111-111111111111";
const OTHER_MEAL = "22222222-2222-4222-8222-222222222222";

// The cook side: one dish whose stepIndex values are NOT its array positions.
//   dA#4 "Dice 1 onion"                  prep  ← covered by Onions
//   dA#6 "Mince 3 cloves garlic and …"   prep  ← covered by Garlic AND Ginger
//   dA#7 "Chop the cilantro"             prep  ← covered by NOTHING (tag only)
//   dA#9 "Sear the chicken"              cook
/** CLIENT-6 B — a dish ingredient row, by name. */
function ing(name: string): MealDetail["dishes"][number]["ingredients"][number] {
  return { name, quantity: 1, unit: "each", preparationNote: null, category: "Produce", isOptional: false };
}

function preppedMeal(): MealDetail {
  return mealDetail({
    steps: [],
    dishes: [
      {
        dishId: "dA",
        title: "Chicken",
        roleLabel: "main",
        positionIndex: 0,
        minutes: 30,
        difficulty: "easy",
        servings: 2,
        ingredients: ["onion", "garlic cloves", "fresh ginger", "fresh cilantro", "chicken thighs"].map(ing),
        steps: [
          step({ stepIndex: 4, text: "Dice 1 onion", phaseType: "prep" }),
          step({ stepIndex: 6, text: "Mince 3 cloves garlic and grate the ginger", phaseType: "prep" }),
          step({ stepIndex: 7, text: "Chop the cilantro", phaseType: "prep" }),
          step({ stepIndex: 9, text: "Sear the chicken", phaseType: "cook" }),
        ],
      },
    ],
  });
}

function prepStep(
  stepKey: string,
  title: string,
  extra: Partial<PrepWeekResult["phases"][number]["steps"][number]> = {},
): PrepWeekResult["phases"][number]["steps"][number] {
  return {
    number: 1,
    stepKey,
    title,
    instructions: `${title} for the week.`,
    estimatedMinutes: 5,
    contributesToMealIds: [MEAL],
    ...extra,
  };
}

// The prep side. Titles are deliberately NOT the cook steps' text, so a recap
// built from cook steps cannot pass for one built from prep steps.
function preppedResult(): PrepWeekResult {
  return {
    totalEstimatedMinutes: 30,
    phases: [
      { phase: "seasonings_dry", title: "Dry ingredients", skippable: true, steps: [] },
      {
        phase: "produce",
        title: "Produce",
        skippable: false,
        steps: [
          prepStep("produce#onion", "Onions", {
            coversCookSteps: [{ mealId: MEAL, dishId: "dA", stepIndex: 4 }],
          }),
          prepStep("produce#garlic", "Garlic", {
            coversCookSteps: [{ mealId: MEAL, dishId: "dA", stepIndex: 6 }],
          }),
          prepStep("produce#ginger", "Ginger", {
            coversCookSteps: [
              { mealId: MEAL, dishId: "dA", stepIndex: 6 },
              // Same dish + index under ANOTHER meal: must not leak across.
              { mealId: OTHER_MEAL, dishId: "dA", stepIndex: 9 },
            ],
          }),
          prepStep("produce#leeks", "Leeks", { contributesToMealIds: [OTHER_MEAL] }),
          // Not prepped by the cook: never rendered (D-WS7-184) / holds no food.
          prepStep("produce#herbs", "Herbs", { skipSuggested: true }),
          prepStep("produce#wash", "Wash and dry the produce", { holdsNoContainer: true }),
        ],
      },
      { phase: "sauces_marinades", title: "Sauces and marinades", skippable: true, steps: [] },
      { phase: "proteins", title: "Proteins", skippable: false, steps: [] },
    ],
  };
}

function keysByText(steps: CookStep[], keys: ReadonlySet<string>): string[] {
  return steps.filter((s) => keys.has(s.key)).map((s) => s.text);
}

test("K-R7 identity: dish steps carry their dish and PERSISTED stepIndex, on both paths", () => {
  const flat = flattenMealSteps(twoDishMeal());
  assert.deepEqual(
    flat.map((s) => [s.dishId, s.stepIndex]),
    [
      ["dA", 5],
      ["dA", 2],
      ["dB", 0],
    ],
  );
  const sequenced = sequenceMealSteps(twoDishMeal(), [
    seq({ dishId: "dB", originalStepIndex: 0, sequenceIndex: 0 }),
  ]);
  assert.deepEqual(
    sequenced.map((s) => [s.dishId, s.stepIndex]),
    [
      ["dB", 0],
      ["dA", 5], // §27 append keeps the identity too
      ["dA", 2],
    ],
  );
});

test("K-R7: a cook step collapses only when EVERY prep step covering it is complete", () => {
  const steps = flattenMealSteps(preppedMeal());
  // Onions + Garlic ticked, Ginger not: the garlic-and-ginger step still has
  // work in it, so it renders normally.
  const partial = doneInPrepStepKeys(
    steps,
    preppedResult(),
    MEAL,
    new Set(["produce#onion", "produce#garlic"]),
    preppedMeal().dishes,
  );
  assert.deepEqual(keysByText(steps, partial), ["Dice 1 onion"]);

  const all = doneInPrepStepKeys(
    steps,
    preppedResult(),
    MEAL,
    new Set(["produce#onion", "produce#garlic", "produce#ginger"]),
    preppedMeal().dishes,
  );
  assert.deepEqual(keysByText(steps, all), [
    "Dice 1 onion",
    "Mince 3 cloves garlic and grate the ginger",
  ]);

  assert.equal(doneInPrepStepKeys(steps, preppedResult(), MEAL, new Set(), preppedMeal().dishes).size, 0);
});

test("K-R7: the prep TAG alone never collapses a step; nor do other meals' covers", () => {
  const steps = flattenMealSteps(preppedMeal());
  const everything = new Set([
    "produce#onion",
    "produce#garlic",
    "produce#ginger",
    "produce#leeks",
  ]);
  const done = doneInPrepStepKeys(steps, preppedResult(), MEAL, everything, preppedMeal().dishes);
  const texts = keysByText(steps, done);
  // "Chop the cilantro" is tagged prep but no prep step covers it.
  assert.ok(!texts.includes("Chop the cilantro"), `uncovered prep step collapsed: ${texts}`);
  // Ginger also covers dA#9 — but for OTHER_MEAL, not this one.
  assert.ok(!texts.includes("Sear the chicken"), `another meal's cover leaked: ${texts}`);

  // No payload, or no meal (a dishId launch): nothing collapses.
  assert.equal(doneInPrepStepKeys(steps, undefined, MEAL, everything, preppedMeal().dishes).size, 0);
  assert.equal(doneInPrepStepKeys(steps, preppedResult(), "", everything, preppedMeal().dishes).size, 0);
});

test("K-R7: no step is dropped — the tag-based filter and its recap are gone", async () => {
  const mod = (await import("../cookSession")) as Record<string, unknown>;
  assert.equal(mod.applyPrepFilter, undefined, "the old prep filter is still exported");
  assert.equal(mod.misePlaceItems, undefined, "the old cook-step recap is still exported");

  // Fully prepped, every covering step ticked: the flow is still all four steps.
  const steps = flattenMealSteps(preppedMeal());
  const done = doneInPrepStepKeys(
    steps,
    preppedResult(),
    MEAL,
    new Set(["produce#onion", "produce#garlic", "produce#ginger"]),
    preppedMeal().dishes,
  );
  assert.equal(steps.length, 4);
  assert.ok([...done].every((k) => steps.some((s) => s.key === k)));
});

test("K-R7 recap: the plan's PREP steps for this meal — not its cook steps", () => {
  const recap = prepRecap(preppedResult(), MEAL, [], new Date(2026, 9, 3, 18));
  // Prep titles, in Prep the Week's order. Not "Dice 1 onion" (a cook step),
  // not Leeks (another meal), not Herbs (never rendered), not the wash.
  assert.deepEqual(recap.items, ["Onions", "Garlic", "Ginger"]);
  assert.equal(prepRecap(undefined, MEAL, [], new Date()).items.length, 0);
});

test("K-R7 recap: 'Prepped on {day}' from the latest completion this week, else 'Already prepped'", () => {
  const now = new Date(2026, 9, 3, 18); // Saturday, local time
  const at = (y: number, m: number, d: number, h = 15) => new Date(y, m, d, h).toISOString();

  // Sunday the 27th, then Monday the 28th: the LATEST names the day.
  assert.equal(
    prepRecap(preppedResult(), MEAL, [{ stepKey: "produce#onion", checkedAt: at(2026, 8, 27) }], now)
      .heading,
    "Prepped on Sunday",
  );
  assert.equal(
    prepRecap(
      preppedResult(),
      MEAL,
      [
        { stepKey: "produce#onion", checkedAt: at(2026, 8, 27) },
        { stepKey: "produce#garlic", checkedAt: at(2026, 8, 28) },
      ],
      now,
    ).heading,
    "Prepped on Monday",
  );
  // Seven days back is the same weekday a week ago — the day alone would lie.
  assert.equal(
    prepRecap(preppedResult(), MEAL, [{ stepKey: "produce#onion", checkedAt: at(2026, 8, 26) }], now)
      .heading,
    "Already prepped",
  );
  // No completion (a manual pin), or only another meal's: the day is unknown.
  assert.equal(prepRecap(preppedResult(), MEAL, [], now).heading, "Already prepped");
  assert.equal(
    prepRecap(preppedResult(), MEAL, [{ stepKey: "produce#leeks", checkedAt: at(2026, 9, 2) }], now)
      .heading,
    "Already prepped",
  );
});

test("K-R7 navigation: the anchor starts on, and steps over to, live steps only", () => {
  const steps = flattenMealSteps(preppedMeal()); // keys of dA#4, dA#6, dA#7, dA#9
  const done = new Set([steps[0].key, steps[1].key]);
  assert.equal(firstLiveIndex(steps, done), 2);
  assert.equal(nextLiveIndex(steps, done, 2), 3);
  assert.equal(nextLiveIndex(steps, done, 3), 3, "no live step after the last");
  assert.equal(prevLiveIndex(steps, done, 2), 2, "no live step before the first");
  assert.equal(lastLiveIndex(steps, done), 3);

  const middle = new Set([steps[1].key, steps[2].key]);
  assert.equal(nextLiveIndex(steps, middle, 0), 3);
  assert.equal(prevLiveIndex(steps, middle, 3), 0);

  // Nothing done in prep → plain positions.
  assert.equal(firstLiveIndex(steps, new Set()), 0);
  assert.equal(lastLiveIndex(steps, new Set()), 3);
});

// CLIENT-3 F (BUG-527) — "yes, I prepped" with no plan item on the launch reads
// the meal through this week's plan, so the server words its prepped steps.
test("CLIENT-3 F: a 'yes' with no plan item reads through this meal's item in this week's plan", () => {
  const week = [
    { id: "pi-a", mealId: "m-other" },
    { id: "pi-b", mealId: "m1" },
    { id: "pi-c", mealId: "m1" },
  ];
  const base = { planItemId: "", mealId: "m1", thisWeekItems: week };
  assert.equal(preppedReadPlanItemId({ ...base, prepAnswer: true }), "pi-b", "the first, in plan order");
  // Before the answer, and on a "no": the read is unchanged (no plan item).
  assert.equal(preppedReadPlanItemId({ ...base, prepAnswer: null }), undefined);
  assert.equal(preppedReadPlanItemId({ ...base, prepAnswer: false }), undefined);
  // Not in this week's plan, or the plan not read yet: unchanged.
  assert.equal(preppedReadPlanItemId({ ...base, mealId: "m9", prepAnswer: true }), undefined);
  assert.equal(preppedReadPlanItemId({ ...base, thisWeekItems: undefined, prepAnswer: true }), undefined);
  // A launch that carried its plan item keeps it, whatever the answer.
  assert.equal(preppedReadPlanItemId({ ...base, planItemId: "pi-x", prepAnswer: true }), "pi-x");
  assert.equal(preppedReadPlanItemId({ ...base, planItemId: "pi-x", prepAnswer: null }), "pi-x");
});

test("CLIENT-3 F: Cook Mode reads this week's plan only after a 'yes' on a launch with no plan item", () => {
  const route = readFileSync(new URL("../../../app/cook-session.tsx", import.meta.url), "utf8");
  assert.match(
    route,
    /const findThisWeekItem =\s*planItemId\.length === 0 && mealId\.length > 0 && !planDish && prepAnswer === true;/,
  );
  assert.match(route, /usePlans\(\["my_plans"\], \{ enabled: findThisWeekItem \}\)/);
  assert.match(route, /const mealQuery = useMeal\(mealId, readPlanItemId, \{ prepped: preppedMealRead\(prepAnswer\) \}\);/);
});

// CLIENT-3 B (BUG-526) — "Skip to cooking" scrolls past the recap and the muted
// "Done in prep" rows to the first step left to cook.
test("CLIENT-3 B: Skip to cooking targets the first live step's laid-out y", () => {
  const steps = flattenMealSteps(preppedMeal());
  const done = new Set([steps[0].key, steps[1].key]);
  const offsets = { 0: 180, 1: 240, 2: 300, 3: 520 };
  assert.equal(skipToCookingY(steps, done, offsets), 300);
  // Nothing done in prep → the first step, below the recap.
  assert.equal(skipToCookingY(steps, new Set(), offsets), 180);
  // Not laid out yet → nothing to scroll to (the anchor still moves).
  assert.equal(skipToCookingY(steps, done, {}), undefined);
  assert.equal(skipToCookingY([], done, offsets), undefined);
});

test("K-R7: Cook Mode loads the prep payload only once a prep session has happened", () => {
  assert.equal(shouldLoadPrepForCook(true, 3), true);
  assert.equal(shouldLoadPrepForCook(true, 0), false, "no completion → a live AI call for nothing");
  assert.equal(shouldLoadPrepForCook(false, 3), false, "no plan context");
});

// ── CLIENT-2b D (D-WS9-321) — preppedRefs on the wire and through the flow ──

test("CLIENT-2b D: MealStepSchema keeps preppedRefs; absent and null both parse as no refs", () => {
  const wire = { ...step(), preppedRefs: [{ containerId: "c-1", label: "Taco spices" }] };
  assert.deepEqual(MealStepSchema.parse(wire).preppedRefs, [{ containerId: "c-1", label: "Taco spices" }]);
  assert.equal(MealStepSchema.parse(step()).preppedRefs, undefined);
  assert.equal(MealStepSchema.parse({ ...step(), preppedRefs: null }).preppedRefs, null);
  // A ref without its label is not a ref.
  assert.equal(MealStepSchema.safeParse({ ...step(), preppedRefs: [{ containerId: "c-1" }] }).success, false);
});

test("CLIENT-2b D: every Cook Mode path carries preppedRefs; none, null or [] leaves the field off", () => {
  const refs = [{ containerId: "c-1", label: "Taco spices" }];
  const meal = twoDishMeal();
  meal.dishes[0].steps[0] = step({ stepIndex: 5, text: "Sear chicken", preppedRefs: refs });
  meal.dishes[1].steps[0] = { ...meal.dishes[1].steps[0], preppedRefs: [] };
  const flat = flattenMealSteps(meal);
  assert.deepEqual(flat.find((s) => s.text === "Sear chicken")!.preppedRefs, refs);
  assert.ok(flat.filter((s) => s.text !== "Sear chicken").every((s) => !("preppedRefs" in s)));
  const sequenced = sequenceMealSteps(meal, [seq({ dishId: "dA", originalStepIndex: 5, sequenceIndex: 0 })]);
  assert.deepEqual(sequenced.find((s) => s.text === "Sear chicken")!.preppedRefs, refs);
  assert.deepEqual(flattenMealSteps(mealDetail({ steps: [step({ preppedRefs: refs })] }))[0].preppedRefs, refs);
  assert.ok(!("preppedRefs" in flattenMealSteps(mealDetail({ steps: [step({ preppedRefs: null })] }))[0]));
});

// ── CLIENT-6 B (BUG-584 / D-WS9-350 phase 1) — fold only what was really prepped ──
//
// The cook steps and prep steps are QA-NIGHT-1's (dev, 2026-10-28/29), verbatim.

const KEEMA_ING = ["ground beef (85% lean)", "yellow onion", "garlic cloves", "fresh ginger", "vegetable oil", "ground cumin", "ground coriander", "garam masala", "ground turmeric", "Kashmiri chili powder", "Kosher salt", "fresh cilantro"].map(ing);
function keemaMeal(): MealDetail {
  return mealDetail({
    steps: [],
    dishes: [
      {
        dishId: "dK",
        title: "Beef Keema Curry",
        roleLabel: "main",
        positionIndex: 0,
        minutes: 40,
        difficulty: "easy",
        servings: 4,
        ingredients: KEEMA_ING,
        steps: [
          // BUG-584's own step: linked to the garlic prep step only.
          step({ stepIndex: 0, text: "Finely dice the yellow onion and mince the 2 garlic cloves.", phaseType: "prep" }),
          step({ stepIndex: 1, text: "Finely dice the yellow onion, mince the 4 garlic cloves, and peel and grate 1 tablespoon fresh ginger.", phaseType: "prep" }),
          step({ stepIndex: 2, text: "Measure out 1½ teaspoons ground cumin, 1½ teaspoons ground coriander, 1½ teaspoons garam masala, ½ teaspoon ground turmeric, and ¾ teaspoon Kashmiri chili powder.", phaseType: "prep" }),
          step({ stepIndex: 3, text: "Mince the 4 garlic cloves.", phaseType: "prep" }),
          step({ stepIndex: 4, text: "Heat 2 tablespoons vegetable oil and brown the beef with the minced garlic.", phaseType: "cook" }),
          step({ stepIndex: 5, text: "Prep everything for the curry.", phaseType: "prep" }),
        ],
      },
    ],
  });
}
const covers = (...idx: number[]) => idx.map((stepIndex) => ({ mealId: MEAL, dishId: "dK", stepIndex }));
function keemaPrep(extra: { onionCovers?: number[]; garlicInstructions?: string } = {}): PrepWeekResult {
  return {
    totalEstimatedMinutes: 30,
    phases: [
      {
        phase: "seasonings_dry",
        title: "Dry ingredients",
        skippable: true,
        steps: [
          prepStep("cnt#seas#dK|r:0|", "Measure the Curry spices", {
            instructions: "Get a small bowl for the Curry spices. Into the bowl:\n3¾ tsp ground cumin\n3¾ tsp ground coriander\n3¾ tsp garam masala\n1¼ tsp ground turmeric\n2 tsp Kashmiri chili powder",
            containerNames: ["Curry spices"],
            coversCookSteps: covers(2),
          }),
        ],
      },
      {
        phase: "produce",
        title: "Produce",
        skippable: false,
        steps: [
          prepStep("produce#onion", "Dice all yellow onions", {
            instructions: "Dice 3 yellow onions.\nInto the Curry plate: 1 onion for the Beef Keema Curry",
            containerNames: ["Curry plate"],
            coversCookSteps: covers(...(extra.onionCovers ?? [])),
          }),
          prepStep("produce#garlic", "Mince all garlic", {
            instructions: extra.garlicInstructions ?? "Mince 31 cloves of garlic.\nInto the Minced garlic tub: 5 cloves for the Creamy Beef and Mushroom Stroganoff · 10 cloves for the Beef Keema Curry with Peas",
            containerNames: ["Minced garlic"],
            coversCookSteps: covers(0, 1, 3, 4, 5),
          }),
          prepStep("produce#ginger", "Grate the ginger", {
            instructions: "Peel and grate 2½ tbsp fresh ginger for the Curry plate.",
            containerNames: ["Curry plate"],
            coversCookSteps: covers(1),
          }),
        ],
      },
      { phase: "sauces_marinades", title: "Sauces and marinades", skippable: true, steps: [] },
      { phase: "proteins", title: "Proteins", skippable: false, steps: [] },
    ],
  };
}
const ALL_KEEMA = new Set(["cnt#seas#dK|r:0|", "produce#onion", "produce#garlic", "produce#ginger"]);
const idxOf = (steps: CookStep[], keys: ReadonlySet<string>) => steps.filter((s) => keys.has(s.key)).map((s) => s.stepIndex);

test("CLIENT-6 B (BUG-584): garlic ticked, onion not — the onion-and-garlic step shows in full, with the garlic's chip", () => {
  const steps = flattenMealSteps(keemaMeal());
  const ticked = new Set(["produce#garlic"]);
  const done = doneInPrepStepKeys(steps, keemaPrep(), MEAL, ticked, keemaMeal().dishes);
  // Before: step 0's only covering step (garlic) was ticked, so it folded and the onion was never diced.
  assert.ok(!idxOf(steps, done).includes(0), "the onion folded away");
  // The garlic-only step folds; it names nothing the garlic step did not do.
  assert.deepEqual(idxOf(steps, done), [3]);
  const chips = prepChips(steps, keemaPrep(), MEAL, ticked, done);
  assert.deepEqual(chips.get(steps[0].key), [{ containerId: "produce#garlic", label: "Minced garlic" }]);
  assert.equal(chips.get(steps[3].key), undefined, "a folded step needs no chip");
  const shown = withPrepChips(steps, chips);
  assert.equal(shown[0].text, steps[0].text, "the words are the recipe's, in full");
  assert.deepEqual(shown[0].preppedRefs?.map((r) => r.label), ["Minced garlic"]);
});

test("CLIENT-6 B: after full prep a step folds only when its covering steps did every food it names", () => {
  const steps = flattenMealSteps(keemaMeal());
  const done = doneInPrepStepKeys(steps, keemaPrep(), MEAL, ALL_KEEMA, keemaMeal().dishes);
  // 0/1: the onion's own step does not cover them, so nothing proves it was diced for them.
  // 2: every spice is a line of the Curry spices step. 3: garlic. 4: oil and beef are cook work.
  // 5: names no ingredient — the client cannot tell.
  assert.deepEqual(idxOf(steps, done), [2, 3]);
  // When the onion's step does cover them, they fold.
  const linked = doneInPrepStepKeys(steps, keemaPrep({ onionCovers: [0, 1] }), MEAL, ALL_KEEMA, keemaMeal().dishes);
  assert.deepEqual(idxOf(steps, linked), [0, 1, 2, 3]);
  // ...and still not while that onion step is unticked (the old strictness holds).
  const noOnion = new Set([...ALL_KEEMA].filter((k) => k !== "produce#onion"));
  assert.deepEqual(idxOf(steps, doneInPrepStepKeys(steps, keemaPrep({ onionCovers: [0, 1] }), MEAL, noOnion, keemaMeal().dishes)), [2, 3]);
});

test("CLIENT-6 B: where a prep step's food GOES is not what it cut", () => {
  const steps = flattenMealSteps(keemaMeal());
  // "…for the Creamy Beef and Mushroom Stroganoff" names beef; the garlic step did not brown it.
  const done = doneInPrepStepKeys(steps, keemaPrep(), MEAL, ALL_KEEMA, keemaMeal().dishes);
  assert.ok(!idxOf(steps, done).includes(4));
  // A garlic step whose line says "yellow onion" only as a destination does not cover the onion.
  const sneaky = keemaPrep({ garlicInstructions: "Mince 31 cloves of garlic for the yellow onion and garlic base." });
  assert.ok(!idxOf(steps, doneInPrepStepKeys(steps, sneaky, MEAL, ALL_KEEMA, keemaMeal().dishes)).includes(0));
});

test("CLIENT-6 B: green onions are not a yellow onion; a bare 'onion' ingredient is any onion", () => {
  const meal = keemaMeal();
  const steps = flattenMealSteps(meal).filter((s) => s.stepIndex === 0);
  const green = keemaPrep({ onionCovers: [0] });
  green.phases[1].steps[0] = { ...green.phases[1].steps[0], title: "Slice the green onions", instructions: "Slice 4 green onions." };
  assert.equal(doneInPrepStepKeys(steps, green, MEAL, ALL_KEEMA, meal.dishes).size, 0);
  const bare = [{ ...meal.dishes[0], ingredients: [ing("onion"), ing("garlic cloves")] }];
  assert.equal(doneInPrepStepKeys(steps, green, MEAL, ALL_KEEMA, bare).size, 1);
});

test("CLIENT-6 B: when the client cannot tell, nothing folds", () => {
  const steps = flattenMealSteps(keemaMeal());
  // No dishes to read names from.
  assert.equal(doneInPrepStepKeys(steps, keemaPrep(), MEAL, ALL_KEEMA).size, 0);
  // A dish whose ingredient list does not name what the step says.
  const nameless = [{ ...keemaMeal().dishes[0], ingredients: [] }];
  assert.equal(doneInPrepStepKeys(steps, keemaPrep(), MEAL, ALL_KEEMA, nameless).size, 0);
});

test("CLIENT-6 B chips: unticked covering steps get none, the server's own chip is not repeated, several containers read the title", () => {
  const steps = flattenMealSteps(keemaMeal());
  const prep = keemaPrep();
  // Ginger's step fills two containers here: its chip reads its title.
  prep.phases[1].steps[2] = { ...prep.phases[1].steps[2], containerNames: ["Curry plate", "Stir-fry plate"] };
  const withServerChip = steps.map((s) => (s.stepIndex === 1 ? { ...s, preppedRefs: [{ containerId: "c-garlic", label: "Minced garlic" }] } : s));
  const chips = prepChips(withServerChip, prep, MEAL, new Set(["produce#garlic", "produce#ginger"]), new Set());
  assert.deepEqual(chips.get(steps[1].key), [{ containerId: "produce#ginger", label: "Grate the ginger" }]);
  // Step 2's covering step (the spices) is not ticked: no chip.
  assert.equal(chips.get(steps[2].key), undefined);
  // Another meal's read: none.
  assert.equal(prepChips(steps, prep, "other-meal", ALL_KEEMA, new Set()).size, 0);
});

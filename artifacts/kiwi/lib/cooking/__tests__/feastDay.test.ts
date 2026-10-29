// PREP-2 — which of a Thanksgiving dish's steps belong to which day (feastDay.ts),
// a dish's Cook Mode in plan context (cookSession.flattenPlanDishSteps), and the
// dish screen's servings (lib/dishes/planDish.ts). The step texts are the dev
// catalog's, verbatim up to the first clause (THX-2G-F's phrase contract).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MealDetail, MealStep } from "@/lib/api/meals";
import { flattenMealSteps, flattenPlanDishSteps, sequenceMealSteps } from "@/lib/cooking/cookSession";
import { decodeRun, encodeRun, feastDayNameOf, feastDayStep, makeAheadRunSteps, onTheDayMeal, onTheDaySteps, runCookLine } from "@/lib/cooking/feastDay";
import { planDishView } from "@/lib/dishes/planDish";
import { CLASSIC_TURKEY, FEAST_DAY_VECTORS, OVERNIGHT_STUFFING, UNPREFIXED_RUN } from "@/lib/cooking/__tests__/feastDayVectors.mts";
import { formatIngredientLine } from "@/lib/format/ingredientLine";

const t = (texts: readonly string[]) => texts.map((text) => ({ text }));
const idx = (texts: readonly string[], out: { text: string }[] | null) => out?.map((s) => texts.indexOf(s.text)) ?? null;

describe("PREP-2 — a make-ahead row's run", () => {
  it("the Classic turkey: the thaw is one step, Wednesday night is the brine and the butter", () => {
    assert.deepEqual(idx(CLASSIC_TURKEY, makeAheadRunSteps(t(CLASSIC_TURKEY), { kind: "thaw", dayName: "Friday" })), [0]);
    assert.deepEqual(idx(CLASSIC_TURKEY, makeAheadRunSteps(t(CLASSIC_TURKEY), { kind: "brine", dayName: "Wednesday" })), [1, 2, 3, 4]);
    // A brine is the NIGHT: Wednesday's day run is not it.
    assert.equal(makeAheadRunSteps(t(CLASSIC_TURKEY), { kind: "make", dayName: "Wednesday" }), null);
  });

  it("Make-Ahead's stuffing: Wednesday's row is Wednesday's steps (Tuesday's bread step has no row)", () => {
    assert.deepEqual(idx(OVERNIGHT_STUFFING, makeAheadRunSteps(t(OVERNIGHT_STUFFING), { kind: "make", dayName: "Wednesday" })), [1, 2, 3, 4, 5]);
    assert.deepEqual(idx(OVERNIGHT_STUFFING, makeAheadRunSteps(t(OVERNIGHT_STUFFING), { kind: "make", dayName: "Tuesday" })), [0]);
  });

  it("an unprefixed simmer stays in its run, up to 'On Thursday:'", () => {
    assert.deepEqual(idx(UNPREFIXED_RUN, makeAheadRunSteps(t(UNPREFIXED_RUN), { kind: "make", dayName: "Monday" })), [0, 1, 2]);
  });

  it("no such run → null (the caller cooks the whole dish); the day matches case-insensitively", () => {
    assert.equal(makeAheadRunSteps(t(["Season with salt.", "Roast 1 hour."]), { kind: "make", dayName: "Monday" }), null);
    assert.deepEqual(makeAheadRunSteps(t(["MAKE AHEAD (monday): Zest 2 oranges."]), { kind: "make", dayName: "Monday" })?.length, 1);
  });

  it("the run rides a route param and back; anything else is no run", () => {
    assert.equal(encodeRun({ kind: "brine", dayName: "Tuesday" }), "brine:Tuesday");
    assert.deepEqual(decodeRun("brine:Tuesday"), { kind: "brine", dayName: "Tuesday" });
    assert.equal(decodeRun(undefined), null);
    assert.equal(decodeRun("bake:Tuesday"), null);
    assert.equal(runCookLine({ kind: "brine", dayName: "Tuesday" }), "Cook Mode opens the Tuesday night steps.");
    assert.equal(runCookLine({ kind: "make", dayName: "Monday" }), "Cook Mode opens the Monday make-ahead steps.");
  });
});

function step(text: string, stepIndex: number): MealStep {
  return {
    stepIndex,
    text,
    estimatedMinutes: 5,
    phaseType: "prep",
    requiresPreheat: false,
    requiresRest: false,
    requiresMarination: false,
    isTimingSensitive: false,
  } as MealStep;
}

function feast(effectiveServings: number): MealDetail {
  return {
    id: "feast",
    title: "Classic Thanksgiving",
    servings: 10,
    authoredServingsDefault: 10,
    effectiveServings,
    tags: ["thanksgiving-feast"],
    steps: [],
    dishes: [
      {
        dishId: "turkey",
        title: "Herb-Roasted Whole Turkey",
        roleLabel: "main",
        positionIndex: 0,
        minutes: 300,
        difficulty: "medium",
        servings: 10,
        authoredServingsDefault: 10,
        ingredients: [],
        // stepIndex is the persisted index, deliberately not the array position.
        steps: CLASSIC_TURKEY.map((text, i) => step(text, i + 10)),
      },
      {
        dishId: "cran",
        title: "Cranberry-Orange Sauce",
        roleLabel: "side",
        positionIndex: 1,
        minutes: 30,
        difficulty: "easy",
        servings: 10,
        authoredServingsDefault: 10,
        ingredients: [{ name: "fresh cranberries", quantity: 24, unit: "ounce", preparationNote: null, category: "Produce", isOptional: false }],
        steps: UNPREFIXED_RUN.map((text, i) => step(text, i)),
      },
    ],
  } as unknown as MealDetail;
}

describe("PREP-2 item 2 — Cook Mode for one dish of the feast", () => {
  it("with the row's run: only that run, keyed by dish and persisted stepIndex", () => {
    const steps = flattenPlanDishSteps(feast(10), "turkey", { kind: "brine", dayName: "Wednesday" });
    assert.deepEqual(steps.map((s) => s.key), ["turkey#11", "turkey#12", "turkey#13", "turkey#14"]);
    assert.ok(steps.every((s) => s.dishId === "turkey" && s.dishTitle === undefined));
  });
  it("no run, or a run the dish does not have: the whole dish; an unknown dish: nothing", () => {
    assert.equal(flattenPlanDishSteps(feast(10), "turkey", null).length, 12);
    assert.equal(flattenPlanDishSteps(feast(10), "turkey", { kind: "make", dayName: "Monday" }).length, 12);
    assert.deepEqual(flattenPlanDishSteps(feast(10), "nope", null), []);
  });
});

describe("PREP-2 item 2 — the dish reads at the plan's servings, the way meal detail does", () => {
  it("at the feast's own 10: serves 10, amounts as written", () => {
    const v = planDishView(feast(10), "cran")!;
    assert.deepEqual([v.servings, v.multiplier], [10, 1]);
    assert.equal(formatIngredientLine(v.dish.ingredients[0], { multiplier: v.multiplier }), "24 ounces fresh cranberries");
  });
  it("at 8: serves 8, amounts × 0.8", () => {
    const v = planDishView(feast(8), "cran")!;
    assert.deepEqual([v.servings, v.multiplier], [8, 0.8]);
    // WEB-4d (R5) — 19.2 oz: whole ounces from 4 oz (was "19¼").
    assert.equal(formatIngredientLine(v.dish.ingredients[0], { multiplier: v.multiplier }), "19 ounces fresh cranberries");
  });
  it("a meal that no longer holds the dish: null (the screen falls back to the dish alone)", () => {
    assert.equal(planDishView(feast(10), "gone"), null);
  });
});

// ── PREP-2 item 3 — the feast's Cook Mode is Thursday's ────────────────────────

describe("PREP-2 item 3 — the feast day's steps", () => {
  // The same literal vectors as api-server mealTimingBug418.test.ts (the server's
  // onTheDaySteps): the two readings must agree step for step.
  it("the Classic turkey cooks from 'On Thursday:' on; the thaw and the brine are runs", () => {
    assert.deepEqual(idx(CLASSIC_TURKEY, onTheDaySteps(t(CLASSIC_TURKEY))), [5, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual(idx(OVERNIGHT_STUFFING, onTheDaySteps(t(OVERNIGHT_STUFFING))), [6, 7, 8]);
    assert.deepEqual(idx(UNPREFIXED_RUN, onTheDaySteps(t(UNPREFIXED_RUN))), [3]);
    // A recipe with no prefixes at all is all feast day (the Wellington).
    assert.deepEqual(onTheDaySteps(t(["Chop the mushrooms.", "Bake 30 minutes."])).length, 2);
  });

  it("a feast's Cook Mode (both paths) leaves the runs out; the §27 append does not put them back", () => {
    const meal = feast(10);
    const flat = flattenMealSteps(onTheDayMeal(meal));
    // The turkey's persisted stepIndex is its array position + 10 (see `feast`).
    assert.deepEqual(flat.map((s) => `${s.dishId}@${s.stepIndex}`), [
      "turkey@15", "turkey@16", "turkey@17", "turkey@18", "turkey@19", "turkey@20", "turkey@21", "cran@3",
    ]);
    // An older server that still sequenced every step: its make-ahead entries have
    // nothing to map to, and the append adds only what the feast day holds.
    const seq = meal.dishes.flatMap((d) =>
      d.steps.map((s, i) => ({ sequenceIndex: i, dishId: d.dishId, originalStepIndex: s.stepIndex, reason: null, startOffsetMinutes: null })),
    );
    const sequenced = sequenceMealSteps(onTheDayMeal(meal), seq as never);
    assert.equal(sequenced.length, 8);
    assert.ok(sequenced.every((s) => !/^(make ahead|thaw) \(/i.test(s.text)), sequenced.map((s) => s.text).join("\n"));
  });

  it("a meal NOT tagged thanksgiving-feast is the same object, and cooks every step as before", () => {
    const ordinary = { ...feast(10), tags: ["american", "thanksgiving"] } as MealDetail;
    assert.equal(onTheDayMeal(ordinary), ordinary);
    assert.deepEqual(flattenMealSteps(onTheDayMeal(ordinary)), flattenMealSteps(ordinary));
    assert.equal(flattenMealSteps(ordinary).length, 16);
  });
});

// ── CLIENT-6 A (D-WS9-351) — "On feast day:", read alike and shown off a Thursday ──

describe("CLIENT-6 A — the shared vectors: both prefixes are the feast day", () => {
  for (const v of FEAST_DAY_VECTORS) {
    it(v.name, () => {
      assert.deepEqual(idx(v.steps, onTheDaySteps(t(v.steps))), [...v.onTheDay]);
    });
  }
  it("an 'On feast day:' turkey keeps its brine run: the brine is still Wednesday night's", () => {
    const said = FEAST_DAY_VECTORS.find((v) => v.name === "Classic turkey, On feast day:")!.steps;
    assert.deepEqual(idx(said, makeAheadRunSteps(t(said), { kind: "brine", dayName: "Wednesday" })), [1, 2, 3, 4]);
  });
});

describe("CLIENT-6 A — the feast's Cook Mode on a Thursday and a Saturday feast", () => {
  const classic = CLASSIC_TURKEY;
  const makeAhead = FEAST_DAY_VECTORS.find((v) => v.name === "Make-Ahead turkey, On Thursday:")!.steps;
  // Cook Mode's own path: onTheDayMeal → flattenMealSteps → feastDayStep per step.
  const cook = (texts: readonly string[], day: string | null) =>
    flattenMealSteps(
      onTheDayMeal({
        ...feast(10),
        dishes: [{ ...feast(10).dishes[0], steps: texts.map((text, i) => step(text, i)) }],
      } as MealDetail),
    ).map((s) => feastDayStep(s, day).text);
  const has = (texts: string[], re: RegExp) => texts.some((x) => re.test(x));

  for (const [name, texts] of [["Classic", classic], ["Make-Ahead", makeAhead]] as const) {
    for (const stored of ["On Thursday:", "On feast day:"]) {
      const storedTexts = stored === "On Thursday:" ? texts : texts.map((x) => x.replace(/^On Thursday:/, stored));
      for (const day of ["Thursday", "Saturday"]) {
        it(`${name}, stored "${stored}", a ${day} feast: brine out, roast, rest and carve in; the prefix says ${day === "Thursday" && stored === "On Thursday:" ? "Thursday" : "feast day"}`, () => {
          const shown = cook(storedTexts, day);
          assert.ok(has(shown, /^On (Thursday|feast day): Remove the turkey from the (brine|fridge)/), shown.join("\n"));
          assert.ok(has(shown, /\broast at 325°F/), "roast");
          assert.ok(has(shown, /\brest\b/), "rest");
          assert.ok(has(shown, /^Carve the turkey/), "carve");
          assert.ok(!has(shown, /^(Make ahead|Thaw) \(/), "no run step");
          const head = shown.find((x) => /^On /.test(x))!;
          assert.equal(head.startsWith("On feast day:"), !(day === "Thursday" && stored === "On Thursday:"));
        });
      }
    }
  }

  it("a Thursday feast reads byte-identical, and so does an unknown day (no plan)", () => {
    const s = { text: "On Thursday: Preheat the oven to 375°F.", amountRefs: null };
    assert.equal(feastDayStep(s, "Thursday"), s);
    assert.equal(feastDayStep(s, "thursday"), s);
    assert.equal(feastDayStep(s, null), s);
    assert.equal(feastDayStep(s, undefined), s);
    assert.deepEqual(cook(classic, "Thursday"), cook(classic, null));
  });

  it("only a LEADING prefix is said again; other steps are the same object", () => {
    const mid = { text: "Pull it out Thursday morning. On Thursday: roast." };
    assert.equal(feastDayStep(mid, "Saturday"), mid);
    assert.equal(feastDayStep({ text: "  on THURSDAY: Spoon." }, "Saturday").text, "  On feast day: Spoon.");
  });

  it("the amount refs after the prefix move by one character, so the amount still lands on its words", () => {
    const text = "On Thursday: Rub 2 tablespoons olive oil over the skin.";
    const at = text.indexOf("2 tablespoons");
    const s = { text, amountRefs: [{ ingredientId: "oil", quantity: 2, unit: "tablespoon", charStart: at, charEnd: at + 13 }] };
    const out = feastDayStep(s, "Saturday");
    const r = out.amountRefs![0];
    assert.equal(out.text.slice(r.charStart, r.charEnd), "2 tablespoons");
    assert.equal(s.amountRefs[0].charStart, at, "the input is not mutated");
  });

  it("the day comes from the plan's make-ahead payload, for its feast meal only", () => {
    const plan = { makeAhead: { feastMealId: "feast", feastDayName: "Saturday" } };
    assert.equal(feastDayNameOf(plan, "feast"), "Saturday");
    assert.equal(feastDayNameOf(plan, "other"), null);
    assert.equal(feastDayNameOf({}, "feast"), null);
    assert.equal(feastDayNameOf(undefined, "feast"), null);
  });
});

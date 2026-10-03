// WS9 D-WS9-301 rules 9-14 — Hans's October 1 device pass.
//
// He walked every step of the week-of-Sep-30 plan and gave the model the engine
// was missing: the phases are the KIND OF WORK, in the order a cook works a
// board, and every produce line has to say where each portion goes, with its
// quantity. "there's no other easy way to see the recipe and ingredients on
// that screen, so without quantities the user is lost."

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { combinePrep, type PrepCombineInput } from "../prepCombineEngine";
import {
  WASH_STEP_KEY,
  WASH_STEP_TITLE,
  buildStepPlan,
  assemblePrepWeekResult,
  countContainers,
} from "../prepWeekAssembly";
import { proteinVerbsFor } from "../prepComponents";
import {
  applyStorageOverlay,
  NO_COOK_DAYS_NOTE,
  PROTEINS_PHASE_NOTE,
  type StorageContext,
} from "../prepStorage";
import { PrepWeekResultSchema, type PrepWeekResult } from "../ai/schemas/prepWeek";
import type { PrepNarrationResult } from "../ai/schemas/prepNarration";

const MEAL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEAL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEAL_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const echo = (sp: ReturnType<typeof buildStepPlan>): PrepNarrationResult => ({
  steps: sp.steps
    .filter((s) => !s.fixedProse)
    .map((s, i) => ({ stepId: s.stepId, title: `T${i}`, instructions: `I${i}` })),
});

// ── rule 9: the order ───────────────────────────────────────────────────────

describe("D-WS9-301 rule 9 — the phases are the kind of work, in work order", () => {
  it("🔴 Dry · Produce · Sauces and marinades · Proteins", () => {
    // Hans: "measure the dry stuff … then I do my produce … then I would add the
    // olive oil and lemon juice to any marinades … and then, if I'm still going
    // strong, I'll trim the chicken."
    const sp = buildStepPlan(combinePrep({ meals: [] }), "Empty");
    const result = assemblePrepWeekResult(sp, { steps: [{ stepId: "x", title: "t", instructions: "i" }] });
    assert.deepEqual(
      result.phases.map((p) => p.title),
      ["Dry ingredients", "Produce", "Sauces and marinades", "Proteins"],
    );
    assert.deepEqual(
      result.phases.map((p) => p.phase),
      ["seasonings_dry", "produce", "sauces_marinades", "proteins"],
    );
  });

  it("the KEYS are unchanged, so no stored stepKey moved", () => {
    // Every PrepStepCompletion row is keyed `<phase>#<ingredientId>`. Swapping
    // the keys to match the new order would have orphaned all of them.
    const sp = buildStepPlan(combinePrep({ meals: [] }), "Empty");
    void sp;
    const keys = PrepWeekResultSchema.safeParse({
      totalEstimatedMinutes: 1,
      phases: (["seasonings_dry", "produce", "sauces_marinades", "proteins"] as const).map((p) => ({
        phase: p, title: p, skippable: false, steps: [],
      })),
    });
    assert.equal(keys.success, true);
  });
});

// ── rule 10: the wash step ──────────────────────────────────────────────────

function withProduce(): PrepCombineInput {
  return {
    meals: [
      {
        mealId: MEAL_A,
        mealName: "Taco Night",
        dishes: [
          {
            dishId: "d1",
            dishName: "Tacos",
            dishRole: "main",
            ingredients: [
              { ingredientId: "onion", ingredientName: "white onion", category: "Produce", quantity: 1, unit: "each", preparationNote: "diced" },
            ],
          },
        ],
      },
    ],
  };
}

describe("D-WS9-301 rule 10 — produce opens with the wash", () => {
  it("🔴 exactly one wash step, and it is step 1 of the produce phase", () => {
    const sp = buildStepPlan(combinePrep(withProduce()), "Test Plan");
    const produce = sp.steps.filter((s) => s.phase === "produce");
    assert.equal(produce.filter((s) => s.stepKey === WASH_STEP_KEY).length, 1);
    assert.equal(produce[0].stepKey, WASH_STEP_KEY);
    assert.equal(produce[0].number, 1);
    assert.equal(produce[0].estimatedMinutes, 3);
  });

  it("🔴 NO wash step when the plan has no produce", () => {
    const dryOnly: PrepCombineInput = {
      meals: [
        {
          mealId: MEAL_A,
          mealName: "Pantry Night",
          dishes: [
            {
              dishId: "d1",
              dishName: "Spiced Rice",
              dishRole: "main",
              ingredients: [
                { ingredientId: "c", ingredientName: "ground cumin", category: "Pantry", quantity: 1, unit: "tsp" },
                { ingredientId: "p", ingredientName: "smoked paprika", category: "Pantry", quantity: 1, unit: "tsp" },
                { ingredientId: "o", ingredientName: "dried oregano", category: "Pantry", quantity: 1, unit: "tsp" },
              ],
            },
          ],
        },
      ],
    };
    const sp = buildStepPlan(combinePrep(dryOnly), "Test Plan");
    assert.equal(sp.steps.filter((s) => s.stepKey === WASH_STEP_KEY).length, 0);
  });

  it("🔴 it is NOT a container and does NOT gate 'prepped'", () => {
    // It contributes to every meal with produce. Counted, it inflates the
    // header; required, no meal reads prepped until it is ticked — including
    // for a cook who buys washed greens.
    const sp = buildStepPlan(combinePrep(withProduce()), "Test Plan");
    const wash = sp.steps.find((s) => s.stepKey === WASH_STEP_KEY)!;
    assert.equal(wash.holdsNoContainer, true);
    assert.equal(countContainers(sp.steps), sp.steps.filter((s) => !s.demoted).length - 1);
  });

  it("🔴 its prose is the ENGINE's — the model is never asked", () => {
    const sp = buildStepPlan(combinePrep(withProduce()), "Test Plan");
    assert.ok(!sp.narrationInput.steps.some((s) => s.stepId === sp.steps[0].stepId && sp.steps[0].fixedProse));
    const washIds = sp.steps.filter((s) => s.fixedProse).map((s) => s.stepId);
    for (const id of washIds) {
      assert.ok(!sp.narrationInput.steps.some((s) => s.stepId === id), "the wash step was sent to the model");
    }
    // …and it survives assembly with that prose even though no narration mentions it.
    const result = assemblePrepWeekResult(sp, echo(sp));
    const produce = result.phases.find((p) => p.phase === "produce")!;
    assert.equal(produce.steps[0].title, WASH_STEP_TITLE);
  });
});

// ── rules 10/11: destinations ───────────────────────────────────────────────

describe("D-WS9-301 rules 10 and 11 — every portion names its container", () => {
  /** One onion across three dishes; one of them also builds a marinade. */
  const sharedOnion = (): PrepCombineInput => ({
    meals: [
      {
        mealId: MEAL_A,
        mealName: "Mexican Week",
        dishes: [
          {
            dishId: "d1",
            dishName: "Enchiladas",
            dishRole: "main",
            ingredients: [
              { ingredientId: "onion", ingredientName: "white onion", category: "Produce", quantity: 1, unit: "each", preparationNote: "finely diced" },
              { ingredientId: "oil", ingredientName: "sesame oil", category: "Pantry", quantity: 2, unit: "tbsp", component: { key: "sauce", noun: "sauce", bowlName: "Enchiladas sauce jar" }, momentKey: "c:sauce" },
              { ingredientId: "vin", ingredientName: "red wine vinegar", category: "Pantry", quantity: 1, unit: "tbsp", component: { key: "sauce", noun: "sauce", bowlName: "Enchiladas sauce jar" }, momentKey: "c:sauce" },
              // H7 — a third wet member: the ruling's floor for a sauce base is 3 (or 2
              // that must SIT, a marinade or a brine). Oil and vinegar alone are two
              // things poured at the stove, and the container would rightly not exist.
              { ingredientId: "soy", ingredientName: "soy sauce", category: "Pantry", quantity: 1, unit: "tbsp", component: { key: "sauce", noun: "sauce", bowlName: "Enchiladas sauce jar" }, momentKey: "c:sauce" },
            ],
          },
        ],
      },
      {
        mealId: MEAL_B,
        mealName: "Rice Night",
        dishes: [{ dishId: "d2", dishName: "Mexican Rice", dishRole: "main", ingredients: [{ ingredientId: "onion", ingredientName: "white onion", category: "Produce", quantity: 0.5, unit: "each", preparationNote: "finely diced" }] }],
      },
      {
        mealId: MEAL_C,
        mealName: "Chili Night",
        dishes: [{ dishId: "d3", dishName: "Chili Fixings", dishRole: "topping", ingredients: [{ ingredientId: "onion", ingredientName: "white onion", category: "Produce", quantity: 0.5, unit: "each", preparationNote: "finely diced" }] }],
      },
    ],
  });

  it("🔴 the per-dish amounts sum to the total and each names its dish", () => {
    const sp = buildStepPlan(combinePrep(sharedOnion()), "Test Plan");
    const onion = sp.steps.find((s) => s.components.some((c) => c.ingredientName === "white onion"))!;
    const measures = onion.components[0].measures;
    assert.equal(measures.length, 3);
    assert.deepEqual(measures.map((m) => m.amount).sort(), ["1", "½", "½"]);
    assert.deepEqual(
      measures.map((m) => m.forDish).sort(),
      ["Chili Fixings", "Enchiladas", "Mexican Rice"],
    );
  });

  it("the destination field exists for a portion that goes into a named container", () => {
    const sp = buildStepPlan(combinePrep(sharedOnion()), "Test Plan");
    const sauce = sp.steps.find((s) => s.bowlName === "Enchiladas sauce jar");
    assert.ok(sauce, "the authored sauce container should exist");
    for (const c of sauce!.components) {
      for (const m of c.measures) {
        assert.equal(m.destination, "Enchiladas sauce jar");
      }
    }
  });

  it("🔴 a shared portion keeps ONE container — rule 5 is not undone", () => {
    const sp = buildStepPlan(combinePrep(sharedOnion()), "Test Plan");
    const onionSteps = sp.steps.filter((s) => s.components.some((c) => c.ingredientName === "white onion"));
    assert.equal(onionSteps.length, 1, "the onion split across dishes again");
  });
});

// ── rule 12: the verb ───────────────────────────────────────────────────────

describe("D-WS9-301 rule 12 — a protein step names the action", () => {
  it("🔴 the lemon-herb chicken is POUNDED and the slow-cooker thighs are TRIMMED", () => {
    assert.deepEqual(
      proteinVerbsFor(null, "Pound the chicken breasts to an even ¾-inch thickness, then pat dry."),
      ["pound"],
    );
    assert.deepEqual(
      proteinVerbsFor("trimmed of excess fat", "Add the chicken thighs to the slow cooker."),
      ["trim"],
    );
  });

  it("🔴 THE PROSE WINS OVER THE NOTE", () => {
    // The Buttermilk chicken's note says "sliced very thin" — the shopping
    // form — while its prose says pound and portion, which is what the cook
    // step expects to find ready.
    assert.deepEqual(
      proteinVerbsFor("sliced very thin", "Pound each breast, then portion into four."),
      ["pound", "portion"],
    );
  });

  it("at most two verbs, and none when the recipe names none", () => {
    const many = proteinVerbsFor(null, "Butterfly, pound, cube, trim and portion the chicken.");
    assert.equal(many.length, 2);
    assert.deepEqual(proteinVerbsFor(null, "Season the chicken and bake."), []);
  });
});

// ── rule 13: the held list ──────────────────────────────────────────────────

function proteinsResult(): PrepWeekResult {
  return {
    totalEstimatedMinutes: 10,
    phases: (["seasonings_dry", "produce", "sauces_marinades", "proteins"] as const).map((p) => ({
      phase: p,
      title: p,
      skippable: false,
      steps:
        p === "proteins"
          ? [{
              number: 1,
              stepKey: "proteins#chuck",
              title: "Cube the chuck",
              instructions: "…",
              estimatedMinutes: 8,
              contributesToMealIds: [MEAL_A],
            }]
          : [],
    })),
  } as PrepWeekResult;
}

const ctx = (o: Partial<StorageContext> & { phase: string }): StorageContext => ({
  text: "", ingredientNames: [], ...o,
});

describe("D-WS9-301 rule 13 — held for cook day, shown not dropped", () => {
  it("🔴 a demoted protein appears in the held list, with its day", () => {
    const out = applyStorageOverlay(
      proteinsResult(),
      new Map([["proteins#chuck", ctx({
        phase: "proteins",
        daysUntilCook: 5,
        ingredientNames: ["beef chuck"],
        dayName: "Saturday",
        mealName: "Texas-Style Beef Chili",
      })]]),
    );
    const proteins = out.phases.find((p) => p.phase === "proteins")!;
    assert.equal(proteins.steps[0].skipSuggested, true);
    assert.ok(proteins.heldForCookDay, "nothing was held");
    assert.equal(proteins.heldForCookDay!.length, 1);
    assert.match(proteins.heldForCookDay![0], /Texas-Style Beef Chili/);
    assert.match(proteins.heldForCookDay![0], /Saturday, 5 days out/);
  });

  it("a protein that KEEPS is not in the list", () => {
    const out = applyStorageOverlay(
      proteinsResult(),
      new Map([["proteins#chuck", ctx({ phase: "proteins", daysUntilCook: 1, ingredientNames: ["beef chuck"] })]]),
    );
    assert.equal(out.phases.find((p) => p.phase === "proteins")!.heldForCookDay, undefined);
  });

  it("🔴 with NO cook days anywhere, the phase says how to get them", () => {
    const out = applyStorageOverlay(
      proteinsResult(),
      new Map([["proteins#chuck", ctx({ phase: "proteins", ingredientNames: ["beef chuck"] })]]),
    );
    const note = out.phases.find((p) => p.phase === "proteins")!.note!;
    assert.ok(note.startsWith(PROTEINS_PHASE_NOTE));
    assert.ok(note.includes(NO_COOK_DAYS_NOTE));
    // …and nothing is held, because everything is prepped with the 2-day note.
    assert.equal(out.phases.find((p) => p.phase === "proteins")!.heldForCookDay, undefined);
  });

  it("…and with a day known, the standing line alone", () => {
    const out = applyStorageOverlay(
      proteinsResult(),
      new Map([["proteins#chuck", ctx({ phase: "proteins", daysUntilCook: 1, ingredientNames: ["beef chuck"] })]]),
    );
    assert.equal(out.phases.find((p) => p.phase === "proteins")!.note, PROTEINS_PHASE_NOTE);
  });
});

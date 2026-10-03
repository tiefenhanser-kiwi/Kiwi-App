// WS9 D-WS9-301 rule 11(c) — H4. A container's members are distributed to steps
// by the KIND OF WORK they need; the container keeps one name across them, and
// the counter counts containers, not steps.
//
// Hans's objection on the October 1 device pass is the whole of this file:
// *"the user should have already prepped the veggies that will go into that
// marinade"*. A marinade step that minces its own garlic asks the cook to pick
// the knife back up after they put it down.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { combinePrep, type PrepCombineInput } from "../prepCombineEngine";
import {
  buildStepPlan,
  assemblePrepWeekResult,
  countContainers,
  containerNamesOf,
  memberKind,
  summarizePrepWeek,
  WASH_STEP_KEY,
} from "../prepWeekAssembly";
import { demotedStepKeysFromStructure } from "../prepStepSet";
import type { PrepNarrationResult } from "../ai/schemas/prepNarration";

const MEAL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const echo = (sp: ReturnType<typeof buildStepPlan>): PrepNarrationResult => ({
  steps: sp.steps
    .filter((s) => !s.fixedProse)
    .map((s, i) => ({ stepId: s.stepId, title: `T${i}`, instructions: `I${i}` })),
});

const MARINADE = { key: "marinade", noun: "marinade", bowlName: "Lemon-Herb Chicken marinade bowl" };

/**
 * One authored marinade with all four kinds of member in it: a dry measure, two
 * pieces of knife work, and two liquids. Every one of them is filed by the
 * catalog under the SAME component, which is how the engine used to emit them
 * as one "Build the marinade bowl" step in the middle of the produce phase.
 */
function marinade(): PrepCombineInput {
  const m = (
    ingredientId: string,
    ingredientName: string,
    category: string,
    quantity: number,
    unit: string,
    preparationNote?: string,
  ) => ({
    ingredientId,
    ingredientName,
    category,
    quantity,
    unit,
    ...(preparationNote ? { preparationNote } : {}),
    component: MARINADE,
    momentKey: "c:marinade",
  });
  return {
    meals: [
      {
        mealId: MEAL_A,
        mealName: "Lemon-Herb Chicken",
        dishes: [
          {
            dishId: "d1",
            dishName: "Lemon-Herb Chicken",
            dishRole: "main",
            ingredients: [
              // Three, because D-WS9-299 tier 3 pre-measures a dry seasoning
              // only when its dish has 3+ of them. Below that the engine is
              // right to leave them in the jar.
              m("cumin", "ground cumin", "Pantry", 1, "tsp"),
              m("paprika", "smoked paprika", "Pantry", 2, "tsp"),
              m("oregano", "dried oregano", "Pantry", 1, "tsp"),
              m("garlic", "garlic cloves", "Produce", 3, "clove", "minced"),
              m("rosemary", "fresh rosemary", "Produce", 2, "tbsp", "chopped"),
              m("oil", "extra-virgin olive oil", "Pantry", 3, "tbsp"),
              m("lemon", "lemon", "Produce", 1, "each", "juiced and zested"),
            ],
          },
        ],
      },
    ],
  };
}

/** No liquid anywhere: a dry rub plus the vegetables that go in the crock. */
function slowCooker(): PrepCombineInput {
  const c = { key: "crock", noun: "prep container", bowlName: "Slow-Cooker Chicken spice blend" };
  const m = (
    ingredientId: string,
    ingredientName: string,
    category: string,
    quantity: number,
    unit: string,
    preparationNote?: string,
  ) => ({
    ingredientId,
    ingredientName,
    category,
    quantity,
    unit,
    ...(preparationNote ? { preparationNote } : {}),
    component: c,
    momentKey: "c:crock",
  });
  // H7 — the vegetables enter at the cook step that scatters them into the crock
  // ("scatter the onion, celery, carrots, and garlic", step 1 on the real plan).
  // They are a heat moment of their own and never share the dry rub's container.
  const veg = (
    ingredientId: string,
    ingredientName: string,
    quantity: number,
    preparationNote: string,
  ) => ({ ingredientId, ingredientName, category: "Produce", quantity, unit: "each", preparationNote, momentKey: "s:1" });
  return {
    meals: [
      {
        mealId: MEAL_A,
        mealName: "Slow-Cooker Chicken",
        dishes: [
          {
            dishId: "d1",
            dishName: "Slow-Cooker Chicken",
            dishRole: "main",
            ingredients: [
              m("paprika", "smoked paprika", "Pantry", 2, "tsp"),
              m("thyme_d", "dried thyme", "Pantry", 1, "tsp"),
              m("gpowder", "garlic powder", "Pantry", 1, "tsp"),
              veg("onion", "yellow onion", 1, "diced"),
              veg("celery", "celery stalks", 3, "sliced"),
              veg("carrot", "carrots", 2, "sliced"),
            ],
          },
        ],
      },
    ],
  };
}

const phaseOf = (sp: ReturnType<typeof buildStepPlan>, phase: string) =>
  sp.steps.filter((s) => s.phase === phase && !s.demoted);
const names = (s: { components: { ingredientName: string }[] }) =>
  s.components.map((c) => c.ingredientName).sort();

// ── 1 ───────────────────────────────────────────────────────────────────────

describe("rule 11(c) — a marinade's produce is prepped in the produce phase", () => {
  it("🔴 garlic and rosemary get their OWN steps, with the marinade as destination and a quantity", () => {
    const sp = buildStepPlan(combinePrep(marinade()), "Test Plan");
    const produce = phaseOf(sp, "produce").filter((s) => s.stepKey !== WASH_STEP_KEY);
    const garlic = produce.find((s) => names(s).includes("garlic cloves"));
    const rosemary = produce.find((s) => names(s).includes("fresh rosemary"));
    assert.ok(garlic, "the marinade's garlic is not prepped in the produce phase");
    assert.ok(rosemary, "the marinade's rosemary is not prepped in the produce phase");
    for (const step of [garlic!, rosemary!]) {
      assert.equal(step.containerId, undefined, "knife work is not itself the container");
      for (const c of step.components) {
        for (const measure of c.measures) {
          assert.equal(measure.destination, MARINADE.bowlName);
          assert.match(measure.amount, /\S/, "a portion with no quantity leaves the cook lost");
        }
      }
    }
  });

  it("the knife work names the bowl it fills, and no bowl of its own", () => {
    // H6.1-B — `feedsContainersOnly` is gone; the question is now which VESSELS a
    // step touches. The garlic fills the marinade and puts nothing else out.
    const sp = buildStepPlan(combinePrep(marinade()), "Test Plan");
    const garlic = phaseOf(sp, "produce").find((s) => names(s).includes("garlic cloves"))!;
    assert.deepEqual(containerNamesOf(garlic), [MARINADE.bowlName]);
  });
});

// ── 2 ───────────────────────────────────────────────────────────────────────

describe("rule 11(c) — the phase 3 step is the liquids, and it says what is already in it", () => {
  it("🔴 oil and lemon, and `containerHolds` names the four that went in before", () => {
    const sp = buildStepPlan(combinePrep(marinade()), "Test Plan");
    const sauces = phaseOf(sp, "sauces_marinades");
    assert.equal(sauces.length, 1, "the marinade should be finished in exactly one step");
    const step = sauces[0];
    assert.equal(step.bowlName, MARINADE.bowlName, "the container keeps ONE name across its steps");
    // 🔴 H5.3 REVERSED H4 HERE. H4 read "juiced and zested" as wet work and put
    // the lemon in this step beside the oil. Hans ruled on the October 2 device
    // pass that a whole lemon is worked at the board like an onion — its juice and
    // zest portioned per destination in phase 2 — and that this step then adds
    // only what it adds here. The FORM decides now, and a lemon is a fruit.
    assert.deepEqual(names(step), ["extra-virgin olive oil"]);
    assert.equal(memberKind("produce", "lemon", "juiced and zested"), "produce");
    // H7 2d reverses H5.3 here: "all of one food's knife work — juice and zest
    // included — is one produce step". A produce juice is board work now.
    assert.equal(memberKind("produce", "lemon juice", ""), "produce", "juice is squeezed at the board (H7 2d)");
    assert.ok(step.containerHolds, "the finishing step does not say what is in the bowl");
    assert.deepEqual(
      [...step.containerHolds!].sort(),
      // …and the lemon is in the bowl BEFORE the oil now, so it is held, not added.
      // H7 2d — and squeezed citrus says which produce step it came from.
      ["dried oregano", "fresh rosemary", "garlic cloves", "ground cumin", "smoked paprika"]
        .concat(step.containerHolds!.filter((h) => /^the lemon from produce step \d+$/.test(h)))
        .sort(),
    );
    assert.ok(step.containerHolds!.some((h) => /^the lemon from produce step \d+$/.test(h)), "the lemon is not held");
  });

  it("🔴 the dry measure is phase 1 and holds NO knife work", () => {
    const sp = buildStepPlan(combinePrep(marinade()), "Test Plan");
    const dry = phaseOf(sp, "seasonings_dry");
    assert.equal(dry.length, 1);
    assert.deepEqual(names(dry[0]), ["dried oregano", "ground cumin", "smoked paprika"]);
    assert.equal(dry[0].containerHolds, undefined, "nothing is in the bowl yet");
  });
});

// ── 3 ───────────────────────────────────────────────────────────────────────

describe("rule 11(c) — the counter counts containers, not steps", () => {
  it("🔴 the marinade is worked in TWO steps and counted ONCE", () => {
    const sp = buildStepPlan(combinePrep(marinade()), "Test Plan");
    const steps = sp.steps.filter((s) => !s.demoted && s.bowlName === MARINADE.bowlName);
    assert.equal(steps.length, 2, "expected a dry step and a wet step");
    assert.equal(new Set(steps.map((s) => s.containerId)).size, 1, "two steps, one identity");
    // The bowl, and nothing else: the garlic, the rosemary and the lemon all
    // live in it, and the wash step holds nothing.
    assert.equal(countContainers(sp.steps), 1);
  });

  it("🔴 the number ON SCREEN agrees, over the assembled result", () => {
    const sp = buildStepPlan(combinePrep(marinade()), "Test Plan");
    const result = summarizePrepWeek(assemblePrepWeekResult(sp, echo(sp)));
    assert.equal(result.containerCount, 1);
    // 🔴 AND THE WIRE SAYS SO HONESTLY. A bowl carries its identity and does NOT
    // claim to hold nothing; the knife work that fills it is the other way
    // round. Without this the counter still happened to be right — it checks the
    // identity first — and the payload was telling the client that every
    // container on the plan was empty.
    const wire = result.phases.flatMap((p) => p.steps);
    const bowl = wire.filter((s) => s.containerId);
    assert.equal(bowl.length, 2, "the bowl's two steps should both carry the identity");
    for (const s of bowl) {
      // H6.1-B — a container's own step NAMES it, which is how the header counts
      // it once across both of its steps.
      assert.deepEqual(s.containerNames, [MARINADE.bowlName]);
    }
    // …and the knife work that fills it names it too, so the union is still one.
    const feeders = wire.filter((s) => !s.containerId && (s.containerNames ?? []).length > 0);
    assert.ok(feeders.length > 0, "the produce steps stopped naming their destination");
    for (const s of feeders) assert.deepEqual(s.containerNames, [MARINADE.bowlName]);
    // …and the two steps still both show, and both cost minutes.
    const shown = result.phases.flatMap((p) => p.steps).filter((s) => !s.skipSuggested);
    assert.ok(shown.length > result.containerCount!, "the steps collapsed with the count");
  });
});

// ── 4 ───────────────────────────────────────────────────────────────────────

describe("rule 11(c) — a container with no liquid has no phase 3 step", () => {
  it("🔴 dry in phase 1, produce in its own steps, nothing in Sauces — and H7: two containers", () => {
    const sp = buildStepPlan(combinePrep(slowCooker()), "Test Plan");
    const dry = phaseOf(sp, "seasonings_dry");
    assert.equal(dry.length, 1);
    assert.deepEqual(names(dry[0]), ["dried thyme", "garlic powder", "smoked paprika"]);
    assert.equal(dry[0].bowlName, "Slow-Cooker Chicken spice blend");

    const produce = phaseOf(sp, "produce").filter((s) => s.stepKey !== WASH_STEP_KEY);
    assert.deepEqual(
      produce.flatMap(names).sort(),
      ["carrots", "celery stalks", "yellow onion"],
    );
    // 🔴 H7 — the vegetables go into the pot together, so they share ONE container,
    // and it is not the dry rub's: "don't combine seasonings … with veggies until
    // cook" (Hans, October 2). H4 put all six in one bowl.
    for (const s of produce) {
      for (const c of s.components) {
        for (const m of c.measures) assert.equal(m.destination, "Slow-Cooker Chicken vegetables");
      }
    }

    assert.equal(phaseOf(sp, "sauces_marinades").length, 0, "a dry container was finished in Sauces");
    assert.equal(countContainers(sp.steps), 2);
  });
});

// ── 5 ───────────────────────────────────────────────────────────────────────

describe("rule 11(c) — Produce holds no 'Build the …' step", () => {
  it("🔴 no produce step carries a bowlName on either fixture", () => {
    for (const input of [marinade(), slowCooker()]) {
      const sp = buildStepPlan(combinePrep(input), "Test Plan");
      const built = phaseOf(sp, "produce").filter((s) => s.bowlName);
      assert.deepEqual(
        built.map((s) => s.bowlName),
        [],
        "a container is being assembled in the middle of the knife work",
      );
    }
  });
});

// ── 6 ───────────────────────────────────────────────────────────────────────

describe("rule 11(c) — each phase holds only its own kind of work", () => {
  it("🔴 no knife work in phase 1 or 3, and no dry measure in phase 2", () => {
    const KNIFE = ["garlic cloves", "fresh rosemary", "yellow onion", "celery stalks", "carrots"];
    const DRY = ["ground cumin", "smoked paprika", "dried oregano", "dried thyme", "garlic powder"];
    for (const input of [marinade(), slowCooker()]) {
      const sp = buildStepPlan(combinePrep(input), "Test Plan");
      for (const s of sp.steps) {
        if (s.demoted) continue;
        const held = names(s);
        if (s.phase === "seasonings_dry" || s.phase === "sauces_marinades") {
          for (const n of held) assert.ok(!KNIFE.includes(n), `${n} needs a knife and is in ${s.phase}`);
        }
        if (s.phase === "produce") {
          for (const n of held) assert.ok(!DRY.includes(n), `${n} is a dry measure and is in produce`);
        }
      }
    }
  });
});

describe("rule 11(c) / H5.3 — the form decides, and only the form", () => {
  it("🔴 a grated cucumber squeezed dry is KNIFE work, not juicing", () => {
    // H4 found this by measuring the corpus and fixed it with an exception;
    // H5.3's simpler rule gets it for free, which is the better reason to hold.
    assert.equal(memberKind("produce", "english cucumber", "grated and squeezed dry"), "produce");
  });

  it("…and the FORM is the only signal — H5.3 retired the note arm", () => {
    // H4 had two signals and an exception between them (CUT_NOTE beat the
    // squeeze). H5.3 removed the note arm altogether, which removed the need for
    // the exception: a whole fruit is produce whatever is going to be done to it,
    // and a bottle of juice is wet whatever the note says.
    assert.equal(memberKind("produce", "lemon", "zested and juiced"), "produce");
    assert.equal(memberKind("produce", "lemon", "freshly squeezed"), "produce");
    assert.equal(memberKind("produce", "english cucumber", "grated and squeezed dry"), "produce");
    assert.equal(memberKind("produce", "lime juice", "freshly squeezed"), "produce"); // H7 2d
    // H7 2d — the PHASE decides now; an oil is a Pantry row and its phase is wet.
    assert.equal(memberKind("sauces_marinades", "extra-virgin olive oil", ""), "wet");
  });
});

// ── 7 ───────────────────────────────────────────────────────────────────────

/**
 * The sample plan's Garlic Herb Roasted Potatoes: four aromatics and ONE olive
 * oil. Its phase 3 share is a single measure, and the first corpus run after the
 * split dissolved it on exactly that — so the container never got its oil.
 */
function oneLiquid(): PrepCombineInput {
  const c = { key: "potatoes", noun: "prep container", bowlName: "Garlic Herb Potatoes sauce jar" };
  const m = (
    ingredientId: string,
    ingredientName: string,
    category: string,
    quantity: number,
    unit: string,
    preparationNote?: string,
  ) => ({
    ingredientId,
    ingredientName,
    category,
    quantity,
    unit,
    ...(preparationNote ? { preparationNote } : {}),
    component: c,
    momentKey: "c:potatoes",
  });
  return {
    meals: [
      {
        mealId: MEAL_A,
        mealName: "Garlic Herb Potatoes",
        dishes: [
          {
            dishId: "d1",
            dishName: "Garlic Herb Potatoes",
            dishRole: "side",
            ingredients: [
              m("potato", "baby Yukon gold potatoes", "Produce", 2, "lb", "halved"),
              m("garlic", "garlic cloves", "Produce", 4, "clove", "minced"),
              m("rosemary", "fresh rosemary", "Produce", 1, "tbsp", "chopped"),
              m("thyme", "fresh thyme", "Produce", 1, "tbsp", "chopped"),
              m("oil", "extra-virgin olive oil", "Pantry", 3, "tbsp"),
            ],
          },
        ],
      },
    ],
  };
}

describe("rule 11(c) — a container whose phase 3 share is ONE measure survives", () => {
  it("🔴 four aromatics and one oil: the oil is still poured", () => {
    const sp = buildStepPlan(combinePrep(oneLiquid()), "Test Plan");
    const sauces = phaseOf(sp, "sauces_marinades");
    assert.equal(sauces.length, 1, "the container dissolved on its own single liquid");
    assert.deepEqual(names(sauces[0]), ["extra-virgin olive oil"]);
    assert.equal(sauces[0].bowlName, "Garlic Herb Potatoes sauce jar");
    // Three aromatics went in before it, and the step says so. 🔴 H7 2f — NOT the
    // potatoes: a halved potato browns in the fridge, so it is cut on cook day and
    // was never put in. The sample plan's prose said "potatoes already in it" here.
    assert.deepEqual([...(sauces[0].containerHolds ?? [])].sort(), ["fresh rosemary", "fresh thyme", "garlic cloves"]);
    assert.equal(countContainers(sp.steps), 1);
  });
});

describe("rule 11(c) — a plan with a wet mixture has a non-empty Sauces phase", () => {
  it("🔴 the marinade plan's Sauces phase is where the bowl is finished", () => {
    const sp = buildStepPlan(combinePrep(marinade()), "Test Plan");
    const result = assemblePrepWeekResult(sp, echo(sp));
    const sauces = result.phases.find((p) => p.phase === "sauces_marinades")!;
    assert.ok(sauces.steps.length > 0, "the liquids vanished with the Build step");
  });
});

// ── 8 ───────────────────────────────────────────────────────────────────────

describe("rule 11(c) — the completion rollup over a two-step container", () => {
  it("🔴 BOTH of a container's steps are required, and the knife work with them", () => {
    const sp = buildStepPlan(combinePrep(marinade()), "Test Plan");
    const result = assemblePrepWeekResult(sp, echo(sp));
    // The rollup's required set is loadPrepStepSet's filter (steps that hold a
    // container) minus demotedStepKeysFromStructure (steps the blob excuses).
    const excused = demotedStepKeysFromStructure(result);
    const required = sp.steps
      .filter((s) => !s.holdsNoContainer && !excused.has(s.stepKey))
      .map((s) => s.stepKey);

    const bowlKeys = sp.steps
      .filter((s) => s.bowlName === MARINADE.bowlName && !s.demoted)
      .map((s) => s.stepKey);
    assert.equal(bowlKeys.length, 2, "expected a dry step and a wet step");
    for (const k of bowlKeys) {
      assert.ok(required.includes(k), `a container step is missing from the rollup: ${k}`);
    }
    // The knife work fills the bowl and puts no bowl out — but the cook still
    // has to do it, so it stays in the set. `feedsContainersOnly` is NOT
    // `holdsNoContainer`, and this is the line that keeps them apart.
    const garlic = sp.steps.find((s) => names(s).includes("garlic cloves"))!;
    assert.ok(required.includes(garlic.stepKey), "the garlic dropped out of 'prepped'");
    // …and the wash step, which holds nothing, is still excused.
    assert.ok(!required.includes(WASH_STEP_KEY), "the wash step gates 'prepped' again");
  });
});

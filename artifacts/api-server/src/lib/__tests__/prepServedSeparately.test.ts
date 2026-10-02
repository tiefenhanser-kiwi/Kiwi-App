// WS9 H5 — Hans's October 2 device pass, items 5.1, 6, 10.
//
// Three rulings, each with a measured defect behind it:
//
//   5.1  "Taco Toppings" was named a "Taco Toppings sauce jar" and five things
//        that go out in five separate dishes were stirred into one. Toppings and
//        garnishes are served separately; they are never combined.
//   6/10 A finished step ended "set aside" with "Airtight in the fridge — up to
//        3 days" printed underneath it. Two instructions, disagreeing.
//   10   "zest and juice 1 lemon, then slice the second into rounds for topping
//        — 2 lemons total". Cut citrus is cook-day work, and the step was asking
//        for 2 lemons when 1 is prep.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { combinePrep, type PrepCombineInput } from "../prepCombineEngine";
import { buildStepPlan, memberKind } from "../prepWeekAssembly";
import { isServedSeparately, resolveDishComponents } from "../prepComponents";
import { prepPortion } from "../prepCombineAdapter";
import { readFileSync } from "node:fs";

/** The authored prompt body, asserted directly: the rules in H5.2 are prose. */
const PROMPT_PATH = new URL("../../../prisma/seeds/aiPrompts.ts", import.meta.url);

const MEAL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// ── 5.1 ─────────────────────────────────────────────────────────────────────

describe("H5.1 — toppings are never a mix", () => {
  it("🔴 the class, and the mixture names that beat it", () => {
    for (const name of [
      "Taco Toppings",
      "Fajita Toppings",
      "Toppings",
      "Classic Chili Fixings",
      "Cotija Topping",
      "Corn Tortillas & Toppings",
      "Garnishes",
      "Sour cream, for serving",
    ]) {
      assert.equal(isServedSeparately(name), true, `"${name}" should not be a container`);
    }
    // 🔴 A REAL MIXTURE KEEPS ITS BOWL whoever eats it and however the recipe
    // introduces it. Without this arm the salsa and the guacamole lose their
    // vessels the moment a dish calls them toppings.
    for (const name of ["Pico de Gallo", "Guacamole Toppings", "Salsa Verde for serving"]) {
      assert.equal(isServedSeparately(name), false, `"${name}" names a real mixture`);
    }
    // And an ordinary dish is untouched.
    for (const name of ["Lemon-Herb Baked Chicken Breast", "Texas-Style Beef Chili"]) {
      assert.equal(isServedSeparately(name), false);
    }
  });

  it("🔴 the condiment's own NAME was the whole defect", () => {
    // Measured on Hans's plan: every componentKey was null and the dish role was
    // `side`, so the mixture noun came from signal 2 — the step's prose — and the
    // prose was "…and 1 tablespoon HOT SAUCE (optional) in small serving dishes".
    // `/\bsauce\b/i` matched the condiment and built a jar around it.
    const steps = [
      {
        stepIndex: 0,
        text: "Roughly chop ¼ cup fresh cilantro and set out ½ cup sour cream and 1 tablespoon hot sauce in small serving dishes.",
        phaseType: "assemble",
        componentKey: null,
        ingredientIds: ["cilantro", "cream", "hotsauce"],
      },
      {
        stepIndex: 1,
        text: "Arrange all toppings on the table so guests can build their own tacos.",
        phaseType: "assemble",
        componentKey: null,
        ingredientIds: [],
      },
    ];
    const ings = [
      { ingredientId: "cilantro", ingredientName: "fresh cilantro", preparationNote: "roughly chopped", phase: "produce" },
      { ingredientId: "cream", ingredientName: "Sour cream", preparationNote: null, phase: null },
      { ingredientId: "hotsauce", ingredientName: "hot sauce", preparationNote: null, phase: "sauces_marinades" },
    ];
    const asToppings = resolveDishComponents("Taco Toppings", "Taco Night", steps as never, ings as never);
    assert.deepEqual(asToppings.components, [], "the toppings were stirred into a jar again");

    // The same steps under a dish name that is NOT in the class still form the
    // jar — proof the fix is the name test and not an accident of this fixture.
    const asDish = resolveDishComponents("Smoky Chipotle Sauce", "Taco Night", steps as never, ings as never);
    assert.equal(asDish.components.length, 1, "the fixture must be capable of forming a jar");
  });

  it("🔴 …and the MOMENT route cannot rebuild it", () => {
    // The first fix did only the resolver, and the run grouping (D-WS9-301 rule 1)
    // put the same four members back together — rule 8 then named the bucket off
    // the dish and "Taco Toppings sauce jar" returned as "Taco Toppings prep
    // container". Same defect, different label.
    const input: PrepCombineInput = {
      meals: [
        {
          mealId: MEAL_A,
          mealName: "Taco Night",
          dishes: [
            {
              dishId: "d1",
              dishName: "Taco Toppings",
              dishRole: "side",
              ingredients: [
                { ingredientId: "lettuce", ingredientName: "iceberg lettuce", category: "Produce", quantity: 2, unit: "cup", preparationNote: "finely shredded", momentKey: "r:0" },
                { ingredientId: "tomato", ingredientName: "roma tomatoes", category: "Produce", quantity: 2, unit: "each", preparationNote: "diced", momentKey: "r:0" },
                { ingredientId: "cilantro", ingredientName: "fresh cilantro", category: "Produce", quantity: 0.25, unit: "cup", preparationNote: "roughly chopped", momentKey: "r:0" },
              ],
            },
          ],
        },
      ],
    };
    const sp = buildStepPlan(combinePrep(input), "Test Plan");
    const named = sp.steps.filter((s) => !s.demoted && s.bowlName);
    assert.deepEqual(named.map((s) => s.bowlName), [], "a container was rebuilt from the run");
    // Each member is handled on its own, which is the ruling.
    const live = sp.steps.filter((s) => !s.demoted && !s.holdsNoContainer);
    assert.ok(live.length >= 3, "the members lost their steps as well as their jar");
    // H6.1-B — every portion names a container, so the test is no longer "nothing
    // named" but "nothing SHARED": each topping goes into a tub of its own, labelled
    // for its dish, and never into one mixture with the others.
    const destinations = new Set(
      live.flatMap((s) => s.components.flatMap((c) => c.measures.map((m) => m.destination))),
    );
    assert.equal(
      destinations.size,
      live.length,
      `the toppings share a container: ${[...destinations].join(" | ")}`,
    );
    for (const d of destinations) {
      assert.ok(d, "a topping still says nothing about where it goes");
      assert.match(d!, /Taco Toppings —/, "a topping's tub should be labelled for its dish");
    }
  });
});

// ── 10 ──────────────────────────────────────────────────────────────────────

describe("H5.3 — the service portion of a row is not prep", () => {
  it("🔴 a split row keeps only its prep count, and loses the service clause", () => {
    // The three shapes the corpus actually contains, all citrus, all
    // "<n> prep, <m> cut for service".
    assert.deepEqual(
      prepPortion("lemon", 2, "each", "1 zested and juiced, 1 sliced into rounds for topping"),
      { quantity: 1, preparationNote: "1 zested and juiced" },
    );
    assert.deepEqual(
      prepPortion("lemon", 2, "each", "1 juiced, 1 cut into wedges for serving"),
      { quantity: 1, preparationNote: "1 juiced" },
    );
    assert.deepEqual(
      prepPortion("lemon", 2, "each", "1 zested and juiced, 1 cut into wedges for serving"),
      { quantity: 1, preparationNote: "1 zested and juiced" },
    );
  });

  it("🔴 a row that is ALL a cut for service contributes nothing to prep", () => {
    // The purpose and the cut may sit in different clauses — one instruction, split
    // by a comma. The first draft of this parser required both in one clause and
    // therefore did nothing here.
    assert.equal(prepPortion("lime", 2, "each", "cut into wedges, for serving"), null);
    assert.equal(prepPortion("lime", 2, "each", "sliced into rounds for the table"), null);
    // …and the cut may be named by the INGREDIENT rather than the note.
    assert.equal(prepPortion("lemon wedges", 4, "each", "for serving"), null);
  });

  it("🔴 a garnish that is NOT a cut keeps everything — rule 7 owns it", () => {
    // 🔴 THE HAZARD THE SECOND DRAFT EXISTS FOR. Stripping "for garnish" from the
    // note would blind rule 7's drop class, which recognises a single-dish garnish
    // portion by exactly those words. A chopped herb also stores fine for days, so
    // there is no food reason to move it either.
    assert.deepEqual(prepPortion("fresh flat-leaf parsley", 2, "tablespoon", "chopped, for garnish"), {
      quantity: 2,
      preparationNote: "chopped, for garnish",
    });
    assert.deepEqual(prepPortion("fresh cilantro", 0.25, "cup", "roughly chopped, for serving"), {
      quantity: 0.25,
      preparationNote: "roughly chopped, for serving",
    });
    assert.deepEqual(prepPortion("Sour cream", 0.5, "cup", "for serving"), {
      quantity: 0.5,
      preparationNote: "for serving",
    });
  });

  it("an ordinary note is untouched — the parser only ever reduces", () => {
    assert.deepEqual(prepPortion("garlic", 3, "clove", "minced"), {
      quantity: 3,
      preparationNote: "minced",
    });
    assert.deepEqual(prepPortion("lemon", 1, "each", null), { quantity: 1, preparationNote: null });
    assert.deepEqual(prepPortion("lemon", 2, "each", "zested and juiced"), {
      quantity: 2,
      preparationNote: "zested and juiced",
    });
    // "for the marinade" is a destination, not a service purpose (ruling 4).
    assert.deepEqual(prepPortion("lemon", 2, "each", "juiced, for the marinade"), {
      quantity: 2,
      preparationNote: "juiced, for the marinade",
    });
  });

  it("🔴 never more than the row had, and no quantity guess on a weight", () => {
    assert.deepEqual(prepPortion("lemon", 1, "each", "2 zested and juiced, 1 sliced for topping"), {
      quantity: 1,
      preparationNote: "2 zested and juiced",
    });
    // No counts to subtract on a weight: the clause goes, the quantity stands.
    assert.deepEqual(
      prepPortion("parmesan cheese", 2, "ounce", "finely grated, sliced for serving"),
      { quantity: 2, preparationNote: "finely grated" },
    );
  });

  it("🔴 a whole lemon is produce; a bottle of juice is not", () => {
    // H5.3 reversed H4 here — see prepContainers.test.ts for the reversal.
    assert.equal(memberKind("produce", "lemon", "zested and juiced"), "produce");
    assert.equal(memberKind("produce", "lime juice", ""), "wet");
  });
});

// ── 6 and 10 ────────────────────────────────────────────────────────────────

describe("H5.2 — a finished step ends in the fridge, not 'set aside'", () => {
  /** A marinade with a dry measure in phase 1 and its liquids in phase 3. */
  const twoPhase = (): PrepCombineInput => {
    const MARINADE = { key: "marinade", noun: "marinade", bowlName: "Chicken marinade bowl" };
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
          mealName: "Chicken Night",
          dishes: [
            {
              dishId: "d1",
              dishName: "Marinated Chicken",
              dishRole: "main",
              ingredients: [
                m("cumin", "ground cumin", "Pantry", 1, "tsp"),
                m("paprika", "smoked paprika", "Pantry", 2, "tsp"),
                m("oregano", "dried oregano", "Pantry", 1, "tsp"),
                m("garlic", "garlic cloves", "Produce", 3, "clove", "minced"),
                m("oil", "extra-virgin olive oil", "Pantry", 3, "tbsp"),
              ],
            },
          ],
        },
      ],
    };
  };

  it("🔴 the phase 1 step is told its bowl comes back; the phase 3 step is not", () => {
    const sp = buildStepPlan(combinePrep(twoPhase()), "Test Plan");
    const dry = sp.steps.find((x) => x.phase === "seasonings_dry" && x.containerId)!;
    const wet = sp.steps.find((x) => x.phase === "sauces_marinades" && x.containerId)!;
    assert.ok(dry, "no phase 1 container step");
    assert.ok(wet, "no phase 3 container step");
    assert.equal(dry.containerId, wet.containerId, "two steps, one container");

    const sent = new Map(
      sp.narrationInput.steps.map((x) => [x.stepId, (x as { setAsideFor?: string }).setAsideFor]),
    );
    // H6.1-C — the handoff is computed over container NAMES, so the NEXT step to
    // touch this bowl is the one that counts. Its garlic is prepped in the produce
    // phase and portioned into it, so the dry measure hands off to PRODUCE; the
    // sauces step is later still.
    assert.equal(
      sent.get(dry.stepId),
      "produce",
      "the dry measure was not told its bowl is worked again — it will say 'set aside' or send it to the fridge",
    );
    assert.equal(
      sent.get(wet.stepId),
      undefined,
      "the FINISHING step was told to set the bowl aside — it is done, and the app's storage line closes it",
    );
  });

  it("🔴 a per-ingredient step is never set aside — its work is finished", () => {
    const sp = buildStepPlan(combinePrep(twoPhase()), "Test Plan");
    const garlic = sp.steps.find((x) =>
      x.components.some((c) => c.ingredientName === "garlic cloves"),
    )!;
    const sent = new Map(
      sp.narrationInput.steps.map((x) => [x.stepId, (x as { setAsideFor?: string }).setAsideFor]),
    );
    // 🔴 H6.1-C MOVED THIS ONE, and the new answer is the better one: the garlic is
    // portioned INTO the marinade bowl, which is opened again in the sauces phase, so
    // the garlic step is part of the handoff and says so. The storage line belongs to
    // whichever step closes the bowl, and that is not this one.
    assert.equal(sent.get(garlic.stepId), "sauces and marinades");
    assert.equal(garlic.suppressStorage, true, "a step feeding a later bowl kept a storage line");

    // The step that DOES close the marinade carries it.
    const last = sp.steps.find((x) => x.phase === "sauces_marinades" && x.containerId)!;
    assert.equal(last.suppressStorage, undefined, "the closing step lost its storage line");
  });

  it("the model is no longer asked for a storageNote at all", () => {
    // It was already DISCARDED by applyStorageOverlay — the note depends on the
    // cook day and the prose is cached — so asking for it bought a contradiction
    // and nothing else. Same contract as the minutes (BUG-204).
    const prompt = readFileSync(PROMPT_PATH, "utf8");
    assert.match(prompt, /DO NOT return a 'storageNote'/);
    assert.match(prompt, /NEVER write "set aside"/);
    assert.ok(
      !/- 'storageNote' \(optional\)/.test(prompt),
      "the old storageNote request is still in the prompt body",
    );
  });
});

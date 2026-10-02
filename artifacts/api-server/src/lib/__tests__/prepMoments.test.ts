// WS9 BUG-346 / D-WS9-301 — the grouping re-cut.
//
// Hans tested Prep the Week on his phone: 28 steps, ~30 containers, ~2 hours,
// all correct by the old rules. The rules grouped by COMPONENT (one bowl per
// sub-recipe) and portioned PER DISH. These tests pin the re-cut.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveMoments, proseNames, isLoneKey } from "../prepMoments";
import type { ComponentStep, ComponentIngredient } from "../prepComponents";
import {
  buildStepPlan,
  countContainers,
  lowValueClass,
  summarizePrepWeek,
} from "../prepWeekAssembly";
import { combinePrep, isGroundMeat, type PrepCombineInput } from "../prepCombineEngine";
import { buildPrepCombineInput } from "../prepCombineAdapter";
import { STORAGE_TABLE, storageClassFor } from "../prepStorage";
import type { PrepWeekResult } from "../ai/schemas/prepWeek";

// ── fixtures ────────────────────────────────────────────────────────────────

const step = (
  stepIndex: number,
  phaseType: string,
  text: string,
  o: { componentKey?: string; ids?: string[] } = {},
): ComponentStep => ({
  stepIndex,
  text,
  phaseType,
  componentKey: o.componentKey ?? null,
  ingredientIds: o.ids ?? [],
});

const ing = (id: string, name: string, phase: string | null): ComponentIngredient => ({
  ingredientId: id,
  ingredientName: name,
  preparationNote: null,
  phase,
});

// ── rule 1: the moment ──────────────────────────────────────────────────────

describe("D-WS9-301 rule 1 — a moment is closed by heat", () => {
  it("🔴 THE TACO CASE — the onion is sautéed first, the spices go in after browning", () => {
    // Hans's own example. The onion enters at the sauté; the spices enter two
    // steps later. Both amounts are STATED on prep steps, so `amountRefs` alone
    // calls them the same moment — the cook steps' prose is what separates them.
    const steps = [
      step(0, "prep", "Dice 1 yellow onion and mince 3 cloves garlic.", { ids: ["onion", "garlic"] }),
      step(1, "prep", "Combine the chili powder, cumin and oregano in a small bowl.", {
        componentKey: "seasoning",
        ids: ["chili", "cumin", "oregano"],
      }),
      step(2, "cook", "Heat the oil in a large skillet over medium-high heat."),
      step(3, "cook", "Add the diced onion and cook until softened, about 4 minutes."),
      step(4, "cook", "Brown the beef, then stir in the spice mixture and cook 1 minute more."),
    ];
    const r = resolveMoments(steps, [
      ing("onion", "yellow onion", "produce"),
      ing("garlic", "garlic", "produce"),
      ing("chili", "chili powder", "seasonings_dry"),
      ing("cumin", "ground cumin", "seasonings_dry"),
      ing("oregano", "dried oregano", "seasonings_dry"),
    ]);
    const k = (id: string) => r.keyByIngredientId.get(id);
    // At THIS layer the onion and the spices share a run, and that is correct:
    // both amounts are stated before any heat. What separates them is the
    // COMPONENT TAG, and the component is resolved one layer up — so the
    // pipeline test below is the one that pins Hans's example. The override is
    // recorded for the onion (its prose moment is step 3) and deliberately not
    // applied, because it already has a run.
    assert.equal(k("onion"), "r:0");
    assert.equal(k("chili"), "r:0");
    assert.equal(r.overrides.find((o) => o.ingredientName === "yellow onion")?.stepIndex, 3);
    assert.equal(r.overrides.find((o) => o.ingredientName === "yellow onion")?.wasRunMoment, 0);
  });

  it("🔴 THE TACO CASE, THROUGH THE PIPELINE — two containers, not one", () => {
    const loaded = {
      planId: "p1",
      planName: "Taco Week",
      meals: [
        {
          mealId: "m1",
          mealName: "Taco Night",
          cuisine: null,
          servingsOverride: null,
          dishes: [
            {
              dishId: "d1",
              dishName: "Tex-Mex Seasoned Beef",
              dishRole: "main",
              baseServings: 4,
              authoredBaseServings: 4,
              stepTexts: [],
              componentSteps: [
                step(0, "prep", "Dice 1 yellow onion.", { ids: ["onion"] }),
                step(1, "prep", "Combine the chili powder, cumin and oregano.", {
                  componentKey: "seasoning",
                  ids: ["chili", "cumin", "oregano"],
                }),
                step(2, "cook", "Heat the oil in a skillet."),
                step(3, "cook", "Add the diced onion and cook until softened."),
                step(4, "cook", "Brown the beef, then stir in the spice mixture."),
              ],
              ingredients: [
                { ingredientId: "onion", ingredientName: "yellow onion", category: "Produce", quantity: 1, unit: "each", preparationNote: "diced", sourceYield: null },
                { ingredientId: "chili", ingredientName: "chili powder", category: "Pantry", quantity: 1, unit: "tbsp", preparationNote: null, sourceYield: null },
                { ingredientId: "cumin", ingredientName: "ground cumin", category: "Pantry", quantity: 2, unit: "tsp", preparationNote: null, sourceYield: null },
                { ingredientId: "oregano", ingredientName: "dried oregano", category: "Pantry", quantity: 1, unit: "tsp", preparationNote: null, sourceYield: null },
              ],
            },
          ],
        },
      ],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sp = buildStepPlan(combinePrep(buildPrepCombineInput(loaded as any)), "Taco Week");
    const stepOf = (name: string) =>
      sp.steps.find((s) => s.components.some((c) => c.ingredientName === name))!;
    const onionStep = stepOf("yellow onion");
    const spiceStep = stepOf("chili powder");
    assert.notEqual(onionStep.stepId, spiceStep.stepId, "the onion is in the taco seasoning container");
    // 🔴 AND ITS PORTION GOES NOWHERE NAMED. H4 / rule 11(c) gives every produce
    // member its own step whether a container absorbed it or not, so two stepIds
    // no longer prove anything. What absorption changes is the DESTINATION: a
    // swallowed onion is portioned into the dry blend, and a dry blend has to
    // stay shelf stable.
    for (const c of onionStep.components) {
      for (const v of c.measures) {
        assert.equal(v.destination, undefined, "the diced onion is portioned into a dry container");
      }
    }
    // The spices are ONE container, and it is named.
    assert.equal(spiceStep.components.length, 3);
    assert.ok(spiceStep.bowlName, "the spice blend has no name");
    // The onion is a plain portion — no vessel, because it is not a mixture.
    assert.equal(onionStep.bowlName, undefined);
  });

  it("🔴 THE SLOW-COOKER CASE — herbs, onion and chicken go in together", () => {
    // Hans: "Slow-cooker herbs + onion + chicken go in together → one container
    // is right." Nothing is heated between them; it is one dump into the crock.
    const steps = [
      step(0, "prep", "Slice the celery and carrots, and mince the garlic.", {
        ids: ["celery", "carrot", "garlic"],
      }),
      step(1, "cook", "Add the chicken thighs to the slow cooker.", { ids: ["chicken"] }),
      step(2, "cook", "Pour in the broth and add the dried thyme and rosemary.", {
        ids: ["broth", "thyme", "rosemary"],
      }),
    ];
    const r = resolveMoments(steps, [
      ing("celery", "celery stalks", "produce"),
      ing("carrot", "carrots", "produce"),
      ing("garlic", "garlic cloves", "produce"),
      ing("broth", "low-sodium chicken broth", "sauces_marinades"),
      ing("thyme", "dried thyme", "seasonings_dry"),
      ing("rosemary", "dried rosemary", "seasonings_dry"),
    ]);
    const keys = new Set(
      ["celery", "carrot", "garlic", "broth", "thyme", "rosemary"].map((id) =>
        r.keyByIngredientId.get(id),
      ),
    );
    assert.equal(keys.size, 1, `expected one moment, got ${[...keys].join(" / ")}`);
  });

  it("🔴 A COOK STEP BETWEEN TWO PREP RUNS SPLITS THEM — heat is the boundary", () => {
    // The break harness caught the absence of this one: the slow-cooker and taco
    // cases both pass even with the heat close removed (one has a single run
    // anyway, the other is separated by its component tag), so nothing pinned
    // the rule that gives the module its name. This is the shape that needs it:
    // something prepped before the pan, and something prepped after it.
    const steps = [
      step(0, "prep", "Halve the potatoes and toss with the oil.", { ids: ["potato", "oil"] }),
      step(1, "cook", "Roast for 30 minutes until browned."),
      step(2, "prep", "Chop the parsley to finish.", { ids: ["parsley"] }),
    ];
    const r = resolveMoments(steps, [
      ing("potato", "baby Yukon gold potatoes", "produce"),
      ing("oil", "extra-virgin olive oil", "sauces_marinades"),
      ing("parsley", "fresh flat-leaf parsley", "produce"),
    ]);
    const k = (id: string) => r.keyByIngredientId.get(id);
    assert.equal(k("potato"), k("oil"), "the two things prepped together split");
    assert.notEqual(
      k("parsley"),
      k("potato"),
      "the garnish chopped AFTER roasting shares a container with what went into the oven",
    );
    assert.equal(k("potato"), "r:0");
    assert.equal(k("parsley"), "r:1");
  });

  it("🔴 THE MARINADE IS ONE CONTAINER, LEMON INCLUDED — rule 1's inverse case", () => {
    // "The lemon-herb marinade… all its parts enter together (into the
    // marinade), so it is ONE container finished in ONE step — zest and juice
    // the lemon inside that step, never deferred to the produce phase."
    //
    // The marinade's steps carry the component tag; the LEMON's amount is on a
    // step that carries none. The shipped plan therefore split them and said so:
    // "Note: the lemon zest and juice for this marinade are handled in the lemon
    // prep step — add them to this bowl once prepped."
    const steps = [
      step(0, "prep", "Pound the chicken breasts to an even thickness.", { ids: ["chicken"] }),
      step(1, "prep", "Zest and juice one lemon; slice the second into rounds.", { ids: ["lemon"] }),
      step(2, "prep", "Mince the garlic and chop the rosemary and thyme.", {
        componentKey: "marinade",
        ids: ["garlic", "rosemary", "thyme"],
      }),
      step(3, "prep", "Whisk the oil and mustard into the herbs to make the marinade.", {
        componentKey: "marinade",
        ids: ["oil", "mustard"],
      }),
      step(4, "cook", "Bake for 25 minutes."),
    ];
    const r = resolveMoments(steps, [
      ing("chicken", "boneless skinless chicken breasts", "proteins"),
      ing("lemon", "lemon", "produce"),
      ing("garlic", "garlic", "produce"),
      ing("rosemary", "fresh rosemary", "produce"),
      ing("thyme", "fresh thyme", "produce"),
      ing("oil", "extra-virgin olive oil", "sauces_marinades"),
      ing("mustard", "dijon mustard", "sauces_marinades"),
    ]);
    // Every marinade part — and the lemon — sits in the same RUN, which is what
    // the adapter needs in order to let the resolved component absorb it.
    const run = (id: string) => r.runByIngredientId.get(id);
    for (const id of ["lemon", "garlic", "rosemary", "thyme", "oil", "mustard"]) {
      assert.equal(run(id), run("garlic"), `${id} is not in the marinade's run`);
    }
  });

  it("🔴 THE MARINADE, THROUGH THE PIPELINE — the lemon is IN the bowl", () => {
    const loaded = {
      planId: "p1",
      planName: "Lemon Week",
      meals: [
        {
          mealId: "m1",
          mealName: "Lemon-Herb Chicken",
          cuisine: null,
          servingsOverride: null,
          dishes: [
            {
              dishId: "d1",
              dishName: "Lemon-Herb Baked Chicken Breast",
              dishRole: "main",
              baseServings: 4,
              authoredBaseServings: 4,
              stepTexts: [],
              componentSteps: [
                step(0, "prep", "Pound the chicken breasts to an even thickness.", { ids: ["chicken"] }),
                step(1, "prep", "Zest and juice one lemon.", { ids: ["lemon"] }),
                step(2, "prep", "Mince the garlic and chop the rosemary.", {
                  componentKey: "marinade",
                  ids: ["garlic", "rosemary"],
                }),
                step(3, "prep", "Whisk the oil and mustard in to make the marinade.", {
                  componentKey: "marinade",
                  ids: ["oil", "mustard"],
                }),
                step(4, "cook", "Bake for 25 minutes."),
              ],
              ingredients: [
                { ingredientId: "chicken", ingredientName: "boneless skinless chicken breasts", category: "Protein", quantity: 2, unit: "lb", preparationNote: "pounded", sourceYield: null },
                { ingredientId: "lemon", ingredientName: "lemon", category: "Produce", quantity: 2, unit: "each", preparationNote: "zested and juiced", sourceYield: null },
                { ingredientId: "garlic", ingredientName: "garlic", category: "Produce", quantity: 4, unit: "clove", preparationNote: "minced", sourceYield: null },
                { ingredientId: "rosemary", ingredientName: "fresh rosemary", category: "Produce", quantity: 2, unit: "tsp", preparationNote: "chopped", sourceYield: null },
                { ingredientId: "oil", ingredientName: "extra-virgin olive oil", category: "Pantry", quantity: 3, unit: "tbsp", preparationNote: null, sourceYield: null },
                { ingredientId: "mustard", ingredientName: "dijon mustard", category: "Pantry", quantity: 1, unit: "tbsp", preparationNote: null, sourceYield: null },
              ],
            },
          ],
        },
      ],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sp = buildStepPlan(combinePrep(buildPrepCombineInput(loaded as any)), "Lemon Week");
    // 🔴 BY NAME, NOT BY "the first bowl". H4 / rule 11(c) gave a plan more than
    // one bowl step, and when the lemon is NOT absorbed it gets a container of
    // its own that sorts ahead of the marinade — so `find((s) => s.bowlName)`
    // returned the lemon's own bowl and this test passed on the defect.
    const bowl = sp.steps.find((s) => /marinade/i.test(s.bowlName ?? ""));
    assert.ok(bowl, "the marinade produced no named container");
    // And it is the ONLY container on this dish: a second one means the lemon
    // was given its own, which is what ruling 1 forbids.
    assert.deepEqual(
      sp.steps.filter((s) => s.bowlName).map((s) => s.bowlName),
      [bowl!.bowlName],
      "the lemon was given a container of its own",
    );
    // 🔴 H5.3 — "IN the bowl" is now a DESTINATION, not a seat. Ruling 1's claim
    // is that the lemon belongs to this marinade and is not deferred to a second
    // container; H5.3 adds that its juicing happens at the board, in its own
    // produce step, with the bowl named. Both still hold — and the thing ruling 1
    // actually forbids, a second container for the lemon, is asserted below.
    const lemonSteps = sp.steps.filter((s) => s.components.some((c) => c.ingredientName === "lemon"));
    assert.equal(lemonSteps.length, 1, "the lemon is prepped twice");
    const destinations = lemonSteps[0].components
      .flatMap((c) => c.measures.map((v) => v.destination))
      .filter((d): d is string => typeof d === "string");
    assert.deepEqual(
      [...new Set(destinations)],
      [bowl!.bowlName],
      "the lemon no longer goes into the marinade",
    );
    assert.deepEqual(
      sp.steps.filter((s) => s.bowlName).map((s) => s.bowlName),
      [bowl!.bowlName],
      "the lemon was given a container of its own",
    );
    // The CHICKEN is not a member — raw flesh has a destination, not a seat.
    assert.ok(
      !bowl!.components.some((c) => c.ingredientName === "boneless skinless chicken breasts"),
      "the raw chicken is sitting in the marinade bowl at prep time",
    );
  });

  it("🔴 A DISH WITH NO amountRefs INVENTS NOTHING", () => {
    // 23 of the 148 corpus dishes carry no refs at all. Reporting that is the
    // point: a 0%-covered dish must not behave like a 100%-covered one just
    // because the code cannot tell.
    const steps = [step(0, "prep", "Chop everything."), step(1, "cook", "Cook it.")];
    const r = resolveMoments(steps, [ing("a", "dragon fruit", "produce"), ing("b", "star anise", "seasonings_dry")]);
    assert.equal(r.hasCoverage, false);
    assert.ok(isLoneKey(r.keyByIngredientId.get("a")!), "a lone ingredient must not be bucketed");
    assert.notEqual(r.keyByIngredientId.get("a"), r.keyByIngredientId.get("b"));
  });

  it("the prose override does not reach inside an authored mixture", () => {
    const steps = [
      step(0, "prep", "Whisk the soy sauce and honey into a glaze.", {
        componentKey: "glaze",
        ids: ["soy", "honey"],
      }),
      step(1, "cook", "Brush the honey glaze over the salmon and bake."),
    ];
    const r = resolveMoments(steps, [
      ing("soy", "soy sauce", "sauces_marinades"),
      ing("honey", "honey", "sauces_marinades"),
    ]);
    assert.equal(r.overrides.length, 0, "the override split a mixture the author grouped");
  });

  it("🔴 a head word is not a suffix-free match — onion vs onion powder", () => {
    // The same trap that sent a jar of dry spices to the 4-day fridge class.
    assert.equal(proseNames("Add 1 tsp onion powder and stir.", "yellow onion"), false);
    assert.equal(proseNames("Add the diced onion and stir.", "yellow onion"), true);
    assert.equal(proseNames("Stir in the garlic powder.", "garlic"), false);
    // …while an ingredient that genuinely IS the powder still matches.
    assert.equal(proseNames("Stir in the garlic powder.", "garlic powder"), true);
  });
});

// ── H2.2 second half — the name is re-checked where membership is final ─────

describe("D-WS9-301 H2.2 — an ABSORBED fresh ingredient still strips a dry name", () => {
  it("🔴 a container the adapter put garlic into cannot stay a 'spice blend'", () => {
    // `resolveDishComponents` drops a dry noun when ITS OWN members include
    // something fresh. It never sees the ingredients rule 1's run absorption adds
    // later, so one container in the 14-plan corpus — "Texas-Style Beef Chili
    // spice blend" — kept its name with five minced garlic cloves in it. Found by
    // asserting the property over the corpus, not by re-reading the code.
    //
    // The shape, directly: a dry-nouned component, plus a produce ingredient
    // carrying the same moment key, which is exactly what the adapter emits.
    const BOWL = "Texas-Style Beef Chili spice blend";
    const component = { key: "seasoning", noun: "spice blend", bowlName: BOWL };
    const input: PrepCombineInput = {
      meals: [
        {
          mealId: "m1",
          mealName: "Chili Night",
          dishes: [
            {
              dishId: "d1",
              dishName: "Texas-Style Beef Chili",
              dishRole: "main",
              ingredients: [
                { ingredientId: "cumin", ingredientName: "ground cumin", category: "Pantry", quantity: 2, unit: "tsp", preparationNote: null, component, momentKey: "c:seasoning" },
                { ingredientId: "oregano", ingredientName: "dried oregano", category: "Pantry", quantity: 1, unit: "tsp", preparationNote: null, component, momentKey: "c:seasoning" },
                // A third dry item, because `detectBlendComponents` keeps a dry
                // blend only at 3+ per dish — below that they are noise and get
                // dropped, and the container would never form at all.
                { ingredientId: "paprika", ingredientName: "smoked paprika", category: "Pantry", quantity: 1, unit: "tsp", preparationNote: null, component, momentKey: "c:seasoning" },
                // Absorbed by the run, with no component of its own — the case
                // prepComponents structurally cannot see.
                { ingredientId: "garlic", ingredientName: "garlic cloves", category: "Produce", quantity: 5, unit: "clove", preparationNote: "minced", momentKey: "c:seasoning" },
              ],
            },
          ],
        },
      ],
    };
    const sp = buildStepPlan(combinePrep(input), "Test Plan");
    const bowl = sp.steps.find((s) => s.bowlName)!;
    assert.ok(bowl, "no container was formed");
    // H4 / rule 11(c) — the garlic still BELONGS to this container, but its
    // mincing is no longer done inside it: that work is its own produce step,
    // naming this container as the destination. So membership is proved from the
    // destination, not from the bowl step's component list.
    const garlic = sp.steps.find((s) => s.components.some((c) => c.ingredientName === "garlic cloves"));
    assert.ok(garlic, "the garlic left the plan entirely — that is not the fix");
    assert.ok(
      garlic!.components.some((c) => c.measures.some((v) => v.destination === bowl.bowlName)),
      "the garlic no longer goes into the container — that is not the fix",
    );
    assert.ok(
      !/\b(seasoning|spice blend|rub)\b/i.test(bowl.bowlName!),
      `"${bowl.bowlName}" still promises a shelf-stable dry blend`,
    );
  });

  it("…and an all-dry container keeps its name through the same pass", () => {
    const BOWL = "Beef Enchiladas Verdes spice blend";
    const component = { key: "seasoning", noun: "spice blend", bowlName: BOWL };
    const input: PrepCombineInput = {
      meals: [
        {
          mealId: "m1",
          mealName: "Enchilada Night",
          dishes: [
            {
              dishId: "d1",
              dishName: "Beef Enchiladas Verdes",
              dishRole: "main",
              ingredients: [
                { ingredientId: "cumin", ingredientName: "ground cumin", category: "Pantry", quantity: 2, unit: "tsp", preparationNote: null, component, momentKey: "c:seasoning" },
                { ingredientId: "chili", ingredientName: "chili powder", category: "Pantry", quantity: 1, unit: "tsp", preparationNote: null, component, momentKey: "c:seasoning" },
                { ingredientId: "oregano", ingredientName: "dried oregano", category: "Pantry", quantity: 1, unit: "tsp", preparationNote: null, component, momentKey: "c:seasoning" },
              ],
            },
          ],
        },
      ],
    };
    const sp = buildStepPlan(combinePrep(input), "Test Plan");
    assert.equal(sp.steps.find((s) => s.bowlName)!.bowlName, BOWL);
  });
});

// ── rule 4: ground meat ─────────────────────────────────────────────────────

describe("D-WS9-301 rule 4 — ground meat is never touched", () => {
  it("🔴 ground beef produces NO prep step; a whole cut still does", () => {
    const input: PrepCombineInput = {
      meals: [
        {
          mealId: "m1",
          mealName: "Taco Night",
          dishes: [
            {
              dishId: "d1",
              dishName: "Tacos",
              dishRole: "main",
              ingredients: [
                { ingredientId: "gb", ingredientName: "ground beef (80/20)", category: "Protein", quantity: 1.5, unit: "lb", preparationNote: null },
                { ingredientId: "roast", ingredientName: "beef chuck roast", category: "Protein", quantity: 2, unit: "lb", preparationNote: "cut into cubes" },
              ],
            },
          ],
        },
      ],
    };
    const sp = buildStepPlan(combinePrep(input), "Test Plan");
    const names = sp.steps.flatMap((s) => s.components.map((c) => c.ingredientName));
    assert.ok(!names.includes("ground beef (80/20)"), "ground beef reached a prep step");
    assert.ok(names.includes("beef chuck roast"), "knife work on a whole cut was dropped");
  });

  it("names the forms, and only the forms", () => {
    for (const n of ["ground beef", "ground turkey (93% lean)", "ground pork", "lean ground beef"]) {
      assert.equal(isGroundMeat(n), true, n);
    }
    for (const n of ["beef chuck roast", "chicken thighs", "skirt steak", "ground cumin", "ground coriander"]) {
      assert.equal(isGroundMeat(n), false, n);
    }
  });
});

// ── rule 5: one container across dishes ─────────────────────────────────────

describe("D-WS9-301 rule 5 — a shared ingredient is ONE container", () => {
  const threeDishGarlic = (): PrepCombineInput => ({
    meals: [
      {
        mealId: "m1",
        mealName: "Mexican Week",
        dishes: ["Chili", "Enchiladas", "Rice"].map((dishName, i) => ({
          dishId: `d${i}`,
          dishName,
          dishRole: "main" as const,
          ingredients: [
            { ingredientId: "garlic", ingredientName: "garlic cloves", category: "Produce", quantity: 2, unit: "clove", preparationNote: "minced" },
          ],
        })),
      },
    ],
  });

  it("🔴 ONE step, THREE named dishes — never one container per dish", () => {
    const sp = buildStepPlan(combinePrep(threeDishGarlic()), "Test Plan");
    const garlic = sp.steps.filter((s) => s.components.some((c) => c.ingredientName === "garlic cloves"));
    assert.equal(garlic.length, 1, `garlic split into ${garlic.length} steps`);
    const dishes = new Set(garlic[0].components.flatMap((c) => c.measures.map((m) => m.forDish)));
    assert.deepEqual([...dishes].sort(), ["Chili", "Enchiladas", "Rice"]);
    // One container, whatever the dish count.
    assert.equal(countContainers(sp.steps), 1);
  });

  it("🔴 a single-dish moment must not claim a shared ingredient", () => {
    // Rule 1 groups within a dish. Let loose on an ingredient three dishes use,
    // it produces three single-dish containers — exactly what rule 5 forbids —
    // and the measured count went UP rather than down.
    const input = threeDishGarlic();
    for (const d of input.meals[0].dishes) {
      d.ingredients.push({
        ingredientId: "onion",
        ingredientName: "white onion",
        category: "Produce",
        quantity: 1,
        unit: "each",
        preparationNote: "diced",
      });
      // Both of this dish's ingredients share one unnamed moment.
      for (const i of d.ingredients) i.momentKey = "r:0";
    }
    const sp = buildStepPlan(combinePrep(input), "Test Plan");
    assert.equal(countContainers(sp.steps), 2, "expected one garlic container and one onion container");
    for (const s of sp.steps) {
      assert.equal(s.bowlName, undefined, "a shared ingredient was given a single-dish vessel");
    }
  });
});

// ── rule 7: the count, and where the drop pass stops ────────────────────────

describe("D-WS9-301 rule 7 — the container count and the bounded drop", () => {
  it("citrus wedges and single-dish garnish portions are the only droppable classes", () => {
    const plan = buildStepPlan(
      combinePrep({
        meals: [
          {
            mealId: "m1",
            mealName: "Taco Night",
            dishes: [
              {
                dishId: "d1",
                dishName: "Tacos",
                dishRole: "main",
                ingredients: [
                  { ingredientId: "lime", ingredientName: "lime", category: "Produce", quantity: 2, unit: "each", preparationNote: "cut into wedges" },
                  { ingredientId: "cil", ingredientName: "fresh cilantro", category: "Produce", quantity: 0.25, unit: "cup", preparationNote: "chopped, for garnish" },
                  { ingredientId: "onion", ingredientName: "white onion", category: "Produce", quantity: 1, unit: "each", preparationNote: "diced" },
                ],
              },
            ],
          },
        ],
      }),
      "Test Plan",
    );
    const by = (name: string) =>
      plan.steps.find((s) => s.components.some((c) => c.ingredientName === name))!;
    assert.equal(lowValueClass(by("lime")), "citrus-wedge");
    assert.equal(lowValueClass(by("fresh cilantro")), "garnish");
    assert.equal(lowValueClass(by("white onion")), null, "plain knife work is not droppable");
  });

  it("🔴 THE DROP PASS STOPS AFTER TWO CLASSES, even if the plan is still over", () => {
    // Hans: "A plan at 23 containers of real dry blends, marinades and knife
    // work is 23; the count is reported, not forced." A pass that kept going
    // would start deleting the knife work the screen exists for.
    const dishes = Array.from({ length: 25 }, (_, i) => ({
      dishId: `d${i}`,
      dishName: `Dish ${i}`,
      dishRole: "main" as const,
      ingredients: [
        {
          ingredientId: `veg${i}`,
          ingredientName: `vegetable ${i}`,
          category: "Produce",
          quantity: 1,
          unit: "each",
          preparationNote: "diced",
        },
      ],
    }));
    const sp = buildStepPlan(
      combinePrep({ meals: [{ mealId: "m1", mealName: "Big Week", dishes }] }),
      "Test Plan",
    );
    assert.equal(countContainers(sp.steps), 25, "knife work was dropped to reach the target");
    assert.equal(sp.steps.filter((s) => s.demoted).length, 0);
  });

  it("the drop pass does not fire at all when the plan is inside the target", () => {
    const sp = buildStepPlan(
      combinePrep({
        meals: [
          {
            mealId: "m1",
            mealName: "Small Week",
            dishes: [
              {
                dishId: "d1",
                dishName: "Tacos",
                dishRole: "main",
                ingredients: [
                  { ingredientId: "lime", ingredientName: "lime", category: "Produce", quantity: 2, unit: "each", preparationNote: "cut into wedges" },
                ],
              },
            ],
          },
        ],
      }),
      "Test Plan",
    );
    assert.equal(sp.steps.filter((s) => s.demoted).length, 0, "a 1-container plan dropped something");
  });
});

// ── ruling 4: the header's two numbers ──────────────────────────────────────

function wireResult(steps: { minutes: number; skip?: boolean; noContainer?: boolean }[]): PrepWeekResult {
  return {
    totalEstimatedMinutes: 10,
    phases: (["seasonings_dry", "sauces_marinades", "produce", "proteins"] as const).map((p, pi) => ({
      phase: p,
      title: p,
      skippable: pi < 2,
      steps:
        pi === 2
          ? steps.map((s, i) => ({
              number: i + 1,
              stepKey: `k${i}`,
              title: "t",
              instructions: "i",
              estimatedMinutes: s.minutes,
              contributesToMealIds: ["00000000-0000-4000-8000-000000000001"],
              ...(s.skip ? { skipSuggested: true } : {}),
              ...(s.noContainer ? { holdsNoContainer: true } : {}),
            }))
          : [],
    })),
  } as PrepWeekResult;
}

describe("D-WS9-301 ruling 4 — the header reads N containers, about M min", () => {
  it("🔴 MINUTES ROUND UP TO THE NEXT 5 — a stated number must not be beaten by reality", () => {
    // Hans's condition: "I just want to be sure 40 minutes is no more than 50
    // minutes or so in reality, otherwise, people won't trust it."
    const out = summarizePrepWeek(wireResult([{ minutes: 4 }, { minutes: 4 }, { minutes: 4 }]));
    assert.equal(out.estimatedMinutes, 15, "12 min must state 15, never 10");
    assert.equal(out.containerCount, 3);
  });

  it("a demoted step is neither a container nor a minute", () => {
    const out = summarizePrepWeek(wireResult([{ minutes: 5 }, { minutes: 30, skip: true }]));
    assert.equal(out.containerCount, 1);
    // 5 min + 10% overhead = 5.5 → the next 5 is 10. The 30-minute demoted step
    // contributes nothing, which is the assertion that matters here.
    assert.equal(out.estimatedMinutes, 10);
    assert.equal(summarizePrepWeek(wireResult([{ minutes: 5 }])).estimatedMinutes, 10);
  });

  it("a cook-day sentence costs minutes but is not a container", () => {
    const out = summarizePrepWeek(wireResult([{ minutes: 5 }, { minutes: 2, noContainer: true }]));
    assert.equal(out.containerCount, 1);
    assert.equal(out.estimatedMinutes, 10); // 7 min + 10% = 7.7 → 10
  });

  it("an empty plan states zero, so the header can hide itself", () => {
    const out = summarizePrepWeek(wireResult([]));
    assert.equal(out.containerCount, 0);
    assert.equal(out.estimatedMinutes, 0);
  });
});

// ── the storage class of a shared container ─────────────────────────────────

describe("D-WS9-301 — a shared container keeps for the STRICTEST of its members", () => {
  it("🔴 garlic AND cilantro keeps 3 days, not 4", () => {
    assert.equal(storageClassFor("garlic cloves, fresh cilantro").days, 3);
    assert.equal(storageClassFor("garlic cloves").days, 4);
  });

  it("🔴 and the invariant that makes it true for EVERY pair, not just that one", () => {
    // `storageClassFor` returns the FIRST match in table order, so "first match"
    // only means "strictest" while the table is sorted by window. Asserting the
    // ordering is what makes the ruling hold for pairs nobody wrote a case for.
    const fridge = STORAGE_TABLE.filter((c) => !c.roomTemp).map((c) => c.days);
    for (let i = 1; i < fridge.length; i++) {
      assert.ok(
        fridge[i] >= fridge[i - 1],
        `STORAGE_TABLE is out of order at ${i}: ${fridge[i - 1]} then ${fridge[i]} — first match is no longer the strictest`,
      );
    }
  });
});

// ── BUG-346 (a) ─────────────────────────────────────────────────────────────

describe("BUG-346 (a) — the flesh check reads identity, never a free-text note", () => {
  it("🔴 baking soda for tenderizing beef is not beef", () => {
    const note = "baking soda (for tenderizing beef)";
    // Without the identities, the note's own words pick the class.
    assert.equal(storageClassFor(note).key, "raw-meat");
    // With them, the container is judged on what is in it.
    assert.notEqual(storageClassFor(note, "", ["baking soda"]).key, "raw-meat");
  });

  it("🔴 cornstarch for velveting the chicken is not chicken", () => {
    const note = "cornstarch (for velveting the chicken)";
    assert.equal(storageClassFor(note).key, "raw-meat");
    assert.notEqual(storageClassFor(note, "", ["cornstarch"]).key, "raw-meat");
  });

  it("…and real flesh in the container is still caught", () => {
    assert.equal(
      storageClassFor("salmon fillets, soy sauce", "Teriyaki glaze jar", ["salmon fillets", "soy sauce"]).key,
      "raw-fish",
    );
  });
});

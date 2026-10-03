// WS9 H6.1 — Hans's October 2 walk of the real payload.
//
// One ingredient is one food, every portion names a container, and the storage line
// fits what is in it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { combinePrep, type PrepCombineInput } from "../prepCombineEngine";
import {
  buildStepPlan,
  countContainers,
  containerNamesOf,
  isNoWorkPortion,
} from "../prepWeekAssembly";
import { ingredientGroupKey, buildRelationIndex } from "../ingredientRelations";
import { timeStep } from "../prepStepMinutes";
import { storageClassFor } from "../prepStorage";
import { resolveDishComponents, isCookingWork } from "../prepComponents";
import { resolveMoments } from "../prepMoments";

const MEAL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GARLIC_A = "11111111-1111-4111-8111-111111111111";
const GARLIC_B = "22222222-2222-4222-8222-222222222222";

// ── ruling 1 ────────────────────────────────────────────────────────────────

describe("H6.1 ruling 1 — one ingredient is one FOOD, not one catalog row", () => {
  it("🔴 the identity function is shared, and the singular clove folds", () => {
    // The grocery list has always folded these; the prep lane was the only one still
    // keying on the database row, so Hans got "Mince all garlic" (10 cloves) AND
    // "Mince all garlic cloves" (17) on one screen.
    assert.equal(ingredientGroupKey("garlic"), "garlic");
    assert.equal(ingredientGroupKey("garlic cloves"), "garlic");
    // The SINGULAR was missing from the hand map, so a recipe written "1 garlic
    // clove" got its own line in the basket and its own step on the screen.
    assert.equal(ingredientGroupKey("garlic clove"), "garlic");
    assert.equal(ingredientGroupKey("garlic head"), "garlic");
    // …and garlic powder is a different food.
    assert.notEqual(ingredientGroupKey("garlic powder"), "garlic");
    // The fixpoint property both lanes rely on.
    for (const n of ["garlic cloves", "garlic", "yellow onion"]) {
      assert.equal(ingredientGroupKey(ingredientGroupKey(n)), ingredientGroupKey(n));
    }
  });

  it("the index's own key is that function with the DB folds composed in", () => {
    // One implementation of the fold loop, so the two lanes cannot grow two notions
    // of "the same food".
    const index = buildRelationIndex([]);
    for (const n of ["garlic cloves", "garlic clove", "garlic head", "yellow onion"]) {
      assert.equal(index.groupKey(n), ingredientGroupKey(n));
    }
  });

  const twoRows = (): PrepCombineInput => ({
    meals: [
      {
        mealId: MEAL_A,
        mealName: "Garlic Week",
        dishes: [
          {
            dishId: "d1",
            dishName: "Chicken",
            dishRole: "main",
            ingredients: [
              { ingredientId: GARLIC_A, ingredientName: "garlic", category: "Produce", quantity: 4, unit: "clove", preparationNote: "minced" },
            ],
          },
          {
            dishId: "d2",
            dishName: "Chili",
            dishRole: "main",
            ingredients: [
              { ingredientId: GARLIC_B, ingredientName: "garlic cloves", category: "Produce", quantity: 5, unit: "each", preparationNote: "minced" },
            ],
          },
        ],
      },
    ],
  });

  it("🔴 two catalog rows for garlic are ONE step, with the minutes summed over the total", () => {
    const sp = buildStepPlan(combinePrep(twoRows()), "Test Plan");
    const steps = sp.steps.filter((s) => !s.demoted && s.components.some((c) => /garlic/i.test(c.ingredientName)));
    assert.equal(steps.length, 1, "garlic is two steps again");
    const measures = steps[0].components.flatMap((c) => c.measures);
    assert.equal(measures.length, 2, "the two rows' portions should both be on it");
    // 9 cloves at 1 min per 3 = 3 min. Costed per row it was 2 + 2.
    assert.equal(steps[0].estimatedMinutes, 3);
  });

  it("🔴 and the merged group reconciles its UNITS, so the count is not lost", () => {
    // One row says "4 clove" and the other "5 each". Summed per unit they stayed two
    // lines, and the second was charged as ONE clove — 27 cloves for 20 seconds on
    // the real plan.
    const sp = buildStepPlan(combinePrep(twoRows()), "Test Plan");
    const step = sp.steps.find((s) => s.components.some((c) => /garlic/i.test(c.ingredientName)))!;
    assert.equal(step.components.length, 1, "the group kept two lines for one food");
  });

  it("a bare count on a clove-shaped name is a clove count", () => {
    assert.equal(timeStep({ components: [{ ingredientName: "garlic cloves", preparationNote: "minced", measures: [{ amount: "27", preparationNote: null }] }] }).minutes, 9);
  });
});

// ── ruling 3 ────────────────────────────────────────────────────────────────

describe("H6.1 ruling 3 — the order of authority over a moment", () => {
  /** The taco: two adjacent prep steps, one of them the spice bowl. */
  const taco = () => ({
    steps: [
      { stepIndex: 0, text: "Finely dice the yellow onion and mince the 3 garlic cloves.", phaseType: "prep", componentKey: null, ingredientIds: ["onion", "garlic"] },
      { stepIndex: 1, text: "In a small bowl, combine 2 teaspoons chili powder, 1½ teaspoons ground cumin, ½ teaspoon garlic powder, ½ teaspoon onion powder; set aside.", phaseType: "prep", componentKey: "seasoning", ingredientIds: ["chili", "cumin", "gpowder", "opowder"] },
      { stepIndex: 2, text: "Heat the oil, then add the diced onion and cook for 3 minutes until softened.", phaseType: "cook", componentKey: null, ingredientIds: [] },
      { stepIndex: 3, text: "Add the minced garlic and cook for 30 seconds until fragrant.", phaseType: "cook", componentKey: null, ingredientIds: [] },
      { stepIndex: 4, text: "Stir in the spice blend and cook 1 minute.", phaseType: "cook", componentKey: "seasoning", ingredientIds: [] },
    ],
    ings: [
      { ingredientId: "onion", ingredientName: "yellow onion", preparationNote: "finely diced", phase: "produce" },
      // Named as the real catalog row is, and as the cook step says it: "Add the
      // minced garlic". A head word the prose never uses cannot be matched.
      { ingredientId: "garlic", ingredientName: "garlic", preparationNote: "minced", phase: "produce" },
      { ingredientId: "chili", ingredientName: "chili powder", preparationNote: null, phase: "seasonings_dry" },
      { ingredientId: "cumin", ingredientName: "ground cumin", preparationNote: null, phase: "seasonings_dry" },
      { ingredientId: "gpowder", ingredientName: "garlic powder", preparationNote: null, phase: "seasonings_dry" },
      { ingredientId: "opowder", ingredientName: "onion powder", preparationNote: null, phase: "seasonings_dry" },
    ],
  });

  it("🔴 signal 4 does not read ONE food's name out of ANOTHER's", () => {
    // THE TACO'S ACTUAL CAUSE, and it was not the run absorption I first reported.
    // Signal 4 takes an unplaced ingredient's head word and looks for it in a combine
    // step's text — and that step says "½ teaspoon GARLIC POWDER, ½ teaspoon ONION
    // POWDER". "garlic" and "onion" were both found, in the names of two powders
    // already in the bowl, and two fresh aromatics were conscripted into a
    // shelf-stable spice blend.
    const { steps, ings } = taco();
    const r = resolveDishComponents("Tex-Mex Seasoned Ground Beef", null, steps as never, ings as never);
    assert.equal(r.components.length, 1, "the spice blend should still form");
    const members = r.components[0].memberIds;
    assert.ok(!members.includes("onion"), "the diced onion is in the spice blend");
    assert.ok(!members.includes("garlic"), "the minced garlic is in the spice blend");
    assert.deepEqual([...members].sort(), ["chili", "cumin", "gpowder", "opowder"]);
  });

  it("🔴 a cook step that names an ingredient beats the run proxy", () => {
    const { steps, ings } = taco();
    const r = resolveMoments(steps as never, ings as never);
    const k = (id: string) => (r.keyByIngredientId as Map<string, string>).get(id);
    assert.equal(k("onion"), "s:2", "the onion enters at the sauté");
    assert.equal(k("garlic"), "s:3", "the garlic enters a step later");
    assert.equal(k("chili"), "r:0", "a spice no cook step names keeps the run");
    // The earliest ENTRY step wins, so a later mention of the same food cannot move it.
    assert.notEqual(k("onion"), k("garlic"));
  });

  it("🔴 a component whose own steps are all cooking work is no prep container", () => {
    // The chili's chile-base: "Toast the chiles… cover with boiling water and soak",
    // then "Drain… transfer to a blender… blend until smooth". The engine was
    // pre-measuring whole dried chiles into a bowl for Sunday.
    assert.equal(
      isCookingWork([
        "Toast the 3 ancho chiles in a dry skillet for 30-45 seconds per side, then cover with boiling water and soak for 15 minutes.",
        "Drain the soaked chiles, transfer to a blender with ½ cup broth, and blend until completely smooth.",
      ]),
      true,
    );
    // 🔴 EVERY STEP, NOT SOME — a dumpling dough is whisked cold AND cooked later, and
    // the first draft dissolved it.
    assert.equal(
      isCookingWork([
        "Whisk together the flour, baking powder and salt in a large bowl.",
        "Drop the dumplings onto the simmering stew and cover for 15 minutes.",
      ]),
      false,
    );
    assert.equal(isCookingWork([]), false);
  });
});

// ── ruling 5 / H6.1-B ───────────────────────────────────────────────────────

describe("H6.2 item 4 — whole-protein knife work always reaches phase 4", () => {
  /** One cook sentence names the thighs AND the aromatics, as the slow cooker's does. */
  const sharedSentence = (): PrepCombineInput => ({
    meals: [
      {
        mealId: MEAL_A,
        mealName: "Slow-Cooker Night",
        dishes: [
          {
            dishId: "d1",
            dishName: "Slow-Cooker Chicken",
            dishRole: "main",
            ingredients: [
              { ingredientId: "thighs", ingredientName: "boneless skinless chicken thighs", category: "Protein", quantity: 1.75, unit: "pound", preparationNote: "trimmed of excess fat", momentKey: "s:1" },
              { ingredientId: "onion", ingredientName: "yellow onion", category: "Produce", quantity: 1, unit: "each", preparationNote: "diced", momentKey: "s:1" },
              { ingredientId: "celery", ingredientName: "celery stalks", category: "Produce", quantity: 3, unit: "each", preparationNote: "sliced", momentKey: "s:1" },
            ],
          },
        ],
      },
    ],
  });

  it("🔴 a protein sharing a moment with its aromatics keeps its own trim step", () => {
    // "Place the trimmed 1¾ lb chicken thighs in the slow cooker and scatter the onion,
    // celery, carrots, and garlic over and around the chicken." One sentence, so after
    // H6.1 they shared a moment — and H4 had left protein members CLAIMED while the
    // emission skipped container steps in the proteins phase, so "trim the thighs"
    // vanished from the plan. A regression of rule 4 and rule 12; raw flesh has a
    // destination, not a seat.
    const sp = buildStepPlan(combinePrep(sharedSentence()), "Test Plan");
    const thighs = sp.steps.find((s) =>
      s.components.some((c) => /thighs/i.test(c.ingredientName)),
    );
    assert.ok(thighs, "the thighs have no step at all");
    assert.equal(thighs!.phase, "proteins", "whole-protein knife work left the proteins phase");
    assert.equal(thighs!.demoted, undefined);
  });
});

describe("H6.1-B — every portion names a container", () => {
  const shared = (): PrepCombineInput => ({
    meals: [
      {
        mealId: MEAL_A,
        mealName: "Mexican Week",
        dishes: [
          { dishId: "d1", dishName: "Enchiladas", dishRole: "main", ingredients: [{ ingredientId: "onion", ingredientName: "white onion", category: "Produce", quantity: 1, unit: "each", preparationNote: "finely diced" }] },
          { dishId: "d2", dishName: "Mexican Rice", dishRole: "side", ingredients: [{ ingredientId: "onion", ingredientName: "white onion", category: "Produce", quantity: 0.5, unit: "each", preparationNote: "finely diced" }] },
          { dishId: "d3", dishName: "Tomatillo Sauce", dishRole: "sauce", ingredients: [{ ingredientId: "tomatillo", ingredientName: "fresh tomatillos", category: "Produce", quantity: 4, unit: "each", preparationNote: "husked and halved" }] },
        ],
      },
    ],
  });

  it("🔴 a portion that goes into a SHARED container always names it", () => {
    // H6.2 item 1 narrowed H6.1-B. A portion still never says "set aside" — but a
    // SINGLE lone portion gets no tub of its own, because one portion is not a
    // container; it IS its own, which is what a missing destination has always meant
    // ("dice the onion — into the onion container" is the noise rule 11 avoids).
    // What must never happen is a portion sharing a vessel without saying which.
    const sp = buildStepPlan(combinePrep(shared()), "Test Plan");
    for (const s of sp.steps) {
      if (s.demoted || s.holdsNoContainer || s.phase === "proteins") continue;
      for (const c of s.components) {
        const dishes = new Set(c.measures.map((m) => m.forDish));
        if (dishes.size < 2) continue; // its own container, no pointer needed
        for (const m of c.measures) {
          assert.ok(
            m.destination,
            `"${c.ingredientName}" for ${m.forDish} is shared and says nothing about where it goes`,
          );
        }
      }
    }
  });

  it("(b) a shared portion gets ONE tub, labelled with its dishes", () => {
    const sp = buildStepPlan(combinePrep(shared()), "Test Plan");
    const onion = sp.steps.find((s) => s.components.some((c) => c.ingredientName === "white onion"))!;
    const dests = new Set(onion.components.flatMap((c) => c.measures.map((m) => m.destination)));
    assert.equal(dests.size, 1, "the shared onion was split across containers");
    const label = [...dests][0]!;
    assert.match(label, /^Finely diced white onion — /);
    assert.match(label, /Enchiladas/);
    assert.match(label, /Mexican Rice/);
  });

  it("(c) a single-dish portion gets a container named for its dish and use", () => {
    const sp = buildStepPlan(combinePrep(shared()), "Test Plan");
    const t = sp.steps.find((s) => s.components.some((c) => c.ingredientName === "fresh tomatillos"))!;
    // The label takes the CUT from the note — "halved".
    // 🔴 H7 2a REVERSES H6.2 item 1. "One portion is not a container" printed "their
    // own portion" and "no destination container needed" on the sample plan. Hans,
    // October 2: a cut portion that joins nothing gets a container named
    // `<Dish> — <item, cut>`. The NO-WORK floor stays (next describe block).
    assert.equal(t.components[0].measures[0].destination, "Tomatillo Sauce — halved fresh tomatillos");
  });

  /** Two unclaimed portions of ONE dish, at the same kind of work. */
  const twoLonePortions = (): PrepCombineInput => ({
    meals: [
      {
        mealId: MEAL_A,
        mealName: "Mexican Week",
        dishes: [
          {
            dishId: "d3",
            dishName: "Tomatillo Sauce",
            dishRole: "sauce",
            ingredients: [
              { ingredientId: "tomatillo", ingredientName: "fresh tomatillos", category: "Produce", quantity: 4, unit: "each", preparationNote: "husked and halved" },
              { ingredientId: "poblano", ingredientName: "poblano pepper", category: "Produce", quantity: 1, unit: "each", preparationNote: "halved and seeded" },
            ],
          },
        ],
      },
    ],
  });

  it("🔴 the counter counts VESSELS BY NAME — one container, however many steps fill it", () => {
    const sp = buildStepPlan(combinePrep(shared()), "Test Plan");
    // Two ingredient steps, two tubs, and the wash step holds nothing.
    // The count is the distinct NAMES plus the steps that name nothing — which after
    // H6.2 includes a dish's single lone portion, its own container by construction.
    const named = new Set(
      sp.steps.filter((s) => !s.demoted && !s.holdsNoContainer).flatMap(containerNamesOf),
    ).size;
    const unnamed = sp.steps.filter(
      (s) => !s.demoted && !s.holdsNoContainer && containerNamesOf(s).length === 0,
    ).length;
    assert.equal(named + unnamed, countContainers(sp.steps));
    // 🔴 AND IT IS NOT ZERO. The predicate this replaced asked "does this step put a
    // bowl out of its own?", which became false for every ingredient step once rule
    // 11 named every destination — and the count collapsed to the mixtures alone.
    assert.ok(countContainers(sp.steps) >= 2, "every container vanished from the count");
    // 🔴 AND A CONTAINER THIS STEP ONLY FILLS IS STILL COUNTED. The shared onion tub
    // belongs to no step of its own; a counter reading only a step's OWN vessel would
    // drop it, which is how the count collapsed to the authored mixtures alone.
    const onionStep2 = sp.steps.find((s) =>
      s.components.some((c) => c.ingredientName === "white onion"),
    )!;
    const tub = onionStep2.components[0].measures[0].destination;
    assert.ok(tub, "the shared onion lost its tub");
    const counted = new Set(
      sp.steps.filter((s) => !s.demoted && !s.holdsNoContainer).flatMap(containerNamesOf),
    );
    assert.ok(counted.has(tub!), "a container the step only FILLS is missing from the count");
  });

  it("🔴 …two vegetables of ONE dish share a container only when they go into the heat together", () => {
    // Hans's own example: "Roasted Tomatillo Sauce roasting tray: tomatillos, poblano,
    // jalapeño, onion wedges". 🔴 H7 narrows H6.2's reason for it: not "cut in the same
    // phase" but "veggies + veggies is ok if they go in the pan together" (October 2).
    // With no evidence of a shared heat step, each is its own labelled container…
    const dests = (input: PrepCombineInput) =>
      new Set(
        buildStepPlan(combinePrep(input), "Test Plan")
          .steps.filter((s) => !s.demoted && s.phase === "produce" && !s.holdsNoContainer)
          .flatMap((s) => s.components.flatMap((c) => c.measures.map((m) => m.destination)))
          .filter((d): d is string => typeof d === "string"),
      );
    assert.deepEqual(
      [...dests(twoLonePortions())].sort(),
      ["Tomatillo Sauce — halved fresh tomatillos", "Tomatillo Sauce — halved poblano pepper"],
    );
    // …and with it (the broil step names both), they share ONE.
    const onTheTray = twoLonePortions();
    for (const i of onTheTray.meals[0].dishes[0].ingredients) i.momentKey = "s:2";
    const tray = dests(onTheTray);
    assert.equal(tray.size, 1, `expected one tray, got ${[...tray].join(" | ")}`);
    assert.equal([...tray][0], "Tomatillo Sauce vegetables");
  });
});

describe("H6.2 follow-up — a member that goes in LATER leaves the bowl", () => {
  /** The tomatillo sauce: a tray broiled at step 2, and cilantro into the blender at 4. */
  const trayAndBlender = (): PrepCombineInput => ({
    meals: [
      {
        mealId: MEAL_A,
        mealName: "Mexican Week",
        dishes: [
          {
            dishId: "d1",
            dishName: "Roasted Tomatillo Sauce",
            dishRole: "sauce",
            ingredients: [
              // H7 — the MOMENT carries it now: the tray is broiled at step 2 (the prep
              // step that spreads it on the sheet names both), the blender is step 4.
              { ingredientId: "tomatillo", ingredientName: "fresh tomatillos", category: "Produce", quantity: 4, unit: "each", preparationNote: "husked and halved", entryStep: 2, momentKey: "s:2" },
              { ingredientId: "poblano", ingredientName: "poblano pepper", category: "Produce", quantity: 1, unit: "each", preparationNote: "halved and seeded", entryStep: null, momentKey: "s:2" },
              { ingredientId: "cilantro", ingredientName: "fresh cilantro", category: "Produce", quantity: 0.25, unit: "cup", preparationNote: "roughly chopped", entryStep: 4, momentKey: "s:4" },
            ],
          },
        ],
      },
    ],
  });

  it("🔴 the tray keeps what is cut with it; the blender's cilantro splits off", () => {
    // Rule 1 exists so the cook never picks something back out at the stove. The tray is
    // broiled whole; the cilantro joins the blender two steps later.
    const sp = buildStepPlan(combinePrep(trayAndBlender()), "Test Plan");
    const dest = (name: string) =>
      sp.steps
        .filter((s) => !s.demoted)
        .flatMap((s) => s.components.filter((c) => c.ingredientName === name))
        .flatMap((c) => c.measures.map((m) => m.destination))[0];
    assert.equal(dest("fresh tomatillos"), "Roasted Tomatillo Sauce vegetables");
    assert.equal(dest("poblano pepper"), "Roasted Tomatillo Sauce vegetables");
    // …and the cilantro is not on it. H7 2a — alone, it gets its own labelled lid.
    assert.equal(dest("fresh cilantro"), "Roasted Tomatillo Sauce — chopped fresh cilantro");
  });
});

describe("H6.2 item 2 — a portion that needs no action is not prep", () => {
  it("🔴 whole, unpeeled, left whole: no line and no container", () => {
    for (const note of ["unpeeled", "left whole", "whole", "skin-on", "left whole, unpeeled"]) {
      assert.equal(isNoWorkPortion(note), true, `"${note}" should not be prep`);
    }
    // 🔴 AND A ROW WITH NO NOTE IS A DIFFERENT CASE — whole produce the narrator still
    // judges (D-WS9-299 tier 4). It must not be swept up here.
    assert.equal(isNoWorkPortion(null), false);
    assert.equal(isNoWorkPortion(""), false);
    for (const note of ["minced", "halved", "husked and halved", "zested and juiced"]) {
      assert.equal(isNoWorkPortion(note), false, `"${note}" is work`);
    }
  });

  it("🔴 the tomatillo sauce's 3 unpeeled cloves get no tub", () => {
    // The line Hans struck: "3 cloves (unpeeled) — into a tub labelled 'Roasted
    // Tomatillo Sauce — garlic'". The recipe roasts them whole; they stay in the bag.
    const sp = buildStepPlan(combinePrep(unpeeledGarlic()), "Test Plan");
    const live = sp.steps.filter((s) => !s.demoted && !s.holdsNoContainer);
    const dests = live.flatMap((s) =>
      s.components.flatMap((c) => c.measures.map((m) => m.destination)),
    );
    void dests;
    // 🔴 THE PORTION IS GONE, not merely unlabelled. Asserting that no tub is NAMED for
    // garlic missed the break: with the guard off the cloves simply joined the dish's
    // prep bowl, whose name says nothing about garlic.
    const garlicLines = live.flatMap((s) =>
      s.components
        .filter((c) => /garlic/i.test(c.ingredientName))
        .flatMap((c) => c.measures.map((m) => m.amount)),
    );
    assert.deepEqual(garlicLines, [], "the 3 unpeeled cloves are still a line on the plan");
  });
});

// ── ruling 4 / H6.1-C ───────────────────────────────────────────────────────

const unpeeledGarlic = (): PrepCombineInput => ({
  meals: [
    {
      mealId: MEAL_A,
      mealName: "Mexican Week",
      dishes: [
        {
          dishId: "d1",
          dishName: "Roasted Tomatillo Sauce",
          dishRole: "sauce",
          ingredients: [
            { ingredientId: "tomatillo", ingredientName: "fresh tomatillos", category: "Produce", quantity: 4, unit: "each", preparationNote: "husked and halved" },
            { ingredientId: "poblano", ingredientName: "poblano pepper", category: "Produce", quantity: 1, unit: "each", preparationNote: "halved and seeded" },
            { ingredientId: GARLIC_A, ingredientName: "garlic", category: "Produce", quantity: 3, unit: "clove", preparationNote: "unpeeled" },
          ],
        },
      ],
    },
  ],
});

describe("H6.1-C — the storage line fits the container", () => {
  it("🔴 a flour-and-leavener container is shelf stable", () => {
    const c = storageClassFor(
      "All-purpose flour baking powder baking soda fine salt",
      "Slow-Cooker Chicken dough bowl",
      ["All-purpose flour", "baking powder", "baking soda", "fine salt"],
    );
    assert.equal(c.roomTemp, true, "a bowl of flour was sent to the fridge");
    assert.match(c.note, /room temperature/);
    assert.doesNotMatch(c.note, /up to \d+ days/);
  });

  it("🔴 the dish name never selects a class", () => {
    // "Jalapeño Cheddar Cornbread" matched `cut-peppers` on JALAPEÑO, so a bowl of
    // flour and cornmeal was classed as cut chillies and given 4 fridge days.
    const names = ["All-purpose flour", "baking powder", "baking soda", "yellow cornmeal"];
    const withName = storageClassFor(names.join(" "), "Jalapeño Cheddar Cornbread seasoning bowl", names);
    const without = storageClassFor(names.join(" "), "", names);
    assert.deepEqual(withName, without, "the bowl name moved the storage class");
    assert.equal(withName.roomTemp, true);
  });

  it("🔴 a wet mix never carries the damp-towel line", () => {
    // The advice is for loose herbs in a tub. A marinade holding rosemary keeps for 3
    // days BECAUSE of the rosemary and is still a jar of oil.
    const names = ["extra-virgin olive oil", "lemon", "garlic", "fresh rosemary", "fresh thyme"];
    const c = storageClassFor(names.join(" "), "Lemon-Herb marinade bowl", names);
    assert.doesNotMatch(c.note, /damp paper towel/);
    assert.match(c.note, /Covered in the fridge/);
    // …and the WINDOW is the strictest member's — here the garlic's 4 days, since
    // the leafy-herb class lists parsley and cilantro, not rosemary and thyme.
    assert.equal(c.days, 4);
    const withParsley = [...names, "fresh flat-leaf parsley"];
    assert.equal(
      storageClassFor(withParsley.join(" "), "", withParsley).days,
      3,
      "a stricter member must pull the window in",
    );
  });

  it("…while loose herbs on their own still get it", () => {
    const names = ["fresh flat-leaf parsley"];
    const c = storageClassFor(names.join(" "), "", names);
    assert.match(c.note, /damp paper towel/);
  });

  it("a cupboard form cannot override a fridge class the contents matched", () => {
    // "cooked rice" matches the dry vocabulary on RICE; 14 room-temperature days for
    // cooked rice is the food-safety mistake this table exists to avoid.
    const c = storageClassFor("cooked white rice", "", ["cooked white rice"]);
    assert.notEqual(c.roomTemp, true);
    assert.ok(c.days <= 4);
  });
});

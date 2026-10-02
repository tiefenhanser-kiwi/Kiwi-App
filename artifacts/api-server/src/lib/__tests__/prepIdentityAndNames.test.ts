// WS9 H6.1 — Hans's October 2 walk of the real payload.
//
// One ingredient is one food, every portion names a container, and the storage line
// fits what is in it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { combinePrep, type PrepCombineInput } from "../prepCombineEngine";
import { buildStepPlan, countContainers, containerNamesOf } from "../prepWeekAssembly";
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

  it("🔴 no portion line is left without a container name", () => {
    const sp = buildStepPlan(combinePrep(shared()), "Test Plan");
    for (const s of sp.steps) {
      if (s.demoted || s.holdsNoContainer || s.phase === "proteins") continue;
      for (const c of s.components) {
        for (const m of c.measures) {
          assert.ok(
            m.destination,
            `"${c.ingredientName}" for ${m.forDish} says nothing about where it goes`,
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
    // The label takes the CUT from the note — "halved". "Husked" is not a cut and is
    // deliberately not in the vocabulary; the label names the vessel, not the recipe.
    assert.equal(t.components[0].measures[0].destination, "Tomatillo Sauce — halved fresh tomatillos");
  });

  it("🔴 the counter counts VESSELS BY NAME — one container, however many steps fill it", () => {
    const sp = buildStepPlan(combinePrep(shared()), "Test Plan");
    // Two ingredient steps, two tubs, and the wash step holds nothing.
    assert.deepEqual(
      [...new Set(sp.steps.filter((s) => !s.demoted && !s.holdsNoContainer).flatMap(containerNamesOf))].length,
      countContainers(sp.steps),
    );
    // 🔴 AND IT IS NOT ZERO. The predicate this replaced asked "does this step put a
    // bowl out of its own?", which became false for every ingredient step once rule
    // 11 named every destination — and the count collapsed to the mixtures alone.
    assert.ok(countContainers(sp.steps) >= 2, "every container vanished from the count");
  });
});

// ── ruling 4 / H6.1-C ───────────────────────────────────────────────────────

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

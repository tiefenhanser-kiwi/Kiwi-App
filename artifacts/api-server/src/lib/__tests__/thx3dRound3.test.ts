// THX-3d round 3 (U) — wording: a prepped food's cut goes with it; a held dish's foil
// step agrees with its name's number.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rewordFeastSteps, type FeastDishFacts, type WordingRow, type WordingStep } from "../feastCookWording";
import { ingredientGroupKey } from "../ingredientRelations";
import { holdCoveredText, HOLD_COVERED_STEP } from "../cookingScheduler";

const row = (ingredientId: string, name: string): WordingRow => ({ ingredientId, name });
const step = (stepIndex: number, text: string): WordingStep => ({ stepIndex, text, amountRefs: [] });

describe("THX-3d round 3 (U) — the prepped celery takes its \", cut into thirds,\" with it", () => {
  it("Small's roasting bed: \"…the quartered onion and celery you prepped in the bottom of a roasting pan\"", () => {
    const ONION = row("on", "yellow onion");
    const CELERY = row("ce", "celery stalks");
    const facts: FeastDishFacts = {
      dishId: "breast",
      mixes: [],
      cuts: [
        { id: "on", key: ingredientGroupKey("yellow onion"), into: "Turkey aromatics", note: "quartered", kind: "plate" },
        { id: "ce", key: ingredientGroupKey("celery stalks"), into: "Turkey aromatics", note: "cut into thirds", kind: "plate" },
      ],
    };
    const text = "Scatter the quartered onion and 2 celery stalks, cut into thirds, in the bottom of a roasting pan; drizzle 1 tablespoon olive oil over the vegetables.";
    const at = text.indexOf("2 celery");
    const bed: WordingStep = { stepIndex: 6, text, amountRefs: [{ ingredientId: "ce", quantity: 2, unit: "each", charStart: at, charEnd: at + 1 }] };
    const out = rewordFeastSteps([bed], [ONION, CELERY], facts, ["Roast Turkey Breast"]);
    assert.doesNotMatch(out[0].text, /cut into thirds/);
    assert.match(out[0].text, /celery you prepped in the bottom of a roasting pan/);
  });
});

describe("THX-3d round 3 (U) — the foil step agrees with the dish's name", () => {
  it("\"…Smashed Potatoes with foil to keep them warm\"; a stuffing keeps \"it\"", () => {
    assert.equal(holdCoveredText("Garlic-Parmesan Smashed Potatoes", false), "Cover the Garlic-Parmesan Smashed Potatoes with foil to keep them warm.");
    assert.equal(holdCoveredText("Herb Stuffing", true), "Cover the Herb Stuffing with foil to keep it warm while the oven heats for the next dish.");
    assert.equal(holdCoveredText("Baked Mac and Cheese", false), "Cover the Baked Mac and Cheese with foil to keep it warm.");
    for (const t of ["Cover the Garlic-Parmesan Smashed Potatoes with foil to keep them warm.", "Cover the Herb Stuffing with foil to keep it warm."]) assert.match(t, HOLD_COVERED_STEP);
  });
});

import { scheduleCookingSequence, type SchedulerDish, type SchedulerPhase } from "../cookingScheduler";
import { referBack } from "../heldMorning";

const st = (stepIndex: number, phaseType: SchedulerPhase, estimatedMinutes: number, text: string) => ({ stepIndex, phaseType, estimatedMinutes, text, isTimingSensitive: false, parallelGroup: null, componentKey: null, pathKey: null });
const dish = (dishId: string, title: string, positionIndex: number, steps: ReturnType<typeof st>[]): SchedulerDish => ({ dishId, title, positionIndex, roleLabel: null, steps });

describe("THX-3d round 3 (U) — served hot, at serving time (serveLate)", () => {
  // Weeknight Tuesday, as dumped: the tortillas were warmed, the pico finished, and the
  // tortillas sat before "…and serve immediately".
  const TACOS = dish("tacos", "Green Chile Ground Beef Taco Filling", 0, [
    st(0, "prep", 5, "Dice the onion."),
    st(1, "cook", 8, "Brown the beef with the onion."),
    st(2, "cook", 4, "Pour in the broth and simmer until absorbed."),
    st(3, "cook", 6, "Warm the 6 corn tortillas one at a time on a dry skillet."),
    st(4, "assemble", 3, "Spoon the filling into the warm tortillas, top with the cheese, and serve immediately."),
  ]);
  const PICO = dish("pico", "Fresh Pico de Gallo", 1, [
    st(0, "prep", 8, "Seed and dice the tomatoes, onion and jalapeño."),
    st(1, "prep", 3, "Chop the cilantro and squeeze the lime."),
    st(2, "assemble", 2, "Combine everything with the salt."),
    st(3, "assemble", 2, "Cut the limes into wedges and set them out."),
  ]);
  it("the tortillas are warmed and filled as the meal is served, not ten minutes before", () => {
    const r = scheduleCookingSequence([TACOS, PICO]);
    const at = (d: string, i: number) => r.steps.find((e) => e.dishId === d && e.originalStepIndex === i)!.startOffsetMinutes;
    assert.equal(at("tacos", 4), at("tacos", 3) + 6, "filled as soon as they are warm");
    assert.ok(at("tacos", 4) + 3 >= -3, `served within 3 minutes of serving (ends T${at("tacos", 4) + 3})`);
  });
});

describe("THX-3d round 3 (U) — a morning garnish is named, not measured again (referBack)", () => {
  it("chives, parsley, cilantro", () => {
    assert.equal(referBack("Transfer the potatoes to a serving bowl and garnish with 2 tablespoons thinly sliced fresh chives.", "fresh chives", "thinly sliced, for garnish"), "Transfer the potatoes to a serving bowl and garnish with the chives you sliced this morning.");
    assert.equal(referBack("Transfer the potatoes to a platter, scatter with ¼ cup minced parsley and ½ teaspoon flaky sea salt (optional).", "fresh parsley", "minced, for garnish"), "Transfer the potatoes to a platter, scatter with the parsley you minced this morning and ½ teaspoon flaky sea salt (optional).");
    assert.equal(referBack("garnish with ¼ cup roughly chopped cilantro (optional) and 3 tablespoons toasted pepitas (optional).", "fresh cilantro", "roughly chopped, for garnish"), "garnish with the cilantro you chopped this morning (optional) and 3 tablespoons toasted pepitas (optional).");
    assert.equal(referBack("Mince ¼ cup fresh parsley; keep it covered in a small container in the fridge until serving.", "fresh parsley", "minced, for garnish"), "Mince ¼ cup fresh parsley; keep it covered in a small container in the fridge until serving.");
  });
});

describe("THX-3d round 3 — a step is never placed before the steps it follows in its dish", () => {
  it("the bird's roast waits for its herb butter, even when another dish's prep pushed the butter later", () => {
    const BIRD = dish("t", "Herb-Roasted Whole Turkey", 0, [
      st(0, "hold", 30, "Let the turkey sit at room temperature for 30 minutes."),
      st(1, "prep", 10, "Rub the herb butter under the skin."),
      st(2, "cook", 100, "Roast the turkey at 350°F for about 1¾ hours."),
      st(3, "rest", 20, "Transfer the turkey to a cutting board and rest 20 minutes."),
      st(4, "assemble", 10, "Carve the turkey."),
    ]);
    // A stovetop side whose prep takes the hands as the butter would start.
    const CABBAGE = dish("c", "Braised Red Cabbage", 1, [
      st(0, "prep", 30, "Shred the cabbage and slice the apples."),
      st(1, "cook", 150, "Braise the cabbage on the stove for 2½ hours."),
    ]);
    const r = scheduleCookingSequence([BIRD, CABBAGE], { feastOven: true });
    const at = (d: string, i: number) => r.steps.find((e) => e.dishId === d && e.originalStepIndex === i)!.startOffsetMinutes;
    assert.ok(at("t", 2) >= at("t", 1) + 10, `the roast starts T${at("t", 2)}, the butter ends T${at("t", 1) + 10}`);
    assert.ok(at("t", 3) >= at("t", 2) + 100, "the rest follows the roast");
  });
});

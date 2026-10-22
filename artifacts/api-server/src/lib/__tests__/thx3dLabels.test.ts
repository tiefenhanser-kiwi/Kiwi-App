// THX-3d round 2 (N) — Prep the feast's containers carry labels a cook can write on tape.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { feastLabelMap, labelFeastContainers, FEAST_LABEL_STEP_KEY } from "../prepFeastLabels";
import type { PlannedStep, StepPlan } from "../prepWeekAssembly";

/** A step: its container (A) and each portion's destination, as the engine names them. */
function step(n: number, phase: string, bowlName: string | undefined, parts: [ingredient: string, dish: string, destination?: string, note?: string][]): PlannedStep {
  return {
    stepId: `${phase}#${n}`, stepKey: `k${n}`, phase, number: n, ingredientId: null, contributesToMealIds: ["m"], isBlend: !!bowlName, estimatedMinutes: 2, relevantDishes: [],
    ...(bowlName ? { bowlName } : {}),
    components: parts.map(([ingredientName, forDish, destination, note]) => ({
      ingredientName,
      measures: [{ amount: "1", forDish, dishRole: "side", ...(destination ? { destination } : {}), ...(note ? { preparationNote: note } : {}) }],
    })),
  } as unknown as PlannedStep;
}

// Classic, as the engine named its containers before round 2.
const CLASSIC: StepPlan = {
  steps: [
    step(1, "seasonings_dry", "Cranberry-Orange Sauce dry mix", [["kosher salt", "Cranberry-Orange Sauce"], ["granulated sugar", "Cranberry-Orange Sauce"], ["cinnamon stick", "Cranberry-Orange Sauce"]]),
    step(2, "seasonings_dry", "Pumpkin Pie dry mix", [["light brown sugar", "Pumpkin Pie"], ["ground cinnamon", "Pumpkin Pie"], ["ground nutmeg", "Pumpkin Pie"], ["ground ginger", "Pumpkin Pie"]]),
    step(3, "produce", undefined, [
      ["fresh thyme", "Sage and Onion Stuffing", "Sage and Onion Stuffing — fresh thyme, fresh sage and fresh flat-leaf parsley"],
      ["fresh sage", "Sage and Onion Stuffing", "Sage and Onion Stuffing — fresh thyme, fresh sage and fresh flat-leaf parsley"],
      ["fresh flat-leaf parsley", "Sage and Onion Stuffing", "Sage and Onion Stuffing — fresh thyme, fresh sage and fresh flat-leaf parsley"],
      ["yellow onion", "Sage and Onion Stuffing", "Sage and Onion Stuffing — yellow onion and celery"],
      ["celery", "Sage and Onion Stuffing", "Sage and Onion Stuffing — yellow onion and celery"],
      ["garlic", "Herb-Roasted Whole Turkey", "Herb-Roasted Whole Turkey vegetables", "3 minced for herb butter"],
      ["lemon", "Herb-Roasted Whole Turkey", "Herb-Roasted Whole Turkey vegetables", "zested for herb butter, halved for cavity"],
      ["yellow onion", "Herb-Roasted Whole Turkey", "Herb-Roasted Whole Turkey toppings plate", "quartered, for cavity"],
      ["yellow onion", "Pan Gravy", "Pan Gravy vegetables"], ["celery", "Pan Gravy", "Pan Gravy vegetables"], ["carrots", "Pan Gravy", "Pan Gravy vegetables"],
      ["garlic", "Green Bean Casserole", "Minced garlic — Sage and Onion Stuffing, Green Bean Casserole"],
    ]),
  ],
  narrationInput: { planName: "p", dishSteps: {}, steps: [] } as unknown as StepPlan["narrationInput"],
};

describe("THX-3d N — a label by rule: <dish short name> <role>", () => {
  const { map } = feastLabelMap(CLASSIC);
  it("mixes, herbs, a two-food tub, vegetables, a shared tub", () => {
    assert.equal(map.get("Cranberry-Orange Sauce dry mix"), "Cranberry mix");
    assert.equal(map.get("Pumpkin Pie dry mix"), "Pie spice mix");
    assert.equal(map.get("Sage and Onion Stuffing — fresh thyme, fresh sage and fresh flat-leaf parsley"), "Stuffing herbs");
    assert.equal(map.get("Sage and Onion Stuffing — yellow onion and celery"), "Stuffing onion & celery");
    assert.equal(map.get("Pan Gravy vegetables"), "Gravy vegetables");
    assert.equal(map.get("Minced garlic — Sage and Onion Stuffing, Green Bean Casserole"), "Minced garlic");
  });
  it("one container per dish per moment: the cavity's onion plate is the turkey's aromatics", () => {
    assert.equal(map.get("Herb-Roasted Whole Turkey vegetables"), "Turkey aromatics");
    assert.equal(map.get("Herb-Roasted Whole Turkey toppings plate"), "Turkey aromatics");
  });
  it("two mixes in one dish say which: the crisp's topping and filling", () => {
    const crisp: StepPlan = { ...CLASSIC, steps: [
      step(1, "seasonings_dry", "Apple Crisp dry mix", [["old-fashioned rolled oats", "Apple Crisp"], ["all-purpose flour", "Apple Crisp"], ["ground cinnamon", "Apple Crisp"]]),
      step(2, "seasonings_dry", "Apple Crisp dry mix 2", [["granulated sugar", "Apple Crisp"], ["ground cinnamon", "Apple Crisp"], ["ground nutmeg", "Apple Crisp"], ["cornstarch", "Apple Crisp"]]),
    ] };
    const m = feastLabelMap(crisp).map;
    assert.deepEqual([m.get("Apple Crisp dry mix"), m.get("Apple Crisp dry mix 2")], ["Crisp topping mix", "Crisp filling mix"]);
  });
});

describe("THX-3d N — the label everywhere, and the step that lists them", () => {
  const out = labelFeastContainers(CLASSIC);
  it("the first step: \"Label 7 containers\", the labels in the session's order", () => {
    assert.equal(out.steps[0].stepKey, FEAST_LABEL_STEP_KEY);
    assert.equal(out.steps[0].fixedProse?.title, "Label 7 containers");
    assert.match(out.steps[0].fixedProse!.instructions, /^Write these on tape, one per container: Cranberry mix · Pie spice mix · Stuffing herbs · /);
  });
  it("every name in the plan is the label: the container, each destination", () => {
    const names = JSON.stringify(out.steps.slice(1));
    assert.ok(!/dry mix|toppings plate|Pan Gravy vegetables| — fresh thyme/.test(names), names.slice(0, 300));
    assert.equal(out.steps[1].bowlName, "Cranberry mix");
    assert.equal(out.feastLabels.kinds.get("Minced garlic"), "shared");
    assert.equal(out.feastLabels.kinds.get("Gravy vegetables"), "own");
  });
});

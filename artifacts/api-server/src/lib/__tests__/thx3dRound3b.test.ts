// THX-3d round 3b — production parity, the read-time half: Cook Mode's words and Prep the
// feast's labels on production's own sentences (the Oct 23 export), each from a line
// production's copy read wrong.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rewordFeastSteps, type FeastDishFacts, type WordingRef, type WordingRow, type WordingStep } from "../feastCookWording";
import { feastLabelMap } from "../prepFeastLabels";
import { FEAST_SESSION_VERSION } from "../prepWeekFingerprint";
import { ingredientGroupKey } from "../ingredientRelations";
import type { PlannedStep, StepPlan } from "../prepWeekAssembly";

function step(stepIndex: number, text: string, spans: [string, string][] = []): WordingStep {
  const amountRefs: WordingRef[] = spans.map(([span, ingredientId]) => {
    const at = text.indexOf(span);
    assert.ok(at >= 0, `span "${span}" in "${text}"`);
    return { ingredientId, quantity: 1, unit: "", charStart: at, charEnd: at + span.length };
  });
  return { stepIndex, text, amountRefs };
}
const row = (ingredientId: string, name: string): WordingRow => ({ ingredientId, name });
const cut = (r: WordingRow, into: string, note: string, kind: FeastDishFacts["cuts"][number]["kind"] = null) => ({ id: r.ingredientId, key: ingredientGroupKey(r.name), into, note, kind });

describe("THX-3d 3b — a tub of a citrus zested and juiced", () => {
  const plan = {
    steps: [{
      stepId: "produce#1", stepKey: "k1", phase: "produce", number: 1, ingredientId: null, contributesToMealIds: ["m"], isBlend: false, estimatedMinutes: 3, relevantDishes: [],
      components: [{
        ingredientName: "orange",
        measures: [
          { amount: "1½", forDish: "Citrus-Herb Spatchcock Turkey", dishRole: "main", destination: "zested and juiced orange — Citrus-Herb Spatchcock Turkey, Cranberry-Jalapeño Relish" },
          { amount: "½", forDish: "Cranberry-Jalapeño Relish", dishRole: "sauce", destination: "zested and juiced orange — Citrus-Herb Spatchcock Turkey, Cranberry-Jalapeño Relish" },
        ],
      }],
    } as unknown as PlannedStep],
    narrationInput: { planName: "p", dishSteps: {}, steps: [] } as unknown as StepPlan["narrationInput"],
  } as StepPlan;
  it("is labelled by its food: \"Orange zest and juice\", never \"And juiced orange zest\"", () => {
    assert.equal(feastLabelMap(plan).map.get("zested and juiced orange — Citrus-Herb Spatchcock Turkey, Cranberry-Jalapeño Relish"), "Orange zest and juice");
  });
  it("the feast sessions' gate moved with it (their labels changed for the same feast)", () => {
    assert.equal(FEAST_SESSION_VERSION, 2);
  });
});

describe("THX-3d 3b — Cook Mode's words on production's sentences", () => {
  const ORANGE = row("orange", "orange"), LEMON = row("lemon", "lemon"), OIL = row("oil", "olive oil");
  it("New Twist: two fruits squeezed over the bird pour their juice", () => {
    const facts: FeastDishFacts = { dishId: "t", mixes: [], cuts: [cut(ORANGE, "Orange zest and juice", "zested and juiced", "shared"), cut(LEMON, "Turkey toppings", "zested and juiced", "plate")] };
    const [w] = rewordFeastSteps([step(7, "Remove the turkey from the fridge; work the compound butter under the breast skin and rub 3 tablespoons olive oil all over the outside, then squeeze the juice of 2 oranges and 2 lemons over the bird.", [["3 tablespoons", "oil"], ["2", "orange"]])], [ORANGE, LEMON, OIL], facts, ["Citrus-Herb Spatchcock Turkey"]);
    assert.equal(w.text, "Remove the turkey from the fridge; work the compound butter under the breast skin and rub 3 tablespoons olive oil all over the outside, then pour the orange and lemon juice you prepped over the bird.");
  });
  it("a zest-and-juice tub pours its juice", () => {
    const LIME = row("lime", "fresh lime");
    const facts: FeastDishFacts = { dishId: "v", mixes: [], cuts: [cut(LIME, "Lime zest and juice", "zested and juiced", "shared")] };
    const [w] = rewordFeastSteps([step(5, "Transfer the sweet potatoes to a serving platter; squeeze 1 lime over the top.", [["1", "lime"]])], [LIME], facts, ["Chipotle-Maple Sweet Potatoes"]);
    assert.equal(w.text, "Transfer the sweet potatoes to a serving platter; pour the lime juice you prepped over the top.");
  });
  it("New Twist: the blanched green beans are the dish's own by then, not the prep's", () => {
    const BEANS = row("beans", "green beans"), SALT = row("salt", "kosher salt");
    const facts: FeastDishFacts = { dishId: "g", mixes: [], cuts: [cut(BEANS, "Green beans plate", "trimmed", "plate")] };
    const text = "Add the blanched green beans, 1 teaspoon kosher salt, and ½ teaspoon black pepper; toss to coat and heat through, 2–3 minutes.";
    const [w] = rewordFeastSteps([step(5, text, [["1 teaspoon", "salt"]])], [BEANS, SALT], facts, ["Brown-Butter Green Beans"]);
    assert.equal(w.text, text);
  });
  it("Make-Ahead: a food named by its shape goes whole, and a mid-list cut keeps the list's comma", () => {
    const GARLIC = row("garlic", "garlic"), ONION = row("onion", "yellow onion"), CELERY = row("celery", "celery"), CARROT = row("carrot", "carrots"), THYME = row("thyme", "fresh thyme");
    const facts: FeastDishFacts = {
      dishId: "t",
      mixes: [],
      cuts: [cut(GARLIC, "Turkey plate", "smashed", "plate"), cut(ONION, "Turkey plate", "quartered", "plate"), cut(CELERY, "Gravy plate", "cut into pieces", "plate"), cut(CARROT, "Gravy plate", "cut into pieces", "plate")],
    };
    const [cavity] = rewordFeastSteps([step(6, "Rub 6 tablespoons softened butter under the breast skin. Stuff the cavity with the 6 cloves garlic, onion quarters, 6 thyme sprigs, and 6 sage leaves.", [["6 cloves", "garlic"]])], [GARLIC, ONION, THYME], facts, ["Dry-Brined Roast Turkey"]);
    assert.doesNotMatch(cavity.text, /you prepped quarters/);
    assert.match(cavity.text, /onion you prepped, 6 thyme sprigs/);
    // Production's Tuesday gravy, its refs where production's are (each count's own digit).
    const text = "Make ahead (Tuesday): Add 1 quartered onion, 2 celery stalks, 1 carrot, cut into pieces, 4 smashed garlic cloves, 4 thyme sprigs, and 8 cups water to the pot.";
    const at = (s: string) => ({ charStart: text.indexOf(s), charEnd: text.indexOf(s) + 1, quantity: 1, unit: "" });
    const gravyStep: WordingStep = { stepIndex: 1, text, amountRefs: [{ ingredientId: "onion", ...at("1 quartered") }, { ingredientId: "celery", ...at("2 celery") }, { ingredientId: "carrot", ...at("1 carrot") }, { ingredientId: "garlic", ...at("4 smashed") }] };
    const [gravy] = rewordFeastSteps([gravyStep], [ONION, CELERY, CARROT, GARLIC, THYME], { ...facts, cuts: [...facts.cuts, cut(GARLIC, "Gravy plate", "smashed", "plate")] }, ["Make-Ahead Turkey Gravy"]);
    assert.match(gravy.text, /carrots? you prepped,/);
    assert.doesNotMatch(gravy.text, /you prepped (?:the|4)\b/);
  });
});

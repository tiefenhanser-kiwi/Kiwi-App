// PREP-3 (R1, R2) — a weeknight's Cook Mode words, from what the cook ticked: a mix or a
// prepped cut named where a step uses it, a shared tub with the step's own amount, a
// prepped cut clause gone from a step that does more, a marinade named where it is used,
// a step Cook Mode collapses left as it is. The steps are the dumps' own (dump0).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rewordFeastSteps, weeknightCookWordingFor, type FeastDishFacts, type WordingStep } from "../feastCookWording";
import { deriveAmountRefs } from "../stepAmountRefs";
import { ingredientGroupKey } from "../ingredientRelations";

type Row = { ingredientId: string; name: string; quantity: number; unit: string };
const step = (i: number, text: string, rows: Row[]): WordingStep => ({ stepIndex: i, text, amountRefs: deriveAmountRefs(text, rows).amountRefs as never });
const words = (title: string, rows: Row[], facts: FeastDishFacts, texts: string[]) =>
  rewordFeastSteps(texts.map((t, i) => step(i, t, rows)), rows, facts, [title], { weeknight: true }).map((s) => s.text);
const cut = (id: string, name: string, into: string, note: string, kind: "own" | "shared" | "plate" | "mix") => ({ id, key: ingredientGroupKey(name), into, note, kind });
const mix = (name: string, rows: Row[]) => ({ name, ids: new Set(rows.map((r) => r.ingredientId)), keys: new Set(rows.map((r) => ingredientGroupKey(r.name))) });

describe("PREP-3 (R1) — a prepped cut leaves a step that does more", () => {
  it("Wednesday's eggs are beaten; the scallions are on Wednesday's plate", () => {
    const rows: Row[] = [{ ingredientId: "egg", name: "large eggs", quantity: 2, unit: "each" }, { ingredientId: "wp", name: "white pepper", quantity: 0.125, unit: "tsp" }, { ingredientId: "sc", name: "scallions", quantity: 1.5, unit: "each" }, { ingredientId: "gar", name: "garlic cloves", quantity: 1, unit: "clove" }];
    const out = words("Egg Fried Rice", rows, { dishId: "f", mixes: [], cuts: [cut("sc", "scallions", "Wednesday plate", "thinly sliced, whites and greens separated", "plate"), cut("gar", "garlic cloves", "Minced garlic", "minced", "shared")] }, [
      "Lightly beat 2 large eggs with ⅛ teaspoon white pepper in a small bowl, and thinly slice 1½ scallions, keeping the whites and greens separated.",
      "Add 2 minced garlic cloves and the scallion whites and stir-fry for 30 seconds until fragrant.",
    ]);
    assert.equal(out[0], "Lightly beat 2 large eggs with ⅛ teaspoon white pepper in a small bowl.");
    // (R2) the shared tub keeps the step's amount; the whites are the scallions' own.
    assert.equal(out[1], "Add the minced garlic you prepped (2 cloves) and the scallion whites you prepped and stir-fry for 30 seconds until fragrant.");
  });

  it("the snap peas' strings are pulled; the sliced garlic is on the plate", () => {
    const rows: Row[] = [{ ingredientId: "sp", name: "fresh snap peas", quantity: 6, unit: "oz" }, { ingredientId: "gar", name: "garlic cloves", quantity: 1, unit: "clove" }];
    const out = words("Stir-Fried Snap Peas", rows, { dishId: "p", mixes: [], cuts: [cut("gar", "garlic cloves", "Wednesday plate", "thinly sliced", "plate")] }, ["Pull the strings from 6 oz fresh snap peas and thinly slice 1 garlic clove."]);
    assert.equal(out[0], "Pull the strings from 6 oz fresh snap peas.");
  });

  it("\"Zest and juice\" is one clause: never \"Zest, then whisk…\"", () => {
    const rows: Row[] = [{ ingredientId: "lem", name: "lemon", quantity: 0.5, unit: "each" }, { ingredientId: "oil", name: "extra-virgin olive oil", quantity: 2, unit: "tbsp" }];
    const out = words("Lemon Vinaigrette", rows, { dishId: "v", mixes: [], cuts: [cut("lem", "lemon", "Lemon juice", "zested and juiced", "shared")] }, [
      "Zest and juice ½ lemon, then whisk the zest and juice with 2 tablespoons extra-virgin olive oil.",
    ]);
    assert.equal(out[0], "Whisk the zest and juice with 2 tablespoons extra-virgin olive oil.");
  });

  it("a list of cuts keeps the one not prepped, capitalised", () => {
    const rows: Row[] = [{ ingredientId: "gar", name: "garlic cloves", quantity: 4, unit: "clove" }, { ingredientId: "sh", name: "shallots", quantity: 3, unit: "each" }, { ingredientId: "go", name: "green onions", quantity: 4, unit: "each" }, { ingredientId: "pn", name: "roasted unsalted peanuts", quantity: 0.5, unit: "cup" }];
    const out = words("Tofu Pad Thai", rows, { dishId: "pt", mixes: [], cuts: [cut("gar", "garlic cloves", "Minced garlic", "minced", "shared"), cut("sh", "shallots", "Friday plate", "thinly sliced", "plate"), cut("go", "green onions", "Friday plate", "cut into 1-inch pieces", "plate")] }, [
      "Mince the 4 garlic cloves, thinly slice the 3 shallots, cut the 4 green onions into 1-inch pieces, and roughly chop the ½ cup peanuts.",
    ]);
    assert.equal(out[0], "Roughly chop the ½ cup peanuts.");
  });
});

describe("PREP-3 (R1, R2, R4) — mixes and tubs named where they are used", () => {
  const lp: Row[] = [
    { ingredientId: "lem", name: "lemon", quantity: 1, unit: "each" }, { ingredientId: "oil", name: "olive oil", quantity: 3, unit: "tbsp" },
    { ingredientId: "pep", name: "coarsely cracked black pepper", quantity: 1.5, unit: "tsp" }, { ingredientId: "gp", name: "garlic powder", quantity: 1, unit: "tsp" },
    { ingredientId: "op", name: "onion powder", quantity: 0.5, unit: "tsp" }, { ingredientId: "salt", name: "kosher salt", quantity: 1, unit: "tsp" }, { ingredientId: "thy", name: "fresh thyme leaves", quantity: 1, unit: "tsp" },
  ];
  const marinade = [
    "Zest and juice 1 lemon, then whisk together the zest, juice, 3 tablespoons olive oil, 1½ teaspoons cracked black pepper, 1 teaspoon garlic powder, ½ teaspoon onion powder, 1 teaspoon kosher salt, and 1 teaspoon fresh thyme leaves into a marinade.",
    "Coat the chicken breasts evenly in the marinade and let sit at room temperature for 10 minutes.",
  ];
  const facts = (covered: number[]): FeastDishFacts => ({ dishId: "c", covered: new Set(covered), mixes: [mix("Monday marinade", lp)], cuts: [cut("lem", "lemon", "Monday marinade", "1 zested and juiced", "mix"), cut("thy", "fresh thyme leaves", "Monday marinade", "", "mix")] });

  it("\"Coat the chicken … in the Monday marinade\"; the step Cook Mode collapses keeps its words", () => {
    const out = words("Grilled Lemon Pepper Chicken Breasts", lp, facts([0]), marinade);
    assert.equal(out[0], marinade[0]);
    assert.equal(out[1], "Coat the chicken breasts evenly in the Monday marinade and let sit at room temperature for 10 minutes.");
  });

  it("Tuesday's spices are named at the step that measured them; the salt and pepper stay", () => {
    const taco: Row[] = [{ ingredientId: "cp", name: "chili powder", quantity: 1.5, unit: "tsp" }, { ingredientId: "cu", name: "ground cumin", quantity: 1, unit: "tsp" }, { ingredientId: "pa", name: "smoked paprika", quantity: 0.5, unit: "tsp" }, { ingredientId: "or", name: "dried oregano", quantity: 0.5, unit: "tsp" }, { ingredientId: "salt", name: "kosher salt", quantity: 0.75, unit: "tsp" }, { ingredientId: "pep", name: "black pepper", quantity: 0.25, unit: "tsp" }];
    const out = words("Green Chile Ground Beef Taco Filling", taco, { dishId: "tf", mixes: [mix("Tuesday spices", taco.slice(0, 4))], cuts: [] }, [
      "In a small bowl, combine 1½ teaspoons chili powder, 1 teaspoon cumin, ½ teaspoon smoked paprika, ½ teaspoon dried oregano, ¾ teaspoon kosher salt, and ¼ teaspoon black pepper.",
    ]);
    assert.equal(out[0], "In a small bowl, combine the Tuesday spices, ¾ teaspoon kosher salt, and ¼ teaspoon black pepper.");
  });

  it("the tzatziki's own bowl, the shared garlic and lemon with their amounts, and no \"the squeezed the cucumber\"", () => {
    const tz: Row[] = [{ ingredientId: "yog", name: "full-fat greek yogurt", quantity: 1, unit: "cup" }, { ingredientId: "cuc", name: "english cucumber", quantity: 0.5, unit: "each" }, { ingredientId: "gar", name: "garlic cloves", quantity: 2, unit: "clove" }, { ingredientId: "dill", name: "fresh dill", quantity: 2, unit: "tbsp" }, { ingredientId: "lj", name: "fresh lemon juice", quantity: 1, unit: "tbsp" }, { ingredientId: "oil", name: "extra-virgin olive oil", quantity: 1, unit: "tbsp" }];
    const out = words("Tzatziki", tz, { dishId: "t", mixes: [], cuts: [cut("cuc", "english cucumber", "Monday tzatziki", "grated and squeezed dry", "own"), cut("gar", "garlic cloves", "Minced garlic", "minced", "shared"), cut("dill", "fresh dill", "Monday tzatziki", "finely chopped", "own"), cut("lj", "fresh lemon juice", "Lemon juice", "freshly squeezed juice", "shared")] }, [
      "Stir together 1 cup full-fat Greek yogurt, the squeezed cucumber, 2 minced garlic cloves, 2 tablespoons finely chopped fresh dill, 1 tablespoon lemon juice, 1 tablespoon olive oil, and ¼ teaspoon kosher salt until fully combined.",
    ]);
    assert.equal(out[0], "Stir together 1 cup full-fat Greek yogurt, the Monday tzatziki you prepped, the minced garlic you prepped (2 cloves), the lemon juice you prepped (1 tablespoon), 1 tablespoon olive oil, and ¼ teaspoon kosher salt until fully combined.");
  });
});

describe("PREP-3 (R1) — the words come from what the cook ticked", () => {
  it("a weeknight plan with nothing ticked keeps every stored word (and reads no week)", async () => {
    let loaded = false;
    const prisma = {
      prepStepCompletion: { findMany: async () => [] },
      mealPlanInstance: { findUnique: async () => { loaded = true; return null; } },
    };
    const out = await weeknightCookWordingFor(prisma as never, { planId: "p", userId: "u", mealTags: [], dishes: [{ dishId: "d", title: "Tacos", steps: [{ stepIndex: 0, text: "In a small bowl, combine 1 teaspoon cumin." }] }] });
    assert.equal(out.size, 0);
    assert.equal(loaded, false);
  });

  it("a feast is never worded here (feastCookWordingFor's)", async () => {
    const out = await weeknightCookWordingFor({} as never, { planId: "p", userId: "u", mealTags: ["thanksgiving-feast"], prepped: true, dishes: [{ dishId: "d", title: "Turkey", steps: [] }] });
    assert.equal(out.size, 0);
  });
});

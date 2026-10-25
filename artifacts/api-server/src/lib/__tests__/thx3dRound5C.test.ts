// THX-3d round 5 (C) — D-WS9-321: a reworded Cook Mode step names the prepped containers it
// uses (preppedRefs) and says a mix as prepped; BUG-514: an empty phrase never ships;
// BUG-515: a count noun agrees with the number Cook Mode shows, and a lone number gets its
// noun or goes. The steps are hans+8's WEEK device plans' own (census 2026-10-25).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PreppedRefsSchema, rewordFeastSteps, type FeastDishFacts, type WordingStep } from "../feastCookWording";
import { deriveAmountRefs } from "../stepAmountRefs";
import { ingredientGroupKey } from "../ingredientRelations";
import { logger } from "../logger";

type Row = { ingredientId: string; name: string; quantity: number; unit: string };
const step = (i: number, text: string, rows: Row[]): WordingStep => ({ stepIndex: i, text, amountRefs: deriveAmountRefs(text, rows).amountRefs as never });
const reword = (title: string, rows: Row[], facts: FeastDishFacts, texts: string[], opts: { weeknight?: boolean; countOf?: (r: { quantity: number }) => number } = { weeknight: true }) =>
  rewordFeastSteps(texts.map((t, i) => step(i, t, rows)), rows, facts, [title], opts);
const cut = (id: string, name: string, into: string, note: string, kind: "own" | "shared" | "plate" | "mix", containerId?: string) => ({ id, key: ingredientGroupKey(name), into, note, kind, ...(containerId ? { containerId } : {}) });
const mix = (name: string, rows: Row[], containerId: string) => ({ name, ids: new Set(rows.map((r) => r.ingredientId)), keys: new Set(rows.map((r) => ingredientGroupKey(r.name))), containerId });

describe("THX-3d round 5 (D-WS9-321) — a mix said as prepped, and the step's preppedRefs", () => {
  const spices: Row[] = [
    { ingredientId: "chp", name: "chili powder", quantity: 1.5, unit: "tsp" }, { ingredientId: "cum", name: "cumin", quantity: 1, unit: "tsp" },
    { ingredientId: "pap", name: "smoked paprika", quantity: 0.5, unit: "tsp" }, { ingredientId: "ore", name: "dried oregano", quantity: 0.5, unit: "tsp" },
  ];
  const rows: Row[] = [...spices, { ingredientId: "salt", name: "kosher salt", quantity: 0.75, unit: "tsp" }, { ingredientId: "pep", name: "black pepper", quantity: 0.25, unit: "tsp" }];
  it("Tuesday's tacos: \"combine the Taco spices you prepped\", the salt and pepper kept, the jar named", () => {
    const [s] = reword("Green Chile Ground Beef Taco Filling", rows, { dishId: "t", mixes: [mix("Taco spices", spices, "c:taco")], cuts: [] }, [
      "In a small bowl, combine 1½ teaspoons chili powder, 1 teaspoon cumin, ½ teaspoon smoked paprika, ½ teaspoon dried oregano, ¾ teaspoon kosher salt, and ¼ teaspoon black pepper.",
    ]);
    assert.equal(s.text, "In a small bowl, combine the Taco spices you prepped, ¾ teaspoon kosher salt, and ¼ teaspoon black pepper.");
    assert.deepEqual(s.preppedRefs, [{ containerId: "c:taco", label: "Taco spices" }]);
  });

  it("the Skewers marinade made whole at prep, used by its bowl: said as prepped, beside the chicken chunks' package", () => {
    const sk: Row[] = [{ ingredientId: "oil", name: "olive oil", quantity: 3, unit: "tbsp" }, { ingredientId: "lj", name: "lemon juice", quantity: 3, unit: "tbsp" }, { ingredientId: "ch", name: "chicken thighs", quantity: 2, unit: "lb" }];
    const out = reword("Lemon-Herb Marinated Chicken Skewers", sk, {
      dishId: "k", mixes: [mix("Skewers marinade", sk.slice(0, 2), "c:sk")], cuts: [],
      proteins: [{ id: "ch", key: ingredientGroupKey("chicken thighs"), into: "Skewers chicken", note: "cut into 1½-inch chunks", containerId: "p:sk" }],
      covered: new Set([0]),
    }, [
      "Whisk together 3 tablespoons olive oil and 3 tablespoons lemon juice in a large bowl.",
      "Cut the 2 pounds of chicken thighs into 1½-inch chunks and add them to the marinade bowl, tossing well to coat.",
    ]);
    assert.equal(out[1].text, "Add the chicken chunks you prepped (2 pounds) to the Skewers marinade you prepped, tossing well to coat.");
    assert.deepEqual(out[1].preppedRefs, [{ containerId: "p:sk", label: "Skewers chicken" }, { containerId: "c:sk", label: "Skewers marinade" }]);
    assert.equal(out[0].preppedRefs, undefined, "the step Cook Mode collapses keeps its words, and names nothing");
  });

  it("a feast's skip step names what Prep the feast made; a step that uses nothing prepped has no refs", () => {
    const cr: Row[] = [{ ingredientId: "cran", name: "fresh cranberries", quantity: 12, unit: "oz" }, { ingredientId: "sug", name: "granulated sugar", quantity: 1, unit: "cup" }, { ingredientId: "w", name: "water", quantity: 0.5, unit: "cup" }];
    const out = reword("Cranberry-Orange Sauce", cr, { dishId: "c", mixes: [mix("Cranberry mix", cr.slice(0, 2), "c:cr")], cuts: [] }, [
      "Make ahead (Monday): Measure 12 oz fresh cranberries and 1 cup granulated sugar.",
      "Make ahead (Monday): Bring the sauce to a simmer.",
    ], {});
    assert.match(out[0].text, /^Make ahead \(Monday\): Skip if you prepped\. Otherwise, measure/);
    assert.deepEqual(out[0].preppedRefs, [{ containerId: "c:cr", label: "Cranberry mix" }]);
    assert.equal(out[1].preppedRefs, undefined);
  });

  it("a shared tub's id is its name, and a name past 120 characters goes by its hash (the schema caps the id at 200)", () => {
    const lemon: Row[] = [{ ingredientId: "lem", name: "lemon", quantity: 0.5, unit: "" }];
    const tub = `Lemon juice — ${Array.from({ length: 8 }, (_, i) => `Weeknight Dish Number ${i + 1}`).join(", ")}`;
    const [s] = reword("Roasted Asparagus with Lemon", lemon, { dishId: "a", mixes: [], cuts: [cut("lem", "lemon", "Lemon juice", "juiced", "shared", tub)] }, ["Squeeze the juice of ½ lemon over the top."]);
    assert.match(s.preppedRefs![0].containerId, /^h:[0-9a-f]{24}$/);
    assert.equal(s.preppedRefs![0].label, "Lemon juice");
    assert.ok(PreppedRefsSchema.safeParse(s.preppedRefs).success);
  });

  it("the wire's schema: a ref list is never empty, every ref has an id and a label", () => {
    assert.ok(PreppedRefsSchema.safeParse([{ containerId: "c:taco", label: "Taco spices" }]).success);
    assert.ok(!PreppedRefsSchema.safeParse([]).success);
    assert.ok(!PreppedRefsSchema.safeParse([{ containerId: "", label: "Taco spices" }]).success);
  });
});

describe("THX-3d round 5 (BUG-514) — an empty phrase never ships", () => {
  const lemon: Row[] = [{ ingredientId: "lem", name: "lemon", quantity: 0.5, unit: "" }, { ingredientId: "par", name: "parmesan", quantity: 2, unit: "tbsp" }];
  it("Monday's asparagus: the pour names the lemon juice once (it read \"pour  you prepped over the top\")", () => {
    const tub = "Lemon juice — Red Lentil Dal, Roasted Asparagus with Lemon, Garlic Butter Broccoli";
    const [s] = reword("Roasted Asparagus with Lemon", lemon, { dishId: "a", mixes: [], cuts: [cut("lem", "lemon", "Lemon juice", "juiced", "shared", tub)] }, [
      "Transfer the asparagus to a platter, squeeze the juice of ½ lemon over the top, and finish with 2 tablespoons finely grated parmesan if using.",
    ]);
    assert.equal(s.text, "Transfer the asparagus to a platter, pour the lemon juice you prepped over the top, and finish with 2 tablespoons finely grated parmesan if using.");
    assert.deepEqual(s.preppedRefs, [{ containerId: tub, label: "Lemon juice" }]);
  });

  it("a pour whose phrase has commas in it is the pour's too (the long tub name, as a label)", () => {
    const tub = "Lemon juice — Red Lentil Dal, Roasted Asparagus with Lemon";
    const [s] = reword("Roasted Asparagus with Lemon", lemon, { dishId: "a", mixes: [], cuts: [cut("lem", "lemon", tub, "juiced", "shared")] }, [
      "Transfer the asparagus to a platter, squeeze the juice of ½ lemon over the top.",
    ]);
    assert.equal(s.text, "Transfer the asparagus to a platter, pour the lemon juice — red lentil dal, roasted asparagus with lemon you prepped over the top.");
  });

  it("a container whose name says nothing: the stored words, no refs, and a WARN naming the step", () => {
    const warned: unknown[] = [];
    const warn = logger.warn;
    (logger as { warn: unknown }).warn = (obj: unknown) => { warned.push(obj); };
    try {
      const rows: Row[] = [{ ingredientId: "on", name: "yellow onion", quantity: 1, unit: "" }, { ingredientId: "but", name: "butter", quantity: 2, unit: "tbsp" }];
      const text = "Melt 2 tablespoons butter and add 1 yellow onion, diced.";
      const [s] = reword("Herb Stuffing", rows, { dishId: "h", mixes: [], cuts: [cut("on", "yellow onion", " ", "diced", "own")] }, [text], {});
      assert.equal(s.text, text);
      assert.equal(s.preppedRefs, undefined);
      assert.deepEqual(warned.map((w) => { const x = w as { event: string; dishId: string; stepIndex: number }; return [x.event, x.dishId, x.stepIndex]; }), [["cook_wording_empty_phrase", "h", 0]]);
    } finally {
      (logger as { warn: unknown }).warn = warn;
    }
  });
});

describe("THX-3d round 5 (BUG-515) — the noun agrees with the number Cook Mode shows", () => {
  it("Friday's broccoli: a lone \"(½)\" gets its noun — \"(½ lemon)\"", () => {
    const rows: Row[] = [{ ingredientId: "lem", name: "lemon", quantity: 0.5, unit: "" }];
    const [s] = reword("Garlic Butter Broccoli", rows, { dishId: "b", mixes: [], cuts: [cut("lem", "lemon", "Lemon juice", "juiced", "shared")] }, [
      "Remove from heat, squeeze over the juice of ½ lemon (optional), and transfer to a serving dish.",
    ]);
    assert.equal(s.text, "Remove from heat, squeeze over the lemon juice you prepped (½ lemon), and transfer to a serving dish.");
  });

  it("2 celery stalks shown as 1 (BUG-437 rounds 1.05 to 1): \"(2 stalk)\", which Cook Mode reads \"(1 stalk)\"", () => {
    const rows: Row[] = [{ ingredientId: "cel", name: "celery", quantity: 2, unit: "" }];
    const [s] = reword("Pan Gravy", rows, { dishId: "g", mixes: [], cuts: [cut("cel", "celery", "Sliced celery", "sliced", "shared")] }, ["Add 2 celery stalks and cook 3 minutes."], { weeknight: true, countOf: () => 1.05 });
    assert.equal(s.text, "Add the sliced celery you prepped (2 stalk) and cook 3 minutes.");
  });

  it("garlic rounds UP (BUG-437): 1.2 cloves are shown as 2, \"cloves\"", () => {
    const rows: Row[] = [{ ingredientId: "gar", name: "garlic cloves", quantity: 2, unit: "" }];
    const [s] = reword("Garlic Herb Rice", rows, { dishId: "r", mixes: [], cuts: [cut("gar", "garlic cloves", "Minced garlic", "minced", "shared")] }, ["Add 2 minced garlic cloves and sauté 1 minute."], { weeknight: true, countOf: () => 1.2 });
    assert.equal(s.text, "Add the minced garlic you prepped (2 cloves) and sauté 1 minute.");
  });
});

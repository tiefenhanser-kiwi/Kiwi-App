// SERVER-13 E (BUG-633) — an amountRef bound to a same-named sibling row, found from
// the step's words and confirmed by the rows' amounts (scripts/server-13/bug633Refs.ts).
// Classic Beef Lo Mein, as dev holds it: s0's "1 tablespoon soy sauce" bound to the
// dark-soy row.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { dishMisbinds, rebind, type RowLike, type StepLike } from "../../../scripts/server-13/bug633Refs";

const at = (text: string, span: string, from = 0) => text.indexOf(span, from);
function step(stepIndex: number, text: string, refs: [span: string, ingredientId: string, quantity: number, unit: string][]): StepLike {
  let from = 0;
  return {
    stepIndex,
    text,
    amountRefs: refs.map(([span, ingredientId, quantity, unit]) => {
      const charStart = at(text, span, from);
      from = charStart + span.length;
      return { ingredientId, quantity, unit, charStart, charEnd: charStart + span.length };
    }),
  };
}

const ROWS: RowLike[] = [
  { ingredientId: "soy", name: "soy sauce", quantity: 3, unit: "tablespoon" },
  { ingredientId: "dark", name: "dark soy sauce", quantity: 1, unit: "tablespoon" },
  { ingredientId: "oil", name: "sesame oil", quantity: 2, unit: "teaspoon" },
];
const S0 = "In a medium bowl, combine the 1½ lb thinly sliced flank steak with 1 tablespoon soy sauce, 2 teaspoons cornstarch, and 1 teaspoon sesame oil; toss well.";
const S1 = "In a small bowl, whisk together 2 tablespoons soy sauce, 1 tablespoon dark soy sauce and 1 teaspoon sesame oil into the lo mein sauce; set aside.";
const loMein = (s0Soy: string) => [
  step(0, S0, [["1 tablespoon", s0Soy, 1, "tablespoon"], ["1 teaspoon", "oil", 1, "teaspoons"]]),
  step(1, S1, [["2 tablespoons", "soy", 2, "tablespoons"], ["1 tablespoon", "dark", 1, "tablespoon"], ["1 teaspoon", "oil", 1, "teaspoon"]]),
];

describe("SERVER-13 E — a ref bound to a same-named sibling row", () => {
  it("Classic Beef Lo Mein's s0 soy, bound to the dark soy, is confirmed by the amounts and moves to the soy row", () => {
    const steps = loMein("dark");
    const { confirmed, unconfirmed } = dishMisbinds(steps, ROWS);
    assert.deepEqual(confirmed.map((m) => [m.stepIndex, m.index, m.from, m.to]), [[0, 0, "dark", "soy"]]);
    assert.deepEqual(unconfirmed, []);
    const fixed = rebind(steps[0].amountRefs!, confirmed);
    assert.deepEqual(fixed[0], { ...steps[0].amountRefs![0], ingredientId: "soy" }, "only the ingredient moves: span, number, unit kept");
    assert.deepEqual(fixed[1], steps[0].amountRefs![1]);
  });

  it("finds nothing once fixed (the script is idempotent), and nothing in the step that names the dark soy", () => {
    assert.deepEqual(dishMisbinds(loMein("soy"), ROWS), { confirmed: [], unconfirmed: [] });
  });

  it("the words alone are not enough: rows whose amounts already agree are left (Mole's garnish sesame)", () => {
    const rows: RowLike[] = [
      { ingredientId: "ss", name: "sesame seeds", quantity: 2, unit: "tablespoon" },
      { ingredientId: "white", name: "white sesame seeds", quantity: 1, unit: "tablespoon" },
    ];
    const steps = [
      step(2, "Toast 2 tablespoons sesame seeds and the chiles in a dry skillet.", [["2 tablespoons", "ss", 2, "tablespoons"]]),
      step(14, "Garnish with 1 tablespoon sesame seeds (optional) and the cilantro.", [["1 tablespoon", "white", 1, "tablespoon"]]),
    ];
    const r = dishMisbinds(steps, rows);
    assert.deepEqual(r.confirmed, []);
    assert.equal(r.unconfirmed.length, 1);
  });

  it("a food and what is made from it is not this shape (lemon / lemon juice, garlic / chili garlic sauce)", () => {
    const rows: RowLike[] = [
      { ingredientId: "lemon", name: "lemon", quantity: 1, unit: "each" },
      { ingredientId: "juice", name: "fresh lemon juice", quantity: 3, unit: "tablespoon" },
      { ingredientId: "garlic", name: "garlic", quantity: 2, unit: "tablespoon" },
      { ingredientId: "cgs", name: "chili garlic sauce", quantity: 1, unit: "tablespoon" },
    ];
    const steps = [step(0, "Juice 2 lemons to get 3 tablespoons, and measure 2 tablespoons pre-minced garlic.", [["2", "juice", 3, "tablespoon"], ["2 tablespoons", "cgs", 2, "tablespoons"]])];
    assert.deepEqual(dishMisbinds(steps, rows), { confirmed: [], unconfirmed: [] });
  });

  it("a ref in another unit is left out of the sums, not a reason to stop (Szechuan Beef's bought sauce)", () => {
    const steps = [
      ...loMein("dark"),
      step(4, "Or use ½ cup store-bought Szechuan sauce.", [["½ cup", "soy", 0.5, "cup"]]),
    ];
    assert.deepEqual(dishMisbinds(steps, ROWS).confirmed.map((m) => m.to), ["soy"]);
  });
});

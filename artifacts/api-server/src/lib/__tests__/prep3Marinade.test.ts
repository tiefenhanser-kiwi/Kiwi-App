// PREP-3 (R4) — a weeknight marinade is one jar: its spices, citrus, oil, salt and fresh
// herb, with the protein added on the day. Monday's lemon-pepper chicken (hh2, dump0)
// had a spice blend and a citrus jar and left the oil, salt and thyme loose.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildPrepWeekPlan } from "../prepWeekBuild";
import { containers, load, uuid, type Meal } from "./fixtures/prep3Week";

const lemonPepper: Meal = {
  id: uuid(1), name: "Grilled Lemon Pepper Chicken", day: "Monday", lag: 1,
  dishes: [{
    id: uuid(11), name: "Grilled Lemon Pepper Chicken Breasts",
    ings: [
      { id: uuid(101), name: "boneless skinless chicken breasts", category: "Protein", quantity: 2, unit: "lb", note: "pounded to even 3/4-inch thickness" },
      { id: uuid(102), name: "lemon", category: "Produce", quantity: 2, unit: "each", note: "1 zested and juiced, 1 sliced into wedges for serving" },
      { id: uuid(103), name: "olive oil", category: "Pantry", quantity: 3, unit: "tbsp" },
      { id: uuid(104), name: "coarsely cracked black pepper", category: "Pantry", quantity: 1.5, unit: "tsp" },
      { id: uuid(105), name: "garlic powder", category: "Pantry", quantity: 1, unit: "tsp" },
      { id: uuid(106), name: "onion powder", category: "Pantry", quantity: 0.5, unit: "tsp" },
      { id: uuid(107), name: "kosher salt", category: "Pantry", quantity: 1, unit: "tsp" },
      { id: uuid(108), name: "fresh thyme leaves", category: "Produce", quantity: 1, unit: "tsp" },
    ],
    steps: [
      { i: 0, phase: "prep", text: "Pound the chicken breasts to an even ¾-inch thickness, then pat dry with paper towels." },
      { i: 1, phase: "prep", text: "Zest and juice 1 lemon, then whisk together the zest, juice, 3 tablespoons olive oil, 1½ teaspoons cracked black pepper, 1 teaspoon garlic powder, ½ teaspoon onion powder, 1 teaspoon kosher salt, and 1 teaspoon fresh thyme leaves into a marinade.", ids: [uuid(102), uuid(103), uuid(104), uuid(105), uuid(106), uuid(107), uuid(108)], key: "seasoning" },
      { i: 3, phase: "rest", text: "Coat the chicken breasts evenly in the marinade and let sit at room temperature for 10 minutes." },
      { i: 5, phase: "cook", text: "Grill the chicken breasts 5–6 minutes per side until the internal temperature reaches 165°F.", ids: [] },
    ],
  }],
};
const tacos: Meal = {
  id: uuid(2), name: "Tacos", day: "Tuesday", lag: 2,
  dishes: [{
    id: uuid(21), name: "Taco Filling",
    ings: [
      { id: uuid(103), name: "olive oil", category: "Pantry", quantity: 1, unit: "tbsp" },
      { id: uuid(201), name: "white onion", category: "Produce", quantity: 1, unit: "each", note: "finely diced" },
    ],
    steps: [{ i: 0, phase: "cook", text: "Heat 1 tablespoon olive oil in a large skillet and cook the diced onion for 3 minutes.", ids: [uuid(103), uuid(201)] }],
  }],
};

describe("PREP-3 (R4) — the marinade is one jar", () => {
  const b = buildPrepWeekPlan(load([lemonPepper, tacos]));
  const all = [...containers(b)];

  it("its spices, lemon, oil, salt and thyme are in ONE marinade bowl", () => {
    const jar = all.filter(([, items]) => items.some((i) => /garlic powder/.test(i)));
    assert.equal(jar.length, 1, JSON.stringify(all));
    const [name, items] = jar[0];
    assert.match(name, /marinade/i);
    for (const food of [/black pepper/, /onion powder/, /kosher salt/, /lemon/, /olive oil/, /thyme/]) assert.ok(items.some((i) => food.test(i)), `${food} in ${items.join(" · ")}`);
    assert.ok(!all.some(([n]) => / citrus jar$/.test(n)), "no separate citrus jar");
  });

  it("the step that whisks the marinade is done in prep: Cook Mode collapses it (its oil's ref joins the jar's `|mix` measure)", () => {
    const covered = b.stepPlan.steps.flatMap((s) => (s.coversCookSteps ?? []).map((c) => `${c.dishId}#${c.stepIndex}`));
    assert.ok(covered.includes(`${uuid(11)}#1`), covered.join(" "));
  });

  it("the oil another dish heats in its pan stays off the list", () => {
    const oil = b.stepPlan.steps.filter((s) => !s.demoted).flatMap((s) => s.components.filter((c) => /olive oil/.test(c.ingredientName)).flatMap((c) => c.measures.map((m) => m.forDish)));
    assert.deepEqual(oil, ["Grilled Lemon Pepper Chicken Breasts"]);
  });
});

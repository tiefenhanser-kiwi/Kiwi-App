// SERVER-6 BUG-534 (server half) — a mix is made in a named bowl. The shapes are the
// served week's own (WEEK device · hh4-mixed and hh2 on dev, after the labels): the
// mix's dry step, a produce line into it, its "already in it" step, its storage line.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { PrepWeekResult } from "../ai/schemas/prepWeek";
import { mixBowlWording } from "../prepWeekLabels";

const KINDS = new Map([
  ["Skewers marinade", "mix"],
  ["Caesar sauce", "mix"],
  ["Poke marinade", "mix"],
  ["Poke marinade 2", "mix"],
  ["Lemon juice", "shared"],
  ["Tzatziki", "own"],
  ["Broccoli & garlic", "own"],
  ["Skewers plate", "plate"],
]);

const step = (stepKey: string, instructions: string, extra: Record<string, unknown> = {}) => ({
  number: 1, stepKey, title: stepKey, instructions, estimatedMinutes: 2, contributesToMealIds: ["m"], ...extra,
});
const week = (...phases: Array<ReturnType<typeof step>[]>) =>
  ({ phases: phases.map((steps, i) => ({ phase: ["dry", "produce", "sauces", "proteins"][i], title: "P", steps })) }) as unknown as PrepWeekResult;
const texts = (r: PrepWeekResult) => r.phases.flatMap((p) => p.steps.map((s) => s.instructions));

describe("mixBowlWording — BUG-534", () => {
  it("the first place a mix is named gets the bowl; every later one adds to it", () => {
    const out = mixBowlWording(
      week(
        [step("dry", "Into the Skewers marinade:\n1½ tsp dried oregano\nSet aside for the produce step.")],
        [
          step("lemons", "Zest the lemons, then juice them.\nInto the Skewers marinade: 3 tbsp lemon juice · 1 tsp lemon zest\nInto the Lemon juice tub: 1 tbsp for the Tzatziki\n2 tbsp lemon juice for Crisp Caesar Salad — into the Caesar sauce"),
          step("garlic", "4 cloves minced — into the Skewers marinade\n2 cloves minced — into the Tzatziki\n2 cloves thinly sliced — into the Broccoli & garlic container"),
        ],
        [
          step("sauce", "Skewers marinade (dried oregano and the lemon juice from produce step 2 already in it): add\n3 tbsp extra-virgin olive oil\nWhisk to combine."),
          step("caesar", "Caesar sauce (the lemon juice from produce step 2 already in it): add\n1 tsp dijon mustard"),
        ],
        [step("chicken", "Cut the chicken.", { storageNote: "Then into the Skewers marinade to marinate — covered in the fridge, cook within 1 day." })],
      ),
      KINDS,
    );
    assert.deepEqual(texts(out), [
      "Get a small bowl for the Skewers marinade. Into the bowl:\n1½ tsp dried oregano\nSet aside for the produce step.",
      "Zest the lemons, then juice them.\nInto the Skewers marinade bowl: 3 tbsp lemon juice · 1 tsp lemon zest\nInto the Lemon juice tub: 1 tbsp for the Tzatziki\n2 tbsp lemon juice for Crisp Caesar Salad — into a small bowl for the Caesar sauce",
      "4 cloves minced — into the Skewers marinade bowl\n2 cloves minced — into the Tzatziki\n2 cloves thinly sliced — into the Broccoli & garlic container",
      "Into the Skewers marinade bowl (dried oregano and the lemon juice from produce step 2 already in it), add:\n3 tbsp extra-virgin olive oil\nWhisk to combine.",
      "Into the Caesar sauce bowl (the lemon juice from produce step 2 already in it), add:\n1 tsp dijon mustard",
      "Cut the chicken.",
    ]);
    assert.equal(out.phases[3].steps[0].storageNote, "Then into the Skewers marinade bowl to marinate — covered in the fridge, cook within 1 day.");
  });

  it("a longer label is matched whole: 'Poke marinade 2' is not 'Poke marinade' + ' 2'", () => {
    const out = mixBowlWording(week([step("g", "1 tsp — into the Poke marinade 2\n1 tsp — into the Poke marinade\n1 tsp — into the Poke marinade 2")]), KINDS);
    assert.equal(texts(out)[0], "1 tsp — into a small bowl for the Poke marinade 2\n1 tsp — into a small bowl for the Poke marinade\n1 tsp — into the Poke marinade 2 bowl");
    // A label that is another one plus a word: only the longest-first order tells them apart.
    const verde = mixBowlWording(
      week([step("v", "1 clove — into the Tacos sauce verde\n1 clove — into the Tacos sauce")]),
      new Map([["Tacos sauce", "mix"], ["Tacos sauce verde", "mix"]]),
    );
    assert.equal(texts(verde)[0], "1 clove — into a small bowl for the Tacos sauce verde\n1 clove — into a small bowl for the Tacos sauce");
  });

  it("a step held for cook day is reworded but does not introduce the bowl", () => {
    const out = mixBowlWording(
      week([step("held", "Into the Caesar sauce:\n1 tsp dijon mustard", { skipSuggested: true }), step("next", "1 tbsp — into the Caesar sauce")]),
      KINDS,
    );
    assert.deepEqual(texts(out), ["Get a small bowl for the Caesar sauce. Into the bowl:\n1 tsp dijon mustard", "1 tbsp — into a small bowl for the Caesar sauce"]);
  });

  it("a field the longer words would push past 800 keeps its words", () => {
    const long = `Into the Caesar sauce:\n${"x".repeat(790)}`;
    assert.equal(texts(mixBowlWording(week([step("l", long)]), KINDS))[0], long);
  });

  // SERVER-7 E (BUG-554) — the shapes are dev's stored narrations.
  it("a produce sentence ending 'for the {label}' gets the bowl: first a small one, later the label's", () => {
    const kinds = new Map([["Tacos marinade", "mix"], ["Caesar sauce", "mix"], ["Poke marinade 2", "mix"], ["Poke marinade", "mix"], ["Meat spices", "mix"]]);
    const out = mixBowlWording(
      week(
        [step("dry", "Into the Tacos marinade:\n1 tsp ground cumin")],
        [
          step("orange", "Juice oranges to get 3 tbsp fresh orange juice for the Tacos marinade."),
          step("lemon", "Juice enough lemon to make 2 tbsp of fresh lemon juice for the Caesar sauce."),
          step("lemon2", "Squeeze 1 tbsp lemon juice for the Caesar sauce"),
          step("onion", "Thinly slice 4 green onions, keeping the whites and greens separate for the Poke marinade 2."),
        ],
      ),
      kinds,
    );
    assert.deepEqual(texts(out), [
      "Get a small bowl for the Tacos marinade. Into the bowl:\n1 tsp ground cumin",
      "Juice oranges to get 3 tbsp fresh orange juice — into the Tacos marinade bowl.",
      "Juice enough lemon to make 2 tbsp of fresh lemon juice — into a small bowl for the Caesar sauce.",
      "Squeeze 1 tbsp lemon juice — into the Caesar sauce bowl",
      "Thinly slice 4 green onions, keeping the whites and greens separate — into a small bowl for the Poke marinade 2.",
    ]);
  });

  it("'for the {label}' mid-sentence, or after a vessel's word, keeps its words", () => {
    const kinds = new Map([["Meat spices", "mix"], ["Tacos marinade", "mix"]]);
    const keep = [
      "Get a small container for the Meat spices and measure its spices into it:",
      "Get a small container ready for the Meat spices. Measure and combine:",
      "Get a small container or pinch bowl for the Meat spices.",
      "Juice 1 orange for the Tacos marinade and the salsa, then set it aside.",
      "Juice 1 orange for the Tacos marinades.",
    ];
    assert.deepEqual(texts(mixBowlWording(week(keep.map((t, i) => step(`k${i}`, t))), kinds)), keep);
  });

  it("no mix labels: the week is returned as it was", () => {
    const w = week([step("a", "Into the Lemon juice tub: 1 tbsp")]);
    assert.equal(mixBowlWording(w, new Map([["Lemon juice", "shared"]])), w);
  });
});

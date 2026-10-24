// PREP-3 3b (C) — Prep the Week's words, read on dump1-week-hh4-mixed-ticked: "4 cup for the
// Greek Salad" and "3 Romaine lettuces for the Crisp Caesar Salad" in one shared tub; a shared
// tub said by its own words, never its label ("for the shared finely chopped fresh flat-leaf
// parsley tub"); "Monday plate: Plate, wrapped, fridge, up to 2 days."; the label step in a
// skippable phase.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildPrepWeekPlan } from "../prepWeekBuild";
import { WEEK_LABEL_STEP_KEY } from "../prepWeekLabels";
import { fitNote } from "../prepStorage";
import { load, uuid, wire, type Meal } from "./fixtures/prep3Week";

const monday: Meal = {
  id: uuid(1), name: "Greek Night", day: "Monday", lag: 1,
  dishes: [{ id: uuid(11), name: "Greek Salad with Warm Pita",
    ings: [
      { id: uuid(101), name: "romaine lettuce", category: "Produce", quantity: 4, unit: "cup", note: "roughly chopped" },
      { id: uuid(102), name: "cherry tomatoes", category: "Produce", quantity: 1, unit: "cup", note: "halved" },
      { id: uuid(104), name: "ground cumin", category: "Pantry", quantity: 0.5, unit: "tsp" },
      { id: uuid(105), name: "smoked paprika", category: "Pantry", quantity: 0.5, unit: "tsp" },
      { id: uuid(106), name: "dried oregano", category: "Pantry", quantity: 1, unit: "tsp" },
    ],
    steps: [
      { i: 0, phase: "prep", text: "Roughly chop 4 cups romaine lettuce and halve 1 cup cherry tomatoes.", ids: [uuid(101), uuid(102)] },
      { i: 1, phase: "prep", text: "Stir together ½ teaspoon ground cumin, ½ teaspoon smoked paprika and 1 teaspoon dried oregano.", ids: [uuid(104), uuid(105), uuid(106)] },
      { i: 2, phase: "assemble", text: "Combine the romaine and cherry tomatoes and sprinkle with the spices.", ids: [] },
    ] }],
};
const thursday: Meal = {
  id: uuid(2), name: "Salmon Night", day: "Thursday", lag: 3,
  // (The group's id is the romaine's: the plan's identity folds the hearts into it.)
  dishes: [{ id: uuid(21), name: "Crisp Caesar Salad",
    ings: [{ id: uuid(101), name: "romaine lettuce hearts", category: "Produce", quantity: 3, unit: "each", note: "outer leaves removed, inner leaves torn or chopped" }],
    steps: [{ i: 0, phase: "prep", text: "Remove outer leaves from 3 romaine hearts, then tear the inner leaves.", ids: [uuid(101)] }] }],
};

describe("PREP-3 3b (C) — Prep the Week's words", () => {
  const r = wire(buildPrepWeekPlan(load([monday, thursday])));
  const steps = r.phases.flatMap((p) => p.steps);
  const text = steps.map((s) => `${s.instructions}\n${s.storageNote ?? ""}`).join("\n");

  it("a shared tub's line says \"4 cups\" and counts the Caesar's hearts by its own line", () => {
    assert.match(text, /^Into the Chopped romaine lettuce tub: 4 cups for the Greek Salad with Warm Pita · 3 romaine hearts for the Crisp Caesar Salad$/m);
  });

  it("every shared tub is said by its label: never \"one shared …\" or \"the shared … tub\"", () => {
    assert.doesNotMatch(text, /\bshared\b/i);
  });

  it("the label step opens Prep the Week, and its phase is not skippable", () => {
    const first = r.phases.find((p) => p.steps.length > 0)!;
    assert.equal(first.phase, "seasonings_dry");
    assert.equal(first.steps[0].stepKey, WEEK_LABEL_STEP_KEY);
    assert.equal(first.skippable, false);
    assert.equal(r.phases.find((p) => p.phase === "sauces_marinades")!.skippable, true);
  });

  it("a plate's compact storage line says the plate once: \"Monday plate: wrapped, in the fridge — up to 2 days.\"", () => {
    // (Over the note's 200 characters in full, so the compact forms are used.)
    const out = fitNote(["Monday tzatziki: Airtight in the fridge, with a barely damp paper towel — up to 3 days.", "Monday plate: Separate piles (cherry tomatoes, cucumber and red onion) on a small plate, under plastic wrap in the fridge — up to 2 days."]);
    assert.match(out, /Monday plate: wrapped, in the fridge — up to 2 days\./);
    assert.doesNotMatch(out, /Plate, wrapped/);
  });
});

// BUG-332 / D-WS9-288 — the house prompt's two new rules and the product-word
// clean-up that feeds it. Pure functions; no network, no prisma, no DB.
//
// These pin the SHAPE of the fix, not a wording. The two sentence tests match
// on the load-bearing phrases (the ones a careless reword would drop), not on
// the whole string — a prompt nobody may improve is worse than no test.
//
// Run via: pnpm --filter @workspace/api-server test

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildHousePrompt,
  cleanSubjectText,
  cleanSubjectTitle,
} from "../images/imageGenerator";

const subjectOf = (title: string, dishTitles: string[] = []) => ({
  mealId: "m-1",
  title,
  dishTitles,
});

describe("BUG-332 — the house prompt states the plated-meal rule", () => {
  const p = buildHousePrompt(subjectOf("Chicken Piccata", ["Chicken Piccata"]));

  it("says the picture IS the cooked, plated, ready-to-eat dish", () => {
    assert.match(p, /cooked through, plated and ready to eat/i);
    assert.match(p, /as a home cook would serve it/i);
  });

  it("says out loud what a brand or product word in a title means", () => {
    assert.match(p, /brand name or product word/i);
    assert.match(p, /WHAT KIND of dish/i);
  });

  it("still forbids the packaging, and now names the shapes it takes", () => {
    for (const w of ["packaging", "box", "bag", "can", "jar", "wrapper"]) {
      assert.match(p, new RegExp(`\\b${w}\\b`, "i"), `the rule sentence should name "${w}"`);
    }
    assert.match(p, /frozen or raw food/i);
  });

  it("keeps the pre-existing constraints — this is an addition, not a rewrite", () => {
    assert.match(p, /No text/i);
    assert.match(p, /no hands/i);
    assert.match(p, /no branding/i);
    assert.match(p, /three-quarter angle/i);
    assert.match(p, /natural daylight/i);
  });
});

describe("BUG-332 ruling 1b — the house prompt states the portion-and-scale rule", () => {
  const p = buildHousePrompt(
    subjectOf("Classic Herb Butter Roast Chicken with Roasted Potatoes", [
      "Classic Herb Butter Roast Chicken",
      "Garlicky Roasted Potatoes",
    ]),
  );

  it("asks for ONE serving at life-size scale", () => {
    assert.match(p, /ONE person's serving/);
    assert.match(p, /life-size scale/i);
  });

  it("asks for a whole item to be CARVED, and names the items it means", () => {
    assert.match(p, /\bCARVED\b/);
    for (const w of ["whole bird", "whole roast", "whole fish", "rack", "ham", "turkey", "loaf"]) {
      assert.match(p, new RegExp(w.replace(" ", "\\s+"), "i"), `the scale sentence should name "${w}"`);
    }
  });

  it("forbids the failure mode by name: the whole item shrunk to fit the plate", () => {
    assert.match(p, /never the whole item shrunk down to fit/i);
  });

  it("is present for every meal, not only the ones whose title names a roast", () => {
    const pizza = buildHousePrompt(subjectOf("Pepperoni Pizza", ["Pepperoni Pizza"]));
    assert.match(pizza, /ONE person's serving/);
    // Everything after the subject sentence is fixed — the pre-Block-1c
    // invariant, still true with two more sentences in the middle.
    assert.equal(
      pizza.split(". ").slice(1).join(". "),
      buildHousePrompt(subjectOf("Pho")).split(". ").slice(1).join(". "),
    );
  });
});

describe("BUG-332 — the product-word clean-up", () => {
  // The table. Left column is what the user typed; right is what the MODEL is
  // shown. Nothing here is ever written back to Meal.title (see the last block).
  const STRIPPED: Array<[string, string]> = [
    ["Frozen Cheese Pizza", "Cheese Pizza"],
    ["Boxed Mac and Cheese", "Mac and Cheese"],
    ["Canned Tuna Salad Sandwich", "Tuna Salad Sandwich"],
    ["Tinned Sardines on Toast", "Sardines on Toast"],
    ["Jarred Alfredo Pasta", "Alfredo Pasta"],
    ["Bagged Salad Kit", "Salad"],
    ["Store-Bought Rotisserie Chicken", "Rotisserie Chicken"],
    ["store bought pie crust", "pie crust"],
    ["Pre-Made Pizza Dough", "Pizza Dough"],
    ["Ready-Made Pie Crust", "Pie Crust"],
    ["Packaged Ramen", "Ramen"],
    ["Near East Rice Pilaf Mix", "Near East Rice Pilaf"],
    ["Taco Kit", "Taco"],
    // Two product words in a row — the strip repeats.
    ["Frozen Boxed Lasagna", "Lasagna"],
  ];

  for (const [raw, want] of STRIPPED) {
    it(`strips: ${JSON.stringify(raw)} → ${JSON.stringify(want)}`, () => {
      assert.equal(cleanSubjectText(raw), want);
    });
  }

  // The keep-list. Here the word IS the dish, or belongs to an appliance.
  const KEPT = [
    "Frozen Yogurt",
    "Frozen Yogurt with Berries",
    "Frozen Custard",
    "Frozen Margarita",
    "Frozen Lemonade",
    "Frozen Smoothie Bowl",
    "Instant Pot Beef Chili",
    "Instant Pot Carnitas",
  ];
  for (const raw of KEPT) {
    it(`keeps: ${JSON.stringify(raw)} — the word is the dish, not the packaging`, () => {
      assert.equal(cleanSubjectText(raw), raw);
    });
  }

  // Brands pass through untouched. They are unbounded, so they are the prompt
  // sentence's job — the list must not grow a brand column.
  const BRANDS = [
    "Near East Rice Pilaf",
    "Stouffer's Lasagna",
    "Kraft Macaroni and Cheese",
    "Taco Bell-Style Ground Beef Tacos",
    "Ben and Jerry Sundae",
  ];
  for (const raw of BRANDS) {
    it(`passes a brand through untouched: ${JSON.stringify(raw)}`, () => {
      assert.equal(cleanSubjectTitle(raw), raw);
    });
  }

  it("runs per SEGMENT, not only on the head of the title", () => {
    assert.equal(
      cleanSubjectTitle("Grilled Chicken Breast with Frozen Fries and Canned Corn"),
      "Grilled Chicken Breast with Fries and Corn",
    );
    assert.equal(
      cleanSubjectTitle("Frozen Cheese Pizza with Caesar Salad"),
      "Cheese Pizza with Caesar Salad",
    );
    // …and the keep-list survives being in a later segment.
    assert.equal(
      cleanSubjectTitle("Grilled Chicken with Frozen Yogurt"),
      "Grilled Chicken with Frozen Yogurt",
    );
  });

  it("a title that is NOTHING but a product word keeps its own text", () => {
    // An empty subject line would be worse than a literal one.
    assert.equal(cleanSubjectText("Mix"), "Mix");
    assert.equal(cleanSubjectText("Frozen"), "Frozen");
  });

  it("a title with no product word is byte-identical — the control", () => {
    const raw = "Sausage and Kale Orecchiette with Crusty Bread";
    assert.equal(cleanSubjectTitle(raw), raw);
  });

  it("🔴 DERIVED, NEVER STORED — the clean-up only reaches the prompt", () => {
    // The guard for D break 1. buildHousePrompt takes a subject and returns a
    // string; it has no way to write, and the subject object it is handed must
    // come back untouched. If someone ever "fixes" the title at the source,
    // this fails and the grocery list, the plan and the Cookbook are spared.
    const subject = subjectOf("Frozen Cheese Pizza with Caesar Salad", [
      "Frozen Cheese Pizza",
      "Caesar Salad",
    ]);
    const before = JSON.stringify(subject);
    const prompt = buildHousePrompt(subject);

    assert.equal(JSON.stringify(subject), before, "buildHousePrompt mutated its subject");
    assert.equal(subject.title, "Frozen Cheese Pizza with Caesar Salad");
    assert.deepEqual(subject.dishTitles, ["Frozen Cheese Pizza", "Caesar Salad"]);
    // …and the cleaned form is what reached the model.
    assert.match(prompt, /Cheese Pizza with Caesar Salad/);
    assert.doesNotMatch(prompt, /Frozen Cheese Pizza/);
  });
});

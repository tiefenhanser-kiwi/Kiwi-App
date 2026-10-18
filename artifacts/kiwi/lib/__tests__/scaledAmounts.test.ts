// FIX-7 (BUG-437) — a scaled amount is one a cook can measure.
//
// Recipes are written for 4. At household 2, FIX-4's bulk check (22 plans, 110
// meals) found "½ Large eggs", "½ egg yolks", "1½ Large eggs", "⅜ teaspoon"
// salt and pepper, and eighth-pound weights in saved plans. The rule lives in
// lib/format/quantity.ts (displayedQuantity) and reaches the ingredient line,
// the meal's Ingredients sheet and the step text's amount spans.
//
// Every expected value below is a LITERAL, written from the rule rather than
// read back from the code under test. Display only: catalog data and the
// grocery list are not touched (the grocery list never calls these).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatIngredientLine } from "../format/ingredientLine";
import { buildAmountRefSegments } from "../cooking/amountSegments";
import { consolidateMealIngredients } from "../meals/consolidateMealIngredients";

type Row = [name: string, quantity: number, unit: string, multiplier: number, expected: string];

const line = ([name, quantity, unit, multiplier]: Row) =>
  formatIngredientLine({ name, quantity, unit }, { multiplier });

function table(rows: Row[]) {
  for (const row of rows) assert.equal(line(row), row[4], `${row[1]} ${row[2]} ${row[0]} × ${row[3]}`);
}

describe("BUG-437 — the ten worst lines from FIX-4's check, household 2", () => {
  it("each reads as an amount a cook can measure", () => {
    table([
      ["Large eggs", 1, "each", 0.5, "1 Large egg"], // was "½ Large eggs" (Quick Beef Chili, both meatball dishes)
      ["egg yolks", 1, "each", 0.5, "1 egg yolk"], // was "½ egg yolks" (Caesar Salad)
      ["Large eggs", 3, "each", 0.5, "2 Large eggs"], // was "1½ Large eggs" (Chicken Fried Rice)
      ["Kosher salt", 0.75, "teaspoon", 0.5, "½ teaspoon Kosher salt"], // was "⅜ teaspoon"
      ["Black pepper", 0.75, "teaspoon", 0.5, "½ teaspoon Black pepper"], // was "⅜ teaspoon"
      ["Kosher salt", 1.25, "teaspoon", 0.5, "¾ teaspoon Kosher salt"], // was "⅝ teaspoon"
      ["ground beef (80/20)", 1.25, "pound", 0.5, "¾ pound ground beef (80/20)"], // was "⅝ pound"
      ["ground beef (80/20)", 0.75, "pound", 0.5, "½ pound ground beef (80/20)"], // was "⅜ pound"
      ["low-sodium chicken broth", 2.75, "cup", 0.5, "1⅓ cups low-sodium chicken broth"], // was "1⅜ cups"
      ["whole chicken", 4, "pound", 0.5, "4 pounds whole chicken"], // was "2 pounds"
    ]);
  });
});

describe("BUG-437 rule 1 — a whole counted item rounds UP", () => {
  it("eggs, yolks and the other whole items, by name, on a count unit", () => {
    table([
      ["Large eggs", 1, "each", 0.75, "1 Large egg"],
      ["egg", 1, "", 0.5, "1 egg"],
      ["large egg yolks", 3, "each", 0.5, "2 large egg yolks"],
      ["egg", 1, "large", 0.5, "1 large egg"],
      ["garlic cloves", 3, "each", 0.5, "2 garlic cloves"],
      ["corn tortillas", 9, "each", 0.5, "5 corn tortillas"],
      ["bay leaves", 1, "each", 0.5, "1 bay leaf"],
      ["lasagna noodles", 9, "each", 0.5, "5 lasagna noodles"],
      ["boneless skinless chicken breasts", 3, "each", 0.5, "2 boneless skinless chicken breasts"],
      ["rotisserie chicken", 1, "each", 0.5, "1 rotisserie chicken"],
      ["whole chicken", 1, "each", 0.5, "1 whole chicken"],
    ]);
  });

  it("by unit word: clove, slice, sprig, leaf, strip — including the plural a step authors", () => {
    table([
      ["garlic", 3, "clove", 0.5, "2 cloves garlic"],
      ["garlic", 3, "cloves", 0.5, "2 cloves garlic"],
      ["thick-cut bacon", 3, "slice", 0.5, "2 slices thick-cut bacon"],
      ["fresh rosemary", 1, "sprig", 0.5, "1 sprig fresh rosemary"],
      ["fresh thyme", 3, "sprig", 0.5, "2 sprigs fresh thyme"],
      ["fresh basil", 1, "leaf", 0.5, "1 leaf fresh basil"],
    ]);
  });

  it("produce that halves cleanly still halves — the catalog authors ½ onion at household 4", () => {
    table([
      ["yellow onion", 1, "each", 0.5, "½ yellow onion"],
      ["lemon", 1, "each", 0.5, "½ lemon"],
      ["english cucumber", 1, "each", 0.5, "½ english cucumber"],
      ["eggplant", 1, "each", 0.5, "½ eggplant"], // not an egg
      ["green cabbage", 0.5, "head", 0.5, "¼ head green cabbage"],
    ]);
  });
});

describe("BUG-437 rule 2 — spoons snap to ⅛ ¼ ½ ¾, cups to ⅛ ¼ ⅓ ½ ⅔ ¾, never 0", () => {
  it("spoons", () => {
    table([
      ["cayenne pepper", 0.125, "teaspoon", 0.5, "⅛ teaspoon cayenne pepper"], // 1/16 → the ⅛ floor
      ["ground cumin", 0.25, "teaspoon", 0.75, "¼ teaspoon ground cumin"], // 3/16 is a tie → up
      ["soy sauce", 1, "tablespoon", 0.75, "¾ tablespoon soy sauce"],
      ["unsalted butter", 4.75, "tablespoon", 0.5, "2½ tablespoons unsalted butter"], // 2⅜ is a tie between ¼ and ½ → up
      ["ground cloves", 0.01, "teaspoon", 1, "⅛ teaspoon ground cloves"], // was "0.00 teaspoon"
      ["dried oregano", 0.75, "tsp", 0.5, "½ tsp dried oregano"],
    ]);
  });

  it("cups", () => {
    table([
      ["olive oil", 0.25, "cup", 0.5, "⅛ cup olive oil"],
      ["heavy cream", 0.75, "cup", 0.5, "⅓ cup heavy cream"],
      ["water", 1.75, "cup", 0.5, "1 cup water"], // ⅞ is a tie between ¾ and 1 → up
      ["whole milk", 1 / 3, "cup", 0.5, "⅛ cup whole milk"], // ⅙ is nearer ⅛ than ¼
      ["sour cream", 1.25, "cup", 0.5, "⅔ cup sour cream"],
    ]);
  });
});

describe("BUG-437 rule 3 — pounds in ¼ lb steps, nearest, ties up, never below ¼", () => {
  it("meat, fish and produce alike", () => {
    table([
      ["ground pork", 0.25, "pound", 0.5, "¼ pound ground pork"], // ⅛ → the ¼ floor
      ["beef chuck", 1.75, "pound", 0.5, "1 pound beef chuck"],
      ["ground beef (80/20)", 1.5, "pound", 0.75, "1¼ pounds ground beef (80/20)"], // 1⅛ tie → up
      ["skirt steak", 1.5, "pound", 0.5, "¾ pound skirt steak"],
      ["broccoli florets", 1.25, "pound", 0.5, "¾ pound broccoli florets"],
      ["large shrimp", 1.5, "lb", 0.5, "¾ lb large shrimp"],
    ]);
  });
});

describe("BUG-437 rule 4 — a whole bird is never halved by weight", () => {
  it("shows the recipe's own weight below 1×, and scales up as before", () => {
    table([
      ["whole turkey", 14, "pound", 0.2, "14 pounds whole turkey"], // a 10-serving feast at household 2
      ["whole chicken", 3.5, "pound", 0.5, "3½ pounds whole chicken"],
      ["whole chicken", 4, "pound", 1.5, "6 pounds whole chicken"],
      ["boneless skinless chicken thighs", 2, "pound", 0.5, "1 pound boneless skinless chicken thighs"], // not a bird
    ]);
  });

  it("the meal's Ingredients sheet applies it too (it scales before the line formats)", () => {
    const meal = {
      dishes: [
        { title: "Roast Chicken", ingredients: [{ name: "whole chicken", quantity: 4, unit: "pound" }, { name: "Large eggs", quantity: 1, unit: "each" }] },
      ],
    } as unknown as Parameters<typeof consolidateMealIngredients>[0];
    assert.deepEqual(consolidateMealIngredients(meal, 0.5).map((c) => c.line), ["4 pounds whole chicken", "1 Large egg"]);
  });
});

describe("BUG-437 — household 4 on a 4-serving recipe is unchanged", () => {
  it("the authored amounts the catalog actually carries", () => {
    table([
      ["Large eggs", 1, "each", 1, "1 Large egg"],
      ["Large eggs", 3, "each", 1, "3 Large eggs"],
      ["Kosher salt", 0.75, "teaspoon", 1, "¾ teaspoon Kosher salt"],
      ["cayenne pepper", 0.125, "teaspoon", 1, "⅛ teaspoon cayenne pepper"],
      ["whole milk", 0.33, "cup", 1, "⅓ cup whole milk"],
      ["flour", 2.125, "cup", 1, "2⅛ cups flour"],
      ["ground beef (80/20)", 1.25, "pound", 1, "1¼ pounds ground beef (80/20)"],
      ["whole chicken", 4, "pound", 1, "4 pounds whole chicken"],
      ["yellow onion", 0.5, "each", 1, "½ yellow onion"],
      ["garlic cloves", 5, "each", 1, "5 garlic cloves"],
      ["fresh cranberries", 24, "ounce", 1, "24 ounces fresh cranberries"],
    ]);
  });

  it("ounces keep their eighths at any household (the rule does not reach them)", () => {
    table([["fresh cranberries", 24, "ounce", 0.8, "19¼ ounces fresh cranberries"]]);
  });
});

// ── The step text's amount spans agree with the ingredient line ─────────────
//
// buildAmountRefSegments renders each span through the same formatQuantity. The
// ref carries no ingredient name, so the words after the span stand in for it.
function stepAmount(text: string, span: string, quantity: number, unit: string, multiplier: number): string {
  const charStart = text.indexOf(span);
  const ref = { ingredientId: "i", quantity, unit, charStart, charEnd: charStart + span.length };
  return buildAmountRefSegments(text, [ref], multiplier).find((s) => s.isRef)!.text;
}

describe("BUG-437 — step amounts match the ingredient line", () => {
  it("the same amounts, from the step text", () => {
    assert.equal(stepAmount("Lightly beat 3 large eggs in a small bowl.", "3", 3, "", 0.5), "2");
    assert.equal(stepAmount("Whisk 1 egg yolk, 1 teaspoon Dijon mustard and the lemon juice.", "1", 1, "", 0.5), "1");
    assert.equal(stepAmount("Add ¾ teaspoon kosher salt and stir.", "¾ teaspoon", 0.75, "teaspoon", 0.5), "½ teaspoon");
    assert.equal(stepAmount("Add the 1¼ pounds ground beef and break it up.", "1¼ pounds", 1.25, "pounds", 0.5), "¾ pound");
    assert.equal(stepAmount("Pat the 1¾ lb beef chuck cubes dry.", "1¾ lb", 1.75, "lb", 0.5), "1 lb");
    assert.equal(stepAmount("Pour in 2¾ cups low-sodium chicken broth.", "2¾ cups", 2.75, "cups", 0.5), "1⅓ cups");
    assert.equal(stepAmount("Mince 3 cloves garlic and set aside.", "3 cloves", 3, "cloves", 0.5), "2 cloves");
    assert.equal(stepAmount("Pat the 4-pound whole chicken completely dry.", "4", 4, "", 0.5), "4");
    assert.equal(stepAmount("Season the 4 pound whole chicken all over.", "4 pound", 4, "pound", 0.5), "4 pounds");
  });

  it("…and each agrees with the line for the same ingredient", () => {
    const pairs: [string, string][] = [
      [line(["Large eggs", 3, "each", 0.5, ""]), stepAmount("Lightly beat 3 large eggs in a small bowl.", "3", 3, "", 0.5)],
      [line(["Kosher salt", 0.75, "teaspoon", 0.5, ""]), stepAmount("Add ¾ teaspoon kosher salt.", "¾ teaspoon", 0.75, "teaspoon", 0.5)],
      [line(["ground beef (80/20)", 1.25, "pound", 0.5, ""]), stepAmount("Add the 1¼ pounds ground beef.", "1¼ pounds", 1.25, "pounds", 0.5)],
      [line(["whole chicken", 4, "pound", 0.5, ""]), stepAmount("Season the 4 pound whole chicken.", "4 pound", 4, "pound", 0.5)],
    ];
    for (const [l, s] of pairs) assert.ok(l.startsWith(s), `line "${l}" vs step "${s}"`);
  });

  it("the name window stops at the clause: what peppers are cut into is not the peppers", () => {
    assert.equal(stepAmount("Cut 3 bell peppers into strips.", "3", 3, "", 0.5), "1½");
    assert.equal(stepAmount("Add 1 egg, 2 minced onions and the milk.", "2", 2, "", 0.25), "½");
  });

  it("a per-item amount ('1 slice on each') no longer halves to ½ slice", () => {
    assert.equal(stepAmount("Lay 1 slice of Swiss cheese on each patty.", "1 slice", 1, "slice", 0.5), "1 slice");
  });

  it("a step unit that lands on 1 is singular — the ref carries 'pounds' as authored", () => {
    assert.equal(stepAmount("Pat the 2 pounds of chicken breasts dry.", "2 pounds", 2, "pounds", 0.5), "1 pound");
    assert.equal(stepAmount("Add 2 cups water.", "2 cups", 2, "cups", 0.5), "1 cup");
    assert.equal(stepAmount("Add 4 cups water.", "4 cups", 4, "cups", 0.5), "2 cups");
  });
});

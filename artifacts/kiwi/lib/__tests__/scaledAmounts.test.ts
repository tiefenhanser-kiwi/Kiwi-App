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

import { formatIngredientLine, ingredientAmountNote } from "../format/ingredientLine";
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
      ["whole chicken", 4, "pound", 0.5, "3 pounds whole chicken"], // was "2 pounds"; FIX-7 held 4, WEB-4 floors at 3
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

describe("BUG-437 rule 4 + BUG-453 — a whole bird scales down only to the smallest one sold", () => {
  it("floors by kind, never above the recipe's own weight, and scales up as before", () => {
    table([
      ["whole turkey", 14, "pound", 0.2, "10 pounds whole turkey"], // a 10-serving feast at household 2 (FIX-7: 14)
      ["whole turkey", 14, "pound", 0.4, "10 pounds whole turkey"], // Hans's case: 4 people (5.6 lb → the 10 lb floor)
      ["whole turkey", 14, "pound", 0.8, "11¼ pounds whole turkey"], // 8 people: 11.2, above the floor
      ["whole turkey", 14, "pound", 3, "42 pounds whole turkey"], // 30 people: up, as before
      ["whole chicken", 3.5, "pound", 0.5, "3 pounds whole chicken"],
      ["whole chicken", 2.5, "pound", 0.5, "2½ pounds whole chicken"], // already under the floor: the recipe's own weight
      ["whole chicken", 4, "pound", 1.5, "6 pounds whole chicken"],
      ["whole chicken", 64, "ounce", 0.5, "48 ounces whole chicken"], // 3 lb, in the line's own unit
      ["whole duck", 5, "pound", 0.5, "4 pounds whole duck"],
      ["cornish hens", 2, "pound", 0.25, "1 pound cornish hens"],
      ["whole bird", 5, "pound", 0.5, "5 pounds whole bird"], // no known kind: FIX-7's rule
      ["boneless skinless chicken thighs", 2, "pound", 0.5, "1 pound boneless skinless chicken thighs"], // not a bird
    ]);
  });

  it("the meal's Ingredients sheet applies it too (it scales before the line formats)", () => {
    const meal = {
      dishes: [
        { title: "Roast Chicken", ingredients: [{ name: "whole chicken", quantity: 4, unit: "pound" }, { name: "Large eggs", quantity: 1, unit: "each" }] },
      ],
    } as unknown as Parameters<typeof consolidateMealIngredients>[0];
    assert.deepEqual(consolidateMealIngredients(meal, 0.5).map((c) => c.line), ["3 pounds whole chicken", "1 Large egg"]);
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
    assert.equal(stepAmount("Pat the 4-pound whole chicken completely dry.", "4", 4, "", 0.5), "3");
    assert.equal(stepAmount("Season the 4 pound whole chicken all over.", "4 pound", 4, "pound", 0.5), "3 pounds");
    // BUG-453 — "the 3-pound chicken" (no "whole") is a whole bird too, rounded as a weight.
    assert.equal(stepAmount("Pat the 3-pound chicken completely dry.", "3", 3, "", 0.5), "3");
    assert.equal(stepAmount("Rub the 14-pound turkey with the butter.", "14", 14, "", 0.4), "10");
    assert.equal(stepAmount("Pat the 4-pound whole chicken completely dry.", "4", 4, "", 1.3), "5¼");
    // …but a cut of one is not.
    assert.equal(stepAmount("Pat the 2-pound chicken thighs dry.", "2", 2, "", 0.5), "1");
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

// ── WEB-4 — eggs to the NEAREST whole (Hans, October 19) ───────────────────

describe("WEB-4 — eggs, yolks and whites round to the nearest whole, halves up, never below 1", () => {
  it("replaces FIX-7's round-up for eggs only", () => {
    table([
      ["Large eggs", 3, "each", 0.4, "1 Large egg"], // 1.2 — FIX-7 showed 2
      ["egg yolks", 3, "each", 0.75, "2 egg yolks"], // 2.25 — FIX-7 showed 3
      ["Large eggs", 2, "each", 0.75, "2 Large eggs"], // 1.5 — a half rounds up
      ["Large eggs", 5, "each", 0.75, "4 Large eggs"], // 3.75
      ["egg whites", 1, "each", 0.25, "1 egg white"], // 0.25 — never below 1
      ["Large eggs", 1, "each", 0.5, "1 Large egg"], // 0.5 — half up, and the floor
      ["egg", 1, "large", 3, "3 large eggs"],
    ]);
  });

  it("every other counted item keeps FIX-7's ceiling", () => {
    table([
      ["corn tortillas", 9, "each", 0.4, "4 corn tortillas"], // 3.6 → 4
      ["garlic cloves", 5, "each", 0.45, "3 garlic cloves"], // 2.25 → 3, not 2
      ["bay leaves", 3, "each", 0.4, "2 bay leaves"], // 1.2 → 2
    ]);
  });

  it("ingredient lists add the true amount as a note when it differs — eggs only", () => {
    const egg = (quantity: number) => ({ name: "large egg", quantity, unit: "each" });
    assert.equal(ingredientAmountNote(egg(3), { multiplier: 0.25, servings: 1 }), "recipe calls for ¾ at 1 serving");
    assert.equal(ingredientAmountNote(egg(3), { multiplier: 0.5, servings: 2 }), "recipe calls for 1½ at 2 servings");
    assert.equal(ingredientAmountNote(egg(1), { multiplier: 0.75 }), "recipe calls for ¾");
    assert.equal(ingredientAmountNote(egg(2), { multiplier: 0.5, servings: 2 }), null, "1 exactly: nothing rounded");
    assert.equal(ingredientAmountNote(egg(3), { multiplier: 1, servings: 4 }), null, "the recipe's own amount");
    assert.equal(ingredientAmountNote({ name: "corn tortillas", quantity: 9, unit: "each" }, { multiplier: 0.4 }), null);
    assert.equal(ingredientAmountNote({ name: "egg whites", quantity: 1, unit: "cup" }, { multiplier: 0.5 }), null, "a measure, not a count");
  });

  it("the Ingredients sheet carries the note; steps and Cook Mode print the whole number only", () => {
    const meal = {
      dishes: [{ title: "Frittata", ingredients: [{ name: "Large eggs", quantity: 3, unit: "each" }] }],
    } as unknown as Parameters<typeof consolidateMealIngredients>[0];
    const [row] = consolidateMealIngredients(meal, 0.25, 1);
    assert.equal(row.line, "1 Large egg");
    assert.equal(row.note, "recipe calls for ¾ at 1 serving");
    const segs = buildAmountRefSegments("Whisk 3 large eggs.", [{ ingredientId: "i", quantity: 3, unit: "", charStart: 6, charEnd: 7 }], 0.25);
    assert.deepEqual(segs.map((x) => x.text), ["Whisk ", "1", " large eggs."]);
  });
});

// ── WEB-4 (BUG-443, BUG-450) — step amounts that are not quantities ────────

describe("BUG-443 — package sizes and durations in a step never scale", () => {
  it("a hyphenated size of a can, a fillet or a pot prints as written", () => {
    assert.equal(stepAmount("Stir in the 28-oz can of crushed tomatoes.", "28", 28, "", 0.5), "28");
    assert.equal(stepAmount("Crush the two 28-oz cans of whole San Marzano tomatoes.", "28", 28, "", 0.5), "28");
    assert.equal(stepAmount("Pat the 6-oz salmon fillets dry.", "6", 6, "", 0.5), "6");
    assert.equal(stepAmount("Add the 15-ounce can of black beans.", "15", 15, "", 2), "15");
    assert.equal(stepAmount("Heat the oil in a 6-quart saucepan over medium-high heat.", "6", 6, "", 0.5), "6");
  });

  it("a piece bought by its own weight still scales, so the step agrees with its line", () => {
    assert.equal(stepAmount("Pat the 3-pound chuck roast completely dry.", "3", 3, "", 0.5), "1½");
    assert.equal(stepAmount("Season the 4-pound pork shoulder all over.", "4", 4, "", 0.5), "2");
    // A cut sized in POUNDS is the whole amount (one steak); in ounces it is a piece.
    assert.equal(stepAmount("Pat the 1¾-pound flank steak dry.", "1¾", 1.75, "", 0.5), "⅞");
    assert.equal(stepAmount("Sear the 6-oz ribeye steaks.", "6", 6, "", 0.5), "6");
  });

  it("a beer is a package too (beer-can chicken's '12-ounce lager')", () => {
    assert.equal(stepAmount("Open the 12-ounce lager and drink or pour out half.", "12", 12, "", 0.5), "12");
  });

  it("a duration never scales — BUG-450's 'keeps up to 1⅝ days' is this class", () => {
    assert.equal(stepAmount("Cook for 1½ minutes, stirring.", "1½ minutes", 1.5, "minutes", 0.5), "1½ minutes");
    assert.equal(stepAmount("Braise for 3½ hours.", "3½ hours", 3.5, "hours", 2), "3½ hours");
    assert.equal(stepAmount("The pie keeps up to 3¼ days, covered, in the fridge.", "3¼ days", 3.25, "days", 0.5), "3¼ days");
    assert.equal(stepAmount("Make the dough 2 days ahead.", "2", 2, "", 0.5), "2");
  });

  it("a real amount beside them still scales", () => {
    assert.equal(stepAmount("Add 2 cups water to the 6-quart pot.", "2 cups", 2, "cups", 0.5), "1 cup");
  });
});

// ── WEB-4b (BUG-458) — a pinch, a dash and a cinnamon stick are whole ──────
//
// The feast at household 8 printed "¾ pinch" salt and "¾ cinnamon stick". The
// server's prep text already prints these whole (api-server lib/prepQuantity.ts):
// the NEAREST whole number, halves up, never below 1. The client uses the same
// rule, token for token, so a step and its prep line agree.

describe("BUG-458 — pinch, dash and stick print as whole numbers", () => {
  it("the nearest whole, halves up, never below 1", () => {
    table([
      ["salt", 1, "pinch", 0.8, "1 pinch salt"], // was "¾ pinch salt"
      ["ground nutmeg", 1, "pinch", 0.4, "1 pinch ground nutmeg"], // was "⅜ pinch"
      ["kosher salt", 1, "pinch", 2.5, "3 pinches kosher salt"], // a half rounds up
      ["salt", 1, "pinch", 1.2, "1 pinch salt"], // nearest — the server's rule
      ["salt", 2, "pinches", 0.5, "1 pinch salt"],
      ["hot sauce", 1, "dash", 0.5, "1 dash hot sauce"], // was "½ dash"
      ["cinnamon stick", 1, "each", 0.8, "1 cinnamon stick"], // was "¾ cinnamon stick"
      ["cinnamon sticks", 2, "each", 0.75, "2 cinnamon sticks"], // 1.5 → 2
      ["vanilla bean", 1, "each", 0.4, "1 vanilla bean"],
      ["cinnamon stick", 1, "each", 1, "1 cinnamon stick"], // the authored amount
    ]);
  });

  it("a stick of BUTTER is a measure, and ½ stick stays", () => {
    table([["unsalted butter", 1, "stick", 0.5, "½ stick unsalted butter"]]);
  });

  it("…and the step agrees", () => {
    assert.equal(stepAmount("Add 1 cinnamon stick to the pot.", "1", 1, "", 0.8), "1");
    assert.equal(stepAmount("Season with 1 pinch salt.", "1 pinch", 1, "pinch", 0.8), "1 pinch");
    assert.equal(stepAmount("Add 1 dash hot sauce.", "1 dash", 1, "dash", 0.5), "1 dash");
  });
});

describe("BUG-443 — a size word stored as the unit counts the name", () => {
  it("'2 large egg' becomes '2 large eggs'", () => {
    table([
      ["egg", 2, "large", 1, "2 large eggs"],
      ["egg", 1, "large", 1, "1 large egg"],
      ["sweet potatoes", 2, "medium", 1, "2 medium sweet potatoes"],
      ["white onion", 1, "large", 1, "1 large white onion"],
    ]);
  });
});

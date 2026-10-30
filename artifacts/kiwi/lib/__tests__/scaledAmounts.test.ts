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

  // WEB-4d (R5) — a SCALED ounce is whole from 4 oz now (was "19¼"); at its own
  // servings it is as written (the row above).
  it("a scaled ounce from 4 oz is whole", () => {
    table([["fresh cranberries", 24, "ounce", 0.8, "19 ounces fresh cranberries"]]);
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
      ["thick-cut bacon", 3, "slice", 0.4, "2 slices thick-cut bacon"], // 1.2 → 2 (WEB-4d: bay leaves are nearest now)
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
    // CLIENT-8 B (BUG-618) — and the noun after it is said for the 1.
    assert.deepEqual(segs.map((x) => x.text), ["Whisk ", "1", " large egg."]);
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

// ── WEB-4c (BUG-464) — equipment, stalks and ribs, star anise ──────────────
//
// Equipment never scales: as written, never below 1 (in a dish with a bird by
// count, one per bird — birdRule.test.ts). Skewers and toothpicks are one per
// piece of food and follow it (rule 1) — refused from the prompt's list, with
// the catalog measure in lib/format/quantity.ts. A stalk or a rib prints whole: the
// pinch rule (nearest, halves up, never below 1), by the unit or by the name on
// a count unit. "star anise" is its own plural.

describe("BUG-464 — equipment never scales", () => {
  it("as written, at any size, never below 1", () => {
    table([
      ["large brining bag", 1, "each", 0.4, "1 large brining bag"], // was "⅜ large brining bag"
      ["large brining bag", 1, "each", 2, "1 large brining bag"], // was "2 large brining bags"
      ["aluminum foil", 1, "sheet", 0.5, "1 sheet aluminum foil"], // was "½ sheet"
      ["parchment paper", 1, "sheet", 0.4, "1 sheet parchment paper"], // was "⅜ sheet"
      ["kitchen twine", 0.5, "each", 1, "1 kitchen twine"], // never below 1
      ["cheesecloth", 1, "each", 3, "1 cheesecloth"],
      ["gallon-size zip-top bag", 1, "each", 0.5, "1 gallon-size zip-top bag"], // the server's tokens
      ["turkey-size oven bag", 1, "each", 2, "1 turkey-size oven bag"],
    ]);
  });

  it("skewers and toothpicks are one per piece: they follow the food, whole", () => {
    table([
      ["wooden skewers", 8, "each", 0.5, "4 wooden skewers"],
      ["wooden or metal skewers", 8, "each", 2, "16 wooden or metal skewers"], // 2 lb shrimp, 4–5 per skewer
      ["toothpicks", 4, "each", 0.3, "2 toothpicks"], // 1.2 → 2, rule 1's ceiling
      ["toothpicks or kitchen twine", 8, "each", 0.5, "4 toothpicks or kitchen twine"], // was "…kitchen twines"
    ]);
  });

  it("…and the step agrees; food wrapped in foil is still food", () => {
    assert.equal(stepAmount("Seal the turkey in 1 large brining bag.", "1", 1, "", 0.4), "1");
    assert.equal(stepAmount("Lay 1 sheet parchment paper on the tray.", "1 sheet", 1, "sheet", 2), "1 sheet");
    assert.equal(stepAmount("Thread the shrimp onto 8 skewers.", "8", 8, "", 2), "16");
    assert.equal(stepAmount("Wrap 8 flour tortillas in foil and warm.", "8", 8, "", 0.5), "4");
    assert.equal(stepAmount("Roast 2 garlic cloves on a foil-lined sheet.", "2", 2, "", 0.5), "1");
  });
});

describe("BUG-464 — a stalk or a rib prints whole", () => {
  it("the nearest whole, halves up, never below 1", () => {
    table([
      ["celery", 2, "stalk", 0.4, "1 stalk celery"], // was "¾ stalk celery"
      ["celery", 6, "stalk", 0.8, "5 stalks celery"], // was "4¾ stalks celery"
      ["celery", 2, "stalk", 1.25, "3 stalks celery"], // 2.5, a half rounds up; was "2½"
      ["celery", 2, "stalk", 0.6, "1 stalk celery"], // 1.2, nearest
      ["celery", 1, "rib", 0.4, "1 rib celery"],
      ["lemongrass", 3, "stalks", 0.5, "2 stalks lemongrass"], // was "1½ stalks"
      ["celery stalks", 3, "each", 0.5, "2 celery stalks"], // by name on a count unit; was "1½"
      ["lemongrass stalk", 1, "each", 0.5, "1 lemongrass stalk"], // was "½ lemongrass stalk"
      ["celery stalks, diced", 2, "each", 0.75, "2 celery stalks, diced"], // was "1½"
    ]);
  });

  it("a rib CHOP and ribs by weight are not stalks", () => {
    table([
      ["bone-in pork rib chops", 3, "each", 0.4, "2 bone-in pork rib chops"], // rule 1 ceils 1.2
      ["baby back pork ribs", 3, "pound", 0.5, "1½ pounds baby back pork ribs"],
    ]);
  });

  it("…and the step agrees", () => {
    assert.equal(stepAmount("Dice 2 stalks of celery.", "2", 2, "", 0.4), "1");
    assert.equal(stepAmount("Slice 3 celery stalks thin.", "3", 3, "", 0.5), "2");
    assert.equal(stepAmount("Chop 2 stalks celery.", "2 stalks", 2, "stalks", 0.4), "1 stalk");
  });
});

describe("BUG-464 — star anise is its own plural", () => {
  it("never 'star anises'", () => {
    table([
      ["star anise", 3, "each", 1, "3 star anise"], // was "3 star anises"
      ["whole star anise", 2, "each", 1, "2 whole star anise"],
      ["star anise", 1, "each", 0.4, "1 star anise"],
    ]);
  });
});

// ── WEB-4d (R5) — the display table: ounces, produce, packages, pieces ─────
//
// THX-3d pins the same rows on the server. Literals, written from the rule. The
// quoted "was" values are what the same line printed before WEB-4d.
//
// Re-pinned (Hans, October 22): an UNSCALED amount is never rounded; produce goes
// to the nearest ½ unless the cut word keeps it whole; chiles are produce; a mix
// baked per package directions is the whole box with no use.

describe("WEB-4d R5 — ounces: whole from 4 oz, the nearest ½ below it", () => {
  it("the prompt's rows, and the edges", () => {
    table([
      ["cremini mushrooms", 11, "oz", 0.875, "10 oz cremini mushrooms"], // 9⅝
      ["baby spinach", 5, "oz", 0.95, "5 oz baby spinach"], // 4¾
      ["grated Parmesan", 4.75, "oz", 0.5, "2½ oz grated Parmesan"], // 2⅜
      ["cream cheese", 8, "oz", 0.5, "4 oz cream cheese"], // exactly 4
      ["goat cheese", 7.6, "oz", 0.5, "4 oz goat cheese"], // 3.8, under 4: nearest ½ is 4
      ["feta", 7.4, "oz", 0.5, "3½ oz feta"], // 3.7
      ["dried porcini", 0.25, "ounce", 0.5, "½ ounce dried porcini"], // never below ½
      ["fresh cranberries", 24, "ounce", 0.8, "19 ounces fresh cranberries"], // was 19¼
      ["chicken broth", 14, "fl oz", 0.3, "4 fl oz chicken broth"], // 4.2: fluid ounces too
    ]);
  });

  it("…and a step's ounces agree", () => {
    assert.equal(stepAmount("Add 11 oz sliced cremini mushrooms and sauté.", "11 oz", 11, "oz", 0.875), "10 oz");
    assert.equal(stepAmount("Stir in 4¾ oz grated Parmesan.", "4¾ oz", 4.75, "oz", 0.5), "2½ oz");
  });
});

describe("WEB-4d R5 — whole produce by the piece: the nearest ½, never below ½", () => {
  it("the produce words and the chiles, by their head noun", () => {
    table([
      ["yellow onion", 1, "each", 0.75, "1 yellow onion"], // ¾
      ["yellow onion", 1, "each", 0.375, "½ yellow onion"], // ⅜
      ["shallots", 19, "each", 0.125, "2½ shallots"], // 2⅜
      ["yellow onions", 3, "each", 0.625, "2 yellow onions"], // 1⅞
      ["lime", 1, "each", 0.2, "½ lime"], // ⅕ → the floor
      ["carrots", 3, "each", 0.5, "1½ carrots"],
      ["lemon", 1, "each", 0.5, "½ lemon"],
      ["Orange", 2, "each", 0.4, "1 Orange"], // ⅘
      ["jalapeño", 3, "each", 0.25, "1 jalapeño"], // ¾
      ["Granny Smith apple", 3, "each", 0.4, "1 Granny Smith apple"], // was 1¼
      ["russet potatoes", 4, "each", 0.3, "1 russet potato"], // 1.2
      ["chipotle chiles in adobo", 3, "each", 0.375, "1 chipotle chile in adobo"], // 1⅛
      ["chipotle peppers in adobo sauce", 3, "each", 0.25, "1 chipotle pepper in adobo sauce"], // ¾
      ["dried ancho chiles", 3, "each", 0.5, "1½ dried ancho chiles"],
    ]);
  });

  it("the cut word keeps it whole, never below 1: the unit, the name or the prep note", () => {
    const at = (name: string, quantity: number, unit: string, multiplier: number, preparationNote?: string) =>
      formatIngredientLine({ name, quantity, unit, preparationNote }, { multiplier });
    assert.equal(at("yellow onion", 1, "each", 0.4, "quartered"), "1 yellow onion");
    assert.equal(at("lemon, halved", 1, "each", 0.4), "1 lemon, halved");
    assert.equal(at("jalapeño", 1, "whole", 0.4), "1 whole jalapeño");
    assert.equal(at("yellow onions", 3, "each", 0.5, "quartered"), "2 yellow onions"); // 1½ → 2
    assert.equal(at("yellow onion", 1, "each", 0.4, "diced"), "½ yellow onion"); // no cut word
  });

  it("an unscaled amount prints as written", () => {
    table([
      ["lemon", 0.5, "each", 1, "½ lemon"],
      ["red onion", 0.25, "each", 1, "¼ red onion"],
      ["canned diced tomatoes", 14.5, "ounce", 1, "14½ ounces canned diced tomatoes"],
      ["black beans", 0.5, "can", 1, "½ can black beans"],
      ["fresh thyme", 2.5, "sprig", 1, "3 sprigs fresh thyme"], // FIX-7's ceiling, as before WEB-4d
    ]);
  });

  it("not by the head noun → not produce", () => {
    table([
      ["lime wedges", 4, "each", 0.3, "2 lime wedges"], // a wedge: FIX-7's ceiling
      ["orange bell pepper", 1, "each", 0.5, "½ orange bell pepper"],
      ["potato buns", 4, "each", 0.3, "2 potato buns"], // a bun: FIX-7's ceiling
      ["onion powder", 1, "teaspoon", 0.5, "½ teaspoon onion powder"],
      ["yellow onion", 1, "cup", 0.5, "½ cup yellow onion"], // a measure, not a count
    ]);
  });

  it("each share rounds on its own, by its own cut word: Classic's onions at 4 are 2½, not '1⅞'", () => {
    // The turkey dish follows its bird (14 lb for 10, floored at 10 lb → 10/14);
    // the gravy and the stuffing follow servings (4 of 10). The cavity onion is
    // quartered (whole: 1), the gravy's diced (0.4 → ½), the stuffing's diced (0.8 → 1).
    const onion = (quantity: number, preparationNote: string) => ({ name: "yellow onion", quantity, unit: "each", preparationNote });
    const meal = {
      dishes: [
        { title: "Herb-Roasted Whole Turkey", ingredients: [{ name: "whole turkey", quantity: 14, unit: "pound" }, onion(1, "quartered")] },
        { title: "Pan Gravy", ingredients: [onion(1, "diced")] },
        { title: "Sage and Onion Stuffing", ingredients: [onion(2, "diced")] },
      ],
    } as unknown as Parameters<typeof consolidateMealIngredients>[0];
    assert.equal(consolidateMealIngredients(meal, 0.4).find((c) => c.name === "yellow onion")!.line, "2½ yellow onions");
    // At the feast's own 10 nothing is scaled: 4 as written.
    assert.equal(consolidateMealIngredients(meal, 1).find((c) => c.name === "yellow onion")!.line, "4 yellow onions");
  });

  it("…and the step agrees", () => {
    assert.equal(stepAmount("Add 2 finely diced onions and 6 diced celery stalks.", "2", 2, "", 0.4), "1");
    assert.equal(stepAmount("Zest and juice 1 lemon.", "1", 1, "", 0.5), "½");
    assert.equal(stepAmount("Slice 6 shallots into rings.", "6", 6, "", 0.4), "2½");
    assert.equal(stepAmount("Mince 3 chipotle peppers from the can.", "3", 3, "", 0.5), "1½");
    // The cut word before the noun, or right after it.
    assert.equal(stepAmount("Add 1 quartered yellow onion and the celery.", "1", 1, "", 0.4), "1");
    assert.equal(stepAmount("Stuff the cavity with 1 lemon, halved, and the herbs.", "1", 1, "", 0.4), "1");
    assert.equal(stepAmount("Add 1 whole jalapeño to the pot.", "1", 1, "", 0.4), "1");
    // "1 lemon, 1 halved onion": the halving is the onion's.
    assert.equal(stepAmount("Add 1 lemon, 1 halved onion.", "1", 1, "", 0.4), "½");
    // Unscaled: as written.
    assert.equal(stepAmount("Squeeze ½ lemon over the fish.", "½", 0.5, "", 1), "½");
  });
});

describe("WEB-4d R5 — packages: whole, rounded up, never below 1, keeping the use", () => {
  it("the use, when the recipe gives the package's size", () => {
    table([
      ["pumpkin purée", 1, "can (15 oz)", 0.375, "1 can (15 oz) pumpkin purée, use 6 oz"],
      ["canned pumpkin purée", 1, "can (15 oz)", 0.4, "1 can (15 oz) canned pumpkin purée, use 6 oz"], // New Twist at 4
      ["cornbread mix (8.5 oz box)", 2, "each", 0.4, "1 cornbread mix (8.5 oz box)"], // a mix: the whole box, no use
      ["pumpkin purée", 1, "can (15 oz)", 1, "1 can (15 oz) pumpkin purée"], // nothing rounded: no use
    ]);
  });

  it("up, not nearest; and a count size or no size has no use", () => {
    table([
      ["black beans", 2, "can", 0.625, "2 cans black beans"], // 1¼ → 2
      ["refrigerated pie crust (contains wheat)", 1, "package (2-count)", 0.4, "1 package (2-count) refrigerated pie crust (contains wheat)"],
      ["salsa verde", 1, "jar", 0.5, "1 jar salsa verde"],
      ["baby spinach", 1, "bag", 0.3, "1 bag baby spinach"],
      ["corn muffin mix", 2, "box", 0.4, "1 box corn muffin mix"],
    ]);
  });

  // The whole step, so the clause and the prose around it are both checked.
  const stepText = (text: string, span: string, quantity: number, unit: string, multiplier: number) => {
    const charStart = text.indexOf(span);
    const ref = { ingredientId: "i", quantity, unit, charStart, charEnd: charStart + span.length };
    return buildAmountRefSegments(text, [ref], multiplier).map((x) => x.text).join("");
  };

  it("a step: the clause keeps its size and gains the use; a total scales", () => {
    // New Twist: the ref is the size, the 2 is bare text — both read as one
    // clause. A cornbread mix is baked whole: the box, no use.
    assert.equal(
      stepText("Prepare 2 boxes (8.5 oz each) cornbread mix in two 8×8 pans.", "8.5 oz", 8.5, "oz", 0.4),
      "Prepare 1 box (8.5 oz each) cornbread mix in two 8×8 pans.",
    );
    assert.equal(
      stepText("Prepare 2 boxes (8.5 oz each) per package directions.", "8.5 oz", 8.5, "oz", 0.4),
      "Prepare 1 box (8.5 oz each) per package directions.",
    );
    // The pumpkin: was "beat in 1 can (6 oz)" before WEB-4d; a held size alone would say the whole can.
    assert.equal(
      stepText("Beat in 1 can (15 oz) pumpkin purée until smooth.", "15 oz", 15, "oz", 0.4),
      "Beat in 1 can (15 oz, use 6 oz) pumpkin purée until smooth.",
    );
    assert.equal(
      stepText("Drain and rinse the 3 cans (15 oz each) of black beans.", "3 cans", 3, "cans", 0.5),
      "Drain and rinse the 2 cans (15 oz each, use 23 oz) of black beans.",
    );
    // Nothing rounded: the clause is the authored text, byte for byte.
    assert.equal(
      stepText("Prepare 2 boxes (8.5 oz each) cornbread mix.", "8.5 oz", 8.5, "oz", 1),
      "Prepare 2 boxes (8.5 oz each) cornbread mix.",
    );
    // A word count is not a clause; its size is still held.
    assert.equal(stepAmount("Pour in one can (13.5 oz) of coconut milk.", "13.5 oz", 13.5, "oz", 0.5), "13.5 oz");
    assert.equal(stepAmount("Shape into 8 balls (4 oz each); season.", "4 oz", 4, "oz", 0.5), "4 oz");
    assert.equal(stepAmount("Drain the black beans (30 oz total) and rinse.", "30 oz", 30, "oz", 0.5), "15 oz");
    assert.equal(stepAmount("Pour the broth cartons (8 cups total) into a pot.", "8 cups", 8, "cups", 0.5), "4 cups");
  });

  it("a size before its package with no hyphen never scales either (the ounce rule rounded it at 4)", () => {
    assert.equal(stepAmount("Open the two 10¾ oz cans of condensed tomato soup.", "10¾ oz", 10.75, "oz", 0.5), "10¾ oz");
    assert.equal(stepAmount("Pour in the 14⅞ fl oz can of Guinness.", "14⅞", 14.875, "", 0.5), "14⅞");
    assert.equal(stepAmount("Microwave both 8½ oz pouches of white rice.", "8½ oz", 8.5, "oz", 0.5), "8½ oz");
    assert.equal(stepAmount("Add 21½ oz sliced mushrooms to the pan.", "21½ oz", 21.5, "oz", 0.5), "11 oz"); // an amount
    // Unscaled, the ref renders as it always did — not the stored "10.75".
    assert.equal(stepAmount("Open the two 10.75 oz cans of condensed tomato soup.", "10.75 oz", 10.75, "oz", 1), "10¾ oz");
  });
});

describe("WEB-4d R5 — caps, sheets, crusts, crackers, leaves, sprigs: the nearest whole, never below 1", () => {
  it("the prompt's rows; sprigs and leaves leave FIX-7's ceiling", () => {
    table([
      ["portobello mushroom caps", 13, "each", 0.125, "2 portobello mushroom caps"], // 1⅝
      ["puff pastry sheets", 1, "each", 0.75, "1 puff pastry sheet"], // ¾
      ["butter crackers", 29, "each", 0.25, "7 butter crackers"], // 7¼ — the ceiling would say 8
      ["refrigerated pie crust dough", 2, "each", 0.4, "1 refrigerated pie crust dough"],
      ["all-butter puff pastry", 2, "sheet", 0.4, "1 sheet all-butter puff pastry"],
      ["fresh thyme", 8, "sprig", 0.4, "3 sprigs fresh thyme"], // 3.2 — was 4
      ["bay leaves", 3, "each", 0.4, "1 bay leaf"], // 1.2 — was 2
      ["fresh sage (leaves)", 6, "each", 0.4, "2 fresh sage (leaves)"], // 2.4 — was "2⅜"
      ["parchment paper", 1, "sheet", 0.4, "1 sheet parchment paper"], // equipment first: as written
    ]);
  });

  it("…and the step agrees", () => {
    assert.equal(stepAmount("Brush 4 portobello caps on both sides.", "4", 4, "", 0.40625), "2");
    assert.equal(stepAmount("Unroll 2 puff pastry sheets.", "2", 2, "", 0.4), "1");
    assert.equal(stepAmount("Add 4 thyme sprigs and 2 bay leaves.", "4", 4, "", 0.8), "3");
    // "flat-leaf" is not a leaf: the count after it is a cup of parsley.
    assert.equal(stepAmount("Add the mint leaves and ½ packed cup flat-leaf parsley.", "½", 0.5, "", 0.5), "¼");
  });
});

describe("WEB-4d R5 — a package size followed by words before its package", () => {
  it("is the package's size; an amount followed by a pan is not", () => {
    assert.equal(stepAmount("Microwave both 8½ oz microwavable white rice pouches.", "8½ oz", 8.5, "oz", 0.5), "8½ oz");
    assert.equal(stepAmount("Cook the two 8½ oz jasmine rice pouches according to the package.", "8½ oz", 8.5, "oz", 0.5), "8½ oz");
    // The package right after the size, though the words go on past it.
    assert.equal(stepAmount("Pour in the 14½ oz can crushed tomatoes.", "14½ oz", 14.5, "oz", 0.5), "14½ oz");
    assert.equal(stepAmount("Pour in the 13½ fl oz can coconut milk.", "13½", 13.5, "", 0.5), "13½");
    assert.equal(stepAmount("Add 8 oz pasta to the pot.", "8 oz", 8, "oz", 0.5), "4 oz");
    assert.equal(stepAmount("Add 8 oz dried pasta in the pot.", "8 oz", 8, "oz", 0.5), "4 oz");
  });
});

describe("WEB-4d R5 — the size's package can sit past the 40-character name window", () => {
  it("'8.5 oz microwavable white rice pouches according to package directions'", () => {
    assert.equal(
      stepAmount("Microwave both 8.5 oz microwavable white rice pouches according to package directions.", "8.5 oz", 8.5, "oz", 0.5),
      "8.5 oz",
    );
  });
});

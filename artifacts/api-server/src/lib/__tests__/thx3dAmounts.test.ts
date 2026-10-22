// THX-3d (B, R2) — every feast step amount equals its ingredient line: the matcher.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deriveAmountRefs, type MatcherIngredient } from "../stepAmountRefs";
import { feastAmountFindings } from "../feastAmountWalk";

const row = (ingredientId: string, name: string, quantity: number, unit: string): MatcherIngredient => ({ ingredientId, name, quantity, unit });
const spans = (text: string, rows: MatcherIngredient[]) =>
  deriveAmountRefs(text, rows).amountRefs.map((r) => `${text.slice(r.charStart, r.charEnd)}|${r.ingredientId}|${r.quantity}|${r.unit}`);

describe("THX-3d B — a mixed number is one number", () => {
  it("'1½ cups granulated sugar' keeps the unit 'cups' (it was '½ cups', printed unscaled)", () => {
    const rows = [row("sugar", "granulated sugar", 1.5, "cup"), row("berries", "fresh cranberries", 24, "ounce")];
    assert.deepEqual(spans("Combine 24 oz rinsed cranberries, 1½ cups granulated sugar and the orange juice.", rows), [
      "24 oz|berries|24|oz",
      "1½ cups|sugar|1.5|cups",
    ]);
  });
});

describe("THX-3d B — numbers that are not an amount of a food", () => {
  const rows = [row("t", "whole turkey", 14, "pound"), row("w", "water", 8, "cup")];
  for (const text of [
    "Refrigerate 12 to 24 hours, turning halfway.",
    "Roast 3 to 3½ hours, until the thigh reads 165°F.",
    "Bake 35 more minutes until golden.",
    "A 14-lb bird takes 3–4 days to thaw.",
    "Place the potatoes in a large pot (at least 8-quart).",
    "Spread across 2 rimmed sheet pans and roast.",
    "Cut 6 small steam vents in the top crust.",
    "Whisk in the stock, 1 cup at a time.",
  ]) {
    it(`no ref: ${text}`, () => assert.deepEqual(spans(text, rows), []));
  }

  it("per package: 'each with 1 egg and ⅓ cup whole milk' never scales; the boxes do, never their size", () => {
    const rows2 = [row("mix", "cornbread mix (8.5 oz box)", 2, "each"), row("egg", "egg", 2, "each"), row("milk", "whole milk", 0.667, "cup")];
    assert.deepEqual(spans("Bake 2 boxes (8.5 oz each) cornbread mix in two separate 8×8 pans, each with 1 egg and ⅓ cup whole milk, per package directions.", rows2), [
      "2 boxes|mix|2|boxes",
    ]);
  });
});

describe("THX-3d B — the food after a participle, a bracket, or a tie", () => {
  it("'5 lb peeled, 2-inch potato chunks' is the potatoes", () => {
    assert.deepEqual(spans("Place 5 lb peeled, 2-inch potato chunks in a large pot.", [row("p", "russet potatoes", 5, "pound"), row("s", "kosher salt", 2, "teaspoon")]), ["5 lb|p|5|lb"]);
  });
  it("'reserve ¼ cup fat' is the turkey drippings", () => {
    assert.deepEqual(spans("Skim off and reserve ¼ cup fat.", [row("d", "turkey drippings", 0.25, "cup"), row("f", "all-purpose flour", 0.5, "cup")]), ["¼ cup|d|0.25|cup"]);
  });
  it("a food listed twice binds the first row when nothing else tells them apart (it was unbound)", () => {
    const rows = [row("b1", "unsalted butter", 6, "tablespoon"), row("b2", "unsalted butter", 2, "tablespoon")];
    assert.deepEqual(spans("Drain and toss with 1 tablespoon butter to prevent sticking.", rows), ["1 tablespoon|b1|1|tablespoon"]);
  });
  it("'the 2 sheets' of puff pastry is a count of the pastry", () => {
    assert.deepEqual(spans("Divide the duxelles between the 2 sheets.", [row("pp", "all-butter puff pastry", 2, "sheet")]), ["2 sheets|pp|2|sheets"]);
  });
});

describe("THX-3d B — the walk", () => {
  const rows = [row("sugar", "granulated sugar", 1.5, "cup"), row("orange", "orange", 2, "each")];
  it("finds a corrupt unit, an unbound amount and a count in words", () => {
    const f = feastAmountFindings(rows, [
      { stepIndex: 0, text: "Zest and juice both oranges.", amountRefs: [] },
      { stepIndex: 1, text: "Add 1½ cups granulated sugar.", amountRefs: [{ ingredientId: "sugar", quantity: 1.5, unit: "½ cups", charStart: 4, charEnd: 11 }] },
      { stepIndex: 2, text: "Stir in 2 cups granulated sugar.", amountRefs: [] },
    ]);
    assert.deepEqual(f.map((x) => `${x.stepIndex}:${x.kind}`), ["0:count", "1:corrupt", "2:unbound"]);
  });
  it("a share, a restatement and the whole amount are not findings", () => {
    const f = feastAmountFindings([row("t", "fresh thyme", 2, "tablespoon"), row("e", "egg", 2, "each")], [
      { stepIndex: 0, text: "Pick 2 tbsp thyme leaves; beat 1 egg.", amountRefs: null },
      { stepIndex: 1, text: "Add the shallots and 2 tbsp thyme; brush with the second egg.", amountRefs: null },
    ], { derive: true });
    assert.deepEqual(f, []);
  });
});

// ── E (R5) — the display table, the same rows as WEB-4d (42907c2e) ───────────
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { OUNCE_UNITS, PACKAGE_WORD, WHOLE_PIECE_NAME, WHOLE_PIECE_UNITS, WHOLE_PRODUCE_HEAD, NAME_WEIGHT, displayedPrepQuantity, dishRowMultipliers } from "../prepQuantity";
import { formatMeasure } from "../prepWeekAssembly";

const CLIENT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../kiwi/lib/format/quantity.ts");

describe("THX-3d E — the R5 table, pinned with WEB-4d", () => {
  it("matches the client's own literals (drift guard)", { skip: !existsSync(CLIENT) && "client file not on disk" }, () => {
    const src = readFileSync(CLIENT, "utf8");
    const lit = (name: string) => new RegExp(`const ${name}\\s*=\\s*\\n?\\s*/(.+)/([a-z]*);`).exec(src)?.[1];
    assert.equal(lit("OUNCE_UNITS"), OUNCE_UNITS.source);
    assert.equal(lit("WHOLE_PRODUCE_HEAD"), WHOLE_PRODUCE_HEAD.source);
    assert.equal(lit("PACKAGE_WORD"), PACKAGE_WORD.source);
    assert.equal(lit("WHOLE_PIECE_UNITS"), WHOLE_PIECE_UNITS.source);
    assert.equal(lit("WHOLE_PIECE_NAME"), WHOLE_PIECE_NAME.source);
    assert.equal(lit("NAME_WEIGHT"), NAME_WEIGHT.source);
  });

  const rows: Array<[number, string, string, string]> = [
    // ounces: whole from 4 oz, the nearest ½ below
    [9.6, "ounce", "fresh cranberries", "10 oz"],
    [4.75, "ounce", "sharp cheddar cheese", "5 oz"],
    [2.375, "ounce", "fontina cheese", "2½ oz"],
    [0.2, "ounce", "parmesan", "½ oz"],
    // produce by the piece: the nearest whole, never below 1, per share
    [0.75, "each", "yellow onion", "1"],
    [0.375, "each", "yellow onion", "1"],
    [2.375, "each", "shallot", "2"],
    [0.375, "each", "lemon", "1"],
    // packages: whole, up; the size never scales
    [0.375, "can (15 oz)", "canned pumpkin purée", "1 can (15 oz)"],
    [0.8, "each", "cornbread mix (8.5 oz box)", "1"],
    // pieces
    [1.625, "each", "portobello mushroom caps", "2"],
    [0.75, "sheet", "all-butter puff pastry", "1 sheet"],
    [7.25, "each", "graham crackers", "7"],
  ];
  for (const [q, unit, name, want] of rows) {
    it(`${q} ${unit} ${name} → ${want}`, () => assert.equal(formatMeasure(q, unit, name), want));
  }

  it("a share rounds on its own: ¾ · ⅜ · ¾ onion is 1 · 1 · 1, so 3 are bought", () => {
    assert.deepEqual([0.75, 0.375, 0.75].map((q) => displayedPrepQuantity(q, "", "yellow onion")), [1, 1, 1]);
  });
});

describe("THX-3d G — a bird by count whose line gives its weight takes the weight rule (feast only)", () => {
  const rows = [
    { quantity: 1, unit: "each", name: "whole turkey (12–14 lb)" },
    { quantity: 6, unit: "tablespoon", name: "unsalted butter" },
    { quantity: 2, unit: "each", name: "orange" },
  ];
  it("at 4 of 10 the dish follows the 10 lb floor of a 14 lb bird (10/14), not one whole bird (×1)", () => {
    const m = dishRowMultipliers(rows, 0.4, { feast: true });
    assert.ok(m.every((x) => Math.abs(x - 10 / 14) < 1e-9), JSON.stringify(m));
  });
  it("outside a feast the count rule stands (the bird is still whole birds; the rest follows servings)", () => {
    const m = dishRowMultipliers(rows, 0.4, {});
    assert.deepEqual(m.slice(1), [0.4, 0.4]);
  });
});

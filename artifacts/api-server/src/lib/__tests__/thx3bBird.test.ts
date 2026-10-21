// THX-3b (BUG-454) — ONE BIRD RULE ON BOTH SIDES. The server copies WEB-4's
// whole-bird floors (artifacts/kiwi/lib/format/quantity.ts, b1f404b) and scales a
// whole-bird dish by its bird. The table at the bottom is the INPUT TABLE WEB-4b
// pins too (Classic's turkey dish, 14 lb written for 10), so the two sides'
// outputs can be compared line for line.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { BIRD_FLOOR_LB, birdFloorPounds, dishRowMultipliers, wholeBirdCount, wholeItemMultiplier } from "../prepQuantity";
import { formatMeasure } from "../prepWeekAssembly";
import { buildPrepCombineInput } from "../prepCombineAdapter";
import type { PrepLoadedPlan } from "../prepWeekAggregation";

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = resolve(here, "../../../../kiwi/lib/format/quantity.ts");

describe("THX-3b — the whole-bird floors (WEB-4's, verbatim)", () => {
  it("pins the table literally", () => {
    assert.deepEqual(
      BIRD_FLOOR_LB.map(([re, lb]) => [re.source, lb]),
      [
        [String.raw`\bturkeys?\b`, 10],
        [String.raw`\b(?:cornish|game) hens?\b`, 1],
        [String.raw`\brotisserie chickens?\b`, 2],
        [String.raw`\bducks?\b`, 4],
        [String.raw`\b(?:goose|geese)\b`, 8],
        [String.raw`\b(?:chickens?|hens?)\b`, 3],
      ],
    );
    assert.equal(birdFloorPounds("Cornish hens"), 1);
    assert.equal(birdFloorPounds("whole chicken"), 3);
  });

  it("matches the client's own table (drift guard)", { skip: !existsSync(CLIENT) && "client file not on disk" }, () => {
    const src = readFileSync(CLIENT, "utf8");
    const block = /const BIRD_FLOOR_LB[^=]*=\s*\[([\s\S]*?)\n\];/.exec(src);
    assert.ok(block, "BIRD_FLOOR_LB not found in the client file");
    const rows = [...block![1].matchAll(/\[\/(.+?)\/i,\s*(\d+)\]/g)].map((m) => [m[1], Number(m[2])]);
    assert.deepEqual(rows, BIRD_FLOOR_LB.map(([re, lb]) => [re.source, lb]));
  });

  it("scales a bird down only to its floor, never above the recipe, and up linearly", () => {
    assert.equal(wholeItemMultiplier(0.4, "pound", "whole turkey", 14), 10 / 14);
    assert.equal(wholeItemMultiplier(0.8, "pound", "whole turkey", 14), 0.8);
    assert.equal(wholeItemMultiplier(0.4, "pound", "whole turkey", 9), 1);
    assert.equal(wholeItemMultiplier(2, "pound", "whole turkey", 14), 2);
    // No quantity, or a kind with no floor: the old rule — no scale-down.
    assert.equal(wholeItemMultiplier(0.4, "pound", "whole turkey"), 1);
    assert.equal(wholeItemMultiplier(0.4, "pound", "whole bird", 14), 1);
    // Not a whole bird by weight: the servings.
    assert.equal(wholeItemMultiplier(0.4, "pound", "bone-in turkey breast", 6), 0.4);
    assert.equal(wholeItemMultiplier(0.4, "each", "whole turkey", 1), 0.4);
  });
});

// Classic's "Herb-Roasted Whole Turkey" (dev b2889ed4, 10 servings) — the rows the
// table reads — and its "Pan Gravy" neck and giblets (a separate dish, f90c8155).
const TURKEY = [
  { quantity: 14, unit: "pound", name: "whole turkey" },
  { quantity: 0.5, unit: "cup", name: "kosher salt" },
  { quantity: 1, unit: "gallon", name: "cold water" },
  { quantity: 0.25, unit: "cup", name: "light brown sugar" },
];
const GRAVY = [
  { quantity: 1, unit: "each", name: "turkey neck" },
  { quantity: 1, unit: "set", name: "turkey giblets" },
  { quantity: 2, unit: "stalk", name: "celery" },
];

describe("THX-3b — the pinned input table (WEB-4b pins the same inputs)", () => {
  // servings → bird · brine salt · brine water · neck
  const TABLE: Array<[number, string, string, string, string]> = [
    [1, "10 lb", "⅓ cup", "¾ gallon", "1"],
    [4, "10 lb", "⅓ cup", "¾ gallon", "1"],
    [8, "11¼ lb", "⅓ cup", "¾ gallon", "1"],
    [10, "14 lb", "½ cup", "1 gallon", "1"],
    [20, "28 lb", "1 cup", "2 gallon", "1"],
    [30, "42 lb", "1½ cup", "3 gallon", "1"],
  ];
  for (const [servings, bird, salt, water, neck] of TABLE) {
    it(`${servings} servings → ${bird} bird, ${salt} salt, ${water} water, ${neck} neck`, () => {
      const t = dishRowMultipliers(TURKEY, servings / 10);
      const g = dishRowMultipliers(GRAVY, servings / 10);
      const shown = (r: (typeof TURKEY)[number], x: number) => formatMeasure(r.quantity * x, r.unit, r.name);
      assert.deepEqual(
        [shown(TURKEY[0], t[0]), shown(TURKEY[1], t[1]), shown(TURKEY[2], t[2]), shown(GRAVY[0], g[0])],
        [bird, salt, water, neck],
      );
      // The giblets come with the bird too; the gravy's celery is not the bird's.
      assert.equal(shown(GRAVY[1], g[1]), "1 set");
      assert.equal(g[2], servings / 10);
    });
  }

  // THX-3c (BUG-462) — WEB-4b's definition: the weight BEFORE the ¼ lb rounding. 8 of
  // 10 shows an 11¼ lb bird, and its brine is 0.8 of the recipe's (not 11¼ / 14).
  it("the factor is the floored weight before rounding ÷ the recipe's: 8 of 10 is 0.8, 4 of 10 is 10/14", () => {
    const t = dishRowMultipliers(TURKEY, 0.8);
    assert.equal(t[1], 0.8);
    assert.ok(t.every((x) => x === t[0]), "every row of a whole-bird dish scales by the bird");
    assert.equal(dishRowMultipliers(TURKEY, 0.4)[1], 10 / 14);
  });

  it("a dish with no whole bird scales by servings", () => {
    assert.deepEqual(dishRowMultipliers([{ quantity: 3, unit: "pound", name: "bone-in turkey breast" }, { quantity: 1, unit: "cup", name: "kosher salt" }], 0.4), [0.4, 0.4]);
  });
});

// THX-3c (BUG-462) — the Buttermilk-Brined turkey (dev alternate b8fcb9f9, 10
// servings): "1 each whole turkey". WEB-4c pins the same inputs.
const COUNT_BIRD = [
  { quantity: 1, unit: "each", name: "whole turkey" },
  { quantity: 2, unit: "quart", name: "buttermilk" },
  { quantity: 0.5, unit: "cup", name: "Kosher salt" },
  { quantity: 8, unit: "clove", name: "garlic" },
  { quantity: 1, unit: "each", name: "turkey neck" },
];

describe("THX-3c — a bird written by count (BUG-462)", () => {
  // servings → birds · buttermilk · salt · garlic · neck
  const TABLE: Array<[number, string, string, string, string, string]> = [
    [1, "1", "2 quart", "½ cup", "8 cloves", "1"],
    [4, "1", "2 quart", "½ cup", "8 cloves", "1"],
    [10, "1", "2 quart", "½ cup", "8 cloves", "1"],
    [15, "2", "4 quart", "1 cup", "16 cloves", "2"],
    [20, "2", "4 quart", "1 cup", "16 cloves", "2"],
  ];
  for (const [servings, ...want] of TABLE) {
    it(`${servings} servings → ${want.join(" · ")}`, () => {
      const m = dishRowMultipliers(COUNT_BIRD, servings / 10);
      assert.deepEqual(COUNT_BIRD.map((r, i) => formatMeasure(r.quantity * m[i], r.unit, r.name)), want);
    });
  }

  it("the count is the nearest whole, halves up, never below 1", () => {
    assert.deepEqual([0.1, 0.4, 0.5, 1, 1.4, 1.5, 2.6].map((x) => wholeBirdCount(1, x)), [1, 1, 1, 1, 1, 2, 3]);
    assert.equal(wholeBirdCount(2, 0.4), 1);
  });

  it("a whole bird by weight still decides first; a part in a weight-bird dish is one", () => {
    const m = dishRowMultipliers([...TURKEY, { quantity: 1, unit: "each", name: "turkey neck" }], 2);
    assert.deepEqual(m, [2, 2, 2, 2, 1]);
  });
});

describe("THX-3b — Prep the Week reads the bird rule (adapter)", () => {
  it("the brine follows the bird, the neck is one", () => {
    const ing = (id: string, name: string, quantity: number, unit: string, category = "Pantry") => ({
      ingredientId: id, ingredientName: name, category, quantity, unit, preparationNote: null, sourceYield: null,
    });
    const loaded = {
      meals: [{
        mealId: "m", mealName: "Feast", servingsOverride: 4,
        dishes: [
          { dishId: "turkey", dishName: "Turkey", dishRole: "main", baseServings: 10, authoredBaseServings: 10, stepTexts: [], componentSteps: [],
            ingredients: [ing("t", "whole turkey", 14, "pound", "Protein"), ing("s", "kosher salt", 0.5, "cup")] },
          { dishId: "gravy", dishName: "Gravy", dishRole: "sauce", baseServings: 10, authoredBaseServings: 10, stepTexts: [], componentSteps: [],
            ingredients: [ing("n", "turkey neck", 1, "each", "Protein"), ing("f", "all-purpose flour", 0.5, "cup")] },
        ],
      }],
    } as unknown as PrepLoadedPlan;
    const out = buildPrepCombineInput(loaded);
    const q = (dish: string, id: string) => out.meals[0].dishes.find((d) => d.dishId === dish)!.ingredients.find((i) => i.ingredientId === id)!.quantity;
    assert.equal(q("turkey", "t"), 10);
    assert.ok(Math.abs(q("turkey", "s") - 0.5 * (10 / 14)) < 1e-12);
    assert.equal(q("gravy", "n"), 1);
    assert.ok(Math.abs(q("gravy", "f") - 0.2) < 1e-12);
  });
});

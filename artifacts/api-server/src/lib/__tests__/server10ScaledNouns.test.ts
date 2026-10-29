// SERVER-10 E (BUG-597) — a unit-less amount's noun is said for the plan's number.
//
// QA-COOK-1 (cooksim-2026-10-29) read, in Cook Mode, dishes authored for 4 and served
// for 2: Fajita Toppings "Cut 1 limes into wedges", Chicken Drunken Noodles "1 eggs",
// the Porterhouse "1 porterhouse steaks". The server serves the authored text and a
// ref on the "2"; the client swaps the number in and cannot re-word the noun after it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { agreeScaledNouns, pluralOf, singularOf } from "../feastScaleFrames";
import type { WordingStep } from "../feastCookWording";
import { scaledNounRows, scaledNounsFor } from "../scaledNouns";

/** A step whose refs sit on the given digits (in order of appearance), each for its ingredient. */
function step(text: string, refs: [digit: string, ingredientId: string, quantity: number][]): WordingStep {
  let from = 0;
  return {
    stepIndex: 0,
    text,
    amountRefs: refs.map(([digit, ingredientId, quantity]) => {
      const at = text.indexOf(digit, from);
      from = at + digit.length;
      return { ingredientId, quantity, unit: "", charStart: at, charEnd: at + digit.length };
    }),
  };
}
const rows = (mult: number, ...names: [id: string, name: string][]) => new Map(names.map(([id, name]) => [id, { mult, name, unit: "each" }]));
const shown = (w: WordingStep) => w.amountRefs!.map((r) => w.text.slice(r.charStart, r.charEnd));

describe("SERVER-10 E — the three QA-COOK-1 steps at 2 of 4", () => {
  it("\"Cut 2 limes into wedges.\" → \"Cut 2 lime into wedges.\" (the client shows 1)", () => {
    const w = agreeScaledNouns(step("Cut 2 limes into wedges.", [["2", "lime", 2]]), rows(0.5, ["lime", "lime"]));
    assert.equal(w.text, "Cut 2 lime into wedges.");
    assert.deepEqual(shown(w), ["2"], "the ref still sits on its number");
  });

  it("eggs and steaks, and a ref after the edit moves with its text", () => {
    const w = agreeScaledNouns(
      step("Push the noodles aside, crack in 2 eggs and scramble; sear 2 porterhouse steaks with 4 cloves.", [["2", "egg", 2], ["2", "steak", 2], ["4", "garlic", 4]]),
      rows(0.5, ["egg", "large eggs"], ["steak", "porterhouse steaks"], ["garlic", "garlic cloves"]),
    );
    assert.equal(w.text, "Push the noodles aside, crack in 2 egg and scramble; sear 2 porterhouse steak with 4 cloves.");
    assert.deepEqual(shown(w), ["2", "2", "4"]);
  });

  it("a count that stays above one keeps its plural (6 limes at ×0.5 is 3)", () => {
    const s = step("Juice 6 limes.", [["6", "lime", 6]]);
    assert.equal(agreeScaledNouns(s, rows(0.5, ["lime", "lime"])), s);
  });
});

describe("SERVER-10 E — and the other way: one authored, more than one shown", () => {
  it("\"Cut 1 lime, juiced\" at ×2 → \"1 limes, juiced\" (the client shows 2; the head is the food, not juiced)", () => {
    assert.equal(agreeScaledNouns(step("Cut 1 lime, juiced.", [["1", "lime", 1]]), rows(2, ["lime", "lime"])).text, "Cut 1 limes, juiced.");
  });

  it("going plural, only the food's own head noun moves: \"Halve 1 yellow onion lengthwise\" → \"1 yellow onions lengthwise\"", () => {
    const w = agreeScaledNouns(step("Halve 1 yellow onion lengthwise.", [["1", "onion", 1]]), rows(2, ["onion", "yellow onion"]));
    assert.equal(w.text, "Halve 1 yellow onions lengthwise.", "never \"lengthwises\" or \"yellows\"");
    const c = agreeScaledNouns(step("Mince 1 garlic clove.", [["1", "garlic", 1]]), rows(3, ["garlic", "garlic"]));
    assert.equal(c.text, "Mince 1 garlic cloves.", "a count noun counts the food whatever its name");
  });

  it("\"Add 1 bay leaf and the stock\" at ×2 → \"1 bay leaves\"", () => {
    assert.equal(agreeScaledNouns(step("Add 1 bay leaf and the stock.", [["1", "bay", 1]]), rows(2, ["bay", "bay leaves"])).text, "Add 1 bay leaves and the stock.");
  });

  it("a unit ref is the client's (\"2 cups\") and is left alone; a step with no change is the same object", () => {
    const s: WordingStep = { stepIndex: 0, text: "Add 2 cups broth.", amountRefs: [{ ingredientId: "b", quantity: 2, unit: "cups", charStart: 4, charEnd: 10 }] };
    assert.equal(agreeScaledNouns(s, rows(0.5, ["b", "broth"])), s);
  });

  it("singular and plural forms", () => {
    for (const [one, many] of [["lime", "limes"], ["egg", "eggs"], ["leaf", "leaves"], ["loaf", "loaves"], ["tomato", "tomatoes"], ["cherry", "cherries"], ["dish", "dishes"], ["steak", "steaks"]]) {
      assert.equal(pluralOf(one), many);
      assert.equal(singularOf(many), one);
    }
  });
});

describe("SERVER-10 E — the meal read's rows and the one query", () => {
  it("rows scale by (servingsOverride ?? servings) / authored", () => {
    const ing = [{ ingredientId: "lime", quantity: 2, unit: "", name: "lime", note: null }];
    assert.equal(scaledNounRows({ servings: 2, authoredServingsDefault: 4 }, ing, null).get("lime")!.mult, 0.5);
    assert.equal(scaledNounRows({ servings: 2, authoredServingsDefault: 4 }, ing, 8).get("lime")!.mult, 2);
  });

  it("an unscaled dish costs no query and changes nothing; a scaled one is worded", async () => {
    let queries = 0;
    const prisma = {
      dishIngredient: {
        findMany: async () => {
          queries++;
          return [{ dishId: "d", ingredientId: "lime", quantity: 2, unit: "", preparationNote: null, ingredient: { displayName: "lime" } }];
        },
      },
    } as never;
    const dish = { dishId: "d", servings: 4, authoredServingsDefault: 4, steps: [step("Cut 2 limes into wedges.", [["2", "lime", 2]])] };
    assert.equal((await scaledNounsFor(prisma, [dish], null)).size, 0);
    assert.equal(queries, 0);
    const out = await scaledNounsFor(prisma, [{ ...dish, servings: 2 }], null);
    assert.equal(out.get("d")!.get(0)!.text, "Cut 2 lime into wedges.");
    assert.equal(queries, 1);
  });
});

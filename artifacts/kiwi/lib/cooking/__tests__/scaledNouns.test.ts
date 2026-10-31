// CLIENT-8 B (BUG-618) — a scaled count's noun is said for the number shown, by
// SERVER-10 E's rule (api-server feastScaleFrames.ts refNounEdits), on every screen
// that scales a step itself: Meal Detail's stepper, Cook Mode, Dish.
//
// The server's own vectors (api-server src/lib/__tests__/server10ScaledNouns.test.ts)
// run here through buildAmountRefSegments: the client shows the number the server's
// test says it will, and the words around it must be the server's words.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildAmountRefSegments } from "../amountSegments";
import { foodHeads, pluralOf, refNounEdit, singularOf } from "../scaledNouns";
import type { AmountRef } from "../../api/meals";
import { ONE_BIRD } from "../../format/quantity";
// CLIENT-9 B (BUG-634) — SERVER-13 F's vectors, the same list the server's
// server13ScaledNouns.test.ts reads (data only; by its real .mts name: Node runs it as is).
import { PLURAL, SINGULAR, STEP_VECTORS } from "../../../../api-server/src/lib/__tests__/shared/scaledNounVectors.mts";

/** Refs on the given digits (in order of appearance), unit-less. */
function refs(text: string, ...digits: [digit: string, quantity: number][]): AmountRef[] {
  let from = 0;
  return digits.map(([digit, quantity]) => {
    const at = text.indexOf(digit, from);
    from = at + digit.length;
    return { ingredientId: "x", quantity, unit: "", charStart: at, charEnd: at + digit.length };
  });
}
const said = (text: string, mult: number, foods: string[], ...digits: [string, number][]) =>
  buildAmountRefSegments(text, refs(text, ...digits), mult, ONE_BIRD, foods).map((s) => s.text).join("");

describe("BUG-618 — the server's vectors, said by the client", () => {
  it("going singular: limes, eggs, porterhouse steaks at 2 of 4", () => {
    assert.equal(said("Cut 2 limes into wedges.", 0.5, ["lime"], ["2", 2]), "Cut 1 lime into wedges.");
    assert.equal(
      said(
        "Push the noodles aside, crack in 2 eggs and scramble; sear 2 porterhouse steaks with 4 cloves.",
        0.5,
        ["large eggs", "porterhouse steaks", "garlic cloves"],
        ["2", 2], ["2", 2], ["4", 4],
      ),
      "Push the noodles aside, crack in 1 egg and scramble; sear 1 porterhouse steak with 2 cloves.",
    );
    assert.equal(said("Juice 6 limes.", 0.5, ["lime"], ["6", 6]), "Juice 3 limes.", "a count that stays above one keeps its plural");
  });

  it("going plural: only a food's own head noun, or a count noun", () => {
    assert.equal(said("Cut 1 lime, juiced.", 2, ["lime"], ["1", 1]), "Cut 2 limes, juiced.");
    assert.equal(said("Halve 1 yellow onion lengthwise.", 2, ["yellow onion"], ["1", 1]), "Halve 2 yellow onions lengthwise.", "never lengthwises or yellows");
    assert.equal(said("Mince 1 garlic clove.", 3, ["garlic"], ["1", 1]), "Mince 3 garlic cloves.");
    assert.equal(said("Add 1 bay leaf and the stock.", 2, ["bay leaves"], ["1", 1]), "Add 2 bay leaves and the stock.");
  });

  it("a unit ref keeps its unit word's own agreement, and nothing after it moves", () => {
    const text = "Add 2 cups broth.";
    const r: AmountRef[] = [{ ingredientId: "b", quantity: 2, unit: "cups", charStart: 4, charEnd: 10 }];
    assert.equal(buildAmountRefSegments(text, r, 0.5, ONE_BIRD, ["broth"]).map((s) => s.text).join(""), "Add 1 cup broth.");
  });

  it("singular and plural forms are the server's", () => {
    for (const [one, many] of [["lime", "limes"], ["egg", "eggs"], ["leaf", "leaves"], ["loaf", "loaves"], ["tomato", "tomatoes"], ["cherry", "cherries"], ["dish", "dishes"], ["steak", "steaks"]]) {
      assert.equal(pluralOf(one), many);
      assert.equal(singularOf(many), one);
    }
  });
});

describe("BUG-618 — Meal Detail's stepper (no plan item: only the client can say it)", () => {
  // Fajita Toppings authored for 4: "Cut 2 limes into wedges." 1 serving = ×¼, 3 = ×¾.
  it("1 serving says half a lime, singular; 3 servings say limes", () => {
    assert.equal(said("Cut 2 limes into wedges.", 0.25, ["lime"], ["2", 2]), "Cut ½ lime into wedges.");
    assert.equal(said("Cut 2 limes into wedges.", 0.75, ["lime"], ["2", 2]), "Cut 1½ limes into wedges.");
    // A recipe that says one, scaled up.
    assert.equal(said("Crack in 1 egg.", 3, ["large egg"], ["1", 1]), "Crack in 3 eggs.");
  });

  it("the ref segment is still only the number, and an unscaled step is as written", () => {
    const text = "Cut 2 limes into wedges.";
    assert.deepEqual(buildAmountRefSegments(text, refs(text, ["2", 2]), 0.5, ONE_BIRD, ["lime"]), [
      { text: "Cut ", isRef: false },
      { text: "1", isRef: true },
      { text: " lime into wedges.", isRef: false },
    ]);
    assert.equal(said(text, 1, ["lime"], ["2", 2]), text);
  });

  it("a step the server already agreed does not move again (a plan's Cook Mode)", () => {
    // The server's "Cut 2 lime into wedges." (ref still 2) at the plan's ×½.
    assert.equal(said("Cut 2 lime into wedges.", 0.5, ["lime"], ["2", 2]), "Cut 1 lime into wedges.");
    // The server's "Mince 1 garlic cloves." at ×3: "garlic" is a food, but the head is cloves.
    assert.equal(said("Mince 1 garlic cloves.", 3, ["garlic"], ["1", 1]), "Mince 3 garlic cloves.");
    assert.equal(said("Cut 1 limes, juiced.", 2, ["lime"], ["1", 1]), "Cut 2 limes, juiced.");
  });

  it("no foods given: going singular still works, going plural moves only a count noun", () => {
    assert.equal(said("Cut 2 limes into wedges.", 0.5, [], ["2", 2]), "Cut 1 lime into wedges.");
    assert.equal(said("Cut 1 lime, juiced.", 2, [], ["1", 1]), "Cut 2 lime, juiced.");
    assert.equal(said("Mince 1 garlic clove.", 2, [], ["1", 1]), "Mince 2 garlic cloves.");
  });
});

describe("BUG-618 — every screen that scales a step passes its dish's foods", () => {
  const src = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
  it("Meal Detail, Dish, Cook Mode", () => {
    assert.match(src("app/meal/[id].tsx"), /stepBirds\.get\(step\) \?\? scale\.mealOwnedBirds,\s*stepFoods\.get\(step\) \?\? mealFoods,/);
    assert.match(src("app/dish/[id].tsx"), /buildAmountRefSegments\(step\.text, step\.amountRefs, multiplier, birds, foods\)/);
    assert.match(src("components/CookSessionView.tsx"), /buildAmountRefSegments\(text, amountRefs, amountMultiplier, birds, foods\)/);
    assert.equal(src("components/CookSessionView.tsx").match(/foods=\{stepFoods\(step\)\}/g)?.length, 2);
    assert.match(src("app/cook-session.tsx"), /dishFoods=\{dishFoods\}/);
  });
});

describe("CLIENT-9 B (BUG-634) — the shared scaled-noun vectors, on the client's rule", () => {
  for (const [plural, one] of SINGULAR) {
    it(`singularOf("${plural}") is "${one}"`, () => assert.equal(singularOf(plural), one));
  }
  for (const [one, plural] of PLURAL) {
    it(`pluralOf("${one}") is "${plural}"`, () => assert.equal(pluralOf(one), plural));
  }
  for (const v of STEP_VECTORS) {
    it(v.name, () => {
      const start = v.text.indexOf(v.ref);
      assert.ok(start >= 0, `"${v.ref}" is in the text`);
      const e = refNounEdit(v.text, start, start + v.ref.length, v.authored, v.shown, foodHeads([v.food]));
      const got = e ? v.text.slice(0, e.start) + e.text + v.text.slice(e.end) : v.text;
      assert.equal(got, v.want);
    });
  }

  it("on the stepper's path: one mango at 2 of 4, chilies and a mass noun at 8", () => {
    assert.equal(said("Peel and dice the 2 ripe mangoes into cubes.", 0.5, ["mango"], ["2", 2]), "Peel and dice the 1 ripe mango into cubes.");
    assert.equal(said("Slice 1 red chili thinly.", 2, ["red chili"], ["1", 1]), "Slice 2 red chilies thinly.");
    assert.equal(said("Stir in 1 onion powder.", 2, ["onion powder"], ["1", 1]), "Stir in 2 onion powder.");
  });
});

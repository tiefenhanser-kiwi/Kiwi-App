// PREP-3 (R5) — every step amount scales the way the cook reads it: a count with its size
// scales the count and holds the size; a lean-to-fat ratio is a name; an amount said as the
// total scales even beside "each … with"; and the re-derive joins a held size to its unit.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deriveAmountRefs, hasUnmatchedAmount } from "../stepAmountRefs";
import { joinSizes } from "../../../scripts/prep3/rederive.lib";

const rows = [
  { ingredientId: "sal", name: "salmon fillets", quantity: 24, unit: "ounce" },
  { ingredientId: "beef", name: "ground beef (80/20)", quantity: 1.5, unit: "pound" },
  { ingredientId: "oil", name: "olive oil", quantity: 2, unit: "tablespoon" },
  { ingredientId: "salt", name: "kosher salt", quantity: 1, unit: "teaspoon" },
  { ingredientId: "pj", name: "pepper jack cheese", quantity: 6, unit: "ounce" },
  { ingredientId: "moz", name: "shredded mozzarella", quantity: 1, unit: "cup" },
];
const said = (t: string) => deriveAmountRefs(t, rows).amountRefs.map((r) => `${t.slice(r.charStart, r.charEnd)}=${r.quantity}${r.unit}@${r.ingredientId}`);

describe("PREP-3 (R5) — the matcher", () => {
  it("a count with its size: the count scales (\"four\" → 2 at household 2), the size holds", () => {
    assert.deepEqual(said("Pat the four 6 oz skin-on salmon fillets dry."), ["four=4@sal"]);
    assert.deepEqual(said("Season 2 (6-oz) salmon fillets with salt."), ["2=2@sal"]);
    assert.equal(hasUnmatchedAmount("Pat the four 6 oz skin-on salmon fillets dry.", deriveAmountRefs("Pat the four 6 oz skin-on salmon fillets dry.", rows).amountRefs), false);
    assert.deepEqual(said("Add 24 oz salmon fillets."), ["24 oz=24oz@sal"]);
  });

  it("\"80/20\" is the beef's name, not an amount", () => {
    assert.deepEqual(said("Add the 1½ pounds 80/20 ground beef and brown it."), ["1½ pounds=1.5pounds@beef"]);
  });

  it("an amount said as the total scales, \"each … with\" or not", () => {
    assert.deepEqual(said("Rub each potato with 2 tablespoons olive oil total and sprinkle evenly with 1 teaspoon kosher salt."), ["2 tablespoons=2tablespoons@oil", "1 teaspoon=1teaspoon@salt"]);
    assert.deepEqual(said("Top each taco with a generous pinch of the 6 ounces of pepper jack cheese."), ["6 ounces=6ounces@pj"]);
    assert.deepEqual(said("Season each cutlet with the remaining 1 teaspoon kosher salt."), ["1 teaspoon=1teaspoon@salt"]);
    // …and a per-item amount still never does (THX-3d round 2, O).
    assert.deepEqual(said("Top each cutlet with ¼ cup shredded mozzarella."), []);
  });
});

describe("PREP-3 (R5) — the re-derive's text", () => {
  it("a held size joins its unit, so the scaled count never sits beside its number", () => {
    assert.equal(joinSizes("Pat the four 6 oz skin-on salmon fillets dry."), "Pat the four 6-oz skin-on salmon fillets dry.");
    assert.equal(joinSizes("Pat the four 6-oz salmon fillets dry."), "Pat the four 6-oz salmon fillets dry.");
    assert.equal(joinSizes("Drain the two 15 oz cans of chickpeas."), "Drain the two 15 oz cans of chickpeas.");
  });
});

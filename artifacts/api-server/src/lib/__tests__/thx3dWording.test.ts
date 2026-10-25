// THX-3d (C, R2) — Cook Mode's words for a feast dish, from its Prep the feast: the
// real stored sentences (dev catalog, October 22), the facts a feast build gives them.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { cutPhrase, mentionsOf, rewordFeastSteps, splitPrepClause, type FeastDishFacts, type WordingRef, type WordingRow, type WordingStep } from "../feastCookWording";
import { ingredientGroupKey } from "../ingredientRelations";

/** A step with a ref on each listed span (its first occurrence; "1|cinnamon stick" refs the "1" of that phrase). */
function step(stepIndex: number, text: string, spans: [string, string][] = []): WordingStep {
  const amountRefs: WordingRef[] = spans.map(([span, ingredientId]) => {
    const [ref, after = ""] = span.split("|");
    const at = text.indexOf(ref + after);
    assert.ok(at >= 0, `span "${span}" in "${text}"`);
    return { ingredientId, quantity: 1, unit: "", charStart: at, charEnd: at + ref.length };
  });
  return { stepIndex, text, amountRefs };
}
const row = (ingredientId: string, name: string): WordingRow => ({ ingredientId, name });
const mix = (name: string, rows: WordingRow[]) => ({ name, ids: new Set(rows.map((r) => r.ingredientId)), keys: new Set(rows.map((r) => ingredientGroupKey(r.name))) });
const cut = (r: WordingRow, into: string, note: string) => ({ id: r.ingredientId, key: ingredientGroupKey(r.name), into, note });
const refText = (s: WordingStep) => (s.amountRefs ?? []).map((r) => s.text.slice(r.charStart, r.charEnd));

// Classic's Cranberry-Orange Sauce.
const CRAN = row("cran", "fresh cranberries");
const ORANGE = row("orange", "orange");
const SUGAR = row("sugar", "granulated sugar");
const WATER = row("water", "water");
const STICK = row("stick", "cinnamon stick");
const SALT = row("salt", "kosher salt");
const CRAN_ROWS = [CRAN, SUGAR, ORANGE, WATER, STICK, SALT];
const CRAN_FACTS: FeastDishFacts = {
  dishId: "cran",
  mixes: [mix("Cranberry-Orange Sauce dry mix", [SALT, SUGAR, STICK])],
  cuts: [cut(CRAN, "Cranberry-Orange Sauce vegetables", "rinsed and picked over"), cut(ORANGE, "Cranberry-Orange Sauce vegetables", "zested and juiced")],
};
const TITLES = ["Herb-Roasted Whole Turkey", "Cranberry-Orange Sauce", "Sage and Onion Stuffing", "Sweet Potato Casserole"];
const CRAN_STEPS = [
  step(0, "Make ahead (Monday): Zest and juice 2 oranges; set aside.", [["2", "orange"]]),
  step(1, "Make ahead (Monday): Combine 24 oz rinsed cranberries, 1½ cups granulated sugar, the orange juice and zest, ½ cup water, 1 cinnamon stick, and a pinch of kosher salt in a medium saucepan over medium-high heat.", [["24 oz", "cran"], ["1½ cups", "sugar"], ["½ cup| water", "water"], ["1| cinnamon", "stick"]]),
  step(2, "Make ahead (Monday): Simmer until the cranberries burst and the sugar dissolves, 10 minutes."),
];

describe("THX-3d C rule 1 — a step whose whole job Prep the feast did", () => {
  const out = rewordFeastSteps(CRAN_STEPS, CRAN_ROWS, CRAN_FACTS, TITLES);
  it("opens \"Skip if you prepped. Otherwise,\" after the day, and its amount still scales", () => {
    assert.equal(out[0].text, "Make ahead (Monday): Skip if you prepped. Otherwise, zest and juice 2 oranges; set aside.");
    assert.deepEqual(refText(out[0]), ["2"]);
  });
  it("not when the citrus was only juiced and the step zests it too", () => {
    const juicedOnly = { ...CRAN_FACTS, cuts: [cut(ORANGE, "Cranberry-Orange Sauce vegetables", "juiced")] };
    assert.equal(rewordFeastSteps(CRAN_STEPS, CRAN_ROWS, juicedOnly, TITLES)[0].text, CRAN_STEPS[0].text);
  });
  it("not when the step goes on to work the food (\"whisk into the filling\")", () => {
    const CIN = row("cin", "ground cinnamon"), GIN = row("gin", "ground ginger"), NUT = row("nut", "ground nutmeg"), CLO = row("clo", "ground cloves");
    const s = step(4, "Make ahead (Wednesday): Measure 1½ teaspoons cinnamon, ½ teaspoon ginger, ¼ teaspoon nutmeg, and ¼ teaspoon cloves; whisk into the filling.", [["1½ teaspoons", "cin"], ["½ teaspoon", "gin"], ["¼ teaspoon nutmeg", "nut"]]);
    const facts = { dishId: "bars", mixes: [mix("Pumpkin Cheesecake Bars dry mix", [CIN, GIN, NUT, CLO])], cuts: [] };
    assert.ok(!/Skip if you prepped/.test(rewordFeastSteps([s], [CIN, GIN, NUT, CLO], facts, [])[0].text));
  });
});

describe("THX-3d C rule 3 + 4 — the mix and the container, where the step measures them", () => {
  const out = rewordFeastSteps(CRAN_STEPS, CRAN_ROWS, CRAN_FACTS, TITLES);
  it("the members name the mix, the produce its container, the rest stay with their amounts", () => {
    assert.equal(out[1].text, "Make ahead (Monday): Combine the Cranberry-Orange Sauce vegetables you prepped, the Cranberry-Orange Sauce dry mix you prepped, and ½ cup water in a medium saucepan over medium-high heat.");
    assert.deepEqual(refText(out[1]), ["½ cup"]);
  });
  it("\"until the cranberries burst\" and \"the sugar dissolves\" are not measured: as written", () => {
    assert.equal(out[2].text, CRAN_STEPS[2].text);
  });
  it("a removed last item takes the list's \"and\" with it; two items left read \"A and B\"", () => {
    const PECAN = row("pecan", "pecan halves"), BROWN = row("brown", "light brown sugar"), FLOUR = row("flour", "all-purpose flour"), BUTTER = row("butter", "unsalted butter");
    const s = step(6, "Make ahead (Wednesday): In a medium bowl, combine 1 cup roughly chopped pecans, ½ cup light brown sugar, and ¼ cup flour; cut in 3 tablespoons cold butter with your fingers until the mixture resembles coarse crumbs; cover and refrigerate.", [["1 cup", "pecan"], ["½ cup", "brown"], ["¼ cup", "flour"], ["3 tablespoons", "butter"]]);
    const facts = { dishId: "sp", mixes: [mix("Sweet Potato Casserole dry mix 2", [BROWN, FLOUR, PECAN])], cuts: [] };
    const [w] = rewordFeastSteps([s], [PECAN, BROWN, FLOUR, BUTTER], facts, TITLES);
    assert.equal(w.text, "Make ahead (Wednesday): In a medium bowl, combine the Sweet Potato Casserole dry mix 2 you prepped; cut in 3 tablespoons cold butter with your fingers until the mixture resembles coarse crumbs; cover and refrigerate.");
    assert.deepEqual(refText(w), ["3 tablespoons"]);
  });
  it("a removed last item with two left: \"A and the mix\", not \"A, the mix\"", () => {
    const OATS = row("oats", "old-fashioned rolled oats"), FLOUR = row("flour", "all-purpose flour"), SALT2 = row("salt", "kosher salt");
    const s = step(1, "Make ahead (Wednesday): In a separate bowl, combine ¾ cup rolled oats, ½ cup all-purpose flour, and ¼ teaspoon kosher salt; work in the butter.", [["¾ cup", "oats"], ["½ cup", "flour"], ["¼ teaspoon", "salt"]]);
    const facts = { dishId: "crisp", mixes: [mix("Apple Crisp dry mix", [FLOUR, SALT2, row("cin", "ground cinnamon")])], cuts: [] };
    assert.equal(rewordFeastSteps([s], [OATS, FLOUR, SALT2], facts, [])[0].text, "Make ahead (Wednesday): In a separate bowl, combine ¾ cup rolled oats and the Apple Crisp dry mix you prepped; work in the butter.");
  });
  it("a shared tub's food by the tub: \"the minced garlic you prepped\"", () => {
    const GARLIC = row("garlic", "garlic");
    const s = step(3, "Make ahead (Wednesday): Add 4 minced garlic cloves and cook 1 minute more; remove from heat.", [["4", "garlic"]]);
    const facts = { dishId: "st", mixes: [], cuts: [cut(GARLIC, "Minced garlic — Sage and Onion Stuffing, Green Bean Casserole", "minced")] };
    assert.equal(rewordFeastSteps([s], [GARLIC], facts, TITLES)[0].text, "Make ahead (Wednesday): Add the minced garlic you prepped and cook 1 minute more; remove from heat.");
  });
  it("a citrus tub by what is in it: \"the lemon juice you prepped\", never \"the juiced lemon\"", () => {
    const LEMON = row("lemon", "lemon"), SUGAR2 = row("gs", "granulated sugar"), CIN = row("cin", "ground cinnamon"), NUT = row("nut", "ground nutmeg"), CORN = row("corn", "cornstarch");
    const s = step(0, "Make ahead (Wednesday): Toss the apples in a large bowl with 3 tablespoons granulated sugar, ¾ teaspoon cinnamon, ¼ teaspoon nutmeg, 1 tablespoon cornstarch, and the juice of 1 lemon.", [["3 tablespoons", "gs"], ["¾ teaspoon", "cin"], ["¼ teaspoon", "nut"], ["1 tablespoon", "corn"], ["1| lemon", "lemon"]]);
    const facts = { dishId: "crisp", mixes: [mix("Apple Crisp dry mix 2", [SUGAR2, CIN, NUT, CORN])], cuts: [cut(LEMON, "Juiced lemon — Roasted Green Beans, Apple Crisp", "juiced")] };
    assert.equal(rewordFeastSteps([s], [LEMON, SUGAR2, CIN, NUT, CORN], facts, [])[0].text, "Make ahead (Wednesday): Toss the apples in a large bowl with the Apple Crisp dry mix 2 you prepped and the lemon juice you prepped.");
  });
  it("never a cut verb's object (\"mince the minced shallot you prepped\")", () => {
    const SHALLOT = row("shallot", "shallots"), MUSH = row("mush", "cremini mushrooms");
    const s = step(0, "Finely chop the 1½ lb cremini mushrooms, mince the 4 shallots, and toss with oil.", [["1½ lb", "mush"], ["4", "shallot"]]);
    const facts = { dishId: "w", mixes: [], cuts: [cut(SHALLOT, "Minced shallot — Wellington, Gravy", "minced")] };
    assert.equal(rewordFeastSteps([s], [SHALLOT, MUSH], facts, [])[0].text, s.text);
  });
  it("a dish title is not its food (\"Sage and Onion Stuffing\" is not sage)", () => {
    const SAGE = row("sage", "fresh sage");
    const s = step(0, "On Thursday: Bake the Sage and Onion Stuffing for 30 minutes.");
    const facts = { dishId: "st", mixes: [], cuts: [cut(SAGE, "Sage and Onion Stuffing — fresh thyme, fresh sage", "finely chopped")] };
    assert.equal(rewordFeastSteps([s], [SAGE], facts, TITLES)[0].text, s.text);
    assert.deepEqual(mentionsOf(s, [SAGE], TITLES), []);
  });
  it("the code-written raise and serve steps are never reworded; no facts, no change", () => {
    const s = step(2, "Raise the oven to 350°F and put in the Sage and Onion Stuffing.");
    assert.equal(rewordFeastSteps([s], CRAN_ROWS, CRAN_FACTS, TITLES)[0], s);
    assert.deepEqual(rewordFeastSteps(CRAN_STEPS, CRAN_ROWS, undefined, TITLES), CRAN_STEPS);
  });
});

describe("THX-3d C rule 2 — the patch splits a step that preps and then works", () => {
  it("Small's cranberry step: the zest-and-juice alone, then the combine", () => {
    assert.deepEqual(splitPrepClause("Make ahead (Monday): Zest 2 oranges, then juice them; combine the 12 ounces cranberries, ¾ cup granulated sugar, orange zest, orange juice, ¼ cup water, 1 cinnamon stick, and a pinch of kosher salt in a medium saucepan.", [ORANGE, CRAN, SUGAR, WATER, STICK, SALT]), {
      prep: "Make ahead (Monday): Zest 2 oranges, then juice them.",
      work: "Make ahead (Monday): Combine the 12 ounces cranberries, ¾ cup granulated sugar, orange zest, orange juice, ¼ cup water, 1 cinnamon stick, and a pinch of kosher salt in a medium saucepan.",
    });
  });
  it("round 2 (K) — the work half names what it works, never \"them\"; a vessel lead-in is still work", () => {
    const CIN = row("cin", "ground cinnamon"), GIN = row("gin", "ground ginger");
    assert.equal(splitPrepClause("Make ahead (Wednesday): Measure 1½ teaspoons cinnamon and ½ teaspoon ginger; whisk into the filling.", [CIN, GIN])?.work, "Make ahead (Wednesday): Whisk the cinnamon and ginger into the filling.");
    const SPROUT = row("sp", "Brussels sprouts"), GARLIC = row("garlic", "garlic"), OIL = row("oil", "olive oil");
    assert.equal(splitPrepClause("Trim and halve 2½ lb Brussels sprouts; thinly slice 4 garlic cloves. In a large bowl, toss the sprouts and garlic with 3 tablespoons olive oil.", [SPROUT, GARLIC, OIL])?.prep, "Trim and halve 2½ lb Brussels sprouts; thinly slice 4 garlic cloves.");
  });
  it("\"and\" before a work verb splits too (Small's green beans on Thursday)", () => {
    const BEANS = row("beans", "fresh green beans"), OIL = row("oil", "olive oil"), GARLIC = row("garlic", "garlic");
    assert.deepEqual(splitPrepClause("On Thursday: Trim 1 pound green beans and toss in a large bowl with 2 tablespoons olive oil and 2 thinly sliced garlic cloves.", [BEANS, OIL, GARLIC]), {
      prep: "On Thursday: Trim 1 pound green beans.",
      // "On Thursday:" opens the day once, on the first half.
      work: "Toss the green beans in a large bowl with 2 tablespoons olive oil and 2 thinly sliced garlic cloves.",
    });
  });
  it("a step that is all prep, or all work, is one step (so the patch is idempotent)", () => {
    assert.equal(splitPrepClause("Make ahead (Monday): Zest and juice 2 oranges; set aside.", [ORANGE]), null);
    assert.equal(splitPrepClause("Make ahead (Monday): Zest 2 oranges, then juice them.", [ORANGE]), null);
    const BREAD = row("bread", "white sandwich bread"), BUTTER = row("butter", "unsalted butter");
    assert.equal(splitPrepClause("Make ahead (Tuesday): Slice 1 loaf bread and let it dry overnight; toss with 4 tablespoons butter.", [BREAD, BUTTER]), null);
    assert.equal(splitPrepClause("Make ahead (Monday): Combine the 12 ounces cranberries and ¾ cup granulated sugar.", [CRAN, SUGAR]), null);
  });
});

describe("THX-3d round 2 (N) — Cook Mode says the container's label", () => {
  const ONION = row("on", "yellow onion"), CELERY = row("ce", "celery"), CARROT = row("ca", "carrots"), GARLIC = row("ga", "garlic");
  it("a dish's own container by its label, a shared tub by its food", () => {
    const s = step(0, "Make ahead (Tuesday): Combine the neck, 1 chopped onion, 2 chopped celery stalks, 1 chopped carrot and 4 cups water.", [["1", "on"], ["2", "ce"], ["1| chopped carrot", "ca"]]);
    const facts = { dishId: "g", mixes: [], cuts: ["on", "ce", "ca"].map((id, i) => ({ id, key: ingredientGroupKey([ONION, CELERY, CARROT][i].name), into: "Gravy vegetables", note: "chopped", kind: "own" as const })) };
    assert.equal(rewordFeastSteps([s], [ONION, CELERY, CARROT], facts, [])[0].text, "Make ahead (Tuesday): Combine the neck, the Gravy vegetables you prepped and 4 cups water.");
    // A label with no "vegetables" in it is still the dish's own container.
    assert.deepEqual(cutPhrase("Stuffing onion & celery", [], "own"), { phrase: "the Stuffing onion & celery you prepped", whole: true });
    const g = step(1, "Add 4 minced garlic cloves and cook 1 minute.", [["4", "ga"]]);
    const shared = { dishId: "s", mixes: [], cuts: [{ id: "ga", key: ingredientGroupKey("garlic"), into: "Minced garlic", note: "minced", kind: "shared" as const }] };
    assert.equal(rewordFeastSteps([g], [GARLIC], shared, [])[0].text, "Add the minced garlic you prepped and cook 1 minute.");
  });
  it("a cut that went into the jar entering here is the jar: one mention (Small's thyme in the glaze)", () => {
    const SYRUP = row("sy", "pure maple syrup"), SALT2 = row("sa", "kosher salt"), PEP = row("pe", "black pepper"), CIN = row("ci", "ground cinnamon"), THYME = row("th", "fresh thyme"), BUTTER = row("bu", "unsalted butter");
    const s = step(0, "On Thursday: In a large bowl, whisk together 3 tablespoons maple syrup, 2 tablespoons melted butter, ½ teaspoon kosher salt, ¼ teaspoon black pepper, ¼ teaspoon ground cinnamon, and the stripped thyme leaves (if using).",
      [["3 tablespoons", "sy"], ["2 tablespoons", "bu"], ["½ teaspoon", "sa"], ["¼ teaspoon| black", "pe"], ["¼ teaspoon| ground", "ci"]]);
    const facts = { dishId: "sp", mixes: [mix("Sweet potatoes sauce", [SYRUP, SALT2, PEP, CIN])], cuts: [{ id: "th", key: ingredientGroupKey("fresh thyme"), into: "Sweet potatoes sauce", note: "leaves stripped", kind: "mix" as const }] };
    assert.equal(rewordFeastSteps([s], [SYRUP, SALT2, PEP, CIN, THYME, BUTTER], facts, [])[0].text, "On Thursday: In a large bowl, whisk together the Sweet potatoes sauce you prepped and 2 tablespoons melted butter.");
  });
});

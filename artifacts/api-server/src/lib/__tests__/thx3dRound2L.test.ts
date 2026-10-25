// THX-3d round 2 (L) — what Prep the feast made, Cook Mode uses by its name: the
// moments that keep a food out of a mix it is not in, and the words that say the rest.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mixtureEntryKey, resolveMoments } from "../prepMoments";
import { cutOf } from "../prepClasses";
import { rewordFeastSteps, type FeastDishFacts, type WordingRow, type WordingStep } from "../feastCookWording";
import { feastWordingFindings } from "../feastWordingWalk";
import { ingredientGroupKey } from "../ingredientRelations";

const cs = (stepIndex: number, phaseType: string, text: string, ids: string[]) => ({ stepIndex, phaseType, text, componentKey: null, ingredientIds: ids });
const ing = (id: string, name: string) => ({ ingredientId: id, ingredientName: name, preparationNote: null, phase: "seasonings_dry" });

describe("THX-3d L — the moments a feast mix is made of", () => {
  it("a step that only measures opens its own run: the cheesecake's spices are not the filling's sugar", () => {
    const steps = [
      cs(3, "prep", "Make ahead (Wednesday): Beat 16 oz cream cheese and ¾ cup granulated sugar until smooth; beat in ½ teaspoon salt.", ["sugar", "salt"]),
      cs(4, "prep", "Make ahead (Wednesday): Measure 1½ teaspoons cinnamon, ½ teaspoon ginger and ¼ teaspoon nutmeg.", ["cin", "gin", "nut"]),
      cs(5, "prep", "Make ahead (Wednesday): Whisk the cinnamon, ginger and nutmeg into the filling.", []),
    ];
    const ings = [ing("sugar", "granulated sugar"), ing("salt", "kosher salt"), ing("cin", "ground cinnamon"), ing("gin", "ground ginger"), ing("nut", "ground nutmeg")];
    const keys = resolveMoments(steps, ings, undefined, { vesselRuns: true }).keyByIngredientId;
    assert.notEqual(keys.get("sugar"), keys.get("cin"));
    assert.equal(keys.get("cin"), keys.get("nut"));
  });
  it("a later clause is a later moment: the gravy's sherry and soy, then the broth whisked in gradually", () => {
    const steps = [cs(4, "cook", "Pour in 3 tablespoons dry sherry and 1 tablespoon soy sauce; stir to combine, then gradually whisk in 4 cups vegetable broth.", ["sh", "soy", "br"])];
    const at = (id: string, name: string) => mixtureEntryKey(steps, id, name, { vesselRuns: true });
    assert.equal(at("sh", "dry sherry"), at("soy", "soy sauce"));
    assert.notEqual(at("sh", "dry sherry"), at("br", "vegetable broth"));
    assert.equal(mixtureEntryKey(steps, "br", "vegetable broth"), mixtureEntryKey(steps, "sh", "dry sherry"), "a weeknight keeps one moment");
  });
  it("\"zested, then juiced\" is zested AND juiced (New Twist's turkey pours the juice)", () => {
    assert.equal(cutOf(["zested, then juiced"]), "zested and juiced");
  });
});

/** A step with a ref on each listed span ("1| lemon" refs the "1" of that phrase). */
function step(stepIndex: number, text: string, spans: [string, string][] = []): WordingStep {
  return {
    stepIndex, text,
    amountRefs: spans.map(([span, ingredientId]) => {
      const [ref, after = ""] = span.split("|");
      const at = text.indexOf(ref + after);
      assert.ok(at >= 0, `span "${span}" in "${text}"`);
      return { ingredientId, quantity: 1, unit: "", charStart: at, charEnd: at + ref.length };
    }),
  };
}
const row = (ingredientId: string, name: string): WordingRow => ({ ingredientId, name });
const cut = (r: WordingRow, into: string, note: string, kind: "own" | "shared" | "plate" | "mix") => ({ id: r.ingredientId, key: ingredientGroupKey(r.name), into, note, kind });

describe("THX-3d L — a plate's pile, a container's part, by its food", () => {
  it("\"garnish with 2 tablespoons sliced chives\" → \"the sliced chives you prepped\"", () => {
    const CH = row("ch", "fresh chives");
    const s = step(7, "Transfer the potatoes to a warm bowl and garnish with 2 tablespoons sliced fresh chives, if using.", [["2 tablespoons", "ch"]]);
    const facts: FeastDishFacts = { dishId: "m", mixes: [], cuts: [cut(CH, "Mashed potatoes toppings", "thinly sliced, for garnish", "plate")] };
    assert.equal(rewordFeastSteps([s], [CH], facts, [])[0].text, "Transfer the potatoes to a warm bowl and garnish with the sliced chives you prepped, if using.");
  });
  it("the cavity's onion, celery and lemon in one list are one phrase; the turkey's butter garlic, another moment, its own", () => {
    const ON = row("on", "yellow onion"), CE = row("ce", "celery"), LE = row("le", "lemon"), GA = row("ga", "garlic");
    const facts: FeastDishFacts = { dishId: "t", mixes: [], cuts: [
      cut(ON, "Turkey vegetables", "quartered, for cavity", "own"), cut(CE, "Turkey vegetables", "trimmed, for cavity", "own"),
      cut(LE, "Turkey vegetables", "halved for cavity", "own"), cut(GA, "Turkey vegetables", "minced for herb butter", "own"),
    ] };
    const s = step(9, "Stuff the cavity with the quartered onion, 2 celery stalks, the halved lemon, and any remaining herb sprigs.", [["2", "ce"]]);
    assert.equal(rewordFeastSteps([s], [ON, CE, LE, GA], facts, [])[0].text, "Stuff the cavity with the quartered onion, celery and halved lemon you prepped and any remaining herb sprigs.");
  });
  it("where it came from is the food's (\"leaves from 4 sprigs\"); a compound is another thing (\"the garlic butter\")", () => {
    const SA = row("sa", "fresh sage"), GA = row("ga", "garlic");
    const facts: FeastDishFacts = { dishId: "t", mixes: [], cuts: [cut(SA, "Turkey aromatics", "chopped", "plate"), cut(GA, "Turkey aromatics", "minced", "plate")] };
    const s = step(4, "Mash 6 tablespoons butter with 3 minced garlic cloves, chopped sage leaves from 4 sprigs, and 1 teaspoon pepper.", [["3", "ga"], ["4| sprigs", "sa"]]);
    assert.equal(rewordFeastSteps([s], [SA, GA], facts, [])[0].text, "Mash 6 tablespoons butter with the minced garlic and chopped sage leaves you prepped and 1 teaspoon pepper.");
    const OIL = row("oil", "olive oil");
    const rub = step(6, "Rub the turkey with 2 tablespoons olive oil and the garlic butter.", [["2 tablespoons", "oil"]]);
    assert.equal(rewordFeastSteps([rub], [SA, GA, OIL], facts, [])[0].text, rub.text);
  });
});

describe("THX-3d L — a citrus juiced in prep is poured", () => {
  const LE = row("le", "lemon"), SH = row("sh", "shallots"), SA = row("sa", "kosher salt");
  it("\"Squeeze the juice of 1 lemon over the beans\" → its jar; a tub that holds more than the lemon says the juice", () => {
    const jar: FeastDishFacts = { dishId: "b", mixes: [], cuts: [cut(LE, "Green beans citrus", "juiced", "own")] };
    assert.equal(rewordFeastSteps([step(5, "Squeeze the juice of 1 lemon over the beans.", [["1", "le"]])], [LE], jar, [])[0].text, "Pour the Green beans citrus you prepped over the beans.");
    const tub: FeastDishFacts = { dishId: "b", mixes: [], cuts: [cut(LE, "Green beans lemon & shallot", "zested and juiced", "own"), cut(SH, "Green beans lemon & shallot", "thinly sliced", "own")] };
    assert.equal(rewordFeastSteps([step(7, "Remove from heat; squeeze the lemon juice over the beans and add the lemon zest and ¼ teaspoon salt; toss to combine.", [["¼ teaspoon", "sa"]])], [LE, SH, SA], tub, [])[0].text,
      "Remove from heat; pour the lemon juice you prepped over the beans and add the lemon zest you prepped and ¼ teaspoon salt; toss to combine.");
  });
});

describe("THX-3d L — a mix is named where it goes in", () => {
  const CIN = row("cin", "ground cinnamon"), GIN = row("gin", "ground ginger"), NUT = row("nut", "ground nutmeg");
  const mix = { name: "Cheesecake bars spice mix", ids: new Set(["cin", "gin", "nut"]), keys: new Set(["ground cinnamon", "ground ginger", "ground nutmeg"].map(ingredientGroupKey)) };
  it("its measuring is a skip step, so the step that whisks it in names it (K's \"them\" is gone too)", () => {
    const out = rewordFeastSteps([
      step(4, "Make ahead (Wednesday): Measure 1½ teaspoons cinnamon, ½ teaspoon ginger, and ¼ teaspoon nutmeg.", [["1½ teaspoons", "cin"], ["½ teaspoon", "gin"], ["¼ teaspoon", "nut"]]),
      step(5, "Make ahead (Wednesday): Whisk the cinnamon, ginger, and nutmeg into the filling."),
    ], [CIN, GIN, NUT], { dishId: "c", mixes: [mix], cuts: [] }, []);
    assert.equal(out[0].text, "Make ahead (Wednesday): Skip if you prepped. Otherwise, measure 1½ teaspoons cinnamon, ½ teaspoon ginger, and ¼ teaspoon nutmeg.");
    assert.equal(out[1].text, "Make ahead (Wednesday): Whisk the Cheesecake bars spice mix you prepped into the filling.");
  });
  it("\"a pinch of cayenne\" is the cayenne pepper the spice mix holds; \"packed brown sugar\" is the brown sugar", () => {
    const CAY = row("cay", "cayenne pepper"), PAP = row("pap", "smoked paprika"), GP = row("gp", "garlic powder"), BS = row("bs", "brown sugar"), GS = row("gs", "granulated sugar");
    const spice = { name: "Mac and cheese spice mix", ids: new Set(["cay", "pap", "gp"]), keys: new Set(["cayenne pepper", "smoked paprika", "garlic powder"].map(ingredientGroupKey)) };
    const s = step(3, "Stir in 12 oz cheddar, ½ teaspoon smoked paprika, ½ teaspoon garlic powder, and a pinch of cayenne until smooth.", [["½ teaspoon| smoked", "pap"], ["½ teaspoon| garlic", "gp"]]);
    assert.equal(rewordFeastSteps([s], [CAY, PAP, GP], { dishId: "m", mixes: [spice], cuts: [] }, [])[0].text, "Stir in 12 oz cheddar and the Mac and cheese spice mix you prepped until smooth.");
    const sugar = { name: "Cranberry mix", ids: new Set(["gs", "bs"]), keys: new Set(["granulated sugar", "brown sugar"].map(ingredientGroupKey)) };
    const c = step(1, "Combine 1 cup granulated sugar, ¼ cup packed brown sugar, and ¼ cup water.", [["1 cup", "gs"], ["¼ cup| packed", "bs"]]);
    assert.equal(rewordFeastSteps([c], [GS, BS], { dishId: "c", mixes: [sugar], cuts: [] }, [])[0].text, "Combine the Cranberry mix you prepped and ¼ cup water.");
  });
});

describe("THX-3d L — the walk finds what the words miss", () => {
  it("a food prepped into a container and added loose; a mix's food added again for its moment", () => {
    const RO = row("ro", "fresh rosemary"), SU = row("su", "granulated sugar"), CI = row("ci", "ground cinnamon"), NU = row("nu", "ground nutmeg");
    const facts: FeastDishFacts = {
      dishId: "d",
      mixes: [{ name: "Bars spice mix", ids: new Set(["su", "ci", "nu"]), keys: new Set(["granulated sugar", "ground cinnamon", "ground nutmeg"].map(ingredientGroupKey)), amounts: new Map([[ingredientGroupKey("granulated sugar"), { qty: 0.75, unit: "cup" }]]) }],
      cuts: [cut(RO, "Turkey plate", "finely chopped", "plate")],
    };
    const steps = [
      step(1, "Mix 3 tablespoons butter with 2 sprigs finely chopped rosemary.", [["2 sprigs", "ro"]]),
      { ...step(3, "Beat the cream cheese with ¾ cup granulated sugar."), amountRefs: [{ ingredientId: "su", quantity: 0.75, unit: "cup", charStart: 30, charEnd: 37 }] },
      step(5, "Whisk the Bars spice mix into the filling."),
    ];
    const rows = [{ ...RO, quantity: 2, unit: "sprigs" }, { ...SU, quantity: 0.75, unit: "cup" }, { ...CI, quantity: 1, unit: "teaspoon" }, { ...NU, quantity: 0.25, unit: "teaspoon" }];
    assert.deepEqual(feastWordingFindings(steps, rows, facts, []).map((f) => `${f.kind}#${f.stepIndex}`), ["loose#1", "double#3"]);
  });
});

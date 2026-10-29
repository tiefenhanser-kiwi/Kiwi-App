// SERVER-10 F (BUG-585) — a prepped bowl is used ONCE, where its parts go in.
//
// Classic Savory Beef and Broccoli (catalog f57cb124, dish f7331c7c), steps verbatim.
// Soy sauce (4 tbsp), Shaoxing (2 tbsp) and cornstarch (3 tbsp) are "divided": half in
// the velvet at s0, half in the stir-fry sauce at s1. Prep put all of them, with the
// sauce's oyster sauce, dark soy and sesame oil, in one "Beef & broccoli sauce" jar;
// Cook Mode said the jar at s0 (and the oyster sauce, dark soy and sesame oil were
// still measured at s1): the bowl's parts used twice. Three causes, three rules:
//   1. prepComponents — an ingredient in two mixes joins neither (`split`);
//   2. prepCombineAdapter — a split row rides no jar (`v:split:`), and a step that
//      SEASONS a food is a use, not the jar's (Cashew Shrimp's salt and white pepper);
//   3. feastCookWording mentionsOf — "soy sauce" is not the "dark soy sauce" row.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveDishComponents, type ComponentStep } from "../prepComponents";
import { buildStepPlan } from "../prepWeekAssembly";
import { combinePrep } from "../prepCombineEngine";
import { buildPrepCombineInput } from "../prepCombineAdapter";
import { mentionsOf, rewordFeastSteps, type WordingStep } from "../feastCookWording";
import { deriveAmountRefs } from "../stepAmountRefs";
import { ingredientGroupKey } from "../ingredientRelations";

const step = (stepIndex: number, phaseType: string, text: string, o: { componentKey?: string; ids?: string[] } = {}): ComponentStep => ({
  stepIndex, text, phaseType, componentKey: o.componentKey ?? null, ingredientIds: o.ids ?? [],
});
const row = (ingredientId: string, ingredientName: string, category: string, quantity: number, unit: string, preparationNote: string | null = null) => ({
  ingredientId, ingredientName, category, quantity, unit, preparationNote, sourceYield: null,
});
function planOf(dishName: string, componentSteps: ComponentStep[], ingredients: ReturnType<typeof row>[]) {
  return {
    planId: "p1", planName: "Week",
    meals: [{
      mealId: "m1", mealName: dishName, cuisine: null, servingsOverride: null,
      dishes: [{ dishId: "d1", dishName, dishRole: "main", baseServings: 4, authoredBaseServings: 4, stepTexts: componentSteps.map((s) => s.text), componentSteps, ingredients }],
    }],
  };
}
/** container → the ingredient names the plan puts in it. */
function containers(loaded: ReturnType<typeof planOf>): Map<string, Set<string>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sp = buildStepPlan(combinePrep(buildPrepCombineInput(loaded as any)), "Week");
  const out = new Map<string, Set<string>>();
  for (const st of sp.steps) {
    if (st.demoted) continue;
    for (const c of st.components) for (const m of c.measures) {
      const dest = m.destination ?? st.bowlName;
      if (dest) out.set(dest, (out.get(dest) ?? new Set()).add(c.ingredientName));
    }
  }
  return out;
}
const holding = (all: Map<string, Set<string>>, name: string) => [...all].filter(([, s]) => s.has(name)).map(([k]) => k);

const BB_STEPS = [
  step(0, "prep", "In a medium bowl, combine the sliced flank steak with ½ teaspoon baking soda, 2 tablespoons soy sauce, 1 tablespoon Shaoxing rice wine, 1 tablespoon cornstarch, and ¼ teaspoon white pepper; toss well and let velvet for 15 minutes.", { ids: ["soda", "soy", "wine", "starch", "wpep"] }),
  step(1, "prep", "In a small bowl, whisk together 2 tablespoons soy sauce, 3 tablespoons oyster sauce, 1 tablespoon dark soy sauce, ½ cup beef broth, 1 tablespoon sesame oil, 1 teaspoon sugar, 1 tablespoon Shaoxing rice wine, and 2 tablespoons cornstarch until smooth; set aside.", { componentKey: "sauce", ids: ["soy", "oyster", "dark", "broth", "sesame", "sugar", "wine", "starch"] }),
  step(4, "cook", "Heat 2 tablespoons vegetable oil in a large wok over high heat; sear the steak until browned, about 2 minutes, then transfer to a plate.", { ids: ["oil"] }),
  step(7, "cook", "Return the beef to the wok, give the sauce a stir, pour it over, and toss until glossy and thickened, about 1 minute."),
];
const BB_ROWS = [
  row("steak", "flank steak", "Protein", 1.5, "pound", "thinly sliced against the grain"),
  row("soda", "baking soda", "Pantry", 0.5, "teaspoon"),
  row("soy", "soy sauce", "Pantry", 4, "tablespoon", "divided"),
  row("wine", "Shaoxing rice wine", "Pantry", 2, "tablespoon", "divided"),
  row("starch", "cornstarch", "Pantry", 3, "tablespoon", "divided"),
  row("wpep", "white pepper", "Pantry", 0.25, "teaspoon"),
  row("oyster", "oyster sauce", "Pantry", 3, "tablespoon"),
  row("dark", "dark soy sauce", "Pantry", 1, "tablespoon"),
  row("broth", "beef broth", "Pantry", 0.5, "cup"),
  row("sesame", "sesame oil", "Pantry", 1, "tablespoon"),
  row("sugar", "granulated sugar", "Pantry", 1, "teaspoon"),
  row("oil", "vegetable oil", "Pantry", 2, "tablespoon"),
];

describe("SERVER-10 F (BUG-585) — Beef and Broccoli's sauce jar is the sauce's alone", () => {
  it("rule 1: the divided rows are in two mixes, so they join neither", () => {
    const r = resolveDishComponents("Savory Beef and Broccoli Stir-Fry", null, BB_STEPS, BB_ROWS.map((x) => ({ ingredientId: x.ingredientId, ingredientName: x.ingredientName, preparationNote: x.preparationNote, phase: null })));
    assert.deepEqual([...r.split].sort(), ["soy", "starch", "wine"]);
    for (const id of r.split) assert.equal(r.byIngredient.get(id), undefined);
    assert.ok(r.byIngredient.get("oyster"), "the sauce keeps its own members");
  });

  it("rule 2: the jar holds oyster sauce, dark soy, sesame oil and sugar, and none of the divided rows", () => {
    const all = containers(planOf("Savory Beef and Broccoli Stir-Fry", BB_STEPS, BB_ROWS));
    const jar = holding(all, "oyster sauce");
    assert.equal(jar.length, 1);
    for (const m of ["dark soy sauce", "sesame oil"]) assert.deepEqual(holding(all, m), jar);
    for (const split of ["soy sauce", "Shaoxing rice wine", "cornstarch"]) assert.deepEqual(holding(all, split).filter((k) => jar.includes(k)), [], `${split} is not in the jar`);
  });

  it("rule 3: \"2 tablespoons soy sauce\" is the soy sauce row, \"1 tablespoon dark soy sauce\" the dark soy", () => {
    const s = BB_STEPS[1];
    const refs = [{ ingredientId: "soy", quantity: 2, unit: "tablespoons", charStart: s.text.indexOf("2 tablespoons soy"), charEnd: s.text.indexOf("2 tablespoons soy") + 13 }];
    const ms = mentionsOf({ stepIndex: 1, text: s.text, amountRefs: refs }, [{ ingredientId: "soy", name: "soy sauce" }, { ingredientId: "dark", name: "dark soy sauce" }, { ingredientId: "oyster", name: "oyster sauce" }], []);
    const at = (id: string) => ms.filter((m) => m.id === id).map((m) => s.text.slice(m.start, m.end));
    assert.deepEqual(at("soy"), ["2 tablespoons soy sauce"]);
    assert.deepEqual(at("dark"), ["dark soy sauce"]);
  });
});

describe("SERVER-10 F — a step that seasons a food is a use, not the sauce jar's", () => {
  it("Cashew Shrimp: the shrimp's salt and white pepper (s0) stay out of the sauce whisked at s2", () => {
    const steps = [
      step(0, "prep", "Pat the shrimp dry and season with ½ teaspoon kosher salt and ¼ teaspoon white pepper.", { ids: ["shrimp", "salt", "wpep"] }),
      step(2, "prep", "In a small bowl, whisk together 3 tablespoons soy sauce, 2 tablespoons oyster sauce, 1 tablespoon rice vinegar, 1 teaspoon sugar, and 1 teaspoon cornstarch; set aside.", { componentKey: "sauce", ids: ["soy", "oyster", "vinegar", "sugar", "starch"] }),
      step(4, "cook", "Heat the oil in a wok and stir-fry the shrimp for 2 minutes; add the sauce and cashews and toss until glossy.", { ids: ["oil", "cashew"] }),
    ];
    const rows = [
      row("shrimp", "large shrimp", "Protein", 1, "pound"), row("salt", "Kosher salt", "Pantry", 0.5, "teaspoon"), row("wpep", "white pepper", "Pantry", 0.25, "teaspoon"),
      row("soy", "soy sauce", "Pantry", 3, "tablespoon"), row("oyster", "oyster sauce", "Pantry", 2, "tablespoon"), row("vinegar", "rice vinegar", "Pantry", 1, "tablespoon"),
      row("sugar", "granulated sugar", "Pantry", 1, "teaspoon"), row("starch", "cornstarch", "Pantry", 1, "teaspoon"), row("oil", "vegetable oil", "Pantry", 2, "tablespoon"), row("cashew", "roasted cashews", "Pantry", 0.5, "cup"),
    ];
    const all = containers(planOf("Cashew Shrimp", steps, rows));
    const jar = holding(all, "oyster sauce");
    assert.equal(jar.length, 1);
    assert.deepEqual(holding(all, "white pepper").filter((k) => jar.includes(k)), []);
  });
});

// Classic Kung Pao (catalog a89d2f85) lists soy sauce twice: 2 tbsp in the marinade (s0)
// and 2 tbsp in the sauce (s1), so both jars hold soy. With the cornstarch out of the
// sauce jar (rule 1), the "early entry" rule took the marinade's soy for the sauce's and
// said the sauce jar at s0 as well.
describe("SERVER-10 F — a jar enters early only on a member that is its own", () => {
  type Row = { ingredientId: string; name: string; quantity: number; unit: string };
  const step = (i: number, text: string, rows: Row[]): WordingStep => ({ stepIndex: i, text, amountRefs: deriveAmountRefs(text, rows).amountRefs as never });
  const mix = (name: string, rows: Row[], amounts: [string, number, string][]) => ({
    name, ids: new Set(rows.map((r) => r.ingredientId)), keys: new Set(rows.map((r) => ingredientGroupKey(r.name))),
    amounts: new Map(amounts.map(([k, qty, unit]) => [k, { qty, unit }])),
  });
  it("Kung Pao: the marinade jar at s0, the sauce jar at s1, each once", () => {
    const rows: Row[] = [
      { ingredientId: "chicken", name: "chicken thigh pieces", quantity: 1.5, unit: "lb" },
      { ingredientId: "soy", name: "soy sauce", quantity: 4, unit: "tablespoon" },
      { ingredientId: "wine", name: "Shaoxing rice wine", quantity: 1, unit: "tablespoon" },
      { ingredientId: "starch", name: "cornstarch", quantity: 2, unit: "tablespoon" },
      { ingredientId: "sesame", name: "sesame oil", quantity: 1, unit: "teaspoon" },
      { ingredientId: "dark", name: "dark soy sauce", quantity: 1, unit: "tablespoon" },
      { ingredientId: "vinegar", name: "Chinkiang black vinegar", quantity: 2, unit: "tablespoon" },
      { ingredientId: "sugar", name: "sugar", quantity: 1.5, unit: "tablespoon" },
      { ingredientId: "stock", name: "chicken stock", quantity: 3, unit: "tablespoon" },
    ];
    const marinade = mix("Pao sauce 2", [rows[1], rows[2], rows[4]], [["soy sauce", 2, "tablespoon"], ["shaoxing rice wine", 1, "tablespoon"], ["sesame oil", 1, "teaspoon"]]);
    const sauce = mix("Pao sauce", [rows[1], rows[5], rows[6], rows[7]], [["soy sauce", 2, "tablespoon"], ["dark soy sauce", 1, "tablespoon"], ["chinkiang black vinegar", 2, "tablespoon"], ["sugar", 1.5, "tablespoon"]]);
    const texts = [
      "In a medium bowl, combine 1½ lb chicken thigh pieces with 2 tablespoons soy sauce, 1 tablespoon Shaoxing rice wine, 1 tablespoon cornstarch, and 1 teaspoon sesame oil; toss well and let marinate for 10 minutes.",
      "In a small bowl, whisk together 2 tablespoons soy sauce, 1 tablespoon dark soy sauce, 2 tablespoons Chinkiang black vinegar, 1½ tablespoons sugar, 3 tablespoons chicken stock, and 1 tablespoon cornstarch until smooth; set aside.",
    ];
    const out = rewordFeastSteps(texts.map((t, i) => step(i, t, rows)), rows, { dishId: "kp", mixes: [marinade, sauce], cuts: [] }, ["Classic Kung Pao Chicken"], { weeknight: true }).map((s) => s.text);
    assert.match(out[0], /the Pao sauce 2 you prepped/);
    assert.doesNotMatch(out[0], /the Pao sauce you prepped/, "the sauce jar never enters at the marinade");
    assert.match(out[1], /the Pao sauce you prepped/);
  });
});

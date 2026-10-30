// SERVER-12 B (BUG-619, D-WS9-362) — a split ingredient adds up. A row the steps divide
// between a prepped bowl and a later step is a portion per step: the bowl holds its own
// share, and the rest is measured where the recipe says. The steps are the catalog's own:
// Classic Pepper Steak (sesame oil ½ + ½), Nashville Hot Popcorn Chicken (garlic powder 1
// tsp in the dredge, ½ tsp in the glaze, listed twice), Wild Rice and Cranberry Stuffed
// Acorn Squash (maple syrup 1 tbsp brushed on the squash, 1 tbsp in the filling).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { dividedIds, keptStepRefs, type ComponentStep } from "../prepComponents";
import { buildStepPlan } from "../prepWeekAssembly";
import { combinePrep } from "../prepCombineEngine";
import { buildPrepCombineInput } from "../prepCombineAdapter";
import { rewordFeastSteps, type FeastDishFacts, type WordingStep } from "../feastCookWording";
import { deriveAmountRefs } from "../stepAmountRefs";
import { ingredientGroupKey } from "../ingredientRelations";

type Ref = { ingredientId: string; quantity: number };
const step = (stepIndex: number, phaseType: string, text: string, refs: Ref[], componentKey: string | null = null): ComponentStep => ({
  stepIndex, text, phaseType, componentKey, ingredientIds: [...new Set(refs.map((r) => r.ingredientId))], refs,
});
const row = (ingredientId: string, ingredientName: string, category: string, quantity: number, unit: string, preparationNote: string | null = null) => ({
  ingredientId, ingredientName, category, quantity, unit, preparationNote, sourceYield: null,
});
/** Classic Pepper Steak's dish as loadPrepWeekInput returns it (catalog 5d4e49a1), refs and all. */
const PEPPER_STEAK = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/server12PepperSteak.json"), "utf8")).dish;
/** Garlic-Ginger Shrimp Stir-Fry (8282d2dc) and Wild Rice and Cranberry Stuffed Acorn Squash (ab77e45d), as loaded. */
const SHARES = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/server12Shares.json"), "utf8"));
function planOf(dishName: string, componentSteps: ComponentStep[], ingredients: ReturnType<typeof row>[], feast = false) {
  return {
    planId: "p1", planName: "Week",
    meals: [{
      mealId: "m1", mealName: dishName, cuisine: null, servingsOverride: null, ...(feast ? { feast: true } : {}),
      dishes: [{ dishId: "d1", dishName, dishRole: "main", baseServings: 4, authoredBaseServings: 4, stepTexts: componentSteps.map((s) => s.text), componentSteps, ingredients }],
    }],
  };
}
/** container → each ingredient's measured amounts in it (demoted steps hold nothing). */
function containers(loaded: ReturnType<typeof planOf>, feast = false): Map<string, Map<string, string[]>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sp = buildStepPlan(combinePrep(buildPrepCombineInput(loaded as any, feast ? { feast: true } : {}), undefined, feast ? { feast: true } : {}), "Week", undefined, undefined, feast ? { feast: true } : {});
  const out = new Map<string, Map<string, string[]>>();
  for (const st of sp.steps) {
    if (st.demoted) continue;
    for (const c of st.components) for (const m of c.measures) {
      const dest = m.destination ?? st.bowlName;
      if (!dest) continue;
      const inner = out.get(dest) ?? new Map<string, string[]>();
      inner.set(c.ingredientName, [...(inner.get(c.ingredientName) ?? []), m.amount ?? ""]);
      out.set(dest, inner);
    }
  }
  return out;
}
const amountsOf = (all: Map<string, Map<string, string[]>>, name: string) => [...all].flatMap(([k, m]) => (m.get(name) ?? []).map((a) => `${k}: ${a}`));

const PEPPER_STEAK_STEPS = [
  step(0, "prep", "Slice the 1½ lb flank steak against the grain into ¼-inch strips, then toss with ¼ teaspoon baking soda, 2 tablespoons soy sauce, 1 tablespoon cornstarch, and ½ tablespoon sesame oil; let sit 15 minutes to velvet.",
    [{ ingredientId: "steak", quantity: 1.5 }, { ingredientId: "soda", quantity: 0.25 }, { ingredientId: "soy", quantity: 2 }, { ingredientId: "starch", quantity: 1 }, { ingredientId: "sesame", quantity: 0.5 }], "beef"),
  step(4, "cook", "Heat 2 tablespoons neutral oil in a wok or large skillet over high heat until shimmering, then add the marinated beef in a single layer and sear undisturbed for 1 minute.", [{ ingredientId: "oil", quantity: 2 }]),
  step(8, "cook", "Return the seared beef and any resting juices to the wok, toss everything together over high heat for 1 minute until the beef is cooked through and fully coated in the sauce, then drizzle with the remaining ½ tablespoon sesame oil.",
    [{ ingredientId: "sesame", quantity: 0.5 }]),
];
const PEPPER_STEAK_ROWS = [
  row("steak", "flank steak", "Protein", 1.5, "pound", "sliced against the grain into 1/4-inch strips"),
  row("soda", "baking soda", "Pantry", 0.25, "teaspoon"),
  row("soy", "soy sauce", "Pantry", 2, "tablespoon"),
  row("starch", "cornstarch", "Pantry", 1, "tablespoon"),
  row("sesame", "sesame oil", "Pantry", 1, "tablespoon", "divided"),
  row("oil", "vegetable oil", "Pantry", 2, "tablespoon"),
];

describe("SERVER-12 B — which rows the steps divide", () => {
  it("Pepper Steak's sesame oil, ½ + ½ of 1 tbsp, is divided; a row stated once is not", () => {
    assert.deepEqual([...dividedIds(PEPPER_STEAK_ROWS, PEPPER_STEAK_STEPS)], ["sesame"]);
  });

  it("a restatement is not a split: 2 bay leaves added and the 2 removed", () => {
    const steps = [step(0, "cook", "Add 2 bay leaves.", [{ ingredientId: "bay", quantity: 2 }]), step(5, "assemble", "Remove the 2 bay leaves.", [{ ingredientId: "bay", quantity: 2 }])];
    assert.equal(dividedIds([{ ingredientId: "bay", quantity: 2 }], steps).size, 0);
  });

  it("the loader keeps refs only where a row is divided (in the row's unit) or listed twice; never in a feast", () => {
    const rows = [{ ingredientId: "ketchup", quantity: 0.25, unit: "cup" }, { ingredientId: "salt", quantity: 1, unit: "teaspoon" }];
    const steps = [
      { stepIndex: 1, refs: [{ ingredientId: "ketchup", quantity: 2, unit: "tablespoons" }, { ingredientId: "salt", quantity: 1, unit: "teaspoon" }] },
      { stepIndex: 3, refs: [{ ingredientId: "ketchup", quantity: 2, unit: "tablespoons" }] },
    ];
    const kept = keptStepRefs(rows, steps);
    assert.deepEqual(kept.map((s) => s.refs), [[{ ingredientId: "ketchup", quantity: 0.125 }, { ingredientId: "salt", quantity: 1 }], [{ ingredientId: "ketchup", quantity: 0.125 }]]);
    assert.deepEqual(keptStepRefs(rows, steps, { feast: true }).map((s) => "refs" in s), [false, false], "a feast's dish is byte-unchanged");
    assert.deepEqual(keptStepRefs([rows[1]], [steps[0]]).map((s) => "refs" in s), [false], "nothing divided, nothing listed twice: no refs");
  });
});

describe("SERVER-12 B — the bowl holds its own share", () => {
  it("Pepper Steak: the velvet's jar holds ½ tbsp sesame oil, and the stove's ½ is no prep", () => {
    const all = containers(planOf(PEPPER_STEAK.dishName, PEPPER_STEAK.componentSteps, PEPPER_STEAK.ingredients));
    assert.deepEqual(amountsOf(all, "sesame oil").map((a) => a.replace(/^.*: /, "")), ["½ tbsp"], JSON.stringify([...all].map(([k, v]) => [k, [...v]])));
  });

  it("Nashville Hot: the dredge's 1 tsp and the glaze's ½ tsp garlic powder are two containers, not one with 1½", () => {
    const steps = [
      step(3, "prep", "In a shallow dish, whisk together 1½ cups all-purpose flour, ¼ cup cornstarch, 1 teaspoon garlic powder, 1 teaspoon onion powder, 1 teaspoon smoked paprika, ½ teaspoon black pepper, and 1½ teaspoons kosher salt.",
        [{ ingredientId: "flour", quantity: 1.5 }, { ingredientId: "starch", quantity: 0.25 }, { ingredientId: "gp", quantity: 1 }, { ingredientId: "op", quantity: 1 }, { ingredientId: "pap", quantity: 1 }, { ingredientId: "pep", quantity: 0.5 }, { ingredientId: "salt", quantity: 1.5 }]),
      step(4, "prep", "In a small bowl, whisk together 3 tablespoons melted unsalted butter, 2 tablespoons cayenne pepper, 1 tablespoon brown sugar, 1 teaspoon chili powder, and ½ teaspoon garlic powder to make the hot glaze; set aside.",
        [{ ingredientId: "butter", quantity: 3 }, { ingredientId: "cay", quantity: 2 }, { ingredientId: "sugar", quantity: 1 }, { ingredientId: "chili", quantity: 1 }, { ingredientId: "gp", quantity: 0.5 }]),
    ];
    const rows = [
      row("flour", "All-purpose flour", "Pantry", 1.5, "cup"), row("starch", "cornstarch", "Pantry", 0.25, "cup"), row("gp", "garlic powder", "Pantry", 1, "teaspoon"),
      row("op", "onion powder", "Pantry", 1, "teaspoon"), row("pap", "smoked paprika", "Pantry", 1, "teaspoon"), row("pep", "Black pepper", "Pantry", 0.5, "teaspoon"),
      row("salt", "Kosher salt", "Pantry", 1.5, "teaspoon"), row("butter", "unsalted butter", "Dairy", 3, "tablespoon", "melted"), row("cay", "cayenne pepper", "Pantry", 2, "tablespoon"),
      row("sugar", "brown sugar", "Pantry", 1, "tablespoon"), row("chili", "chili powder", "Pantry", 1, "teaspoon"), row("gp", "garlic powder", "Pantry", 0.5, "teaspoon", "for hot glaze"),
    ];
    const all = containers(planOf("Nashville Hot Popcorn Chicken", steps, rows));
    const gp = amountsOf(all, "garlic powder");
    assert.equal(gp.length, 2, JSON.stringify(gp));
    assert.notEqual(gp[0].split(":")[0], gp[1].split(":")[0], `one container each: ${JSON.stringify(gp)}`);
    const flourJar = [...all].find(([, m]) => m.has("All-purpose flour"))![0];
    const butterJar = [...all].find(([, m]) => m.has("unsalted butter") || m.has("cayenne pepper"))?.[0];
    assert.notEqual(flourJar, butterJar, "the dredge is not the glaze");
  });

  it("Garlic-Ginger Shrimp: the shrimp's ½ tbsp cornstarch (s0) does not ride the run into the sauce jar (s2)", () => {
    const all = containers(planOf(SHARES.shrimp.dishName, SHARES.shrimp.componentSteps, SHARES.shrimp.ingredients));
    assert.deepEqual(amountsOf(all, "cornstarch"), ["Garlic-Ginger Shrimp Stir-Fry sauce jar: 1 tbsp"]);
  });

  it("Wild Rice: the maple brushed on the squash (s1) is not in the filling's jar, though s8 names maple too", () => {
    const all = containers(planOf(SHARES.squash.dishName, SHARES.squash.componentSteps, SHARES.squash.ingredients));
    assert.deepEqual(amountsOf(all, "maple syrup"), ["Wild Rice and Cranberry Stuffed Acorn Squash sauce jar: 1 tbsp"]);
  });

  it("the feast keeps its containers as they were (frozen)", () => {
    const steps = PEPPER_STEAK.componentSteps as ComponentStep[];
    const before = containers(planOf(PEPPER_STEAK.dishName, steps.map(({ refs: _r, ...x }) => x), PEPPER_STEAK.ingredients, true), true);
    const feast = containers(planOf(PEPPER_STEAK.dishName, steps, PEPPER_STEAK.ingredients, true), true);
    assert.deepEqual([...feast].map(([k, v]) => [k, [...v]]), [...before].map(([k, v]) => [k, [...v]]), "the feast reads as if no refs were kept");
    assert.ok(amountsOf(feast, "sesame oil").some((a) => a.endsWith(": 1 tbsp")), "the feast's velvet still holds the whole row");
  });
});

describe("SERVER-12 B — Cook Mode names each jar where its own share goes in", () => {
  // Classic Beef Lo Mein (catalog cb3473cf), verbatim: the sesame oil is 1 tsp in the velvet
  // (s0) and 1 tsp in the sauce (s1), so prep has a velvet jar and a sauce jar, each with its
  // share. Matched by food alone, the velvet's "1 teaspoon sesame oil" also counted for the
  // sauce jar, which then "went in" at s0: "combine the steak with the Mein sauce 2 you
  // prepped and the Mein sauce you prepped".
  type Row = { ingredientId: string; name: string; quantity: number; unit: string };
  const rows: Row[] = [
    { ingredientId: "steak", name: "flank steak", quantity: 1.5, unit: "pound" }, { ingredientId: "dark", name: "dark soy sauce", quantity: 1, unit: "tablespoon" },
    { ingredientId: "soy", name: "soy sauce", quantity: 3, unit: "tablespoon" }, { ingredientId: "oyster", name: "oyster sauce", quantity: 3, unit: "tablespoon" },
    { ingredientId: "sesame", name: "sesame oil", quantity: 2, unit: "teaspoon" }, { ingredientId: "starch", name: "cornstarch", quantity: 2, unit: "teaspoon" },
    { ingredientId: "soda", name: "baking soda", quantity: 0.25, unit: "teaspoon" }, { ingredientId: "sugar", name: "sugar", quantity: 1, unit: "teaspoon" },
    { ingredientId: "wp", name: "white pepper", quantity: 0.25, unit: "teaspoon" },
  ];
  const at = (i: number, text: string): WordingStep => ({ stepIndex: i, text, amountRefs: deriveAmountRefs(text, rows).amountRefs as never });
  const steps = [
    at(0, "In a medium bowl, combine the 1½ lb thinly sliced flank steak with 1 tablespoon soy sauce, 2 teaspoons cornstarch, ¼ teaspoon baking soda, and 1 teaspoon sesame oil; toss well and let sit for 15 minutes to velvet."),
    at(1, "In a small bowl, whisk together 2 tablespoons soy sauce, 3 tablespoons oyster sauce, 1 tablespoon dark soy sauce, 1 teaspoon sesame oil, 1 teaspoon sugar, and ¼ teaspoon white pepper into the lo mein sauce; set aside."),
  ];
  const mix = (name: string, ids: string[], shares: [string, number][]) => ({
    name, ids: new Set(ids), keys: new Set(ids.map((id) => ingredientGroupKey(rows.find((r) => r.ingredientId === id)!.name))),
    shareSteps: new Map(shares.map(([id, s]) => [id, new Set([s])])),
  });
  const facts: FeastDishFacts = { dishId: "lm", cuts: [], mixes: [mix("Mein sauce", ["starch", "soda", "sesame"], [["sesame", 0]]), mix("Mein sauce 2", ["sugar", "wp", "soy", "oyster", "sesame"], [["sesame", 1]])] };

  it("the velvet step says the velvet's jar only; the sauce step says the sauce's", () => {
    const out = rewordFeastSteps(steps, rows, facts, ["Classic Beef Lo Mein"], { weeknight: true }).map((s) => s.text);
    assert.match(out[0], /the Mein sauce you prepped/);
    assert.doesNotMatch(out[0], /Mein sauce 2/, out[0]);
    assert.match(out[1], /the Mein sauce 2 you prepped/, out[1]);
  });
});

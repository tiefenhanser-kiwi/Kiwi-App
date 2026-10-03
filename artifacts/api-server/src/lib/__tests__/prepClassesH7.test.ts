// [prepcook] H7 — Hans, October 2: "Don't combine seasonings, oil, liquid with
// protein or veggies until cook. Veggies + veggies is ok if they go in the pan
// together." And the code, not the narrator, decides what is prep.
//
// Every test here is about an ABSENCE (no mixing, no grouping, no prep), so every
// one also asserts that its fixture produces the thing it is guarding — the H5
// lesson: a test whose subject is an absence passes on an empty plan.
//
// The class and serve-time fixtures run through the REAL adapter
// (`buildPrepCombineInput`), so the moment resolver and the component resolver are
// exercised, not just hand-set moment keys.
//
// "The narrator cannot flip skipSuggested" lives in prepWeekAssembly.test.ts, beside
// the assembly it pins.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildPrepCombineInput } from "../prepCombineAdapter";
import { assignPhase, combinePrep, type PrepCombineInput, type PrepPhaseKey } from "../prepCombineEngine";
import {
  buildStepPlan,
  containerNamesOf,
  storageClosesByStepKey,
  assemblePrepWeekResult,
  type PlannedStep,
  type StepPlan,
} from "../prepWeekAssembly";
import { applyStorageOverlay, type StorageContext } from "../prepStorage";
import { classOf } from "../prepClasses";
import { admitSubsumesEdge } from "../ingredientRelations";
import { proteinVerbsFor } from "../prepComponents";
import { PREP_PHASE_ORDER } from "../prepCombineEngine";
import type { PrepLoadedPlan } from "../prepWeekAggregation";
import type { PrepNarrationResult } from "../ai/schemas/prepNarration";

const MEAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// ── a loaded-plan fixture, so the adapter's moment logic runs ─────────────────

interface Ing {
  id: string;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  note?: string;
  pack?: string;
}
interface St {
  i: number;
  phase: string;
  text: string;
  ids?: string[];
  key?: string;
}
function loaded(dishes: { id: string; name: string; ings: Ing[]; steps: St[] }[]): PrepLoadedPlan {
  return {
    planId: "p",
    planName: "H7",
    meals: [
      {
        mealId: MEAL,
        mealName: "Week",
        cuisine: null,
        servingsOverride: null,
        dishes: dishes.map((d) => ({
          dishId: d.id,
          dishName: d.name,
          dishRole: "main",
          baseServings: 4,
          authoredBaseServings: 4,
          ingredients: d.ings.map((x) => ({
            ingredientId: x.id,
            ingredientName: x.name,
            category: x.category,
            quantity: x.quantity,
            unit: x.unit,
            preparationNote: x.note ?? null,
            sourceYield: null,
            purchaseUnit: x.pack ?? null,
          })),
          stepTexts: d.steps.map((s) => s.text),
          componentSteps: d.steps.map((s) => ({
            stepIndex: s.i,
            text: s.text,
            componentKey: s.key ?? null,
            ingredientIds: s.ids ?? [],
            phaseType: s.phase,
          })),
        })),
      } as never,
    ],
  };
}
const planFrom = (l: PrepLoadedPlan): StepPlan => {
  const texts = new Map<string, string[]>();
  for (const m of l.meals) for (const d of m.dishes) texts.set(d.dishId, d.stepTexts);
  return buildStepPlan(combinePrep(buildPrepCombineInput(l)), l.planName, texts);
};

/** THE SLOW COOKER, from Hans's sample plan: raw thighs, vegetables, a dry seasoning. */
const slowCooker = () =>
  loaded([
    {
      id: "d-slow",
      name: "Slow-Cooker Chicken and Dumplings",
      ings: [
        { id: "thighs", name: "boneless skinless chicken thighs", category: "Protein", quantity: 1.75, unit: "lb", note: "trimmed of excess fat" },
        { id: "onion", name: "yellow onion", category: "Produce", quantity: 1, unit: "each", note: "diced" },
        { id: "celery", name: "celery stalks", category: "Produce", quantity: 3, unit: "each", note: "sliced into ½-inch pieces" },
        { id: "carrot", name: "carrots", category: "Produce", quantity: 3, unit: "each", note: "peeled and sliced into ½-inch coins" },
        { id: "garlic", name: "garlic cloves", category: "Produce", quantity: 3, unit: "clove", note: "minced" },
        { id: "thyme", name: "dried thyme", category: "Pantry", quantity: 1, unit: "tsp" },
        { id: "rosemary", name: "dried rosemary", category: "Pantry", quantity: 0.5, unit: "tsp" },
        { id: "gp", name: "garlic powder", category: "Pantry", quantity: 0.5, unit: "tsp" },
        { id: "op", name: "onion powder", category: "Pantry", quantity: 0.5, unit: "tsp" },
      ],
      steps: [
        { i: 0, phase: "prep", text: "Dice the yellow onion, slice 3 celery stalks, peel and slice 3 carrots, and mince 3 garlic cloves.", ids: ["celery", "carrot", "garlic"] },
        { i: 1, phase: "cook", text: "Place the trimmed chicken thighs in the slow cooker and scatter the onion, celery, carrots, and garlic over and around them.", ids: ["thighs"] },
        { i: 2, phase: "cook", text: "Whisk together the broth, 1 teaspoon dried thyme, ½ teaspoon dried rosemary, ½ teaspoon garlic powder and ½ teaspoon onion powder, then pour over the chicken.", ids: ["thyme", "rosemary", "gp", "op"] },
        { i: 3, phase: "cook", text: "Cover and cook on low for 6 hours." },
      ],
    },
    // The taco filling puts a vegetable, an aromatic and three spices into the pan in
    // ONE step — so the moment cannot separate them, and only the class rule can.
    {
      id: "d-taco",
      name: "Tex-Mex Ground Beef",
      ings: [
        { id: "t-onion", name: "white onion", category: "Produce", quantity: 1, unit: "each", note: "finely diced" },
        { id: "t-garlic", name: "garlic", category: "Produce", quantity: 2, unit: "clove", note: "minced" },
        { id: "t-cumin", name: "ground cumin", category: "Pantry", quantity: 1, unit: "tsp" },
        { id: "t-chili", name: "chili powder", category: "Pantry", quantity: 2, unit: "tsp" },
        { id: "t-pap", name: "smoked paprika", category: "Pantry", quantity: 1, unit: "tsp" },
      ],
      steps: [
        { i: 0, phase: "prep", text: "Finely dice the onion and mince the garlic.", ids: ["t-onion", "t-garlic", "t-cumin", "t-chili", "t-pap"] },
        { i: 1, phase: "cook", text: "Add the onion, garlic, cumin, chili powder and smoked paprika to the pan and cook for 3 minutes." },
      ],
    },
  ]);

/** THE CAESAR, from `c62587bb`: a dressing whisked ahead, romaine tossed at the table. */
const caesar = () =>
  loaded([
    {
      id: "d-caesar",
      name: "Caesar Salad",
      ings: [
        { id: "romaine", name: "romaine lettuce hearts", category: "Produce", quantity: 2, unit: "each", note: "chopped" },
        { id: "garlic", name: "garlic cloves", category: "Produce", quantity: 1, unit: "clove", note: "minced" },
        { id: "lemon", name: "fresh lemon juice", category: "Produce", quantity: 2, unit: "tbsp" },
        { id: "mayo", name: "mayonnaise", category: "Pantry", quantity: 0.5, unit: "cup", pack: "jar" },
        { id: "dijon", name: "dijon mustard", category: "Pantry", quantity: 1, unit: "tsp", pack: "jar" },
        { id: "worc", name: "worcestershire sauce", category: "Pantry", quantity: 1, unit: "tsp", pack: "bottle" },
      ],
      steps: [
        { i: 0, phase: "prep", text: "Chop the romaine hearts into bite-sized pieces.", ids: ["romaine"] },
        { i: 1, phase: "prep", text: "Whisk together the mayonnaise, lemon juice, dijon mustard, worcestershire sauce and minced garlic.", ids: ["mayo", "lemon", "dijon", "worc", "garlic"] },
        { i: 2, phase: "assemble", text: "Toss the romaine with the dressing and top with the croutons and parmesan." },
      ],
    },
  ]);

/** The phase-and-class view of every container on a plan, from the step plan alone. */
function containersOf(sp: StepPlan, phaseByName: Map<string, PrepPhaseKey | null>) {
  const out = new Map<string, Set<string>>();
  for (const s of sp.steps) {
    if (s.demoted || s.holdsNoContainer || s.cookDaySentence) continue;
    for (const n of containerNamesOf(s)) {
      const classes = out.get(n) ?? new Set<string>();
      for (const c of s.components) {
        if (s.bowlName === n || c.measures.some((m) => m.destination === n)) {
          classes.add(classOf(phaseByName.get(c.ingredientName) ?? null, c.ingredientName));
        }
      }
      out.set(n, classes);
    }
  }
  return out;
}
const phases = (l: PrepLoadedPlan) =>
  new Map(
    l.meals.flatMap((m) =>
      m.dishes.flatMap((d) =>
        d.ingredients.map((i) => [i.ingredientName, assignPhase(i.category, i.ingredientName, i.purchaseUnit)] as const),
      ),
    ),
  );

// ── 1 ───────────────────────────────────────────────────────────────────────

describe("H7 1 — no container mixes classes A, B and C", () => {
  it("🔴 the slow cooker: vegetables in one, the dry seasoning in another, the thighs in neither", () => {
    const l = slowCooker();
    const sp = planFrom(l);
    const byName = containersOf(sp, phases(l));
    // Non-vacuity: the fixture forms BOTH kinds of container.
    const kinds = [...byName.values()].map((s) => [...s].filter((c) => c !== "aromatic").join(""));
    assert.ok(kinds.includes("A"), `no seasoning container formed: ${[...byName.keys()].join(" | ")}`);
    assert.ok(kinds.includes("B"), `no vegetable container formed: ${[...byName.keys()].join(" | ")}`);
    for (const [name, classes] of byName) {
      const real = [...classes].filter((c) => c !== "aromatic");
      assert.ok(real.length <= 1, `"${name}" mixes classes ${real.join("+")}`);
      assert.ok(!classes.has("C"), `"${name}" holds raw protein`);
    }
    // The four vegetables are ONE container: they go into the cooker together.
    const veg = [...byName.keys()].find((n) => /Slow-Cooker.*vegetables/.test(n))!;
    assert.ok(veg, `no slow-cooker vegetable container: ${[...byName.keys()].join(" | ")}`);
    const vegSteps = sp.steps.filter((s) => s.phase === "produce" && containerNamesOf(s).includes(veg));
    assert.equal(vegSteps.length, 4, "onion, celery, carrots and garlic should share one container");
    // …and the taco pan's onion and spices, entering in ONE step, are two containers.
    const tacoSpices = [...byName.keys()].find((n) => /Tex-Mex Ground Beef spice blend/.test(n));
    assert.ok(tacoSpices, `the taco spices formed no blend: ${[...byName.keys()].join(" | ")}`);
  });
});

// ── 2 ───────────────────────────────────────────────────────────────────────

describe("H7 2 — a serve-time step groups nothing", () => {
  it("🔴 the romaine is never chopped into the Caesar dressing jar", () => {
    const l = caesar();
    const sp = planFrom(l);
    const dressing = sp.steps.find((s) => s.bowlName && /dressing|sauce jar/i.test(s.bowlName)); // J.1 R2: named by form
    assert.ok(dressing, "fixture: the whisked dressing must still form");
    const romaine = sp.steps.find((s) => s.components.some((c) => c.ingredientName === "romaine lettuce hearts"))!;
    for (const c of romaine.components) {
      for (const m of c.measures) assert.notEqual(m.destination, dressing!.bowlName, "the romaine went into the dressing");
    }
    // …and the garlic, whisked INTO the dressing, is in it: an aromatic joins the
    // liquid it enters with.
    const garlic = sp.steps.find((s) => s.components.some((c) => c.ingredientName === "garlic cloves"))!;
    assert.equal(garlic.components[0].measures[0].destination, dressing!.bowlName);
  });

  it("🔴 a garnish tossed into a COOKED dish at the table shares no container", () => {
    // H7.1 2a groups a cold RAW mixture (pico, slaw, a chopped salad), so a raw toss
    // no longer isolates this guard. A cooked dish does: the pasta is boiled, then
    // tossed with tomatoes and basil to serve. Two produce items, so the class rule
    // would let them share — only "serve time groups nothing" keeps them apart.
    const l = loaded([
      {
        id: "d-pasta",
        name: "Summer Pasta",
        ings: [
          { id: "tom", name: "tomatoes", category: "Produce", quantity: 2, unit: "each", note: "halved" },
          { id: "bas", name: "basil", category: "Produce", quantity: 0.25, unit: "cup", note: "torn" },
        ],
        steps: [
          { i: 0, phase: "prep", text: "Halve the tomatoes and tear the basil.", ids: ["tom", "bas"] },
          { i: 1, phase: "cook", text: "Boil the pasta until al dente and drain." },
          { i: 2, phase: "assemble", text: "Toss the cooked pasta with the tomatoes and basil and serve." },
        ],
      },
    ]);
    const sp = planFrom(l);
    const dest = (n: string) =>
      sp.steps.find((s) => s.components.some((c) => c.ingredientName === n))!.components[0].measures[0].destination;
    assert.ok(dest("tomatoes") && dest("basil"), "fixture: both are cut and labelled");
    assert.notEqual(dest("tomatoes"), dest("basil"), "a table-side toss shared a container");
  });
});

// ── 3 ───────────────────────────────────────────────────────────────────────

describe("H7 3 (2a) — a lone cut portion gets a `<Dish> — <item>` container", () => {
  it("🔴 the cornbread's diced jalapeño has a lid; a whole item has no line at all", () => {
    const input: PrepCombineInput = {
      meals: [
        {
          mealId: MEAL,
          mealName: "Chili Night",
          dishes: [
            {
              dishId: "d-corn",
              dishName: "Jalapeño Cheddar Cornbread",
              dishRole: "side",
              ingredients: [
                { ingredientId: "jal", ingredientName: "jalapeño", category: "Produce", quantity: 1, unit: "each", preparationNote: "seeded and finely diced" },
                { ingredientId: "gar", ingredientName: "garlic", category: "Produce", quantity: 3, unit: "clove", preparationNote: "unpeeled" },
              ],
            },
          ],
        },
      ],
    };
    const sp = buildStepPlan(combinePrep(input), "P");
    const jal = sp.steps.find((s) => s.components.some((c) => c.ingredientName === "jalapeño"));
    assert.ok(jal && !jal.demoted, "fixture: the jalapeño is prep");
    assert.equal(jal!.components[0].measures[0].destination, "Jalapeño Cheddar Cornbread — finely diced jalapeño");
    // The no-work floor (H6.2) still holds: three unpeeled cloves are not a line.
    assert.ok(!sp.steps.some((s) => !s.demoted && s.components.some((c) => c.ingredientName === "garlic")));
  });
});

// ── 4 ───────────────────────────────────────────────────────────────────────

function overlay(sp: StepPlan) {
  const closes = storageClosesByStepKey(sp.steps, sp.containerExtras);
  const ctx = new Map<string, StorageContext>();
  for (const st of sp.steps) {
    const names = st.components.map((c) => c.ingredientName);
    ctx.set(st.stepKey, {
      phase: st.phase,
      text: names.join(" "),
      bowlName: st.bowlName,
      ingredientNames: names,
      ...(st.phase === "proteins" ? { daysUntilCook: 1 } : {}),
      ...(closes.has(st.stepKey) ? { closes: closes.get(st.stepKey)! } : {}),
      ...(st.marinadeJoin ? { marinadeJoin: st.marinadeJoin } : {}),
    });
  }
  const narration: PrepNarrationResult = {
    steps: sp.narrationInput.steps.map((s) => ({ stepId: s.stepId, title: "T", instructions: "I" })),
  };
  return applyStorageOverlay(assemblePrepWeekResult(sp, narration), ctx);
}

describe("H7 4 (2b) — every container closes exactly once, on its last step", () => {
  it("🔴 the slow cooker's vegetables are closed by the LAST knife step that fills them", () => {
    const sp = planFrom(slowCooker());
    const rank = (s: PlannedStep) => PREP_PHASE_ORDER.indexOf(s.phase) * 1000 + s.number;
    const live = sp.steps.filter((s) => !s.demoted && !s.holdsNoContainer && !s.cookDaySentence);
    const names = new Set(live.flatMap(containerNamesOf));
    assert.ok(names.size >= 2, "fixture: two containers at least");
    let filledByOthers = 0;
    for (const n of names) {
      const touchers = live.filter((s) => containerNamesOf(s).includes(n)).sort((a, b) => rank(a) - rank(b));
      const closers = live.filter((s) => (s.closes ?? []).includes(n));
      assert.equal(closers.length, 1, `"${n}" is closed ${closers.length} times`);
      assert.equal(closers[0], touchers[touchers.length - 1], `"${n}" is closed before its last step`);
      if (!touchers.some((t) => t.bowlName === n)) filledByOthers += 1;
    }
    // Non-vacuity: the defect was a container that NO step owns.
    assert.ok(filledByOthers > 0, "fixture: a container filled only by knife steps");
    // …and on the wire: its closer carries a storage line, the others carry none.
    const wire = new Map(overlay(sp).phases.flatMap((p) => p.steps).map((s) => [s.stepKey, s]));
    for (const st of live) {
      const note = wire.get(st.stepKey)!.storageNote;
      if ((st.closes ?? []).length > 0) assert.ok(note, `${st.stepKey} closes a container and says nothing`);
      else if (containerNamesOf(st).length > 0) assert.equal(note, undefined, `${st.stepKey} closes nothing yet has a line`);
    }
    // The raw thighs are alone and close themselves: "cook within 2 days".
    const thighs = [...wire.values()].find((s) => s.stepKey.startsWith("proteins#"))!;
    assert.match(thighs.storageNote ?? "", /cook within 2 days/);
  });
});

// ── 5, 6 ────────────────────────────────────────────────────────────────────

describe("H7 5 (2c) — a heated step is never prep", () => {
  it("🔴 'Brown the Italian sausage' is cooking; 'Trim the thighs' is prep", () => {
    const l = loaded([
      {
        id: "d-pizza",
        name: "Classic Supreme Pizza",
        ings: [{ id: "saus", name: "Italian sausage", category: "Protein", quantity: 0.5, unit: "lb" }],
        steps: [{ i: 0, phase: "cook", text: "Brown the Italian sausage in a skillet, breaking it up, until no pink remains.", ids: ["saus"] }],
      },
      {
        id: "d-thighs",
        name: "Harissa Chicken Thighs",
        ings: [{ id: "th", name: "boneless skinless chicken thighs", category: "Protein", quantity: 2, unit: "lb" }],
        steps: [{ i: 0, phase: "prep", text: "Trim the chicken thighs of excess fat.", ids: ["th"] }],
      },
    ]);
    const sp = planFrom(l);
    const step = (n: string) => sp.steps.find((s) => s.components.some((c) => c.ingredientName === n))!;
    assert.ok(step("Italian sausage").demoted, "browning the sausage was kept as prep");
    assert.equal(step("boneless skinless chicken thighs").demoted, undefined, "fixture: trimming is prep");
  });
});

describe("H7 6 (2c) — a single-item measure is never prep", () => {
  it("🔴 one spice, a two-spice 'seasoning', a lone condiment: none of them; three spices: yes", () => {
    const one = (dishId: string, dishName: string, ings: [string, string, string?][]) => ({
      dishId,
      dishName,
      dishRole: "main" as const,
      ingredients: ings.map(([id, name, pack]) => ({
        ingredientId: id,
        ingredientName: name,
        category: "Pantry",
        quantity: 1,
        unit: "tsp",
        purchaseUnit: pack ?? "container",
      })),
    });
    const input: PrepCombineInput = {
      meals: [
        {
          mealId: MEAL,
          mealName: "Week",
          dishes: [
            // The Alfredo's two-item "seasoning" (garlic powder + Italian seasoning) —
            // made tier-3 eligible by a third dry item measured at another moment.
            { ...one("d-alf", "Chicken and Broccoli Alfredo", [["gp", "garlic powder"], ["it", "Italian seasoning"], ["pen", "penne pasta"]]) },
            one("d-taco", "Taco Toppings", [["hot", "hot sauce", "bottle"]]),
            one("d-chili", "Chili", [["cum", "ground cumin"], ["chp", "chili powder"], ["pap", "smoked paprika"]]),
          ],
        },
      ],
    };
    // The Alfredo's members enter at two different cook steps.
    for (const i of input.meals[0].dishes[0].ingredients) (i as { momentKey?: string }).momentKey = i.ingredientId === "pen" ? "s:3" : "s:5";
    const sp = buildStepPlan(combinePrep(input), "P");
    const live = sp.steps.filter((s) => !s.demoted);
    const liveNames = live.flatMap((s) => s.components.map((c) => c.ingredientName));
    for (const n of ["garlic powder", "Italian seasoning", "penne pasta", "hot sauce"]) {
      assert.ok(!liveNames.includes(n), `${n} is on the prep list`);
    }
    // Non-vacuity: a real three-spice blend is still prep.
    const blend = live.find((s) => s.isBlend && s.components.length === 3);
    assert.ok(blend, "a three-spice blend vanished too");
  });
});

// ── 8 ───────────────────────────────────────────────────────────────────────

describe("H7 8 (2d) — one produce step per food identity, citrus included", () => {
  it("🔴 lemon, lemon juice, fresh lemon juice and lemon zest are ONE step", () => {
    const y = (fromName: string) => ({ fromName, quantity: 3, unit: "tbsp" });
    const input: PrepCombineInput = {
      meals: [
        {
          mealId: MEAL,
          mealName: "Week",
          dishes: [
            { dishId: "d1", dishName: "Harissa Chicken", dishRole: "main", ingredients: [{ ingredientId: "lemon", ingredientName: "lemon", category: "Produce", quantity: 1, unit: "each", preparationNote: "zested" }] },
            { dishId: "d2", dishName: "Caesar", dishRole: "main", ingredients: [{ ingredientId: "fjuice", ingredientName: "fresh lemon juice", category: "Produce", quantity: 2, unit: "tbsp", sourceYield: y("fresh lemon") }] },
            { dishId: "d3", dishName: "Soup", dishRole: "main", ingredients: [{ ingredientId: "juice", ingredientName: "lemon juice", category: "Produce", quantity: 1, unit: "tbsp", sourceYield: y("lemon") }] },
            { dishId: "d4", dishName: "Couscous", dishRole: "side", ingredients: [{ ingredientId: "zest", ingredientName: "lemon zest", category: "Produce", quantity: 1, unit: "tsp", sourceYield: y("lemon") }] },
          ],
        },
      ],
    };
    const sp = buildStepPlan(combinePrep(input), "P");
    const citrus = sp.steps.filter((s) => s.components.some((c) => /lemon/.test(c.ingredientName)));
    assert.equal(citrus.length, 1, `lemon is worked in ${citrus.length} steps: ${citrus.map((s) => s.stepKey).join(", ")}`);
    assert.equal(citrus[0].phase, "produce");
    assert.equal(citrus[0].stepKey, "produce#lemon", "the whole fruit owns the merged key");
    assert.equal(new Set(citrus[0].components.map((c) => c.ingredientName)).size, 4);
  });

  it("🔴 the parsley pair folds exactly when the grocery lane folds it (H3, one bunch)", () => {
    const row = {
      label: "subsumes" as const,
      fromCanonicalName: "fresh parsley",
      toCanonicalName: "fresh flat-leaf parsley",
      yieldQuantity: null,
      yieldUnit: null,
      coHarvestable: null,
      confidence: "high" as const,
      reviewedByHuman: false,
      fromDefaultUnit: "bunch",
      fromPurchaseUnit: "bunch",
    };
    const both = new Set(["fresh parsley", "fresh flat-leaf parsley"]);
    assert.ok(admitSubsumesEdge(row, { demanded: both, packUnitOf: () => "bunch" }), "both on the plan, one bunch");
    // …and not when the plan asked only for the specific (H3's own gate).
    assert.equal(
      admitSubsumesEdge(row, { demanded: new Set(["fresh flat-leaf parsley"]), packUnitOf: () => "bunch" }),
      null,
    );
  });
});

// ── 9 ───────────────────────────────────────────────────────────────────────

describe("H7 9 (2e) — no condiment in the dry phase", () => {
  it("🔴 dijon and mayonnaise are bought by the jar, so they are poured, not measured dry", () => {
    const dish = (packs: boolean): PrepCombineInput => ({
      meals: [
        {
          mealId: MEAL,
          mealName: "Week",
          dishes: [
            {
              dishId: "d-tuna",
              dishName: "Tuna Melts",
              dishRole: "main",
              ingredients: [
                ["dijon", "dijon mustard", "jar"],
                ["mayo", "mayonnaise", "jar"],
                ["cum", "ground cumin", "container"],
                ["pap", "smoked paprika", "container"],
                ["cay", "cayenne pepper", "container"],
              ].map(([id, name, pack]) => ({
                ingredientId: id,
                ingredientName: name,
                category: "Pantry",
                quantity: 1,
                unit: "tsp",
                ...(packs ? { purchaseUnit: pack } : {}),
              })),
            },
          ],
        },
      ],
    });
    const dryNames = (input: PrepCombineInput) =>
      combinePrep(input).phases.find((p) => p.phase === "seasonings_dry")!.entries.map((e) => e.ingredientName);
    // Non-vacuity: by NAME alone both land in the dry phase — that was the defect.
    assert.ok(dryNames(dish(false)).includes("dijon mustard"), "fixture: the name rule must misfile dijon");
    const dry = dryNames(dish(true));
    assert.ok(!dry.includes("dijon mustard") && !dry.includes("mayonnaise"), `condiment in the dry phase: ${dry.join(", ")}`);
    assert.deepEqual(dry.sort(), ["cayenne pepper", "ground cumin", "smoked paprika"]);
  });
});

// ── 10 ──────────────────────────────────────────────────────────────────────

describe("H7 10 (2f) — the 'already in it' list equals what is in the container", () => {
  it("🔴 the potatoes moved to cook day are not 'already in it'; the verb is the code's", () => {
    const C = { key: "herb", noun: "marinade", bowlName: "Garlic Herb Potatoes marinade bowl" };
    const m = (id: string, name: string, category: string, note?: string) => ({
      ingredientId: id,
      ingredientName: name,
      category,
      quantity: 1,
      unit: "tbsp",
      ...(note ? { preparationNote: note } : {}),
      component: C,
      momentKey: "c:herb",
    });
    const input: PrepCombineInput = {
      meals: [
        {
          mealId: MEAL,
          mealName: "Week",
          dishes: [
            {
              dishId: "d-pot",
              dishName: "Garlic Herb Potatoes",
              dishRole: "side",
              ingredients: [
                m("pot", "baby Yukon gold potatoes", "Produce", "halved"),
                m("gar", "garlic cloves", "Produce", "minced"),
                m("ros", "fresh rosemary", "Produce", "chopped"),
                m("lem", "lemon juice", "Produce", "freshly squeezed"),
                m("oil", "extra-virgin olive oil", "Pantry"),
              ],
            },
          ],
        },
      ],
    };
    const sp = buildStepPlan(combinePrep(input), "P");
    const finish = sp.steps.find((s) => s.bowlName === C.bowlName && s.phase === "sauces_marinades");
    assert.ok(finish, "fixture: the container is finished in phase 3");
    // What the earlier steps actually put in it, read off the steps themselves.
    const putIn = new Set(
      sp.steps
        .filter((s) => !s.demoted && s !== finish && containerNamesOf(s).includes(C.bowlName))
        .flatMap((s) => s.components.filter((c) => c.measures.some((x) => x.destination === C.bowlName)).map((c) => c.ingredientName)),
    );
    const held = (finish!.containerHolds ?? []).map((h) => h.replace(/^the (.+) from produce step \d+$/, "$1"));
    assert.deepEqual([...held].sort(), [...putIn].sort());
    assert.ok(!held.includes("baby Yukon gold potatoes"), "the potatoes were moved to cook day");
    assert.ok(held.length >= 2, "fixture: the bowl must already hold things");
    // The opening is built from that list, and the close from the members.
    for (const h of finish!.containerHolds!) assert.ok(finish!.openingClause!.includes(h), `opening is missing ${h}`);
    assert.equal(finish!.closingLine, "Whisk to combine.");
    // And both reach the narrator as fixed text.
    const ni = sp.narrationInput.steps.find((s) => s.stepId === finish!.stepId)!;
    assert.equal(ni.openingClause, finish!.openingClause);
    assert.equal(ni.closingLine, "Whisk to combine.");
  });
});

// ── found on the H7 AI run ─────────────────────────────────────────────────────

describe("H7 — two defects the regenerated plans showed", () => {
  it("🔴 '1½ pounds shrimp' is a weight, not the verb: no 'Pound the shrimp'", () => {
    assert.deepEqual(proteinVerbsFor(null, "Toss 1½ pounds shrimp with the lemon zest, then sear."), []);
    assert.deepEqual(proteinVerbsFor(null, "Place the 2 pounds bone-in chicken thighs in a large pot."), []);
    // Non-vacuity: the verb itself still reads.
    assert.deepEqual(proteinVerbsFor(null, "Pound the chicken breasts to an even thickness."), ["pound"]);
  });

  it("🔴 a cook-day line never points at a bowl the floor dissolved", () => {
    // The Alfredo's chicken was sent "into the Chicken and Broccoli Alfredo seasoning"
    // on cook day: a two-item blend that no longer exists, and the line replaced the
    // chicken's own step.
    const SEASONING = { key: "seasoning", noun: "seasoning", bowlName: "Alfredo seasoning" };
    const input: PrepCombineInput = {
      meals: [
        {
          mealId: MEAL,
          mealName: "Week",
          dishes: [
            {
              dishId: "d-alf",
              dishName: "Alfredo",
              dishRole: "main",
              ingredients: [
                { ingredientId: "gp", ingredientName: "garlic powder", category: "Pantry", quantity: 1, unit: "tsp", component: SEASONING, momentKey: "c:seasoning" },
                { ingredientId: "it", ingredientName: "Italian seasoning", category: "Pantry", quantity: 1, unit: "tsp", component: SEASONING, momentKey: "c:seasoning" },
                { ingredientId: "chx", ingredientName: "boneless skinless chicken breasts", category: "Protein", quantity: 1.5, unit: "lb", preparationNote: "cut into strips", cookDayInto: "Alfredo seasoning" },
              ],
            },
          ],
        },
      ],
    };
    const sp = buildStepPlan(combinePrep(input), "P");
    const chicken = sp.steps.filter((s) => s.components.some((c) => /chicken/.test(c.ingredientName)));
    assert.equal(chicken.length, 1);
    assert.equal(chicken[0].cookDaySentence, undefined, `points at a dissolved bowl: ${chicken[0].cookDaySentence}`);
    assert.equal(chicken[0].demoted, undefined, "the chicken's own knife work was lost");
  });
});

// ══ H7.1 — mixtures that are meant to sit ════════════════════════════════════════

/** Step plan + overlay with real cook-day lags, so the "now / on cook day" lines run. */
function overlayAt(l: PrepLoadedPlan, lag: number, dayName = "Tuesday") {
  const texts = new Map<string, string[]>();
  for (const m of l.meals) for (const d of m.dishes) texts.set(d.dishId, d.stepTexts);
  const sp = buildStepPlan(combinePrep(buildPrepCombineInput(l)), l.planName, texts, new Map([[MEAL, lag]]));
  const closes = storageClosesByStepKey(sp.steps, sp.containerExtras);
  const ctx = new Map<string, StorageContext>();
  for (const st of sp.steps) {
    const names = st.components.map((c) => c.ingredientName);
    ctx.set(st.stepKey, {
      phase: st.phase,
      text: names.join(" "),
      bowlName: st.bowlName,
      ingredientNames: names,
      daysUntilCook: st.daysUntilCook,
      dayName,
      ...(closes.has(st.stepKey) ? { closes: closes.get(st.stepKey)! } : {}),
      ...(st.marinadeJoin ? { marinadeJoin: st.marinadeJoin } : {}),
    });
  }
  const narration: PrepNarrationResult = {
    steps: sp.narrationInput.steps.map((s) => ({ stepId: s.stepId, title: "T", instructions: "I" })),
  };
  return { sp, wire: applyStorageOverlay(assemblePrepWeekResult(sp, narration), ctx) };
}
const notes = (w: ReturnType<typeof overlayAt>["wire"]) =>
  w.phases.flatMap((p) => p.steps.map((s) => s.storageNote ?? "")).join(" | ");
const destOf = (sp: StepPlan, n: string) =>
  sp.steps.find((s) => s.components.some((c) => c.ingredientName === n))?.components[0].measures[0].destination;

const pico = () =>
  loaded([
    {
      id: "d-pico",
      name: "Fresh Pico de Gallo",
      ings: [
        { id: "tom", name: "roma tomatoes", category: "Produce", quantity: 4, unit: "each", note: "seeded and finely diced" },
        { id: "oni", name: "white onion", category: "Produce", quantity: 0.5, unit: "each", note: "finely diced" },
        { id: "jal", name: "jalapeño", category: "Produce", quantity: 1, unit: "each", note: "seeded and minced" },
        { id: "cil", name: "fresh cilantro", category: "Produce", quantity: 0.25, unit: "cup", note: "finely chopped" },
        { id: "lim", name: "lime juice", category: "Produce", quantity: 2, unit: "tbsp", note: "freshly squeezed" },
      ],
      steps: [
        { i: 0, phase: "prep", text: "Dice the tomatoes and onion, mince the jalapeño and chop the cilantro.", ids: ["tom", "oni", "jal", "cil", "lim"] },
        { i: 1, phase: "assemble", text: "Combine the tomatoes, onion, jalapeño and cilantro with the lime juice; let sit 10 minutes." },
      ],
    },
  ]);

describe("H7.1 1 — a later-step garlic never joins the onion", () => {
  it("🔴 onion and pepper at step 1, garlic at step 2: the garlic has its own container", () => {
    const l = loaded([
      {
        id: "d-taco",
        name: "Taco Filling",
        ings: [
          { id: "oni", name: "yellow onion", category: "Produce", quantity: 1, unit: "each", note: "diced" },
          { id: "pep", name: "green bell pepper", category: "Produce", quantity: 1, unit: "each", note: "diced" },
          { id: "gar", name: "garlic", category: "Produce", quantity: 3, unit: "clove", note: "minced" },
        ],
        steps: [
          { i: 0, phase: "prep", text: "Dice the onion and pepper and mince the garlic.", ids: ["oni", "pep", "gar"] },
          { i: 1, phase: "cook", text: "Sauté the onion and bell pepper for 5 minutes until soft." },
          { i: 2, phase: "cook", text: "Add the garlic and cook 1 minute until fragrant." },
        ],
      },
    ]);
    const sp = planFrom(l);
    assert.equal(destOf(sp, "yellow onion"), destOf(sp, "green bell pepper"), "fixture: the onion and pepper share a pan");
    assert.notEqual(destOf(sp, "garlic"), destOf(sp, "yellow onion"), "the later garlic joined the onion");
  });
});

describe("H7.1 2a — a cold raw mixture groups its cut vegetables", () => {
  it("🔴 the pico's tomato, onion, jalapeño and cilantro are ONE tub; the lime juice is not in it", () => {
    const sp = planFrom(pico());
    const tub = destOf(sp, "roma tomatoes");
    assert.ok(tub, "fixture: the tomatoes have a container");
    for (const n of ["white onion", "jalapeño", "fresh cilantro"]) assert.equal(destOf(sp, n), tub, `${n} is not in the pico tub`);
    assert.notEqual(destOf(sp, "lime juice"), tub, "the acid went in with the vegetables");
  });

  it("🔴 leafy greens never share a container with the wet vegetables", () => {
    const l = loaded([
      {
        id: "d-sal",
        name: "Chopped Salad",
        ings: [
          { id: "rom", name: "romaine lettuce", category: "Produce", quantity: 1, unit: "head", note: "chopped" },
          { id: "cuc", name: "cucumber", category: "Produce", quantity: 1, unit: "each", note: "diced" },
          { id: "tom", name: "tomatoes", category: "Produce", quantity: 2, unit: "each", note: "diced" },
        ],
        steps: [
          { i: 0, phase: "prep", text: "Chop the romaine, dice the cucumber and tomatoes.", ids: ["rom", "cuc", "tom"] },
          { i: 1, phase: "assemble", text: "Toss the romaine, cucumber and tomatoes together." },
        ],
      },
    ]);
    const sp = planFrom(l);
    assert.equal(destOf(sp, "cucumber"), destOf(sp, "tomatoes"), "fixture: the cold mix must form");
    assert.notEqual(destOf(sp, "romaine lettuce"), destOf(sp, "cucumber"), "the lettuce sits against wet vegetables");
  });

  it("🔴 the dressing combines at prep only when the cook day is within 1 day", () => {
    const soon = notes(overlayAt(pico(), 1).wire);
    const later = notes(overlayAt(pico(), 3).wire);
    assert.match(soon, /Stir in the lime juice now/);
    assert.match(later, /Keep the lime juice separate; combine on cook day \(Tuesday\)/);
    assert.doesNotMatch(later, /Stir in the lime juice now/);
  });
});

/** A marinade, a protein, and whether the recipe marinates. */
const marinated = (protein: string, marinates: boolean | "2h") =>
  loaded([
    {
      id: "d-har",
      name: "Harissa Chicken",
      ings: [
        { id: "pro", name: protein, category: "Protein", quantity: 2, unit: "lb", note: "patted dry" },
        { id: "har", name: "harissa paste", category: "Pantry", quantity: 2, unit: "tbsp", pack: "jar" },
        { id: "oil", name: "extra-virgin olive oil", category: "Pantry", quantity: 2, unit: "tbsp", pack: "bottle" },
        { id: "lem", name: "lemon juice", category: "Produce", quantity: 2, unit: "tbsp", note: "freshly squeezed" },
      ],
      steps: [
        { i: 0, phase: "prep", text: "Whisk the harissa paste, olive oil and lemon juice into a marinade.", ids: ["har", "oil", "lem"], key: "marinade" },
        {
          i: 1,
          phase: "prep",
          // J.1 §2 — the recipe's own window decides: overnight joins at prep when the
          // day is near; "at least 2 hours" is a cook-day instruction.
          text: marinates === "2h"
            ? `Coat the ${protein} in the marinade and refrigerate for at least 2 hours.`
            : marinates
              ? `Coat the ${protein} in the marinade and refrigerate overnight.`
              : `Brush the ${protein} with the marinade.`,
          ids: ["pro"],
        },
        { i: 2, phase: "cook", text: `Roast the ${protein} at 425°F for 25 minutes.` },
      ],
    },
  ]);

describe("H7.1 2b — marinades", () => {
  const proteinNote = (w: ReturnType<typeof overlayAt>["wire"]) =>
    w.phases.find((p) => p.phase === "proteins")!.steps[0].storageNote ?? "";

  it("🔴 a protein joins its marinade at prep only when the recipe marinates AND it is cooked within a day", () => {
    assert.match(proteinNote(overlayAt(marinated("chicken thighs", true), 1).wire), /^Then into the .*marinade/);
    assert.doesNotMatch(proteinNote(overlayAt(marinated("chicken thighs", true), 2).wire), /Then into/, "two days out");
    assert.doesNotMatch(proteinNote(overlayAt(marinated("chicken thighs", false), 1).wire), /Then into/, "the recipe never marinates");
  });

  it("🔴 seafood never sits in acid, even cooked tomorrow", () => {
    const { wire } = overlayAt(marinated("shrimp", true), 1);
    assert.doesNotMatch(notes(wire), /Then into/);
    assert.match(notes(wire), /Add the shrimp just before cooking \(Tuesday\) — acid starts to cook seafood/);
  });

  it("🔴 J.1 §2 — the recipe's stated window wins: 'at least 2 hours' is '2 hours before cooking', never the night before", () => {
    const { wire } = overlayAt(marinated("chicken thighs", "2h"), 3);
    assert.ok(notes(wire).includes("Add the chicken thighs 2 hours before cooking (Tuesday)."), notes(wire));
    assert.ok(!notes(wire).includes("night before"), notes(wire));
    // …and even cooked tomorrow, a 2-hour marinade does not start on Sunday.
    assert.doesNotMatch(proteinNote(overlayAt(marinated("chicken thighs", "2h"), 1).wire), /Then into/);
  });

  it("🔴 the marinade's close names the night-before weekday, and the held list carries it", () => {
    const { wire } = overlayAt(marinated("chicken thighs", true), 3);
    const line = "Add the chicken thighs the night before you cook them (Tuesday).";
    assert.ok(notes(wire).includes(line), notes(wire));
    const held = wire.phases.find((p) => p.phase === "proteins")!.heldForCookDay ?? [];
    assert.ok(held.includes(line), `held: ${held.join(" | ")}`);
  });
});

describe("H7.1 2c — a dish's unplaced aromatics share one container", () => {
  it("🔴 Herb Roasted Potatoes: rosemary, thyme and garlic in ONE tub", () => {
    const l = loaded([
      {
        id: "d-pot",
        name: "Herb Roasted Potatoes",
        ings: [
          { id: "pot", name: "baby potatoes", category: "Produce", quantity: 2, unit: "lb", note: "halved" },
          { id: "ros", name: "fresh rosemary", category: "Produce", quantity: 1, unit: "tbsp", note: "finely chopped" },
          { id: "thy", name: "fresh thyme", category: "Produce", quantity: 1, unit: "tbsp", note: "stripped" },
          { id: "gar", name: "garlic", category: "Produce", quantity: 3, unit: "clove", note: "minced" },
        ],
        steps: [
          { i: 0, phase: "prep", text: "Halve the potatoes; chop the rosemary, strip the thyme and mince the garlic.", ids: ["pot", "ros", "thy", "gar"] },
          { i: 1, phase: "cook", text: "Roast everything at 425°F for 35 minutes." },
        ],
      },
    ]);
    const sp = planFrom(l);
    const tub = destOf(sp, "fresh rosemary");
    assert.equal(tub, "Herb Roasted Potatoes — aromatics");
    assert.equal(destOf(sp, "fresh thyme"), tub);
    assert.equal(destOf(sp, "garlic"), tub);
  });
});

describe("H7.1 2d — whole dried chiles never share a container with ground spices", () => {
  it("🔴 the chili's anchos and guajillos go in their own bag", () => {
    const input: PrepCombineInput = {
      meals: [
        {
          mealId: MEAL,
          mealName: "Chili",
          dishes: [
            {
              dishId: "d-chili",
              dishName: "Texas-Style Beef Chili",
              dishRole: "main",
              ingredients: [
                ["cum", "ground cumin", null],
                ["ore", "dried oregano", null],
                ["chp", "chili powder", null],
                ["anc", "dried ancho chiles", "stemmed and seeded"],
                ["gua", "dried guajillo chiles", "stemmed and seeded"],
              ].map(([id, name, note]) => ({
                ingredientId: id!,
                ingredientName: name!,
                category: "Pantry",
                quantity: 1,
                unit: "each",
                ...(note ? { preparationNote: note } : {}),
                purchaseUnit: "container",
                momentKey: "c:spice",
                component: { key: "spice", noun: "spice blend", bowlName: "Texas-Style Beef Chili spice blend" },
              })),
            },
          ],
        },
      ],
    };
    const sp = buildStepPlan(combinePrep(input), "P");
    const bowls = sp.steps.filter((s) => s.bowlName && !s.demoted);
    const chiles = bowls.find((s) => s.components.some((c) => /ancho/.test(c.ingredientName)));
    const spices = bowls.find((s) => s.components.some((c) => c.ingredientName === "ground cumin"));
    assert.ok(chiles && spices, "fixture: both containers form");
    // J.1 (R2) — named by class and form; the bag's own step must not open on a raw label.
    assert.equal(chiles!.bowlName, "Texas-Style Beef Chili dried-chile bag");
    assert.notEqual(chiles!.bowlName, spices!.bowlName);
    assert.ok(!spices!.components.some((c) => /chiles/.test(c.ingredientName)), "a dried chile is in the spice blend");
  });
});

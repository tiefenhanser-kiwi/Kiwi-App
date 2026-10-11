// BUG-358 / D-WS9-301 moment authority — a container holds one mixture's
// ingredients for ONE moment. The two acceptance fixtures are the recipes from
// Hans's plan f49f5209, step text verbatim: the BBQ meatballs' binder (made cold at
// s0) and their glaze (poured into the pan at s5), and the nacho cheese sauce's
// roux flour (s1) and its finishing spices and hot sauce (s3).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mixtureEntryKey } from "../prepMoments";
import { resolveDishComponents, type ComponentStep } from "../prepComponents";
import { buildStepPlan } from "../prepWeekAssembly";
import { combinePrep } from "../prepCombineEngine";
import { buildPrepCombineInput } from "../prepCombineAdapter";

const step = (
  stepIndex: number,
  phaseType: string,
  text: string,
  o: { componentKey?: string; ids?: string[] } = {},
): ComponentStep => ({
  stepIndex,
  text,
  phaseType,
  componentKey: o.componentKey ?? null,
  ingredientIds: o.ids ?? [],
});

const row = (ingredientId: string, ingredientName: string, category: string, quantity: number, unit: string, preparationNote: string | null = null) => ({
  ingredientId, ingredientName, category, quantity, unit, preparationNote, sourceYield: null,
});

function planOf(dishName: string, mealName: string, componentSteps: ComponentStep[], ingredients: ReturnType<typeof row>[]) {
  return {
    planId: "p1",
    planName: "Week",
    meals: [{
      mealId: "m1", mealName, cuisine: null, servingsOverride: null,
      dishes: [{
        dishId: "d1", dishName, dishRole: "main", baseServings: 4, authoredBaseServings: 4,
        stepTexts: componentSteps.map((s) => s.text), componentSteps, ingredients,
      }],
    }],
  };
}

/** container name → the ingredient names the plan puts in it. */
function containers(loaded: ReturnType<typeof planOf>): Map<string, Set<string>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sp = buildStepPlan(combinePrep(buildPrepCombineInput(loaded as any)), "Week");
  const out = new Map<string, Set<string>>();
  for (const st of sp.steps) {
    if (st.demoted) continue;
    for (const c of st.components) {
      for (const m of c.measures) {
        const dest = m.destination ?? st.bowlName;
        if (!dest) continue;
        out.set(dest, (out.get(dest) ?? new Set()).add(c.ingredientName));
      }
    }
  }
  return out;
}

const together = (all: Map<string, Set<string>>, a: string, b: string) =>
  [...all.values()].some((s) => s.has(a) && s.has(b));

// ── the two acceptance fixtures ─────────────────────────────────────────────

const MEATBALL_STEPS = [
  step(0, "prep", "In a large bowl, combine 1½ lb 80/20 ground beef, ⅓ cup plain breadcrumbs, ¼ cup whole milk, 1 large egg, ½ teaspoon garlic powder, ½ teaspoon onion powder, ½ teaspoon smoked paprika, ¾ teaspoon kosher salt, ¼ teaspoon black pepper, and 1 tablespoon Worcestershire sauce; mix until just combined.", {
    componentKey: "meatballs",
    ids: ["beef", "crumbs", "milk", "egg", "garlicp", "onionp", "paprika", "salt", "pepper", "worcs"],
  }),
  step(1, "prep", "Roll the mixture into 24 meatballs, about 1½ inches each, and place them on a plate.", { componentKey: "meatballs" }),
  step(3, "preheat", "Heat 1 tablespoon neutral oil in a large skillet over medium-high heat until shimmering.", { ids: ["oil"] }),
  step(4, "cook", "Add the meatballs in a single layer and sear, turning every 2 minutes, until browned on all sides, about 8 minutes total (they do not need to be fully cooked through yet)."),
  step(5, "cook", "Reduce heat to medium-low, pour in 1 cup smoky-sweet BBQ sauce, and stir to coat all the meatballs; simmer uncovered for 8 minutes, turning occasionally, until the sauce is thickened and the meatballs are cooked through.", { ids: ["bbq"] }),
  step(6, "assemble", "Remove from heat and serve the glazed meatballs over the buttered egg noodles."),
];
const MEATBALL_ROWS = [
  row("beef", "ground beef (80/20)", "Protein", 1.5, "lb"),
  row("crumbs", "plain breadcrumbs", "Pantry", 0.33, "cup"),
  row("milk", "Whole milk", "Dairy", 0.25, "cup"),
  row("egg", "Large eggs", "Dairy", 1, "each"),
  row("garlicp", "garlic powder", "Pantry", 0.5, "tsp"),
  row("onionp", "onion powder", "Pantry", 0.5, "tsp"),
  row("paprika", "smoked paprika", "Pantry", 0.5, "tsp"),
  row("salt", "Kosher salt", "Pantry", 0.75, "tsp"),
  row("pepper", "Black pepper", "Pantry", 0.25, "tsp"),
  row("worcs", "worcestershire sauce", "Pantry", 1, "tbsp"),
  row("oil", "vegetable oil", "Pantry", 1, "tbsp"),
  row("bbq", "bbq sauce", "Pantry", 1, "cup", "smoky-sweet variety"),
];

const NACHO_STEPS = [
  step(0, "prep", "Freshly shred 6 ounces sharp cheddar cheese and finely mince 2 tablespoons pickled jalapeño slices; set both aside.", { componentKey: "sauce", ids: ["cheddar", "jalslices"] }),
  step(1, "cook", "Melt 2 tablespoons unsalted butter in a small saucepan over medium heat, whisk in 2 tablespoons all-purpose flour, and cook the roux for 1 minute, stirring constantly, until it smells slightly nutty.", { componentKey: "sauce", ids: ["butter", "flour"] }),
  step(2, "cook", "Slowly pour in 1 cup whole milk in a thin stream, whisking constantly, and cook over medium heat for 3–4 minutes until the sauce thickens enough to coat the back of a spoon.", { componentKey: "sauce", ids: ["milk"] }),
  step(3, "cook", "Reduce heat to low, add the shredded cheddar a handful at a time, whisking after each addition until fully melted, then stir in the minced jalapeños, 1 tablespoon jalapeño brine, ¼ teaspoon cumin, ¼ teaspoon chili powder, ¼ teaspoon kosher salt, and ½ teaspoon hot sauce (optional).", {
    componentKey: "sauce",
    ids: ["brine", "cumin", "chili", "salt", "hot"],
  }),
  step(5, "hold", "Keep the finished cheese sauce on the lowest heat setting, stirring occasionally, until the tacos are assembled and ready to serve."),
  step(6, "assemble", "Spoon the warm nacho cheese sauce generously over the assembled tacos just before serving."),
];
const NACHO_ROWS = [
  row("butter", "unsalted butter", "Dairy", 2, "tbsp"),
  row("flour", "All-purpose flour", "Pantry", 2, "tbsp"),
  row("milk", "Whole milk", "Dairy", 1, "cup"),
  row("cheddar", "sharp cheddar cheese", "Dairy", 6, "oz", "freshly shredded"),
  row("brine", "pickled jalapeño brine", "Pantry", 1, "tbsp"),
  row("jalslices", "pickled jalapeño slices", "Pantry", 2, "tbsp", "finely minced"),
  row("cumin", "ground cumin", "Pantry", 0.25, "tsp"),
  row("chili", "chili powder", "Pantry", 0.25, "tsp"),
  row("salt", "Kosher salt", "Pantry", 0.25, "tsp"),
  row("hot", "hot sauce", "Pantry", 0.5, "tsp"),
];

describe("BUG-358 — the two jars from f49f5209", () => {
  it("🔴 BBQ meatballs: the binder and the glaze are never one jar", () => {
    const all = containers(planOf("BBQ Glazed Beef Meatballs", "BBQ Meatballs with Buttered Egg Noodles", MEATBALL_STEPS, MEATBALL_ROWS));
    for (const binder of ["plain breadcrumbs", "smoked paprika", "garlic powder", "onion powder", "worcestershire sauce"]) {
      assert.equal(together(all, binder, "bbq sauce"), false, `${binder} shares a jar with the glaze`);
    }
    // The glaze is one condiment poured from its bottle (D-WS9-299): no jar at all.
    assert.equal([...all.values()].some((s) => s.has("bbq sauce")), false, "the BBQ sauce was measured into a container");
    // The binder still has its jar: its dry members enter together at s0.
    assert.equal(together(all, "plain breadcrumbs", "smoked paprika"), true, "the binder lost its container");
  });

  it("🔴 nacho cheese sauce: the roux flour never sits with what goes in after the milk", () => {
    const all = containers(planOf("Velvety Nacho Cheese Sauce", "Cheesy Ground Beef Tacos with Nacho Cheese Sauce", NACHO_STEPS, NACHO_ROWS));
    for (const later of ["hot sauce", "chili powder", "ground cumin", "pickled jalapeño brine"]) {
      assert.equal(together(all, "All-purpose flour", later), false, `the flour shares a jar with the ${later}`);
    }
    // What enters together at s3 still shares one jar.
    assert.equal(together(all, "ground cumin", "hot sauce"), true, "the s3 finish lost its jar");
    assert.equal(together(all, "chili powder", "pickled jalapeño brine"), true);
  });

  it("the binder's noun no longer comes from the Worcestershire sauce's name", () => {
    const { components } = resolveDishComponents(
      "BBQ Glazed Beef Meatballs",
      "BBQ Meatballs",
      MEATBALL_STEPS,
      MEATBALL_ROWS.map((r) => ({ ingredientId: r.ingredientId, ingredientName: r.ingredientName, preparationNote: r.preparationNote, phase: r.category === "Protein" ? "proteins" : null })),
    );
    // One component, the binder — and the glaze's step is not folded into it.
    assert.equal(components.length, 1);
    assert.equal(components[0].noun, null);
    assert.deepEqual(components[0].stepIndexes, [0]);
  });
});

// ── the entry rule itself ───────────────────────────────────────────────────

describe("BUG-358 — mixtureEntryKey", () => {
  it("an amount stated on a heat step enters there; a combine step makes its mixture there", () => {
    assert.equal(mixtureEntryKey(NACHO_STEPS, "flour", "All-purpose flour"), "s:1");
    assert.equal(mixtureEntryKey(NACHO_STEPS, "hot", "hot sauce"), "s:3");
    assert.equal(mixtureEntryKey(MEATBALL_STEPS, "crumbs", "plain breadcrumbs"), "r:0");
    assert.equal(mixtureEntryKey(MEATBALL_STEPS, "bbq", "bbq sauce"), "s:5");
  });

  it("a knife step is not the use: the diced onion enters where the pan takes it", () => {
    const steps = [
      step(0, "prep", "Dice 1 yellow onion and set aside.", { ids: ["onion"] }),
      step(1, "cook", "Heat the oil in a skillet over medium heat."),
      step(2, "cook", "Add the diced onion and cook until soft, about 5 minutes."),
    ];
    assert.equal(mixtureEntryKey(steps, "onion", "yellow onion"), "s:2");
  });

  it("🔴 the lemon-herb lemon: the marinade's whisk names its zest before the bake lays the rounds", () => {
    const steps = [
      step(1, "prep", "Zest and juice 1 lemon; slice the second lemon into rounds and set aside for topping.", { ids: ["lemon"] }),
      step(3, "prep", "Whisk together the lemon zest, lemon juice, minced garlic, rosemary, thyme, 3 tablespoons olive oil and 1 tablespoon Dijon mustard into a marinade.", { componentKey: "marinade", ids: ["oil", "mustard"] }),
      step(7, "cook", "Arrange the marinated chicken breasts in the baking dish, lay the lemon rounds on top, and pour any remaining marinade over them."),
    ];
    assert.equal(mixtureEntryKey(steps, "lemon", "lemon"), "r:0");
  });

  it("a second stated amount is a second portion: the scan stops (one id, two rows)", () => {
    const steps = [
      step(1, "prep", "Measure ½ teaspoon cumin into a small bowl.", { ids: ["cumin"] }),
      step(3, "rest", "Add the chicken to the marinade and let it sit."),
      step(8, "cook", "Stir in 1 teaspoon cumin and cook 1 minute.", { ids: ["cumin"] }),
    ];
    assert.equal(mixtureEntryKey(steps, "cumin", "ground cumin"), "r:0");
  });

  it("no amount anywhere: the first step that names it", () => {
    const steps = [
      step(0, "prep", "In a large bowl, combine the yogurt, the lemon juice and 1 teaspoon each ground cumin and ground coriander.", { ids: ["yogurt"] }),
      step(4, "cook", "Cook the chicken."),
    ];
    assert.equal(mixtureEntryKey(steps, "coriander", "ground coriander"), "r:0");
    assert.equal(mixtureEntryKey(steps, "absent", "saffron"), "i");
  });
});

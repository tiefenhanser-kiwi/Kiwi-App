// WS9 D-WS9-296 / D-WS9-299 — components, named bowls, and prep-worthiness.
//
// Every fixture is reduced from the 13-plan census (scripts/prep-cook-census),
// and each of chat-Claude's eight rulings has a test that goes red without it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  useNounFor,
  bowlNameFor,
  resolveDishComponents,
  judgePrepWorthiness,
  shortDishName,
  type ComponentIngredient,
  type ComponentStep,
} from "../prepComponents";

// ── fixtures ────────────────────────────────────────────────────────────────

const step = (
  stepIndex: number,
  text: string,
  o: { componentKey?: string; ids?: string[]; phaseType?: string } = {},
): ComponentStep => ({
  stepIndex,
  text,
  componentKey: o.componentKey ?? null,
  ingredientIds: o.ids ?? [],
  // D-WS9-301 — defaults to `prep` so every pre-existing component case keeps
  // its meaning; the moment tests pass `cook` explicitly where heat matters.
  phaseType: o.phaseType ?? "prep",
});

const ing = (
  ingredientId: string,
  ingredientName: string,
  phase: string | null,
  preparationNote: string | null = null,
): ComponentIngredient => ({ ingredientId, ingredientName, phase, preparationNote });

/** THE CARNE ASADA, reduced: the marinade whose eight parts used to scatter. */
function carneAsada() {
  return {
    steps: [
      step(
        0,
        "In a bowl, whisk together ¼ cup orange juice, 3 tablespoons lime juice, 4 minced garlic cloves, 1 teaspoon cumin, 1 teaspoon chili powder, ½ teaspoon smoked paprika and ½ teaspoon dried oregano.",
        { ids: ["oj", "lime-juice", "garlic", "cumin", "chili", "paprika", "oregano"] },
      ),
      step(
        1,
        "Place 1½ pounds skirt steak in a zip-top bag, pour the marinade over it, seal, and refrigerate for at least 30 minutes.",
        { ids: ["steak"] },
      ),
      step(2, "Grill the skirt steak 3–4 minutes per side.", {}),
    ],
    ingredients: [
      ing("oj", "orange juice", "produce"),
      ing("lime-juice", "lime juice", "produce"),
      ing("garlic", "garlic", "produce", "minced"),
      ing("cumin", "ground cumin", "seasonings_dry"),
      ing("chili", "chili powder", "seasonings_dry"),
      ing("paprika", "smoked paprika", "seasonings_dry"),
      ing("oregano", "dried oregano", "seasonings_dry"),
      ing("steak", "skirt steak", "proteins"),
    ],
  };
}

// ── the marinade, and ruling 1 ──────────────────────────────────────────────

describe("D-WS9-296 — the carne asada marinade is ONE bowl", () => {
  it("collects all seven measured parts across three phases", () => {
    const f = carneAsada();
    const { components } = resolveDishComponents("Carne Asada", "Carne Asada Tacos", f.steps, f.ingredients);
    assert.equal(components.length, 1, `expected one component, got ${components.map((c) => c.bowlName).join(", ")}`);
    const c = components[0];
    assert.equal(c.bowlName, "Carne Asada marinade bowl");
    assert.deepEqual(
      [...c.memberIds].sort(),
      ["chili", "cumin", "garlic", "lime-juice", "oj", "oregano", "paprika"],
    );
  });

  it("LOOKS AHEAD for the name: the whisk step names nothing, the next says 'marinade'", () => {
    // Without the look-ahead the mixture becomes a nameless "bowl 1" and the
    // "marinade" bucket holds nothing — the defect D-WS9-296 exists to remove,
    // reproduced by the derivation itself.
    const f = carneAsada();
    const { components } = resolveDishComponents("Carne Asada", null, f.steps, f.ingredients);
    assert.equal(components[0].noun, "marinade");
  });

  it("🔴 ruling 1 — the raw steak is NOT a member; it has a destination", () => {
    const f = carneAsada();
    const { components, byIngredient } = resolveDishComponents("Carne Asada", null, f.steps, f.ingredients);
    assert.ok(!components[0].memberIds.includes("steak"), "raw flesh must not sit in the bowl all week");
    assert.deepEqual(components[0].cookDayIds, ["steak"]);
    assert.equal(byIngredient.has("steak"), false);
  });
});

// ── ruling 2 — signal 4's guard ─────────────────────────────────────────────

describe("D-WS9-296 ruling 2 — the name match is guarded", () => {
  /** THE PICO: diced in step 0 with amounts, combined in step 1 with none. */
  const pico = {
    steps: [
      step(0, "Dice 3 roma tomatoes, finely dice ½ white onion, seed and mince 1 jalapeño, and chop ¼ cup cilantro.", {
        ids: ["tomato", "onion", "jalapeno", "cilantro"],
      }),
      step(1, "Combine the tomatoes, onion, jalapeño, and cilantro in a bowl, then squeeze in the juice of 1 lime.", {
        ids: ["lime-juice"],
      }),
      step(2, "Stir to combine and let the pico sit for 5 minutes.", {}),
    ],
    ingredients: [
      ing("tomato", "roma tomatoes", "produce", "diced"),
      ing("onion", "white onion", "produce", "finely diced"),
      ing("jalapeno", "jalapeño", "produce", "seeded and minced"),
      ing("cilantro", "fresh cilantro", "produce", "chopped"),
      ing("lime-juice", "lime juice", "produce"),
    ],
  };

  it("pulls in the four parts whose amounts live on another step", () => {
    const { components } = resolveDishComponents("Pico de Gallo", null, pico.steps, pico.ingredients);
    assert.equal(components.length, 1);
    assert.equal(components[0].memberIds.length, 5, components[0].memberIds.join(", "));
    // Non-ASCII survives: stripping to [a-z] turned "jalapeño" into "jalape".
    assert.ok(components[0].memberIds.includes("jalapeno"));
  });

  it("🔴 a SERVICE FORM never enters a mixture — the wedged limes leave the jar", () => {
    // B2 Part A put "2 limes, cut into wedges, for serving" in the Taco
    // Toppings HOT-SAUCE jar, because "lime" appears in that step's text.
    // ONE combine step with BOTH sauce members, and "lime" in its text. That is the
    // defect's mechanism: signal 4 claims an unplaced ingredient whose head word
    // appears in a combine step, and the jar is what it claims it into.
    const steps = [
      step(0, "Whisk together 2 tablespoons hot sauce and the sour cream with a squeeze of lime.", {
        ids: ["hot-sauce", "sour-cream"],
      }),
    ];
    const ingredients = [
      ing("hot-sauce", "hot sauce", "sauces_marinades"),
      ing("sour-cream", "sour cream", "sauces_marinades"),
      ing("lime", "lime", "produce", "cut into wedges, for serving"),
    ];
    // 🔴 NOT "Taco Toppings". H5.1 refuses that dish a container outright, which
    // would make this pass without consulting the guard at all.
    const { byIngredient, components } = resolveDishComponents(
      "Velvety Nacho Cheese Sauce",
      null,
      steps,
      ingredients,
    );
    // 🔴 AND THE FIXTURE MUST ACTUALLY FORM THE JAR. Without this line the test
    // asserts an absence from an empty map, which is what it had been doing: its
    // two steps held one ingredient each, ruling 3 dissolved both, and the
    // service-form guard was never reached.
    assert.equal(components.length, 1, "the fixture must form the jar, or nothing is being tested");
    assert.equal(components[0].memberIds.length, 2, "the jar should hold the hot sauce and the cream");
    assert.equal(byIngredient.has("lime"), false, "a wedge for the table is not an ingredient of the sauce");
  });

  it("only a COMBINE step can claim by name", () => {
    // "Scatter the cilantro over the finished dish" mentions cilantro and is not
    // a mixture; a name match there would invent a bowl.
    const steps = [
      step(0, "Whisk the soy sauce and the sesame oil into a glaze.", { ids: ["soy", "oil"] }),
      step(1, "Scatter the scallions over the finished salmon.", {}),
    ];
    const ingredients = [
      ing("soy", "soy sauce", "sauces_marinades"),
      ing("oil", "sesame oil", "sauces_marinades"),
      ing("scallion", "scallions", "produce", "thinly sliced"),
    ];
    const { byIngredient } = resolveDishComponents("Teriyaki Salmon", null, steps, ingredients);
    assert.equal(byIngredient.has("scallion"), false);
  });
});

// ── rulings 3, 5, 6, 7, 8 ───────────────────────────────────────────────────

describe("D-WS9-296 rulings 3, 5, 6, 7 and 8", () => {
  it("ruling 3 — a ONE-member mixture is a plain portion, and loses its name", () => {
    // The Sesame Cucumber Salad's lone cucumber was a "dressing jar".
    const steps = [step(0, "Toss the sliced cucumber in the dressing.", { ids: ["cuke"] })];
    const ingredients = [ing("cuke", "english cucumber", "produce", "thinly sliced")];
    const { components, byIngredient } = resolveDishComponents("Sesame Cucumber Salad", null, steps, ingredients);
    assert.deepEqual(components, []);
    assert.equal(byIngredient.size, 0);
  });

  it("ruling 5 — one step group, one name: the MORE SPECIFIC label wins", () => {
    // The same whisk step called a "dressing" in one sentence and a "sauce" in
    // the next produced two jars in B2 Part A.
    const steps = [
      step(0, "Whisk the rice vinegar, sesame oil and honey into a sauce.", { ids: ["vinegar", "oil", "honey"] }),
      step(1, "Pour the dressing over the cucumbers.", {}),
    ];
    const ingredients = [
      ing("vinegar", "rice vinegar", "sauces_marinades"),
      ing("oil", "sesame oil", "sauces_marinades"),
      ing("honey", "honey", "seasonings_dry"),
    ];
    const { components } = resolveDishComponents("Sesame Cucumber Salad", null, steps, ingredients);
    assert.equal(components.length, 1, components.map((c) => c.bowlName).join(" | "));
    assert.equal(components[0].noun, "dressing");
  });

  it("ruling 6 — a componentKey that names a FOOD is a path tag, not a mixture", () => {
    // "garlic", "beef" and "chicken" are Block 3.7 path tags. B2 Part A turned
    // them into "Classic Takeout-Style Chicken Fried garlic bowl".
    const steps = [
      step(0, "Mince the garlic and grate the ginger.", { componentKey: "garlic", ids: ["garlic", "ginger"] }),
    ];
    const ingredients = [
      ing("garlic", "garlic", "produce", "minced"),
      ing("ginger", "fresh ginger", "produce", "grated"),
    ];
    const { components } = resolveDishComponents("Chicken Fried Rice", null, steps, ingredients);
    // No mixture noun anywhere and no combine verb → no component at all.
    assert.deepEqual(components, []);
  });

  it("ruling 7 — a mixture whose base is a cook-day item becomes the MIX-INS bowl", () => {
    const steps = [
      step(0, "Mash the avocados, then fold in the cilantro, jalapeño, onion and lime juice.", {
        ids: ["avocado", "cilantro", "jalapeno", "onion", "lime-juice"],
      }),
    ];
    const ingredients = [
      ing("avocado", "ripe avocado", "produce", "halved and pitted"),
      ing("cilantro", "fresh cilantro", "produce", "chopped"),
      ing("jalapeno", "jalapeño", "produce", "seeded and minced"),
      ing("onion", "white onion", "produce", "finely diced"),
      ing("lime-juice", "lime juice", "produce"),
    ];
    const { components } = resolveDishComponents("Guacamole", null, steps, ingredients);
    assert.equal(components.length, 1);
    assert.equal(components[0].bowlName, "Guacamole mix-ins bowl");
    assert.ok(!components[0].memberIds.includes("avocado"), "cut avocado is brown by Tuesday");
    assert.deepEqual(components[0].cookDayIds, ["avocado"]);
  });

  it("ruling 8 — a dish name never ends on a dangling conjunction", () => {
    // B2 Part A's 4-word cut produced "Pickled Red Onion and".
    // 33 chars, so it trims — and "Pickled Red Onion and Radish" is a fine trim
    // because it does not DANGLE. B2 Part A's 4-word cut gave "Pickled Red Onion
    // and", which is the thing ruling 8 forbids.
    assert.equal(shortDishName("Pickled Red Onion and Radish Slaw"), "Pickled Red Onion and Radish");
    assert.equal(shortDishName("Spinach and Ricotta Stuffed Portobello Mushrooms with Roasted Cherry Tomatoes"), "Spinach and Ricotta Stuffed");
    assert.equal(shortDishName("Carne Asada"), "Carne Asada");
    for (const t of ["A with B", "Pickled Red Onion and Radish Slaw", "Beef of the Day in Sauce"]) {
      const out = shortDishName(t);
      assert.ok(!/\b(and|with|of|in|the|for|or)$/i.test(out), `"${out}" ends on a conjunction`);
      assert.ok(out.length <= 32, `"${out}" is ${out.length} chars`);
    }
  });

  it("ruling 8 — a nameless mixture of seasonings is a SEASONING bowl, not 'bowl 1'", () => {
    const steps = [
      step(0, "Stir together the cumin, the chili powder and the olive oil.", { ids: ["cumin", "chili", "oil"] }),
    ];
    const ingredients = [
      ing("cumin", "ground cumin", "seasonings_dry"),
      ing("chili", "chili powder", "seasonings_dry"),
      ing("oil", "olive oil", "sauces_marinades"),
    ];
    const { components } = resolveDishComponents("Sheet-Pan Fajitas", null, steps, ingredients);
    assert.equal(components[0].bowlName, "Sheet-Pan Fajitas seasoning bowl");
  });
});

// ── D-WS9-299 — prep-worthiness ─────────────────────────────────────────────

describe("D-WS9-299 — a prep step exists only when it saves weeknight time", () => {
  const judge = (o: Partial<Parameters<typeof judgePrepWorthiness>[0]>) =>
    judgePrepWorthiness({
      measuredItems: 1,
      componentNoun: null,
      preparationNotes: [],
      text: "",
      ...o,
    });

  it("🔴 ONE thing measured alone is not prep — Hans's ketchup", () => {
    const v = judge({ measuredItems: 1, text: "hot sauce" });
    assert.equal(v.worthDoingAhead, false);
    assert.equal(v.reason, "single-item");
  });

  it("TWO simple things that just get added at the stove are not prep either", () => {
    const v = judge({ measuredItems: 2, text: "soy sauce sesame oil" });
    assert.equal(v.worthDoingAhead, false);
    assert.equal(v.reason, "two-simple-items");
  });

  it("(a) THREE or more measured items IS prep — the mix and the cleanup", () => {
    assert.equal(judge({ measuredItems: 3 }).worthDoingAhead, true);
    assert.equal(judge({ measuredItems: 6 }).reason, "mixture");
  });

  it("(b) TWO that must SIT together is prep — a marinade, a brine", () => {
    assert.equal(judge({ measuredItems: 2, componentNoun: "marinade" }).reason, "must-sit");
    assert.equal(judge({ measuredItems: 2, componentNoun: "brine" }).worthDoingAhead, true);
    // …but two that merely mix are not.
    assert.equal(judge({ measuredItems: 2, componentNoun: "sauce" }).worthDoingAhead, false);
  });

  it("(c) KNIFE WORK is prep at ANY count — one onion still has to be diced", () => {
    assert.equal(judge({ measuredItems: 1, preparationNotes: ["finely diced"] }).reason, "knife-work");
    assert.equal(judge({ measuredItems: 1, preparationNotes: ["zested"] }).worthDoingAhead, true);
    assert.equal(judge({ measuredItems: 1, text: "husk the corn" }).worthDoingAhead, true);
  });

  it("🔴 a PROTEINS step is exempt — portioning raw flesh is not 'measuring one thing'", () => {
    // Without this every unmarinated protein was demoted as a single item.
    const v = judge({ measuredItems: 1, phase: "proteins", text: "lean ground beef" });
    assert.equal(v.worthDoingAhead, true);
  });
});

// ── WS9 D-WS9-301 rule 8 — "Containers, named by dish + use. Never 'bowl 1'" ─

describe("D-WS9-301 rule 8 — a container is never numbered", () => {
  it("🔴 a nameless mixture gets a USE, not an ordinal", () => {
    // The sample plan shipped "Slow-Cooker Chicken bowl 1" and "Garlic Herb
    // Roasted Potatoes bowl 1". The ordinal is anonymous: a cook looking in the
    // fridge on Friday has no way to tell bowl 1 from bowl 2.
    assert.equal(
      bowlNameFor("Garlic Herb Roasted Potatoes", null, null, 1, false, false, "prep container"),
      "Garlic Herb Roasted Potatoes prep container",
    );
    assert.equal(
      bowlNameFor("Texas-Style Beef Chili", null, null, 2, false, false, "spice blend"),
      "Texas-Style Beef Chili spice blend",
    );
  });

  it("the use noun is derived from what is in the container", () => {
    assert.equal(useNounFor(["seasonings_dry", "seasonings_dry"]), "spice blend");
    assert.equal(useNounFor(["seasonings_dry", "sauces_marinades"]), "sauce bowl");
    // Anything fresh in it and "sauce bowl" would be a lie — a tablespoon of oil
    // does not make a container of potatoes a sauce.
    assert.equal(useNounFor(["produce", "sauces_marinades"]), "prep container");
    assert.equal(useNounFor([]), "prep container");
  });

  it("🔴 and no name this module can produce ends in a bare number", () => {
    for (const noun of [null, "marinade", "glaze", "spice blend"]) {
      for (const use of ["prep container", "spice blend", "sauce bowl"]) {
        const name = bowlNameFor("Some Dish", null, noun, 3, false, false, use);
        assert.ok(!/\b\d+$/.test(name), `"${name}" ends in an ordinal`);
      }
    }
  });
});

// ── WS9 D-WS9-301 H2.2 — a container holding fresh food is not a "seasoning" ──

describe("D-WS9-301 H2.2 — a dry noun never names a container with fresh food in it", () => {
  it("🔴 the Tex-Mex seasoning that held garlic and onion loses the word", () => {
    // Shipped in the H1 corpus: "Tex-Mex Seasoned Ground Beef seasoning" holding
    // six dry spices AND three minced garlic cloves AND a diced yellow onion. The
    // membership is right — they go into the pan together — and H1 already moved
    // the container out of the skippable dry phase and gave it a fridge window.
    // Only the NAME lied, and it is the name the cook reads in the fridge.
    const steps = [
      // The real shape: one tagged step carries the whole lot, spices and fresh
      // aromatics together, because they all go into the skillet at once.
      step(0, "Combine the chili powder, cumin, paprika and oregano with the minced garlic and diced onion.", {
        componentKey: "seasoning",
        ids: ["chili", "cumin", "paprika", "oregano", "garlic", "onion"],
      }),
    ];
    const ingredients = [
      ing("garlic", "garlic", "produce", "minced"),
      ing("onion", "yellow onion", "produce", "finely diced"),
      ing("chili", "chili powder", "seasonings_dry"),
      ing("cumin", "ground cumin", "seasonings_dry"),
      ing("paprika", "smoked paprika", "seasonings_dry"),
      ing("oregano", "dried oregano", "seasonings_dry"),
    ];
    const { components } = resolveDishComponents("Tex-Mex Seasoned Ground Beef", null, steps, ingredients);
    const withFresh = components.find((c) => c.memberIds.includes("onion"));
    assert.ok(withFresh, "the onion left the container entirely — that is not the fix");
    assert.ok(
      !/\b(seasoning|spice blend|rub)\b/i.test(withFresh!.bowlName),
      `"${withFresh!.bowlName}" still promises a dry blend`,
    );
    assert.equal(withFresh!.noun, null);
  });

  it("…and an all-dry container KEEPS its dry noun", () => {
    const steps = [
      step(0, "Combine the cumin, chili powder and oregano as the seasoning blend.", {
        componentKey: "seasoning",
        ids: ["cumin", "chili", "oregano"],
      }),
    ];
    const ingredients = [
      ing("cumin", "ground cumin", "seasonings_dry"),
      ing("chili", "chili powder", "seasonings_dry"),
      ing("oregano", "dried oregano", "seasonings_dry"),
    ];
    const { components } = resolveDishComponents("Beef Enchiladas Verdes", null, steps, ingredients);
    assert.match(components[0].bowlName, /spice blend|seasoning/i);
  });

  it("a WET noun survives fresh members — a marinade is supposed to hold garlic", () => {
    const steps = [
      step(0, "Whisk the oil and lemon juice with the minced garlic to make the marinade.", {
        componentKey: "marinade",
        ids: ["oil", "lemon", "garlic"],
      }),
    ];
    const ingredients = [
      ing("oil", "extra-virgin olive oil", "sauces_marinades"),
      ing("lemon", "lemon juice", "produce"),
      ing("garlic", "garlic", "produce", "minced"),
    ];
    const { components } = resolveDishComponents("Lemon-Herb Chicken", null, steps, ingredients);
    assert.equal(components[0].noun, "marinade");
    assert.match(components[0].bowlName, /marinade/);
  });
});
